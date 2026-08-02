//! Spotify link enumeration for the probe path.
//!
//! `probe_url` used to short-circuit every Spotify URL to a single hard-coded
//! entry, so an album previewed as 1 item while spotdl happily downloaded all
//! N tracks — the app then reported and recorded exactly one of them.
//!
//! This module turns a Spotify link into the same shape a yt-dlp carousel
//! produces: one `ProbeEntry` per track, each pointing at its own
//! `https://open.spotify.com/track/<id>` URL so the download lane can run one
//! spotdl invocation per track (real per-item progress, per-track history
//! rows, per-item cancel).
//!
//! Resolution order — never hard-errors, always degrades:
//!   1. Spotify Web API (client-credentials) when BOTH id + secret are set.
//!   2. `spotdl save` metadata enumeration.
//!   3. Caller's single-stub fallback (see `downloader::probe_url`).
//!
//! The client secret is never logged and never placed in an error string.

use crate::downloader::{get_spotdl_path, ProbeEntry, ProbeResult};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

const API: &str = "https://api.spotify.com/v1";
const TOKEN_URL: &str = "https://accounts.spotify.com/api/token";

/// Hard cap on enumerated tracks. A 500-track playlist must not wedge a probe
/// the user is waiting on; anything past this is dropped with a log line.
const MAX_TRACKS: usize = 100;

/// How long a metadata-only spotdl call may run before it is killed. spotdl
/// can sit forever on an unreachable audio provider — that must not wedge the
/// probe, it must fall through to the stub.
const SPOTDL_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpotifyKind {
    Track,
    Album,
    Playlist,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpotifyRef {
    pub kind: SpotifyKind,
    pub id: String,
}

fn kind_from_segment(seg: &str) -> Option<SpotifyKind> {
    match seg.to_ascii_lowercase().as_str() {
        "track" => Some(SpotifyKind::Track),
        "album" => Some(SpotifyKind::Album),
        "playlist" => Some(SpotifyKind::Playlist),
        _ => None,
    }
}

/// Spotify ids are base62 and 22 chars, but stay lenient: accept any non-empty
/// run of ASCII alphanumerics up to a sane length.
fn clean_id(raw: &str) -> Option<String> {
    let id = raw
        .split(['?', '#', '&'])
        .next()
        .unwrap_or("")
        .trim();
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(id.to_string())
}

/// Parse any of:
///   * `https://open.spotify.com/track|album|playlist/<id>`
///   * locale-prefixed paths (`/intl-de/track/<id>`, `/intl-es/album/<id>`, …)
///   * `?si=…` / `#fragment` query strings
///   * `spotify:track:<id>` / `spotify:album:<id>` / `spotify:playlist:<id>`
///     (and the legacy `spotify:user:<u>:playlist:<id>` form)
///
/// The scan walks path segments looking for the first `track|album|playlist`
/// marker, which is what makes locale prefixes free — they are simply skipped.
pub fn parse_spotify_url(input: &str) -> Option<SpotifyRef> {
    let raw = input.trim();
    if raw.is_empty() {
        return None;
    }

    if raw.to_ascii_lowercase().starts_with("spotify:") {
        let parts: Vec<&str> = raw.split(':').collect();
        for pair in parts.windows(2) {
            if let Some(kind) = kind_from_segment(pair[0]) {
                if let Some(id) = clean_id(pair[1]) {
                    return Some(SpotifyRef { kind, id });
                }
            }
        }
        return None;
    }

    let no_scheme = raw.split_once("://").map(|(_, rest)| rest).unwrap_or(raw);
    let path_only = no_scheme
        .split(['?', '#'])
        .next()
        .unwrap_or("");
    let mut parts = path_only.split('/');
    let host = parts.next()?.to_ascii_lowercase();
    if !host.contains("spotify.com") {
        return None;
    }
    let segs: Vec<&str> = parts.filter(|s| !s.is_empty()).collect();
    for pair in segs.windows(2) {
        if let Some(kind) = kind_from_segment(pair[0]) {
            if let Some(id) = clean_id(pair[1]) {
                return Some(SpotifyRef { kind, id });
            }
        }
    }
    None
}

fn track_url(id: &str) -> String {
    format!("https://open.spotify.com/track/{}", id)
}

/// Entry titles become the downloaded file's stem, so strip what Windows
/// refuses and collapse the whitespace that leaves behind.
fn clean_title(s: &str) -> String {
    let swapped: String = s
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c if (c as u32) < 0x20 => ' ',
            c => c,
        })
        .collect();
    swapped
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ")
        .trim_end_matches('.')
        .trim()
        .to_string()
}

fn nonempty(v: Option<&str>) -> Option<&str> {
    v.map(str::trim).filter(|s| !s.is_empty())
}

fn build_result(
    title: String,
    uploader: Option<String>,
    thumbnail: Option<String>,
    entries: Vec<ProbeEntry>,
) -> ProbeResult {
    ProbeResult {
        kind: if entries.len() == 1 { "single" } else { "multi" }.to_string(),
        title,
        uploader: Some(uploader.unwrap_or_else(|| "Spotify".to_string())),
        thumbnail,
        entries,
    }
}

// ---------------------------------------------------------------------------
// Spotify Web API (client-credentials)
// ---------------------------------------------------------------------------

/// Minimal base64 — the only thing the token call needs and not worth a crate.
fn base64_encode(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init: {}", e))
}

/// NOTE: nothing derived from `secret` may reach the returned error.
async fn fetch_token(client: &reqwest::Client, id: &str, secret: &str) -> Result<String, String> {
    let basic = base64_encode(format!("{}:{}", id, secret).as_bytes());
    let res = client
        .post(TOKEN_URL)
        .header("Authorization", format!("Basic {}", basic))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body("grant_type=client_credentials")
        .send()
        .await
        .map_err(|_| "Spotify token request failed".to_string())?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!(
            "Spotify token endpoint returned HTTP {}",
            status.as_u16()
        ));
    }
    let body = res
        .text()
        .await
        .map_err(|_| "Spotify token response unreadable".to_string())?;
    let json: Value =
        serde_json::from_str(&body).map_err(|_| "Spotify token response was not JSON".to_string())?;
    json.get("access_token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Spotify token response had no access_token".to_string())
}

async fn get_json(client: &reqwest::Client, url: &str, token: &str) -> Result<Value, String> {
    let res = client
        .get(url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Spotify API request failed: {}", e))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("Spotify API returned HTTP {}", status.as_u16()));
    }
    let body = res
        .text()
        .await
        .map_err(|e| format!("Spotify API read failed: {}", e))?;
    serde_json::from_str(&body).map_err(|e| format!("Spotify API sent invalid JSON: {}", e))
}

/// Spotify orders `images` widest-first.
fn first_image(images: &Value) -> Option<String> {
    images
        .as_array()?
        .iter()
        .find_map(|i| i.get("url").and_then(Value::as_str))
        .map(str::to_string)
}

fn primary_artist(v: &Value) -> Option<String> {
    v.get("artists")?
        .as_array()?
        .iter()
        .find_map(|a| a.get("name").and_then(Value::as_str))
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Build one entry from a track object. Returns None for anything that is not
/// a real, addressable track — playlist items can be `null`, podcast episodes,
/// or local files with no id.
fn entry_from_track(v: &Value, index: u32, fallback_cover: Option<&str>) -> Option<ProbeEntry> {
    if !v.is_object() {
        return None;
    }
    if let Some(t) = v.get("type").and_then(Value::as_str) {
        if !t.eq_ignore_ascii_case("track") {
            return None;
        }
    }
    let id = v.get("id").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    let name = v
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("Unknown track");
    let artist = primary_artist(v).unwrap_or_else(|| "Unknown artist".to_string());
    let duration = v
        .get("duration_ms")
        .and_then(Value::as_f64)
        .filter(|ms| *ms > 0.0)
        .map(|ms| ms / 1000.0);
    // Album *simplified* track objects carry no images of their own — the
    // caller passes the album cover down so every entry still previews.
    let thumbnail = v
        .get("album")
        .map(|a| first_image(&a["images"]))
        .unwrap_or(None)
        .or_else(|| fallback_cover.map(str::to_string));

    let url = track_url(id);
    Some(ProbeEntry {
        index,
        title: clean_title(&format!("{} - {}", artist, name)),
        thumbnail,
        duration,
        kind: "audio".to_string(),
        url: Some(url.clone()),
        webpage_url: Some(url),
    })
}

/// Walk a Spotify paging object, `next` link by `next` link, stopping at
/// MAX_TRACKS. `extract` pulls the track object out of one item (identity for
/// album tracks, `item["track"]` for playlist items).
async fn collect_paged(
    client: &reqwest::Client,
    token: &str,
    first_page: Value,
    fallback_cover: Option<&str>,
    extract: fn(&Value) -> &Value,
) -> Result<Vec<ProbeEntry>, String> {
    let mut entries: Vec<ProbeEntry> = Vec::new();
    let mut page = first_page;
    loop {
        if let Some(items) = page.get("items").and_then(Value::as_array) {
            for item in items {
                if entries.len() >= MAX_TRACKS {
                    break;
                }
                let idx = entries.len() as u32 + 1;
                if let Some(e) = entry_from_track(extract(item), idx, fallback_cover) {
                    entries.push(e);
                }
            }
        }
        let next = page.get("next").and_then(Value::as_str).map(str::to_string);
        if entries.len() >= MAX_TRACKS {
            if next.is_some() {
                eprintln!(
                    "[spotify] track list capped at {} entries; ignoring the rest",
                    MAX_TRACKS
                );
            }
            break;
        }
        match next {
            Some(n) => page = get_json(client, &n, token).await?,
            None => break,
        }
    }
    Ok(entries)
}

async fn probe_via_api(
    reference: &SpotifyRef,
    client_id: &str,
    client_secret: &str,
) -> Result<ProbeResult, String> {
    let client = http_client()?;
    let token = fetch_token(&client, client_id, client_secret).await?;

    match reference.kind {
        SpotifyKind::Track => {
            let t = get_json(&client, &format!("{}/tracks/{}", API, reference.id), &token).await?;
            let entry = entry_from_track(&t, 1, None)
                .ok_or_else(|| "Spotify track response had no usable track".to_string())?;
            let title = t
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Spotify track")
                .to_string();
            let thumb = entry.thumbnail.clone();
            Ok(build_result(title, primary_artist(&t), thumb, vec![entry]))
        }
        SpotifyKind::Album => {
            let album = get_json(
                &client,
                &format!("{}/albums/{}?limit=50", API, reference.id),
                &token,
            )
            .await?;
            let title = album
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Spotify album")
                .to_string();
            let cover = first_image(&album["images"]);
            let uploader = primary_artist(&album);
            let page = album.get("tracks").cloned().unwrap_or(Value::Null);
            let entries =
                collect_paged(&client, &token, page, cover.as_deref(), |v| v).await?;
            Ok(build_result(title, uploader, cover, entries))
        }
        SpotifyKind::Playlist => {
            let pl = get_json(
                &client,
                &format!("{}/playlists/{}", API, reference.id),
                &token,
            )
            .await?;
            let title = pl
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Spotify playlist")
                .to_string();
            let cover = first_image(&pl["images"]);
            let uploader = pl
                .get("owner")
                .and_then(|o| o.get("display_name"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            // The embedded `tracks` page is authoritative for page 1; fall back
            // to an explicit request if the playlist object omitted it.
            let first = match pl.get("tracks").filter(|t| t.get("items").is_some()) {
                Some(t) => t.clone(),
                None => {
                    get_json(
                        &client,
                        &format!("{}/playlists/{}/tracks?limit=100", API, reference.id),
                        &token,
                    )
                    .await?
                }
            };
            let entries = collect_paged(&client, &token, first, cover.as_deref(), |item| {
                item.get("track").unwrap_or(&Value::Null)
            })
            .await?;
            Ok(build_result(title, uploader, cover, entries))
        }
    }
}

// ---------------------------------------------------------------------------
// spotdl metadata fallback
// ---------------------------------------------------------------------------

/// Unique temp dir for one probe call. Job dirs are never reused, so a call
/// can only ever clean up after itself.
fn probe_temp_dir() -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir()
        .join("convertx-spotify-probe")
        .join(format!("{}-{}", std::process::id(), stamp))
}

/// Never let a credential appear in a message we surface or log.
fn redact(text: &str, secrets: &[&str]) -> String {
    let mut out = text.to_string();
    for s in secrets {
        if s.len() >= 6 {
            out = out.replace(s, "***");
        }
    }
    out
}

/// `spotdl save <url> --save-file <file>.spotdl` writes a JSON array of Song
/// objects (name / artist / artists / duration / cover_url / url / list_name).
/// Verified against the bundled spotdl 4.4.3: `save` requires `--save-file`
/// and the file must end in `.spotdl`.
///
/// `--audio youtube` matters: the default `youtube-music` provider does a
/// network handshake while the Downloader is constructed, and a blocked IP
/// makes even a metadata-only run die before it reads Spotify at all.
async fn probe_via_spotdl(
    app: &tauri::AppHandle,
    url: &str,
    reference: Option<&SpotifyRef>,
    client_id: Option<&str>,
    client_secret: Option<&str>,
) -> Result<ProbeResult, String> {
    let spotdl_path = get_spotdl_path(app);
    let dir = probe_temp_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create spotdl probe dir: {}", e))?;
    let save_file = dir.join("probe.spotdl");

    let mut args: Vec<String> = vec![
        "save".to_string(),
        url.to_string(),
        "--save-file".to_string(),
        save_file.to_string_lossy().to_string(),
        "--headless".to_string(),
        "--simple-tui".to_string(),
        "--log-level".to_string(),
        "ERROR".to_string(),
        "--audio".to_string(),
        "youtube".to_string(),
    ];
    if let (Some(id), Some(secret)) = (nonempty(client_id), nonempty(client_secret)) {
        args.push("--client-id".to_string());
        args.push(id.to_string());
        args.push("--client-secret".to_string());
        args.push(secret.to_string());
    }

    let mut cmd = Command::new(&spotdl_path);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::downloader::no_window(&mut cmd);

    let child = cmd.spawn().map_err(|e| {
        let _ = std::fs::remove_dir_all(&dir);
        format!(
            "Failed to start spotdl ({}): {}",
            spotdl_path.display(),
            e
        )
    })?;
    let pid = child.id();

    let finished = tokio::time::timeout(SPOTDL_TIMEOUT, child.wait_with_output()).await;
    let output = match finished {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(format!("spotdl process error: {}", e));
        }
        Err(_) => {
            // kill_on_drop already signalled the parent; taskkill /T also
            // reaps the PyInstaller child it spawned.
            if let Some(p) = pid {
                crate::downloader::kill_pid(p);
            }
            let _ = std::fs::remove_dir_all(&dir);
            return Err(format!(
                "spotdl metadata probe timed out after {}s",
                SPOTDL_TIMEOUT.as_secs()
            ));
        }
    };

    let raw = std::fs::read_to_string(&save_file);
    let _ = std::fs::remove_dir_all(&dir);

    let text = match raw {
        Ok(t) => t,
        Err(_) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let tail: Vec<&str> = stderr
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .rev()
                .take(3)
                .collect();
            let detail = tail
                .into_iter()
                .rev()
                .collect::<Vec<&str>>()
                .join(" · ");
            let detail = if detail.is_empty() {
                format!("exit {}", output.status.code().unwrap_or(-1))
            } else {
                detail
            };
            let secrets: Vec<&str> = [client_id, client_secret]
                .into_iter()
                .flatten()
                .collect();
            return Err(format!(
                "spotdl wrote no metadata: {}",
                redact(&detail, &secrets)
            ));
        }
    };

    let parsed: Value = serde_json::from_str(&text)
        .map_err(|e| format!("spotdl metadata was not JSON: {}", e))?;
    let songs = parsed
        .as_array()
        .ok_or_else(|| "spotdl metadata was not a list".to_string())?;

    let mut entries: Vec<ProbeEntry> = Vec::new();
    for song in songs {
        if entries.len() >= MAX_TRACKS {
            eprintln!(
                "[spotify] spotdl track list capped at {} entries; ignoring the rest",
                MAX_TRACKS
            );
            break;
        }
        let name = song
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("Unknown track");
        let artist = song
            .get("artist")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| {
                song.get("artists")?
                    .as_array()?
                    .iter()
                    .find_map(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "Unknown artist".to_string());
        let duration = song
            .get("duration")
            .and_then(Value::as_f64)
            .filter(|d| *d > 0.0);
        let thumbnail = song
            .get("cover_url")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        // Prefer the per-song Spotify URL so each entry downloads on its own;
        // `song_id` is the fallback when an older spotdl omits `url`.
        let track_page = song
            .get("url")
            .and_then(Value::as_str)
            .filter(|s| s.contains("open.spotify.com/track/"))
            .map(str::to_string)
            .or_else(|| {
                song.get("song_id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(|id| track_url(id))
            });
        let Some(track_page) = track_page else { continue };

        entries.push(ProbeEntry {
            index: entries.len() as u32 + 1,
            title: clean_title(&format!("{} - {}", artist, name)),
            thumbnail,
            duration,
            kind: "audio".to_string(),
            url: Some(track_page.clone()),
            webpage_url: Some(track_page),
        });
    }

    if entries.is_empty() {
        return Err("spotdl metadata contained no tracks".to_string());
    }

    let first = songs.first().cloned().unwrap_or(Value::Null);
    let str_of = |v: &Value, k: &str| {
        v.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let kind = reference.map(|r| r.kind);
    let title = match kind {
        Some(SpotifyKind::Track) => str_of(&first, "name"),
        Some(SpotifyKind::Playlist) => str_of(&first, "list_name"),
        Some(SpotifyKind::Album) => str_of(&first, "album_name"),
        None => str_of(&first, "list_name").or_else(|| str_of(&first, "album_name")),
    }
    .unwrap_or_else(|| {
        if entries.len() == 1 {
            entries[0].title.clone()
        } else {
            "Spotify".to_string()
        }
    });
    let uploader = match kind {
        Some(SpotifyKind::Playlist) => None,
        Some(SpotifyKind::Album) => str_of(&first, "album_artist").or_else(|| str_of(&first, "artist")),
        _ => str_of(&first, "artist"),
    };
    let cover = str_of(&first, "cover_url");

    Ok(build_result(title, uploader, cover, entries))
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Enumerate a Spotify link's real tracks. `None` means every lane declined —
/// the caller keeps its single-entry stub so behaviour never regresses to an
/// error.
pub async fn probe_spotify(
    app: &tauri::AppHandle,
    url: &str,
    client_id: Option<&str>,
    client_secret: Option<&str>,
) -> Option<ProbeResult> {
    let parsed = parse_spotify_url(url);

    if let (Some(reference), Some(id), Some(secret)) =
        (parsed.as_ref(), nonempty(client_id), nonempty(client_secret))
    {
        match probe_via_api(reference, id, secret).await {
            Ok(res) if !res.entries.is_empty() => return Some(res),
            Ok(_) => eprintln!("[spotify] Web API returned no tracks; trying spotdl"),
            Err(e) => eprintln!("[spotify] Web API probe failed ({}); trying spotdl", e),
        }
    }

    match probe_via_spotdl(app, url, parsed.as_ref(), client_id, client_secret).await {
        Ok(res) if !res.entries.is_empty() => Some(res),
        Ok(_) => None,
        Err(e) => {
            eprintln!("[spotify] spotdl metadata probe failed ({})", e);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(u: &str) -> Option<(SpotifyKind, String)> {
        parse_spotify_url(u).map(|r| (r.kind, r.id))
    }

    const ID: &str = "4cOdK2wGLETKBW3PvgPWqT";

    #[test]
    fn plain_urls() {
        assert_eq!(
            p("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"),
            Some((SpotifyKind::Track, ID.to_string()))
        );
        assert_eq!(
            p("https://open.spotify.com/album/4cOdK2wGLETKBW3PvgPWqT"),
            Some((SpotifyKind::Album, ID.to_string()))
        );
        assert_eq!(
            p("https://open.spotify.com/playlist/4cOdK2wGLETKBW3PvgPWqT"),
            Some((SpotifyKind::Playlist, ID.to_string()))
        );
    }

    #[test]
    fn locale_prefixes() {
        assert_eq!(
            p("https://open.spotify.com/intl-de/track/4cOdK2wGLETKBW3PvgPWqT"),
            Some((SpotifyKind::Track, ID.to_string()))
        );
        assert_eq!(
            p("https://open.spotify.com/intl-es/album/4cOdK2wGLETKBW3PvgPWqT?si=abc123"),
            Some((SpotifyKind::Album, ID.to_string()))
        );
    }

    #[test]
    fn query_strings_and_fragments() {
        assert_eq!(
            p("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=9f0a&utm_source=copy"),
            Some((SpotifyKind::Track, ID.to_string()))
        );
        assert_eq!(
            p("https://open.spotify.com/playlist/4cOdK2wGLETKBW3PvgPWqT#play"),
            Some((SpotifyKind::Playlist, ID.to_string()))
        );
        assert_eq!(
            p("  http://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT/  "),
            Some((SpotifyKind::Track, ID.to_string()))
        );
        assert_eq!(
            p("open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"),
            Some((SpotifyKind::Track, ID.to_string()))
        );
    }

    #[test]
    fn uris() {
        assert_eq!(
            p("spotify:track:4cOdK2wGLETKBW3PvgPWqT"),
            Some((SpotifyKind::Track, ID.to_string()))
        );
        assert_eq!(
            p("spotify:album:4cOdK2wGLETKBW3PvgPWqT"),
            Some((SpotifyKind::Album, ID.to_string()))
        );
        assert_eq!(
            p("spotify:playlist:4cOdK2wGLETKBW3PvgPWqT"),
            Some((SpotifyKind::Playlist, ID.to_string()))
        );
        assert_eq!(
            p("spotify:user:someone:playlist:4cOdK2wGLETKBW3PvgPWqT"),
            Some((SpotifyKind::Playlist, ID.to_string()))
        );
    }

    #[test]
    fn rejects_non_spotify_and_junk() {
        assert_eq!(p("https://youtube.com/watch?v=abc"), None);
        assert_eq!(p("https://open.spotify.com/artist/4cOdK2wGLETKBW3PvgPWqT"), None);
        assert_eq!(p("https://open.spotify.com/track/"), None);
        assert_eq!(p(""), None);
        assert_eq!(p("spotify:track:"), None);
        // A look-alike host must not resolve.
        assert_eq!(p("https://evil.com/track/4cOdK2wGLETKBW3PvgPWqT"), None);
    }

    #[test]
    fn titles_are_filename_safe() {
        assert_eq!(clean_title("AC/DC - Back: In Black"), "AC DC - Back In Black");
        assert_eq!(clean_title("  spaced   out  "), "spaced out");
    }

    #[test]
    fn base64_matches_rfc4648() {
        assert_eq!(base64_encode(b"a"), "YQ==");
        assert_eq!(base64_encode(b"ab"), "YWI=");
        assert_eq!(base64_encode(b"abc"), "YWJj");
        assert_eq!(base64_encode(b"id:secret"), "aWQ6c2VjcmV0");
    }

    #[test]
    fn entries_point_at_individual_tracks() {
        let track = serde_json::json!({
            "type": "track",
            "id": "4cOdK2wGLETKBW3PvgPWqT",
            "name": "Never Gonna Give You Up",
            "duration_ms": 213573,
            "artists": [{ "name": "Rick Astley" }],
            "album": { "images": [{ "url": "https://i.scdn.co/image/cover.jpg" }] }
        });
        let e = entry_from_track(&track, 1, None).expect("track should parse");
        assert_eq!(e.index, 1);
        assert_eq!(e.title, "Rick Astley - Never Gonna Give You Up");
        assert_eq!(e.kind, "audio");
        assert_eq!(
            e.webpage_url.as_deref(),
            Some("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT")
        );
        assert_eq!(e.url, e.webpage_url);
        assert!((e.duration.unwrap() - 213.573).abs() < 0.001);
        assert_eq!(e.thumbnail.as_deref(), Some("https://i.scdn.co/image/cover.jpg"));
    }

    #[test]
    fn album_tracks_inherit_the_album_cover_and_skip_junk() {
        let simplified = serde_json::json!({
            "type": "track",
            "id": "1111111111111111111111",
            "name": "Track One",
            "duration_ms": 120000,
            "artists": [{ "name": "Some Artist" }]
        });
        let e = entry_from_track(&simplified, 3, Some("https://cover")).unwrap();
        assert_eq!(e.index, 3);
        assert_eq!(e.thumbnail.as_deref(), Some("https://cover"));

        // Playlist junk: nulls, episodes, and local files must be skipped.
        assert!(entry_from_track(&Value::Null, 1, None).is_none());
        assert!(entry_from_track(
            &serde_json::json!({ "type": "episode", "id": "x", "name": "Ep" }),
            1,
            None
        )
        .is_none());
        assert!(entry_from_track(
            &serde_json::json!({ "type": "track", "id": Value::Null, "name": "Local" }),
            1,
            None
        )
        .is_none());
    }

    #[test]
    fn result_kind_switches_on_entry_count() {
        let one = entry_from_track(
            &serde_json::json!({
                "type": "track", "id": "aaaaaaaaaaaaaaaaaaaaaa", "name": "A",
                "artists": [{ "name": "B" }]
            }),
            1,
            None,
        )
        .unwrap();
        assert_eq!(build_result("t".into(), None, None, vec![one.clone()]).kind, "single");
        assert_eq!(
            build_result("t".into(), None, None, vec![one.clone(), one]).kind,
            "multi"
        );
        assert_eq!(
            build_result("t".into(), None, None, vec![]).uploader.as_deref(),
            Some("Spotify")
        );
    }

    #[test]
    fn secrets_never_survive_redaction() {
        let msg = "spotdl: bad request for client sEcReT-value-123";
        assert_eq!(
            redact(msg, &["sEcReT-value-123"]),
            "spotdl: bad request for client ***"
        );
    }
}

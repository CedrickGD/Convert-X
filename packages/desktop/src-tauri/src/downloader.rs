//! URL downloader.
//!
//! - yt-dlp.exe handles ~1800 video sites (YouTube, X/Twitter, Instagram, TikTok,
//!   Snapchat, Reddit, Vimeo, Facebook, SoundCloud, Twitch, …).
//! - spotdl.exe handles Spotify links by reading metadata from the public Spotify
//!   API, finding the same track on YouTube, downloading via yt-dlp, then tagging
//!   the file. (No DRM bypass; quality is YouTube quality.)
//!
//! Routing is by URL host: open.spotify.com → spotdl, everything else → yt-dlp.
//!
//! Every job downloads into a per-job staging directory under %TEMP% and the
//! finished file(s) are moved into the output dir with a collision suffix —
//! deterministic even when several downloads run in parallel. Cancellation is
//! per-job: PIDs live in a HashMap keyed by file_id, and a cancelled-set lets
//! the pending invoke tell a deliberate kill apart from a crash so cancel is
//! surfaced as a typed `{status:"cancelled"}` result, never as an error.

use crate::ffmpeg::get_ffmpeg_path;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt as _;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Hide the console window when spawning a child on Windows. No-op elsewhere.
pub(crate) fn no_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    { cmd.creation_flags(CREATE_NO_WINDOW); }
    cmd
}

fn no_window_std(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    { cmd.creation_flags(CREATE_NO_WINDOW); }
    cmd
}

pub(crate) fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        let mut tk = std::process::Command::new("taskkill");
        tk.args(["/PID", &pid.to_string(), "/F", "/T"]);
        no_window_std(&mut tk);
        let _ = tk.output();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output();
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct DownloadOptions {
    pub url: String,
    /// "mp4" for video with audio, "mp3" for audio-only, or "image" for picture posts.
    /// Spotify always mp3.
    pub format: String,
    /// "best" | "1080" | "720" | "480"
    pub quality: String,
    pub output_dir: Option<String>,
    /// When set, passed to yt-dlp as --playlist-items (e.g. "1,3,5"). Used to pin
    /// a multi-item post (Instagram carousel, etc.) to a specific entry index.
    pub playlist_items: Option<String>,
    /// Force --no-playlist so a self-contained playlist child downloads via its
    /// own webpage_url without re-extracting the whole playlist.
    pub no_playlist: bool,
    /// Append `-%(id)s` to the output template. Set for batches and carousel
    /// children, whose items routinely share one title.
    pub dedupe_names: bool,
    /// Optional user-supplied Spotify API credentials (overrides spotdl's
    /// shared default app, which routinely hits a 24h global rate limit).
    pub spotify_client_id: Option<String>,
    pub spotify_client_secret: Option<String>,
    /// Optional path to a Netscape-format cookies.txt — unlocks login-gated
    /// content (private Instagram, age-restricted YouTube, etc.).
    pub cookies_path: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct ProbeEntry {
    pub index: u32,
    pub title: String,
    pub thumbnail: Option<String>,
    pub duration: Option<f64>,
    /// "video" | "image" | "audio"
    pub kind: String,
    pub url: Option<String>,
    /// The canonical page URL for this entry (never yt-dlp's signed CDN `url`).
    pub webpage_url: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct ProbeResult {
    /// "single" | "multi"
    pub kind: String,
    pub title: String,
    pub uploader: Option<String>,
    pub thumbnail: Option<String>,
    pub entries: Vec<ProbeEntry>,
}

#[derive(Clone, Serialize)]
pub struct DownloadProgressPayload {
    pub file_id: String,
    pub progress: f64,
    pub elapsed: String,
    /// "fetching" | "downloading" | "merging" | "done"
    pub stage: String,
}

/// Typed download result. `status` is "done" or "cancelled" — a deliberate
/// cancel must never surface as an invoke rejection (no error banner).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadOutcome {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl DownloadOutcome {
    fn cancelled() -> Self {
        Self {
            status: "cancelled".to_string(),
            output_path: None,
            output_size: None,
            title: None,
        }
    }

    fn done(output_path: String, output_size: u64, title: String) -> Self {
        Self {
            status: "done".to_string(),
            output_path: Some(output_path),
            output_size: Some(output_size),
            title: Some(title),
        }
    }
}

fn is_spotify_url(url: &str) -> bool {
    let lower = url.trim().to_lowercase();
    lower.contains("open.spotify.com/") || lower.starts_with("spotify:")
}

fn dev_bin(name: &str) -> Option<PathBuf> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bin")
        .join(name);
    if p.exists() { Some(p) } else { None }
}

fn resource_bin(app: &tauri::AppHandle, name: &str) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    let p = dir.join("bin").join(name);
    if p.exists() { Some(p) } else { None }
}

fn appdata_bin(app: &tauri::AppHandle, name: &str) -> Option<PathBuf> {
    let p = crate::tools::tools_dir(app)?.join(name);
    if p.exists() { Some(p) } else { None }
}

pub fn get_ytdlp_path(app: &tauri::AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        if let Some(p) = dev_bin("yt-dlp.exe") { return p; }
    }
    if let Some(p) = appdata_bin(app, "yt-dlp.exe") { return p; }
    if let Some(p) = resource_bin(app, "yt-dlp.exe") { return p; }
    PathBuf::from("yt-dlp")
}

pub fn get_spotdl_path(app: &tauri::AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        if let Some(p) = dev_bin("spotdl.exe") { return p; }
    }
    if let Some(p) = appdata_bin(app, "spotdl.exe") { return p; }
    if let Some(p) = resource_bin(app, "spotdl.exe") { return p; }
    PathBuf::from("spotdl")
}

const AUDIO_FORMATS: &[&str] = &["mp3", "m4a", "wav", "flac", "ogg", "opus", "aac"];
const VIDEO_FORMATS: &[&str] = &["mp4", "mkv", "webm", "avi", "mov"];

fn is_audio_format(f: &str) -> bool { AUDIO_FORMATS.contains(&f) }
fn is_video_format(f: &str) -> bool { VIDEO_FORMATS.contains(&f) }

/// Build a yt-dlp format selector that prefers pre-merged streams (no ffmpeg
/// merge step required) and falls back to merging only when that fails.
///
/// CRITICAL: every term in the fallback chain must require a video codec
/// (`vcodec!=none` or `bv*`). A bare `best` fallback on modern YouTube can
/// resolve to an audio-only m4a track — a user who picked "Video" must never
/// get an audio-only file. The trailing bare `bv*` terms fire only when NO
/// audio stream exists anywhere (muted Instagram stories, silent tweets):
/// every earlier term already claimed anything with audio, and `bv*` still
/// requires a video codec. For capped chains, `bv*+ba` (any size with audio)
/// outranks audio-less rungs so a too-strict cap can't silently produce a
/// soundless file when the source has audio.
///
/// Desktop keeps its container-aware ext pinning on top: mp4 prefers mp4/m4a
/// streams, webm prefers webm streams, and mkv/mov/avi take anything and let
/// yt-dlp remux.
fn has_cookies(path: &Option<String>) -> bool {
    path.as_deref().is_some_and(|c| !c.trim().is_empty())
}

fn is_youtube_url(url: &str) -> bool {
    let low = url.to_lowercase();
    low.contains("youtube.com") || low.contains("youtu.be")
}

/// yt-dlp's two ways of saying "the extractor returned nothing playable" —
/// what a stale YouTube cookie jar produces.
fn ytdlp_lost_formats(tail: &str) -> bool {
    tail.contains("No video formats found") || tail.contains("Requested format is not available")
}

fn build_video_selector(quality: &str, format: &str) -> String {
    let ext_pair = match format {
        "mp4"  => Some(("mp4", "m4a")),
        "webm" => Some(("webm", "webm")),
        _      => None,
    };
    let height: Option<&str> = match quality {
        "1080" | "720" | "480" => Some(quality),
        _ => None,
    };
    match (height, ext_pair) {
        (None, Some((ve, ae))) => format!(
            "best[ext={ve}][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/\
             bv*[ext={ve}]+ba[ext={ae}]/bv*+ba/bv*[ext={ve}]/bv*"
        ),
        (None, None) => {
            "best[acodec!=none][vcodec!=none]/bv*+ba/bv*".to_string()
        }
        (Some(h), Some((ve, ae))) => format!(
            "best[height<={h}][ext={ve}][acodec!=none][vcodec!=none]/\
             best[height<={h}][acodec!=none][vcodec!=none]/\
             bv*[height<={h}][ext={ve}]+ba[ext={ae}]/bv*[height<={h}]+ba/bv*+ba/\
             best[acodec!=none][vcodec!=none]/bv*[height<={h}]/bv*"
        ),
        (Some(h), None) => format!(
            "best[height<={h}][acodec!=none][vcodec!=none]/\
             bv*[height<={h}]+ba/bv*+ba/best[acodec!=none][vcodec!=none]/bv*[height<={h}]/bv*"
        ),
    }
}

fn build_ytdlp_args(
    opts: &DownloadOptions,
    staging_out: &std::path::Path,
    staging_tmp: &std::path::Path,
    ffmpeg_path: &std::path::Path,
) -> Vec<String> {
    let is_image = opts.format == "image";
    let pin_item = opts.playlist_items.as_deref().filter(|s| !s.trim().is_empty());

    let mut args: Vec<String> = vec![
        opts.url.clone(),
        // ONE -o only: `temp` is not a valid `-o` TYPE (only --paths takes
        // home:/temp:), so a second `-o temp:…` falls through to the default
        // key and clobbers the title template. `--paths temp:` below already
        // keeps .part/fragment files out of the output dir.
        "-o".to_string(),
        // Batch/carousel items can share a title, so the caller asks for the
        // id suffix to keep them apart.
        if opts.dedupe_names {
            "%(title)s-%(id)s.%(ext)s".to_string()
        } else {
            "%(title)s.%(ext)s".to_string()
        },
        "--paths".to_string(),
        format!("home:{}", staging_out.display()),
        "--paths".to_string(),
        format!("temp:{}", staging_tmp.display()),
        "--newline".to_string(),
        "--no-warnings".to_string(),
        "--no-colors".to_string(),
        "--ffmpeg-location".to_string(),
        ffmpeg_path.to_string_lossy().to_string(),
        "--embed-metadata".to_string(),
    ];

    // Optional cookies.txt for login-gated content.
    if let Some(cookies) = opts.cookies_path.as_deref().filter(|s| !s.trim().is_empty()) {
        args.push("--cookies".to_string());
        args.push(cookies.to_string());
    }

    if let Some(items) = pin_item {
        // A pinned carousel/playlist index needs the playlist envelope —
        // no_playlist is ignored in that case.
        args.push("--playlist-items".to_string());
        args.push(items.to_string());
    } else if opts.no_playlist {
        // Explicit request: a self-contained playlist child downloads via its
        // own webpage_url without re-extracting the whole playlist.
        args.push("--no-playlist".to_string());
    } else {
        // Historical default: a plain single-item download should never
        // expand into a whole playlist either.
        args.push("--no-playlist".to_string());
    }

    if is_image {
        args.extend(["-f".to_string(), "best".to_string()]);
    } else if is_audio_format(&opts.format) {
        args.push("--embed-thumbnail".to_string());
        args.extend([
            "-f".to_string(),
            "bestaudio/best".to_string(),
            "-x".to_string(),
            "--audio-format".to_string(),
            opts.format.clone(),
            "--audio-quality".to_string(),
            "0".to_string(),
        ]);
    } else if is_video_format(&opts.format) {
        args.push("--embed-thumbnail".to_string());
        let selector = build_video_selector(&opts.quality, &opts.format);
        args.extend([
            "-f".to_string(),
            selector,
            "--merge-output-format".to_string(),
            opts.format.clone(),
        ]);
    } else {
        // Unknown format — fall back to mp4 with the requested quality.
        args.push("--embed-thumbnail".to_string());
        args.extend([
            "-f".to_string(),
            build_video_selector(&opts.quality, "mp4"),
            "--merge-output-format".to_string(),
            "mp4".to_string(),
        ]);
    }
    args
}

fn parse_ytdlp_progress(line: &str) -> Option<(f64, &'static str)> {
    let trimmed = line.trim_start();
    if trimmed.starts_with("[download]") {
        if let Some(pct_end) = trimmed.find('%') {
            let prefix = &trimmed[..pct_end];
            let num_start = prefix
                .rfind(|c: char| c.is_whitespace())
                .map(|i| i + 1)
                .unwrap_or(0);
            if let Ok(pct) = prefix[num_start..].trim().parse::<f64>() {
                return Some((pct.min(100.0), "downloading"));
            }
        }
    } else if trimmed.starts_with("[Merger]") || trimmed.starts_with("[ExtractAudio]") {
        return Some((99.0, "merging"));
    } else if trimmed.starts_with("[info]")
        || trimmed.starts_with("[youtube]")
        || trimmed.starts_with("[generic]")
        || trimmed.starts_with("[twitter]")
        || trimmed.starts_with("[Instagram]")
        || trimmed.starts_with("[TikTok]")
    {
        return Some((1.0, "fetching"));
    }
    None
}

// spotdl prints lines like "Downloaded \"Artist - Title\": <path>" on success.
fn parse_output_path_spotdl(line: &str) -> Option<String> {
    let t = line.trim();
    // "Downloaded \"...\": C:\\path\\to\\file.mp3"
    if let Some(idx) = t.find("\": ") {
        let candidate = &t[idx + 3..];
        let p = std::path::Path::new(candidate);
        if p.exists() {
            return Some(candidate.to_string());
        }
    }
    None
}

fn parse_spotdl_progress(line: &str) -> Option<(f64, &'static str)> {
    let t = line.trim_start();
    if t.contains("Searching") {
        return Some((5.0, "fetching"));
    }
    if t.contains("Found:") {
        return Some((10.0, "fetching"));
    }
    if t.contains("Downloading") || t.contains("downloading") {
        return Some((50.0, "downloading"));
    }
    if t.contains("Embedding") || t.contains("Tagging") {
        return Some((95.0, "merging"));
    }
    if t.starts_with("Downloaded \"") {
        return Some((100.0, "done"));
    }
    None
}

fn title_from_path(p: &str) -> String {
    std::path::Path::new(p)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("download")
        .to_string()
}

fn dirs_downloads_or_cwd() -> PathBuf {
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let downloads = PathBuf::from(home).join("Downloads");
        if downloads.exists() { return downloads; }
    }
    PathBuf::from(".")
}

fn friendly_error(detail: &str, exit_code: i32) -> String {
    let low = detail.to_lowercase();
    if low.contains("rate/request limit") || (low.contains("rate limit") && low.contains("spotify")) {
        "Spotify's free API quota is used up (shared across all spotdl users). \
         Either wait ~24h, or set your own Spotify Client ID + Secret \
         (free, 5-min signup at developer.spotify.com — paste them in Settings).".to_string()
    } else if low.contains("rate-limit reached") || low.contains("login required") && low.contains("instagram") {
        "Instagram blocked the request — either rate-limited, or the post is \
         private/login-only. Public Reels usually work; private posts need cookies.".to_string()
    } else if low.contains("unavailable") || low.contains("video unavailable") {
        "This video is unavailable (private, removed, or region-locked).".to_string()
    } else if low.contains("sign in") || low.contains("login required") || low.contains("age-restricted") {
        "This content requires sign-in or age verification — not supported without cookies.".to_string()
    } else if low.contains("unsupported url") {
        "This URL isn't supported. Try the desktop site URL instead of mobile/share links.".to_string()
    } else if low.contains("http error 403") {
        "Access denied (403). The site may block automated downloads.".to_string()
    } else if low.contains("http error 404") {
        "URL not found (404). Check the link.".to_string()
    } else if low.contains("unable to extract") {
        "Couldn't extract video info — the site may have changed. Try updating yt-dlp.".to_string()
    } else if low.contains("no spotify") || low.contains("spotipy") {
        "Couldn't reach Spotify metadata. Check your internet connection.".to_string()
    } else {
        format!("Download failed (code {}): {}", exit_code, detail)
    }
}

// ── Per-job staging + deterministic output resolution ───────────────────────

/// Filesystem-safe per-job directory name: file_ids may be prober ids like
/// `https://…#3`, so keep only safe chars and append an FNV-1a hash of the
/// full id for uniqueness.
pub(crate) fn sanitize_job_id(id: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in id.bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let safe: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(40)
        .collect();
    let stem = if safe.is_empty() { "job" } else { safe.as_str() };
    format!("{}-{:016x}", stem, hash)
}

/// Staging roots under %TEMP%, one sub-directory per job. Keep the list and
/// the three constants in sync — sweep_stale_staging only cleans what it knows.
pub(crate) const STAGING_ROOT_YTDLP: &str = "convertx-ytdlp";
pub(crate) const STAGING_ROOT_SPOTDL: &str = "convertx-spotdl";
pub(crate) const STAGING_ROOT_DIRECT: &str = "convertx-direct";
const STAGING_ROOTS: [&str; 3] = [STAGING_ROOT_YTDLP, STAGING_ROOT_SPOTDL, STAGING_ROOT_DIRECT];
/// Only sweep staging dirs untouched for this long — a second app instance
/// may have live jobs staged next to ours.
const STAGING_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// Delete staging directories left behind by a previous run that died before
/// its cleanup (app kill, window close mid-download, power loss). Job ids are
/// never reused, so a run can only ever remove its OWN staging dir — without
/// this sweep the leftovers accumulate in %TEMP% forever. Blocking, best
/// effort: call it off the startup path.
pub fn sweep_stale_staging() {
    for root in STAGING_ROOTS {
        let dir = std::env::temp_dir().join(root);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let stale = entry
                .metadata()
                .and_then(|m| m.modified())
                .map(|t| t.elapsed().map(|age| age > STAGING_MAX_AGE).unwrap_or(false))
                .unwrap_or(false);
            if stale {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}

/// Move `src` into `dest_dir`, appending " (2)", " (3)", … to the stem on
/// collision instead of overwriting. Falls back to copy+delete when the
/// rename crosses volumes (temp and output dir on different drives).
pub(crate) fn move_with_collision(src: &std::path::Path, dest_dir: &std::path::Path) -> Result<PathBuf, String> {
    let file_name = src
        .file_name()
        .ok_or_else(|| "Downloaded file has no name".to_string())?
        .to_string_lossy()
        .to_string();
    let stem = src.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let ext = src.extension().map(|e| e.to_string_lossy().to_string());

    let mut n = 1u32;
    let target = loop {
        let name = if n == 1 {
            file_name.clone()
        } else {
            match &ext {
                Some(e) => format!("{} ({}).{}", stem, n, e),
                None => format!("{} ({})", stem, n),
            }
        };
        let candidate = dest_dir.join(name);
        if !candidate.exists() {
            break candidate;
        }
        n += 1;
    };

    match std::fs::rename(src, &target) {
        Ok(()) => Ok(target),
        Err(_) => {
            std::fs::copy(src, &target)
                .map_err(|e| format!("Failed to move download into output folder: {}", e))?;
            let _ = std::fs::remove_file(src);
            Ok(target)
        }
    }
}

/// Final media files in the staging dir — skips yt-dlp temp artifacts.
fn collect_staging_files(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out; };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
        if name.ends_with(".part")
            || name.ends_with(".ytdl")
            || name.ends_with(".tmp")
            || name.contains(".part-frag")
        {
            continue;
        }
        out.push(path);
    }
    out
}

const VIDEO_EXTS: &[&str] = &["mp4", "mkv", "webm", "avi", "mov"];
const AUDIO_EXTS: &[&str] = &["mp3", "m4a", "wav", "flac", "ogg", "opus", "aac"];
const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "heic"];

fn expected_exts(format: &str) -> &'static [&'static str] {
    if is_audio_format(format) { AUDIO_EXTS }
    else if is_video_format(format) { VIDEO_EXTS }
    else if format == "image" { IMAGE_EXTS }
    else { VIDEO_EXTS }
}

/// Move every staged output into the output dir; returns (all moved, primary).
/// Primary = largest file with an extension the requested format expects,
/// falling back to the largest file overall.
fn move_staging_outputs(
    staging_out: &std::path::Path,
    output_dir: &std::path::Path,
    format: &str,
) -> Result<(Vec<PathBuf>, PathBuf), String> {
    let staged = collect_staging_files(staging_out);
    if staged.is_empty() {
        return Err("Download finished but no output file was produced.".to_string());
    }
    let mut moved: Vec<PathBuf> = Vec::new();
    for src in &staged {
        moved.push(move_with_collision(src, output_dir)?);
    }
    let exts = expected_exts(format);
    let size_of = |p: &PathBuf| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    let primary = moved
        .iter()
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .map(|e| exts.iter().any(|x| x.eq_ignore_ascii_case(e)))
                .unwrap_or(false)
        })
        .max_by_key(|p| size_of(p))
        .or_else(|| moved.iter().max_by_key(|p| size_of(p)))
        .cloned()
        .ok_or_else(|| "Download finished but no output file was produced.".to_string())?;
    Ok((moved, primary))
}

// ── Child process runner with per-job registry ──────────────────────────────

struct ChildRun {
    success: bool,
    code: i32,
    tail: String,
}

async fn run_child<F>(
    app: tauri::AppHandle,
    program: PathBuf,
    args: Vec<String>,
    file_id: String,
    pids: Arc<Mutex<HashMap<String, u32>>>,
    parse_progress: F,
) -> Result<ChildRun, String>
where
    F: Fn(&str) -> Option<(f64, &'static str)> + Send + Sync + 'static,
{
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .stdin(Stdio::null());
    no_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to start {}: {}. Make sure it exists in src-tauri/bin/.",
                program.display(),
                e
            )
        })?;

    if let Some(id) = child.id() {
        pids.lock().unwrap().insert(file_id.clone(), id);
    }

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
    let start_time = std::time::Instant::now();

    let app_for_stdout = app.clone();
    let file_id_for_stdout = file_id.clone();

    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some((progress, stage)) = parse_progress(&line) {
                let elapsed = start_time.elapsed();
                let elapsed_str = format!(
                    "{:02}:{:02}",
                    elapsed.as_secs() / 60,
                    elapsed.as_secs() % 60
                );
                let _ = app_for_stdout.emit(
                    "download-progress",
                    DownloadProgressPayload {
                        file_id: file_id_for_stdout.clone(),
                        progress,
                        elapsed: elapsed_str,
                        stage: stage.to_string(),
                    },
                );
            }
        }
    });

    // Last 3 non-empty stderr lines — enough context to diagnose extractor
    // failures without dumping the full log.
    let mut tail: Vec<String> = Vec::new();
    let mut stderr_lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = stderr_lines.next_line().await {
        crate::ffmpeg::push_tail_line(&mut tail, &line);
    }

    let _ = stdout_task.await;

    let status = child
        .wait()
        .await
        .map_err(|e| format!("process error: {}", e))?;

    pids.lock().unwrap().remove(&file_id);

    Ok(ChildRun {
        success: status.success(),
        code: status.code().unwrap_or(-1),
        tail: tail.join(" · "),
    })
}

pub async fn run_ytdlp(
    app: tauri::AppHandle,
    opts: DownloadOptions,
    file_id: String,
    pids: Arc<Mutex<HashMap<String, u32>>>,
    cancelled: Arc<Mutex<HashSet<String>>>,
) -> Result<DownloadOutcome, String> {
    let ytdlp_path = get_ytdlp_path(&app);
    let ffmpeg_path = get_ffmpeg_path(&app);

    let output_dir: PathBuf = match opts.output_dir.as_deref() {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => dirs_downloads_or_cwd(),
    };
    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Failed to create output directory: {}", e))?;

    // Per-job staging: yt-dlp writes into a directory only this job owns, so
    // resolving "which file did this run produce" is deterministic even with
    // several downloads in flight. Fragments/.part files land in tmp/.
    let staging_root = std::env::temp_dir()
        .join(STAGING_ROOT_YTDLP)
        .join(sanitize_job_id(&file_id));
    let staging_out = staging_root.join("out");
    let staging_tmp = staging_root.join("tmp");
    let _ = std::fs::remove_dir_all(&staging_root);
    std::fs::create_dir_all(&staging_out)
        .map_err(|e| format!("Failed to create staging directory: {}", e))?;
    std::fs::create_dir_all(&staging_tmp)
        .map_err(|e| format!("Failed to create staging directory: {}", e))?;

    let args = build_ytdlp_args(&opts, &staging_out, &staging_tmp, &ffmpeg_path);

    // Last gate before the child exists: from here on cancellation kills the
    // PID, but a cancel that arrived during the staging setup has nothing to
    // kill and must stop the job here.
    if cancelled.lock().unwrap().remove(&file_id) {
        let _ = std::fs::remove_dir_all(&staging_root);
        return Ok(DownloadOutcome::cancelled());
    }

    let run = run_child(
        app.clone(),
        ytdlp_path.clone(),
        args,
        file_id.clone(),
        pids.clone(),
        parse_ytdlp_progress,
    )
    .await;

    let was_cancelled = cancelled.lock().unwrap().remove(&file_id);

    let mut run = match run {
        Ok(r) => r,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging_root);
            if was_cancelled {
                return Ok(DownloadOutcome::cancelled());
            }
            return Err(e);
        }
    };

    // YouTube stops serving playable formats to a cookie jar it considers
    // stale — it hands back storyboards only — which would make EVERY
    // YouTube download fail from the moment the user signs in. Public videos
    // still resolve anonymously, so retry once without the jar rather than
    // failing. Login-gated videos fail either way, and keep their real error.
    if !run.success
        && !was_cancelled
        && has_cookies(&opts.cookies_path)
        && is_youtube_url(&opts.url)
        && ytdlp_lost_formats(&run.tail)
    {
        let mut retry = opts.clone();
        retry.cookies_path = None;
        let retry_args = build_ytdlp_args(&retry, &staging_out, &staging_tmp, &ffmpeg_path);
        if cancelled.lock().unwrap().remove(&file_id) {
            let _ = std::fs::remove_dir_all(&staging_root);
            return Ok(DownloadOutcome::cancelled());
        }
        if let Ok(second) = run_child(
            app,
            ytdlp_path,
            retry_args,
            file_id.clone(),
            pids,
            parse_ytdlp_progress,
        )
        .await
        {
            if second.success {
                run = second;
            }
        }
        if cancelled.lock().unwrap().remove(&file_id) {
            let _ = std::fs::remove_dir_all(&staging_root);
            return Ok(DownloadOutcome::cancelled());
        }
    }

    if !run.success || was_cancelled {
        let _ = std::fs::remove_dir_all(&staging_root);
        if was_cancelled {
            return Ok(DownloadOutcome::cancelled());
        }
        let detail = if run.tail.is_empty() { "(no details)".to_string() } else { run.tail };
        return Err(friendly_error(&detail, run.code));
    }

    let moved = move_staging_outputs(&staging_out, &output_dir, &opts.format);
    let _ = std::fs::remove_dir_all(&staging_root);
    let (_, primary) = moved?;

    let resolved = primary.to_string_lossy().to_string();
    let size = std::fs::metadata(&primary).map(|m| m.len()).unwrap_or(0);

    Ok(DownloadOutcome::done(
        resolved.clone(),
        size,
        title_from_path(&resolved),
    ))
}

pub async fn run_spotdl(
    app: tauri::AppHandle,
    opts: DownloadOptions,
    file_id: String,
    pids: Arc<Mutex<HashMap<String, u32>>>,
    cancelled: Arc<Mutex<HashSet<String>>>,
) -> Result<DownloadOutcome, String> {
    let spotdl_path = get_spotdl_path(&app);
    let ffmpeg_path = get_ffmpeg_path(&app);
    let ytdlp_path = get_ytdlp_path(&app);

    let output_dir: PathBuf = match opts.output_dir.as_deref() {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => dirs_downloads_or_cwd(),
    };
    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Failed to create output directory: {}", e))?;

    // Same per-job staging treatment as yt-dlp: spotdl writes into a dir only
    // this job owns, then the finished mp3 moves to the output dir.
    let staging_root = std::env::temp_dir()
        .join(STAGING_ROOT_SPOTDL)
        .join(sanitize_job_id(&file_id));
    let _ = std::fs::remove_dir_all(&staging_root);
    std::fs::create_dir_all(&staging_root)
        .map_err(|e| format!("Failed to create staging directory: {}", e))?;

    // spotdl 4.x: `download <url> --output "<dir>/{title}" --format mp3 --ffmpeg <ffmpeg> --headless`
    // {title} placeholder produces a sane filename. --headless skips terminal UI.
    let template = staging_root
        .join("{artists} - {title}.{output-ext}")
        .to_string_lossy()
        .to_string();

    let mut args: Vec<String> = vec![
        "download".to_string(),
        opts.url.clone(),
        "--output".to_string(),
        template.clone(),
        "--format".to_string(),
        "mp3".to_string(),
        "--ffmpeg".to_string(),
        ffmpeg_path.to_string_lossy().to_string(),
        "--yt-dlp-args".to_string(),
        format!("--ffmpeg-location \"{}\"", ffmpeg_path.to_string_lossy()),
        "--headless".to_string(),
        "--simple-tui".to_string(),
        "--bitrate".to_string(),
        "auto".to_string(),
    ];

    // User-supplied Spotify Web API credentials override spotdl's shared
    // default app (which is rate-limited globally for everyone).
    if let (Some(id), Some(secret)) = (
        opts.spotify_client_id.as_deref().filter(|s| !s.trim().is_empty()),
        opts.spotify_client_secret.as_deref().filter(|s| !s.trim().is_empty()),
    ) {
        args.push("--client-id".to_string());
        args.push(id.to_string());
        args.push("--client-secret".to_string());
        args.push(secret.to_string());
    }

    // Make sure spotdl can find yt-dlp (it spawns yt-dlp itself).
    // If our bundled yt-dlp lives in src-tauri/bin/ but isn't on PATH, prepend it.
    let env_path = std::env::var("PATH").unwrap_or_default();
    let bin_dir = ytdlp_path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    // Last gate before the child exists — see run_ytdlp.
    if cancelled.lock().unwrap().remove(&file_id) {
        let _ = std::fs::remove_dir_all(&staging_root);
        return Ok(DownloadOutcome::cancelled());
    }

    let mut cmd = Command::new(&spotdl_path);
    cmd.args(&args)
        .env("PATH", format!("{};{}", bin_dir, env_path))
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .stdin(Stdio::null());
    no_window(&mut cmd);
    let spawn_res = cmd.spawn();
    let mut child = match spawn_res {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging_root);
            return Err(format!(
                "Failed to start spotdl ({}): {}. Make sure spotdl.exe is in src-tauri/bin/.",
                spotdl_path.display(),
                e
            ));
        }
    };

    if let Some(id) = child.id() {
        pids.lock().unwrap().insert(file_id.clone(), id);
    }

    let stdout = child.stdout.take().ok_or("Failed to capture spotdl stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture spotdl stderr")?;
    let start_time = std::time::Instant::now();

    let app_for_stdout = app.clone();
    let file_id_for_stdout = file_id.clone();

    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut captured_path: Option<String> = None;
        let mut rate_limited = false;
        while let Ok(Some(line)) = lines.next_line().await {
            if line.to_lowercase().contains("rate/request limit") {
                rate_limited = true;
            }
            if let Some(p) = parse_output_path_spotdl(&line) {
                captured_path = Some(p);
            }
            if let Some((progress, stage)) = parse_spotdl_progress(&line) {
                let elapsed = start_time.elapsed();
                let elapsed_str = format!(
                    "{:02}:{:02}",
                    elapsed.as_secs() / 60,
                    elapsed.as_secs() % 60
                );
                let _ = app_for_stdout.emit(
                    "download-progress",
                    DownloadProgressPayload {
                        file_id: file_id_for_stdout.clone(),
                        progress,
                        elapsed: elapsed_str,
                        stage: stage.to_string(),
                    },
                );
            }
        }
        (captured_path, rate_limited)
    });

    let mut tail: Vec<String> = Vec::new();
    let mut stderr_rate_limited = false;
    let mut stderr_lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = stderr_lines.next_line().await {
        if line.to_lowercase().contains("rate/request limit") {
            stderr_rate_limited = true;
        }
        crate::ffmpeg::push_tail_line(&mut tail, &line);
    }

    let (captured, stdout_rate_limited) = stdout_task.await.unwrap_or((None, false));
    let status = child
        .wait()
        .await
        .map_err(|e| format!("spotdl process error: {}", e))?;

    pids.lock().unwrap().remove(&file_id);
    let was_cancelled = cancelled.lock().unwrap().remove(&file_id);

    if was_cancelled {
        let _ = std::fs::remove_dir_all(&staging_root);
        return Ok(DownloadOutcome::cancelled());
    }

    // spotdl exits 0 on rate-limit even though no file was downloaded — treat
    // this as a clear error so the UI surfaces a helpful message.
    if stdout_rate_limited || stderr_rate_limited {
        let _ = std::fs::remove_dir_all(&staging_root);
        return Err(friendly_error("rate/request limit spotify", -1));
    }

    if !status.success() {
        let _ = std::fs::remove_dir_all(&staging_root);
        let tail_str = tail.join(" · ");
        let detail = if tail_str.is_empty() { "spotdl failed".to_string() } else { tail_str };
        return Err(friendly_error(&detail, status.code().unwrap_or(-1)));
    }

    // Deterministic: the staging dir belongs to this job alone. If spotdl
    // reported a path outside staging (older layouts), fall back to it.
    let moved = move_staging_outputs(&staging_root, &output_dir, "mp3");
    let _ = std::fs::remove_dir_all(&staging_root);
    let output_path = match moved {
        Ok((_, primary)) => primary.to_string_lossy().to_string(),
        Err(e) => match captured {
            Some(p) if std::path::Path::new(&p).exists() => p,
            // spotdl exits 0 when it can't match a track to a source and just
            // skips it, so "no output file" is usually a lookup failure, not a
            // crash. Its own last lines say which — surfacing them beats a bare
            // "no output file was produced" the user can do nothing with.
            _ => {
                let tail_str = tail.join(" · ");
                return Err(if tail_str.is_empty() {
                    format!("{} spotdl found no source for this track.", e)
                } else {
                    format!("{} spotdl said: {}", e, tail_str)
                });
            }
        },
    };

    let size = std::fs::metadata(&output_path).map(|m| m.len()).unwrap_or(0);

    Ok(DownloadOutcome::done(
        output_path.clone(),
        size,
        title_from_path(&output_path),
    ))
}

#[tauri::command]
pub async fn download_from_url(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::convert::AppState>,
    file_id: String,
    url: String,
    format: String,
    quality: String,
    output_dir: Option<String>,
    playlist_items: Option<String>,
    no_playlist: Option<bool>,
    dedupe_names: Option<bool>,
    spotify_client_id: Option<String>,
    spotify_client_secret: Option<String>,
    cookies_path: Option<String>,
) -> Result<DownloadOutcome, String> {
    let opts = DownloadOptions {
        url: url.clone(),
        format,
        quality,
        output_dir,
        playlist_items,
        no_playlist: no_playlist.unwrap_or(false),
        dedupe_names: dedupe_names.unwrap_or(false),
        spotify_client_id,
        spotify_client_secret,
        cookies_path,
    };
    let pids = state.downloads.clone();
    let cancelled = state.cancelled_downloads.clone();
    let active_jobs = state.active_jobs.clone();

    // Register BEFORE the first await: a PID only lands in `downloads` after
    // the child spawns, so a cancel-all arriving in between would otherwise
    // find the job in neither set and let it run to completion — a finished
    // file plus a history entry after the user hit Cancel.
    active_jobs.lock().unwrap().insert(file_id.clone());
    let res = if is_spotify_url(&url) {
        run_spotdl(app, opts, file_id.clone(), pids, cancelled.clone()).await
    } else {
        run_ytdlp(app, opts, file_id.clone(), pids, cancelled.clone()).await
    };
    active_jobs.lock().unwrap().remove(&file_id);
    // A cancel that lands after the run already drained the flag would
    // otherwise leave a stale id behind and cancel the next job with the
    // same id.
    cancelled.lock().unwrap().remove(&file_id);
    res
}

/// Probe a URL with yt-dlp's --dump-single-json so the UI can show a preview
/// (title, thumbnail, multi-item carousels, etc.) before committing to a download.
#[tauri::command]
pub async fn probe_url(
    app: tauri::AppHandle,
    url: String,
    cookies_path: Option<String>,
    spotify_client_id: Option<String>,
    spotify_client_secret: Option<String>,
) -> Result<ProbeResult, String> {
    let trimmed = url.trim().to_string();
    if trimmed.is_empty() {
        return Err("URL is empty".to_string());
    }

    if is_spotify_url(&trimmed) {
        // Real enumeration: Web API when credentials exist, else spotdl
        // metadata. Both may decline — the stub below is the last resort so a
        // Spotify link never previews as an error.
        if let Some(res) = crate::spotify::probe_spotify(
            &app,
            &trimmed,
            spotify_client_id.as_deref(),
            spotify_client_secret.as_deref(),
        )
        .await
        {
            return Ok(res);
        }
        return Ok(ProbeResult {
            kind: "single".to_string(),
            title: "Spotify track".to_string(),
            uploader: Some("Spotify".to_string()),
            thumbnail: None,
            entries: vec![ProbeEntry {
                index: 1,
                title: "Spotify track".to_string(),
                thumbnail: None,
                duration: None,
                kind: "audio".to_string(),
                url: Some(trimmed.clone()),
                webpage_url: Some(trimmed.clone()),
            }],
        });
    }

    let ytdlp_path = get_ytdlp_path(&app);
    // Don't pass --flat-playlist: it strips per-entry metadata (titles,
    // thumbnails, kind classification) so multi-item posts came back as
    // 1 stub entry with a black preview box. Probing each entry adds a few
    // seconds for large playlists but produces a real preview.
    let mut args: Vec<String> = vec![
        "--dump-single-json".to_string(),
        "--no-warnings".to_string(),
        "--skip-download".to_string(),
        "--socket-timeout".to_string(),
        "15".to_string(),
        // Cap how many playlist entries we probe so a giant YouTube channel
        // URL doesn't take 10 minutes. 50 is enough for any Instagram post.
        "--playlist-end".to_string(),
        "50".to_string(),
    ];
    if let Some(c) = cookies_path.as_deref().filter(|s| !s.trim().is_empty()) {
        args.push("--cookies".to_string());
        args.push(c.to_string());
    }
    args.push(trimmed.clone());

    let mut cmd = Command::new(&ytdlp_path);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut cmd);
    let output = cmd
        .output()
        .await
        .map_err(|e| {
            format!(
                "Failed to start yt-dlp ({}): {}. Make sure it exists in src-tauri/bin/.",
                ytdlp_path.display(),
                e
            )
        })?;

    if !output.status.success() {
        // Last 3 non-empty stderr lines joined " · " — same tail format the
        // download path and Android use.
        let stderr = String::from_utf8_lossy(&output.stderr);
        let lines: Vec<&str> = stderr
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        let tail = lines
            .iter()
            .rev()
            .take(3)
            .rev()
            .cloned()
            .collect::<Vec<&str>>()
            .join(" · ");
        let detail = if tail.is_empty() { "(no details)".to_string() } else { tail };

        // Same stale-cookie-jar rescue as the download path: a signed-in
        // YouTube probe can come back with nothing playable, which would make
        // the URL un-previewable until the user logs out.
        if has_cookies(&cookies_path) && is_youtube_url(&trimmed) && ytdlp_lost_formats(&stderr) {
            let mut retry: Vec<String> = args
                .iter()
                .filter(|a| a.as_str() != "--cookies")
                .filter(|a| Some(a.as_str()) != cookies_path.as_deref())
                .cloned()
                .collect();
            retry.dedup();
            let mut cmd2 = Command::new(&ytdlp_path);
            cmd2.args(&retry)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            no_window(&mut cmd2);
            if let Ok(out2) = cmd2.output().await {
                if out2.status.success() {
                    let s2 = String::from_utf8_lossy(&out2.stdout).to_string();
                    if let Ok(j2) = serde_json::from_str::<serde_json::Value>(&s2) {
                        return Ok(parse_probe_json(&j2));
                    }
                }
            }
        }

        return Err(friendly_error(&detail, output.status.code().unwrap_or(-1)));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let json: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("Couldn't parse yt-dlp metadata: {}", e))?;

    Ok(parse_probe_json(&json))
}

fn json_str(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|s| s.as_str()).map(|s| s.to_string())
}

fn json_f64(v: &serde_json::Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|n| n.as_f64())
}

fn pick_thumbnail(v: &serde_json::Value) -> Option<String> {
    if let Some(s) = json_str(v, "thumbnail") {
        return Some(s);
    }
    // yt-dlp also exposes a "thumbnails" array with multiple sizes; grab the last
    // (typically the largest).
    if let Some(arr) = v.get("thumbnails").and_then(|t| t.as_array()) {
        for item in arr.iter().rev() {
            if let Some(u) = item.get("url").and_then(|s| s.as_str()) {
                return Some(u.to_string());
            }
        }
    }
    None
}

fn classify_entry(v: &serde_json::Value) -> String {
    let vcodec = json_str(v, "vcodec").unwrap_or_default();
    let acodec = json_str(v, "acodec").unwrap_or_default();
    let ext = json_str(v, "ext").unwrap_or_default().to_lowercase();
    let duration = json_f64(v, "duration").unwrap_or(0.0);

    // Audio-only stream: video codec is "none" and audio codec is set.
    if vcodec.eq_ignore_ascii_case("none") && !acodec.is_empty() && !acodec.eq_ignore_ascii_case("none") {
        return "audio".to_string();
    }

    // yt-dlp may flag images via _type or by ext. Pragmatic check: no duration AND
    // an image-like extension.
    let image_exts = ["jpg", "jpeg", "png", "webp", "gif", "heic"];
    if image_exts.iter().any(|e| *e == ext.as_str()) && duration <= 0.0 {
        return "image".to_string();
    }

    // Some Instagram image entries have _type == "url" with no media info; if there's
    // no duration and no video codec to speak of, treat as image.
    if duration <= 0.0 && (vcodec.is_empty() || vcodec.eq_ignore_ascii_case("none")) && acodec.is_empty() {
        if image_exts.iter().any(|e| *e == ext.as_str()) {
            return "image".to_string();
        }
    }

    "video".to_string()
}

fn entry_title(v: &serde_json::Value, index: u32) -> String {
    json_str(v, "title")
        .or_else(|| json_str(v, "id"))
        .unwrap_or_else(|| format!("Item {}", index))
}

fn parse_probe_json(json: &serde_json::Value) -> ProbeResult {
    let top_type = json_str(json, "_type").unwrap_or_default();
    let is_playlist = top_type.eq_ignore_ascii_case("playlist")
        || top_type.eq_ignore_ascii_case("multi_video")
        || json.get("entries").map(|e| e.is_array()).unwrap_or(false);

    let title = json_str(json, "title").unwrap_or_else(|| "Untitled".to_string());
    let uploader = json_str(json, "uploader")
        .or_else(|| json_str(json, "channel"))
        .or_else(|| json_str(json, "uploader_id"));
    let thumbnail = pick_thumbnail(json);

    if is_playlist {
        let mut entries: Vec<ProbeEntry> = Vec::new();
        if let Some(arr) = json.get("entries").and_then(|e| e.as_array()) {
            for (i, e) in arr.iter().enumerate() {
                let index = (i as u32) + 1;
                entries.push(ProbeEntry {
                    index,
                    title: entry_title(e, index),
                    thumbnail: pick_thumbnail(e),
                    duration: json_f64(e, "duration"),
                    kind: classify_entry(e),
                    url: json_str(e, "url").or_else(|| json_str(e, "webpage_url")),
                    // NEVER fall back to `url` here — for pre-merged formats
                    // it's a signed, expiring CDN media URL, not a page.
                    webpage_url: json_str(e, "webpage_url"),
                });
            }
        }

        // Edge case: top-level claims playlist but entries array is missing/empty —
        // fall back to single representation.
        if entries.is_empty() {
            return single_from_top(json, title, uploader, thumbnail);
        }

        // If the "playlist" actually has just one entry, present it as single. This
        // is common for Instagram single-image posts that yt-dlp wraps in a
        // playlist envelope.
        if entries.len() == 1 {
            return ProbeResult {
                kind: "single".to_string(),
                title,
                uploader,
                thumbnail,
                entries,
            };
        }

        return ProbeResult {
            kind: "multi".to_string(),
            title,
            uploader,
            thumbnail,
            entries,
        };
    }

    single_from_top(json, title, uploader, thumbnail)
}

fn single_from_top(
    json: &serde_json::Value,
    title: String,
    uploader: Option<String>,
    thumbnail: Option<String>,
) -> ProbeResult {
    let entry = ProbeEntry {
        index: 1,
        title: title.clone(),
        thumbnail: thumbnail.clone(),
        duration: json_f64(json, "duration"),
        kind: classify_entry(json),
        url: json_str(json, "webpage_url").or_else(|| json_str(json, "url")),
        webpage_url: json_str(json, "webpage_url").or_else(|| json_str(json, "original_url")),
    };
    ProbeResult {
        kind: "single".to_string(),
        title,
        uploader,
        thumbnail,
        entries: vec![entry],
    }
}

/// Cancel one download by file_id, or ALL active downloads when file_id is
/// omitted. Marks the cancelled-set first so the pending invoke resolves as
/// `{status:"cancelled"}` instead of an error, then kills the child (direct-CDN
/// transfers have no PID — their streaming loop watches the cancelled-set).
#[tauri::command]
pub fn cancel_download(
    state: tauri::State<'_, crate::convert::AppState>,
    file_id: Option<String>,
) -> Result<(), String> {
    match file_id {
        Some(id) => {
            state.cancelled_downloads.lock().unwrap().insert(id.clone());
            let pid = state.downloads.lock().unwrap().remove(&id);
            if let Some(pid) = pid {
                kill_pid(pid);
            }
        }
        None => {
            // active_jobs covers every accepted job that has no PID yet —
            // direct-CDN transfers and jobs still between the invoke and the
            // child spawn.
            let pidless: Vec<String> = state
                .active_jobs
                .lock()
                .unwrap()
                .iter()
                .cloned()
                .collect();
            let pids: Vec<(String, u32)> = state.downloads.lock().unwrap().drain().collect();
            {
                let mut c = state.cancelled_downloads.lock().unwrap();
                for id in pidless {
                    c.insert(id);
                }
                for (id, _) in &pids {
                    c.insert(id.clone());
                }
            }
            for (_, pid) in pids {
                kill_pid(pid);
            }
        }
    }
    Ok(())
}

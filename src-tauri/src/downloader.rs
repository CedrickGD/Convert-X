//! URL downloader.
//!
//! - yt-dlp.exe handles ~1800 video sites (YouTube, X/Twitter, Instagram, TikTok,
//!   Snapchat, Reddit, Vimeo, Facebook, SoundCloud, Twitch, …).
//! - spotdl.exe handles Spotify links by reading metadata from the public Spotify
//!   API, finding the same track on YouTube, downloading via yt-dlp, then tagging
//!   the file. (No DRM bypass; quality is YouTube quality.)
//!
//! Routing is by URL host: open.spotify.com → spotdl, everything else → yt-dlp.

use crate::ffmpeg::get_ffmpeg_path;
use serde::{Deserialize, Serialize};
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
fn no_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    { cmd.creation_flags(CREATE_NO_WINDOW); }
    cmd
}

fn no_window_std(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    { cmd.creation_flags(CREATE_NO_WINDOW); }
    cmd
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

#[derive(Clone, Serialize)]
pub struct DownloadResult {
    pub output_path: String,
    pub output_size: u64,
    pub title: String,
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

pub fn get_ytdlp_path(app: &tauri::AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        if let Some(p) = dev_bin("yt-dlp.exe") { return p; }
    }
    if let Some(p) = resource_bin(app, "yt-dlp.exe") { return p; }
    PathBuf::from("yt-dlp")
}

pub fn get_spotdl_path(app: &tauri::AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        if let Some(p) = dev_bin("spotdl.exe") { return p; }
    }
    if let Some(p) = resource_bin(app, "spotdl.exe") { return p; }
    PathBuf::from("spotdl")
}

const AUDIO_FORMATS: &[&str] = &["mp3", "m4a", "wav", "flac", "ogg", "opus", "aac"];
const VIDEO_FORMATS: &[&str] = &["mp4", "mkv", "webm", "avi", "mov"];

fn is_audio_format(f: &str) -> bool { AUDIO_FORMATS.contains(&f) }
fn is_video_format(f: &str) -> bool { VIDEO_FORMATS.contains(&f) }

fn build_video_selector(quality: &str, format: &str) -> String {
    let height = match quality {
        "1080" => "[height<=1080]",
        "720"  => "[height<=720]",
        "480"  => "[height<=480]",
        _ => "",
    };
    // Constrain stream ext only when the container natively supports a common
    // codec choice. For mkv/mov/avi we let yt-dlp grab the best and remux.
    let ext_filter = match format {
        "mp4"  => Some(("[ext=mp4]", "[ext=m4a]")),
        "webm" => Some(("[ext=webm]", "[ext=webm]")),
        _      => None,
    };
    match ext_filter {
        Some((v, a)) => format!(
            "bestvideo{v}{h}+bestaudio{a}/bestvideo{h}+bestaudio/best{h}",
            v = v, a = a, h = height
        ),
        None => format!(
            "bestvideo{h}+bestaudio/best{h}",
            h = height
        ),
    }
}

fn build_ytdlp_args(
    opts: &DownloadOptions,
    output_dir: &std::path::Path,
    temp_dir: &std::path::Path,
    ffmpeg_path: &std::path::Path,
) -> Vec<String> {
    let is_image = opts.format == "image";
    let pin_item = opts.playlist_items.as_deref().filter(|s| !s.trim().is_empty());

    let mut args: Vec<String> = vec![
        opts.url.clone(),
        "-o".to_string(),
        "%(title)s.%(ext)s".to_string(),
        "-o".to_string(),
        "temp:%(id)s.%(ext)s".to_string(),
        "--paths".to_string(),
        format!("home:{}", output_dir.display()),
        "--paths".to_string(),
        format!("temp:{}", temp_dir.display()),
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
        args.push("--playlist-items".to_string());
        args.push(items.to_string());
    } else {
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

fn parse_output_path_ytdlp(line: &str) -> Option<String> {
    let t = line.trim_start();
    if let Some(rest) = t.strip_prefix("[download] Destination: ") {
        return Some(rest.trim().to_string());
    }
    if let Some(rest) = t.strip_prefix("[ExtractAudio] Destination: ") {
        return Some(rest.trim().to_string());
    }
    if let Some(rest) = t.strip_prefix("[Merger] Merging formats into ") {
        let unquoted = rest.trim().trim_matches('"').trim_matches('\'');
        return Some(unquoted.to_string());
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

fn resolve_final_path(reported: &str, format: &str) -> String {
    use std::path::Path;
    let p = Path::new(reported);
    if p.exists() { return reported.to_string(); }
    let stem = p.file_stem().unwrap_or_default().to_string_lossy();
    let dir = p.parent().unwrap_or(Path::new("."));
    let candidates: Vec<&str> = if is_audio_format(format) {
        vec![format]
    } else if is_video_format(format) {
        // Look for the requested ext first, then common siblings if yt-dlp
        // failed to merge into the chosen container.
        match format {
            "mp4"  => vec!["mp4", "mkv", "webm"],
            "mkv"  => vec!["mkv", "mp4", "webm"],
            "webm" => vec!["webm", "mp4", "mkv"],
            "avi"  => vec!["avi", "mp4", "mkv"],
            "mov"  => vec!["mov", "mp4", "mkv"],
            _      => vec!["mp4", "mkv", "webm"],
        }
    } else if format == "image" {
        vec!["jpg", "jpeg", "png", "webp", "gif", "heic"]
    } else {
        vec!["mp4", "mkv", "webm"]
    };
    for ext in candidates {
        let candidate = dir.join(format!("{}.{}", stem, ext));
        if candidate.exists() {
            return candidate.to_string_lossy().to_string();
        }
    }
    reported.to_string()
}

fn friendly_error(detail: &str, exit_code: i32) -> String {
    let low = detail.to_lowercase();
    if low.contains("rate/request limit") || low.contains("rate limit") && low.contains("spotify") {
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

async fn run_child<F, G>(
    app: tauri::AppHandle,
    program: PathBuf,
    args: Vec<String>,
    file_id: String,
    process_holder: Arc<Mutex<Option<u32>>>,
    parse_progress: F,
    parse_output: G,
) -> Result<(Option<String>, String), String>
where
    F: Fn(&str) -> Option<(f64, &'static str)> + Send + Sync + 'static,
    G: Fn(&str) -> Option<String> + Send + Sync + 'static,
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
        *process_holder.lock().unwrap() = Some(id);
    }

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
    let start_time = std::time::Instant::now();

    let app_for_stdout = app.clone();
    let file_id_for_stdout = file_id.clone();

    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut captured_path: Option<String> = None;
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(p) = parse_output(&line) {
                captured_path = Some(p);
            }
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
        captured_path
    });

    let mut last_error = String::new();
    let mut stderr_lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = stderr_lines.next_line().await {
        let trimmed = line.trim().to_string();
        if !trimmed.is_empty() {
            last_error = trimmed;
        }
    }

    let captured = stdout_task.await.ok().flatten();

    let status = child
        .wait()
        .await
        .map_err(|e| format!("process error: {}", e))?;

    *process_holder.lock().unwrap() = None;

    if !status.success() {
        let detail = if last_error.is_empty() { "(no details)".to_string() } else { last_error };
        return Err(friendly_error(&detail, status.code().unwrap_or(-1)));
    }

    Ok((captured, last_error))
}

pub async fn run_ytdlp(
    app: tauri::AppHandle,
    opts: DownloadOptions,
    file_id: String,
    process_holder: Arc<Mutex<Option<u32>>>,
) -> Result<DownloadResult, String> {
    let ytdlp_path = get_ytdlp_path(&app);
    let ffmpeg_path = get_ffmpeg_path(&app);

    let output_dir: PathBuf = match opts.output_dir.as_deref() {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => dirs_downloads_or_cwd(),
    };
    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Failed to create output directory: {}", e))?;

    // Stash fragments / .part files in the OS temp dir so the user's Downloads
    // folder doesn't show "<title>.mp4.part-Frag72.part" mid-download.
    let temp_dir = std::env::temp_dir().join("convertx-ytdlp");
    let _ = std::fs::create_dir_all(&temp_dir);

    let args = build_ytdlp_args(&opts, &output_dir, &temp_dir, &ffmpeg_path);

    // Take the timestamp before launching so we can find files that yt-dlp
    // wrote during this run by mtime — more reliable than parsing stdout
    // (which varies wildly per extractor).
    let started_at = std::time::SystemTime::now();

    let (captured, _) = run_child(
        app,
        ytdlp_path,
        args,
        file_id,
        process_holder,
        parse_ytdlp_progress,
        parse_output_path_ytdlp,
    ).await?;

    // Trust the filesystem first: the freshest matching file in output_dir is
    // the one yt-dlp just wrote. Falls back to the captured stdout path
    // (resolved against likely extensions) if no fresh file is found —
    // shouldn't happen on success, but covers obscure extractors.
    let on_disk = newest_file_since(&output_dir, expected_exts(&opts.format), started_at);
    let resolved = on_disk.unwrap_or_else(|| {
        captured
            .map(|p| resolve_final_path(&p, &opts.format))
            .unwrap_or_default()
    });

    if resolved.is_empty() || !std::path::Path::new(&resolved).exists() {
        return Err(format!(
            "Download finished but the file couldn't be located in {}. \
             yt-dlp may have used a different output naming scheme for this site.",
            output_dir.display()
        ));
    }

    let size = std::fs::metadata(&resolved).map(|m| m.len()).unwrap_or(0);

    Ok(DownloadResult {
        output_path: resolved.clone(),
        output_size: size,
        title: title_from_path(&resolved),
    })
}

pub async fn run_spotdl(
    app: tauri::AppHandle,
    opts: DownloadOptions,
    file_id: String,
    process_holder: Arc<Mutex<Option<u32>>>,
) -> Result<DownloadResult, String> {
    let spotdl_path = get_spotdl_path(&app);
    let ffmpeg_path = get_ffmpeg_path(&app);
    let ytdlp_path = get_ytdlp_path(&app);

    let output_dir: PathBuf = match opts.output_dir.as_deref() {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => dirs_downloads_or_cwd(),
    };
    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Failed to create output directory: {}", e))?;

    // spotdl 4.x: `download <url> --output "<dir>/{title}" --format mp3 --ffmpeg <ffmpeg> --headless`
    // {title} placeholder produces a sane filename. --headless skips terminal UI.
    let template = output_dir
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

    let mut cmd = Command::new(&spotdl_path);
    cmd.args(&args)
        .env("PATH", format!("{};{}", bin_dir, env_path))
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .stdin(Stdio::null());
    no_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to start spotdl ({}): {}. Make sure spotdl.exe is in src-tauri/bin/.",
                spotdl_path.display(),
                e
            )
        })?;

    if let Some(id) = child.id() {
        *process_holder.lock().unwrap() = Some(id);
    }

    let stdout = child.stdout.take().ok_or("Failed to capture spotdl stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture spotdl stderr")?;
    let start_time = std::time::Instant::now();
    let started_at = std::time::SystemTime::now();

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

    let mut last_error = String::new();
    let mut stderr_rate_limited = false;
    let mut stderr_lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = stderr_lines.next_line().await {
        let trimmed = line.trim().to_string();
        if trimmed.to_lowercase().contains("rate/request limit") {
            stderr_rate_limited = true;
        }
        if !trimmed.is_empty() {
            last_error = trimmed;
        }
    }

    let (captured, stdout_rate_limited) = stdout_task.await.unwrap_or((None, false));
    let status = child
        .wait()
        .await
        .map_err(|e| format!("spotdl process error: {}", e))?;

    *process_holder.lock().unwrap() = None;

    // spotdl exits 0 on rate-limit even though no file was downloaded — treat
    // this as a clear error so the UI surfaces a helpful message.
    if stdout_rate_limited || stderr_rate_limited {
        return Err(friendly_error("rate/request limit spotify", -1));
    }

    if !status.success() {
        let detail = if last_error.is_empty() { "spotdl failed".to_string() } else { last_error };
        return Err(friendly_error(&detail, status.code().unwrap_or(-1)));
    }

    // Trust the filesystem: newest mp3 in output_dir written during this run.
    let on_disk = newest_file_since(&output_dir, &["mp3"], started_at);
    let output_path = on_disk
        .or(captured)
        .or_else(|| newest_file_in(&output_dir, "mp3"))
        .ok_or_else(|| "Spotify download finished but the file path couldn't be located.".to_string())?;
    if !std::path::Path::new(&output_path).exists() {
        return Err("Spotify download finished but the resulting file is missing.".to_string());
    }

    let size = std::fs::metadata(&output_path).map(|m| m.len()).unwrap_or(0);

    Ok(DownloadResult {
        output_path: output_path.clone(),
        output_size: size,
        title: title_from_path(&output_path),
    })
}

fn newest_file_in(dir: &std::path::Path, ext: &str) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case(ext)).unwrap_or(false) {
            if let Ok(meta) = entry.metadata() {
                if let Ok(modified) = meta.modified() {
                    if best.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
                        best = Some((modified, path));
                    }
                }
            }
        }
    }
    best.map(|(_, p)| p.to_string_lossy().to_string())
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

/// Find the newest file in `dir` whose extension matches one in `exts` and that
/// was modified at or after `since`. Used to robustly locate the just-downloaded
/// file when yt-dlp's stdout reports a temp/intermediate path instead of the
/// final home path. Sequential downloads make this unambiguous.
fn newest_file_since(
    dir: &std::path::Path,
    exts: &[&str],
    since: std::time::SystemTime,
) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        // Skip yt-dlp's temp artifacts that sometimes leak into output_dir
        // (the .part / .ytdl files when downloads fail mid-stream).
        let ext = match path.extension().and_then(|s| s.to_str()) {
            Some(e) => e.to_lowercase(),
            None => continue,
        };
        if !exts.iter().any(|e| e.eq_ignore_ascii_case(&ext)) { continue; }
        let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        let modified = match meta.modified() { Ok(m) => m, Err(_) => continue };
        // Allow a small skew: SystemTime resolution + filesystem rounding.
        let cutoff = since.checked_sub(std::time::Duration::from_secs(2)).unwrap_or(since);
        if modified < cutoff { continue; }
        if best.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
            best = Some((modified, path));
        }
    }
    best.map(|(_, p)| p.to_string_lossy().to_string())
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
    spotify_client_id: Option<String>,
    spotify_client_secret: Option<String>,
    cookies_path: Option<String>,
) -> Result<DownloadResult, String> {
    let opts = DownloadOptions {
        url: url.clone(),
        format,
        quality,
        output_dir,
        playlist_items,
        spotify_client_id,
        spotify_client_secret,
        cookies_path,
    };
    if is_spotify_url(&url) {
        run_spotdl(app, opts, file_id, state.ytdlp_process.clone()).await
    } else {
        run_ytdlp(app, opts, file_id, state.ytdlp_process.clone()).await
    }
}

/// Probe a URL with yt-dlp's --dump-single-json so the UI can show a preview
/// (title, thumbnail, multi-item carousels, etc.) before committing to a download.
#[tauri::command]
pub async fn probe_url(
    app: tauri::AppHandle,
    url: String,
    cookies_path: Option<String>,
) -> Result<ProbeResult, String> {
    let trimmed = url.trim().to_string();
    if trimmed.is_empty() {
        return Err("URL is empty".to_string());
    }

    if is_spotify_url(&trimmed) {
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
            }],
        });
    }

    let ytdlp_path = get_ytdlp_path(&app);
    let mut args: Vec<String> = vec![
        "--dump-single-json".to_string(),
        "--flat-playlist".to_string(),
        "--no-warnings".to_string(),
        "--skip-download".to_string(),
        "--socket-timeout".to_string(),
        "15".to_string(),
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
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() { "(no details)".to_string() } else { stderr };
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
    };
    ProbeResult {
        kind: "single".to_string(),
        title,
        uploader,
        thumbnail,
        entries: vec![entry],
    }
}

#[tauri::command]
pub fn cancel_download(state: tauri::State<'_, crate::convert::AppState>) -> Result<(), String> {
    let pid_opt = *state.ytdlp_process.lock().unwrap();
    if let Some(pid) = pid_opt {
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
    *state.ytdlp_process.lock().unwrap() = None;
    Ok(())
}

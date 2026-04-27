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

#[derive(Debug, Clone, Deserialize)]
pub struct DownloadOptions {
    pub url: String,
    /// "mp4" for video with audio, or "mp3" for audio-only. Spotify always mp3.
    pub format: String,
    /// "best" | "1080" | "720" | "480"
    pub quality: String,
    pub output_dir: Option<String>,
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

fn build_ytdlp_args(
    opts: &DownloadOptions,
    output_template: &str,
    ffmpeg_path: &std::path::Path,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        opts.url.clone(),
        "-o".to_string(),
        output_template.to_string(),
        "--no-playlist".to_string(),
        "--newline".to_string(),
        "--no-warnings".to_string(),
        "--no-colors".to_string(),
        "--ffmpeg-location".to_string(),
        ffmpeg_path.to_string_lossy().to_string(),
    ];

    if opts.format == "mp3" {
        args.extend([
            "-f".to_string(),
            "bestaudio/best".to_string(),
            "-x".to_string(),
            "--audio-format".to_string(),
            "mp3".to_string(),
            "--audio-quality".to_string(),
            "0".to_string(),
        ]);
    } else {
        let selector = match opts.quality.as_str() {
            "1080" => "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]",
            "720"  => "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]",
            "480"  => "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]",
            _      => "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best",
        };
        args.extend([
            "-f".to_string(),
            selector.to_string(),
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
    let candidates = if format == "mp3" {
        vec!["mp3"]
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
    if low.contains("unavailable") || low.contains("video unavailable") {
        "This video is unavailable (private, removed, or region-locked).".to_string()
    } else if low.contains("sign in") || low.contains("login required") || low.contains("age") {
        "This content requires sign-in or age verification — not supported.".to_string()
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
    let mut child = Command::new(&program)
        .args(&args)
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .stdin(Stdio::null())
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

    let template = output_dir
        .join("%(title)s.%(ext)s")
        .to_string_lossy()
        .to_string();

    let args = build_ytdlp_args(&opts, &template, &ffmpeg_path);

    let (captured, _) = run_child(
        app,
        ytdlp_path,
        args,
        file_id,
        process_holder,
        parse_ytdlp_progress,
        parse_output_path_ytdlp,
    ).await?;

    let output_path = captured.ok_or_else(||
        "Download finished but output path could not be determined.".to_string()
    )?;
    let resolved = resolve_final_path(&output_path, &opts.format);
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

    let args: Vec<String> = vec![
        "download".to_string(),
        opts.url.clone(),
        "--output".to_string(),
        template.clone(),
        "--format".to_string(),
        "mp3".to_string(),
        "--ffmpeg".to_string(),
        ffmpeg_path.to_string_lossy().to_string(),
        "--ytdlp-args".to_string(),
        format!("--ffmpeg-location \"{}\"", ffmpeg_path.to_string_lossy()),
        "--headless".to_string(),
        "--bitrate".to_string(),
        "auto".to_string(),
    ];

    // Make sure spotdl can find yt-dlp (it spawns yt-dlp itself).
    // If our bundled yt-dlp lives in src-tauri/bin/ but isn't on PATH, prepend it.
    let env_path = std::env::var("PATH").unwrap_or_default();
    let bin_dir = ytdlp_path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut child = Command::new(&spotdl_path)
        .args(&args)
        .env("PATH", format!("{};{}", bin_dir, env_path))
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .stdin(Stdio::null())
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

    let app_for_stdout = app.clone();
    let file_id_for_stdout = file_id.clone();

    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut captured_path: Option<String> = None;
        while let Ok(Some(line)) = lines.next_line().await {
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
        .map_err(|e| format!("spotdl process error: {}", e))?;

    *process_holder.lock().unwrap() = None;

    if !status.success() {
        let detail = if last_error.is_empty() { "spotdl failed".to_string() } else { last_error };
        return Err(friendly_error(&detail, status.code().unwrap_or(-1)));
    }

    // Fallback: scan output_dir for the most recently modified mp3 if we didn't
    // capture a path from stdout (older spotdl versions print differently).
    let output_path = captured.or_else(|| newest_file_in(&output_dir, "mp3"))
        .ok_or_else(|| "Spotify download finished but the file path couldn't be located.".to_string())?;

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

#[tauri::command]
pub async fn download_from_url(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::convert::AppState>,
    file_id: String,
    url: String,
    format: String,
    quality: String,
    output_dir: Option<String>,
) -> Result<DownloadResult, String> {
    let opts = DownloadOptions { url: url.clone(), format, quality, output_dir };
    if is_spotify_url(&url) {
        run_spotdl(app, opts, file_id, state.ytdlp_process.clone()).await
    } else {
        run_ytdlp(app, opts, file_id, state.ytdlp_process.clone()).await
    }
}

#[tauri::command]
pub fn cancel_download(state: tauri::State<'_, crate::convert::AppState>) -> Result<(), String> {
    let pid_opt = *state.ytdlp_process.lock().unwrap();
    if let Some(pid) = pid_opt {
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F", "/T"])
                .output();
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

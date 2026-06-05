//! On-demand fetch of the bundled CLI tools so the app can ship as a single
//! portable .exe. ffmpeg/ffprobe/yt-dlp/spotdl are downloaded into the per-user
//! AppData dir on first run instead of being bundled by an installer.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

const FFMPEG_ZIP: &str =
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";
const YTDLP_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const SPOTDL_API: &str = "https://api.github.com/repos/spotDL/spotify-downloader/releases/latest";

/// Per-user tools directory: %LOCALAPPDATA%\com.convertx.app\bin
pub fn tools_dir(app: &AppHandle) -> Option<PathBuf> {
    let base = app.path().app_local_data_dir().ok()?;
    Some(base.join("bin"))
}

fn emit_status(app: &AppHandle, tool: &str, state: &str) {
    let _ = app.emit("tool-setup", serde_json::json!({ "tool": tool, "state": state }));
}

async fn http_get_bytes(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("HTTP client init: {}", e))?;
    let res = client
        .get(url)
        .header("User-Agent", "Convert-X")
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("Download returned HTTP {}", res.status().as_u16()));
    }
    let bytes = res.bytes().await.map_err(|e| format!("Read body: {}", e))?;
    Ok(bytes.to_vec())
}

/// Depth-first search for a file by name under `root`.
fn find_file(root: &Path, name: &str) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.file_name().map_or(false, |f| f == name) {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// True when every required tool is already present locally.
#[tauri::command]
pub fn tools_ready(app: AppHandle) -> bool {
    match tools_dir(&app) {
        Some(d) => ["ffmpeg.exe", "ffprobe.exe", "yt-dlp.exe", "spotdl.exe"]
            .iter()
            .all(|n| d.join(n).exists()),
        None => false,
    }
}

/// Download any missing tools into AppData/bin. Emits `tool-setup` events
/// (`{tool, state}`) so the UI can show a "preparing" overlay.
#[tauri::command]
pub async fn ensure_tools(app: AppHandle) -> Result<(), String> {
    let dir = tools_dir(&app).ok_or("No app data directory available")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Create tools dir: {}", e))?;

    // ffmpeg + ffprobe ship together in a zip — extract with Windows' bundled tar.
    if !dir.join("ffmpeg.exe").exists() || !dir.join("ffprobe.exe").exists() {
        emit_status(&app, "ffmpeg", "downloading");
        let bytes = http_get_bytes(FFMPEG_ZIP).await?;
        let zip_path = std::env::temp_dir().join("convertx-ffmpeg.zip");
        std::fs::write(&zip_path, &bytes).map_err(|e| format!("Write ffmpeg zip: {}", e))?;

        let extract_dir = std::env::temp_dir().join("convertx-ffmpeg-extract");
        let _ = std::fs::remove_dir_all(&extract_dir);
        std::fs::create_dir_all(&extract_dir).map_err(|e| format!("Create extract dir: {}", e))?;

        emit_status(&app, "ffmpeg", "extracting");
        let mut tar = std::process::Command::new("tar");
        tar.args([
            "-xf",
            &zip_path.to_string_lossy(),
            "-C",
            &extract_dir.to_string_lossy(),
        ]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt as _;
            tar.creation_flags(0x08000000);
        }
        let status = tar.status().map_err(|e| format!("tar spawn: {}", e))?;
        if !status.success() {
            return Err("ffmpeg archive extraction failed".into());
        }

        for name in ["ffmpeg.exe", "ffprobe.exe"] {
            let found = find_file(&extract_dir, name)
                .ok_or_else(|| format!("{} not found in ffmpeg archive", name))?;
            std::fs::copy(&found, dir.join(name)).map_err(|e| format!("Copy {}: {}", name, e))?;
        }
        let _ = std::fs::remove_file(&zip_path);
        let _ = std::fs::remove_dir_all(&extract_dir);
    }

    if !dir.join("yt-dlp.exe").exists() {
        emit_status(&app, "yt-dlp", "downloading");
        let bytes = http_get_bytes(YTDLP_URL).await?;
        std::fs::write(dir.join("yt-dlp.exe"), &bytes).map_err(|e| format!("Write yt-dlp: {}", e))?;
    }

    if !dir.join("spotdl.exe").exists() {
        emit_status(&app, "spotdl", "downloading");
        let meta = http_get_bytes(SPOTDL_API).await?;
        let json: serde_json::Value =
            serde_json::from_slice(&meta).map_err(|e| format!("spotdl API parse: {}", e))?;
        let url = json["assets"]
            .as_array()
            .and_then(|a| {
                a.iter()
                    .find(|x| {
                        x["name"]
                            .as_str()
                            .map_or(false, |n| n.to_lowercase().ends_with("win32.exe"))
                    })
                    .and_then(|x| x["browser_download_url"].as_str())
            })
            .ok_or("spotdl win32 asset not found")?
            .to_string();
        let bytes = http_get_bytes(&url).await?;
        std::fs::write(dir.join("spotdl.exe"), &bytes).map_err(|e| format!("Write spotdl: {}", e))?;
    }

    emit_status(&app, "all", "done");
    Ok(())
}

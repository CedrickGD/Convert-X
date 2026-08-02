#[cfg(test)]
mod acl_test;
mod convert;
mod cookies;
mod detect;
mod downloader;
mod ffmpeg;
mod login;
mod net;
mod power;
mod spotify;
mod tools;
mod updater;

use convert::AppState;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

#[tauri::command]
fn read_file_binary(path: String) -> Result<tauri::ipc::Response, String> {
    let data = std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(tauri::ipc::Response::new(data))
}

/// Fetch a remote image and return its bytes. Used to proxy thumbnails through
/// Tauri so CDNs that hotlink-block (Instagram, etc.) still load in the preview.
#[tauri::command]
async fn fetch_remote_image(url: String) -> Result<tauri::ipc::Response, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init: {}", e))?;
    let res = client
        .get(&url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        )
        .header("Accept", "image/webp,image/jpeg,image/png,*/*;q=0.8")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch image: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("Image fetch returned HTTP {}", res.status().as_u16()));
    }
    let bytes = res.bytes().await.map_err(|e| format!("Failed to read image bytes: {}", e))?;
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {}", path));
    }
    // Use ShellExecuteW via rundll32 fallback or just spawn the file directly.
    // The simplest reliable way on Windows: spawn `cmd /c start "" "<path>"`,
    // but cmd's parser is finicky. Bypass cmd and use the Win32 ShellExecute API
    // via the `start` builtin only as a last resort. The most reliable: invoke
    // the file directly through the OS file association by spawning explorer.
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/c", "start", "", "/b", &path]);
        // Hide cmd's own console flash.
        use std::os::windows::process::CommandExt as _;
        cmd.creation_flags(0x08000000);
        cmd.spawn().map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn open_in_folder(path: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .args(["/select,", &path])
        .spawn()
        .map_err(|e| format!("Failed to open folder: {}", e))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            // Staging dirs are per-job and job ids are never reused, so a run
            // can only clean up after itself — anything left by a killed app
            // would stay in %TEMP% forever. Own thread: this walks the temp
            // dirs and must never delay the window.
            std::thread::spawn(downloader::sweep_stale_staging);
            Ok(())
        })
        .manage(AppState {
            ffmpeg_process: Arc::new(Mutex::new(None)),
            conversion_cancelled: Arc::new(Mutex::new(false)),
            downloads: Arc::new(Mutex::new(HashMap::new())),
            cancelled_downloads: Arc::new(Mutex::new(HashSet::new())),
            active_jobs: Arc::new(Mutex::new(HashSet::new())),
        })
        .invoke_handler(tauri::generate_handler![
            detect::detect_file,
            convert::convert_file,
            convert::cancel_conversion,
            convert::resize_image,
            downloader::download_from_url,
            downloader::cancel_download,
            downloader::probe_url,
            net::http_request,
            net::download_direct,
            cookies::read_cookies_file,
            cookies::write_cookies_file,
            cookies::cookies_file_path,
            cookies::file_exists,
            login::open_login_window,
            power::set_keep_awake,
            read_file_binary,
            fetch_remote_image,
            open_file,
            open_in_folder,
            updater::download_installer,
            updater::launch_installer,
            tools::ensure_tools,
            tools::tools_ready,
            tools::update_ytdlp,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

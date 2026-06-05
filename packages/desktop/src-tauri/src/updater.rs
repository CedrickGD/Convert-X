// Desktop self-updater: download a release MSI and hand it to the Windows
// installer, mirroring the Android one-click flow. The frontend (Credits)
// finds the latest `desktop-v*` release via the GitHub API, then calls these.

use tauri::{AppHandle, Emitter};

/// Download an installer to a temp file, emitting `desktop-update-progress`
/// (0-100) as it goes. Returns the path to the downloaded file.
#[tauri::command]
pub async fn download_installer(app: AppHandle, url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("HTTP client init: {}", e))?;

    let mut res = client
        .get(&url)
        .header("User-Agent", "Convert-X-Updater")
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("Download returned HTTP {}", res.status().as_u16()));
    }

    let total = res.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut buf: Vec<u8> = Vec::with_capacity(total as usize);

    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|e| format!("Download read error: {}", e))?
    {
        buf.extend_from_slice(&chunk);
        downloaded += chunk.len() as u64;
        if total > 0 {
            let pct = ((downloaded as f64 / total as f64) * 100.0) as u32;
            let _ = app.emit("desktop-update-progress", pct);
        }
    }

    // Integrity guard: a truncated download must not be handed to the installer.
    if total > 0 && downloaded != total {
        return Err(format!(
            "Update download was incomplete ({} of {} bytes).",
            downloaded, total
        ));
    }

    let dest = std::env::temp_dir().join("convertx-update.exe");
    std::fs::write(&dest, &buf).map_err(|e| format!("Write installer: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

/// Apply a downloaded portable-exe update: spawn a detached helper that waits
/// for us to exit, swaps the new exe over the running one, and relaunches it.
/// Windows can't overwrite a running .exe, hence the helper.
#[tauri::command]
pub fn launch_installer(app: AppHandle, path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("Update file not found: {}", path));
    }
    let current = std::env::current_exe().map_err(|e| format!("current_exe: {}", e))?;
    let current_str = current.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        // Wait ~2s for this process to release the exe, replace it in place, then
        // relaunch. The cmd helper outlives us (DETACHED_PROCESS) and is windowless.
        let script = format!(
            "ping 127.0.0.1 -n 3 >nul & move /y \"{new}\" \"{cur}\" & start \"\" \"{cur}\"",
            new = path,
            cur = current_str
        );
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/c", &script]);
        cmd.creation_flags(0x08000000 | 0x00000008); // CREATE_NO_WINDOW | DETACHED_PROCESS
        cmd.spawn()
            .map_err(|e| format!("Failed to start update helper: {}", e))?;
    }
    #[cfg(not(windows))]
    {
        return Err("In-app update is only supported on Windows.".into());
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
    app.exit(0);
    Ok(())
}

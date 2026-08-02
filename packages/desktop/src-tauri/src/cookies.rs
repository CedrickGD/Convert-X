//! Canonical cookies.txt store.
//!
//! One Netscape-format file at `<app_local_data_dir>/cookies.txt` is the single
//! source of truth for login state: yt-dlp reads it via `--cookies`, and the
//! shared JS layer parses the SAME text to build explicit `Cookie` headers for
//! the probers. All per-domain merge/remove logic lives in shared JS — Rust
//! only does the raw file IO (no fs plugin exists; plain std::fs in commands
//! sidesteps capability scoping, consistent with the rest of the codebase).

use tauri::Manager;

fn canonical_cookies_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("No app data directory available: {}", e))?;
    Ok(dir.join("cookies.txt"))
}

/// Full cookies.txt text, or None when the file doesn't exist.
#[tauri::command]
pub fn read_cookies_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = canonical_cookies_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("Failed to read cookies file: {}", e))
}

/// Replace the cookies.txt content. Empty/whitespace-only text deletes the
/// file — an absent file is how "not logged in anywhere" is represented.
#[tauri::command]
pub fn write_cookies_file(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let path = canonical_cookies_path(&app)?;
    if text.trim().is_empty() {
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete cookies file: {}", e))?;
        }
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    }
    std::fs::write(&path, text).map_err(|e| format!("Failed to write cookies file: {}", e))
}

/// Absolute path of the canonical cookies.txt (whether or not it exists) —
/// this is the value passed to yt-dlp's `--cookies`.
#[tauri::command]
pub fn cookies_file_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(canonical_cookies_path(&app)?.to_string_lossy().to_string())
}

/// Cheap existence check used by history dead-file pruning.
#[tauri::command]
pub fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

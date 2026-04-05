mod convert;
mod detect;
mod ffmpeg;

use convert::AppState;
use std::sync::{Arc, Mutex};

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", &path])
        .spawn()
        .map_err(|e| format!("Failed to open file: {}", e))?;
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
        .manage(AppState {
            ffmpeg_process: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            detect::detect_file,
            convert::convert_file,
            convert::cancel_conversion,
            convert::resize_image,
            open_file,
            open_in_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

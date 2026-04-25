use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Serialize, Clone)]
pub struct FileMetadata {
    pub file_type: String,
    pub mime_type: String,
    pub codec: Option<String>,
    pub resolution: Option<String>,
    pub duration: Option<f64>,
    pub bitrate: Option<String>,
    pub frame_rate: Option<String>,
    pub size: u64,
    pub file_name: String,
}

fn detect_by_magic_bytes(data: &[u8]) -> Option<(&'static str, &'static str)> {
    if data.len() < 12 {
        return None;
    }

    // Image formats
    if data.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Some(("image", "image/png"));
    }
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(("image", "image/jpeg"));
    }
    if data.starts_with(&[0x47, 0x49, 0x46, 0x38]) {
        return Some(("image", "image/gif"));
    }
    if data.starts_with(&[0x42, 0x4D]) {
        return Some(("image", "image/bmp"));
    }
    if data[0..4] == [0x49, 0x49, 0x2A, 0x00] || data[0..4] == [0x4D, 0x4D, 0x00, 0x2A] {
        return Some(("image", "image/tiff"));
    }
    if data.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return Some(("image", "image/x-icon"));
    }
    if data.starts_with(&[0x52, 0x49, 0x46, 0x46]) && data[8..12] == [0x57, 0x45, 0x42, 0x50] {
        return Some(("image", "image/webp"));
    }

    // Audio formats
    if data.starts_with(&[0x66, 0x4C, 0x61, 0x43]) {
        return Some(("audio", "audio/flac"));
    }
    if data.starts_with(&[0x4F, 0x67, 0x67, 0x53]) {
        return Some(("audio", "audio/ogg"));
    }
    if data.starts_with(&[0x49, 0x44, 0x33]) || (data[0] == 0xFF && (data[1] & 0xE0) == 0xE0) {
        return Some(("audio", "audio/mpeg"));
    }
    if data.starts_with(&[0x52, 0x49, 0x46, 0x46]) && data[8..12] == [0x57, 0x41, 0x56, 0x45] {
        return Some(("audio", "audio/wav"));
    }
    // ASF container (WMV/WMA)
    if data.starts_with(&[0x30, 0x26, 0xB2, 0x75]) {
        return Some(("video", "video/x-ms-asf"));
    }

    // Video formats
    if data.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some(("video", "video/x-matroska"));
    }
    if data.starts_with(&[0x52, 0x49, 0x46, 0x46]) && data[8..12] == [0x41, 0x56, 0x49, 0x20] {
        return Some(("video", "video/x-msvideo"));
    }
    // FLV
    if data.starts_with(&[0x46, 0x4C, 0x56]) {
        return Some(("video", "video/x-flv"));
    }
    // MPEG-TS
    if data[0] == 0x47 && data.len() >= 188 && data[188 % data.len()] == 0x47 {
        return Some(("video", "video/mp2t"));
    }
    // MP4/MOV
    if data.len() >= 8 && &data[4..8] == b"ftyp" {
        return Some(("video", "video/mp4"));
    }

    None
}

fn run_ffprobe(file_path: &str, ffprobe_path: &Path) -> Option<serde_json::Value> {
    let output = Command::new(ffprobe_path)
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            file_path,
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    serde_json::from_slice(&output.stdout).ok()
}

fn parse_ffprobe_output(
    probe: &serde_json::Value,
    file_type: &str,
) -> (
    Option<String>,
    Option<String>,
    Option<f64>,
    Option<String>,
    Option<String>,
) {
    let streams = probe.get("streams").and_then(|s| s.as_array());
    let format = probe.get("format");

    let mut codec = None;
    let mut resolution = None;
    let mut frame_rate = None;

    if let Some(streams) = streams {
        let target_type = if file_type == "video" {
            "video"
        } else {
            "audio"
        };
        for stream in streams {
            let codec_type = stream
                .get("codec_type")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if codec_type == target_type {
                codec = stream
                    .get("codec_name")
                    .and_then(|v| v.as_str())
                    .map(String::from);

                if file_type == "video" {
                    let w = stream.get("width").and_then(|v| v.as_u64()).unwrap_or(0);
                    let h = stream.get("height").and_then(|v| v.as_u64()).unwrap_or(0);
                    if w > 0 && h > 0 {
                        resolution = Some(format!("{}x{}", w, h));
                    }
                    frame_rate = stream
                        .get("r_frame_rate")
                        .and_then(|v| v.as_str())
                        .map(|s| {
                            let parts: Vec<&str> = s.split('/').collect();
                            if parts.len() == 2 {
                                if let (Ok(num), Ok(den)) =
                                    (parts[0].parse::<f64>(), parts[1].parse::<f64>())
                                {
                                    if den > 0.0 {
                                        return format!("{:.2}", num / den);
                                    }
                                }
                            }
                            s.to_string()
                        });
                }
                break;
            }
        }
    }

    let duration = format
        .and_then(|f| f.get("duration"))
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok());

    let bitrate = format
        .and_then(|f| f.get("bit_rate"))
        .and_then(|v| v.as_str())
        .map(|s| {
            if let Ok(bps) = s.parse::<u64>() {
                format!("{} kbps", bps / 1000)
            } else {
                s.to_string()
            }
        });

    (codec, resolution, duration, bitrate, frame_rate)
}

fn get_ffprobe_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    if cfg!(debug_assertions) {
        let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("bin")
            .join("ffprobe.exe");
        if dev_path.exists() {
            return dev_path;
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let prod_path = resource_dir.join("bin").join("ffprobe.exe");
        if prod_path.exists() {
            return prod_path;
        }
    }

    std::path::PathBuf::from("ffprobe")
}

use tauri::Manager;

#[tauri::command]
pub async fn detect_file(app: tauri::AppHandle, file_path: String) -> Result<FileMetadata, String> {
    let path = Path::new(&file_path);

    if !path.exists() {
        return Err("File not found".to_string());
    }

    let file_size = std::fs::metadata(path)
        .map_err(|e| format!("Cannot read file: {}", e))?
        .len();

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let data = std::fs::read(path).map_err(|e| format!("Cannot read file: {}", e))?;

    let (file_type, mime_type) = detect_by_magic_bytes(&data)
        .or_else(|| {
            let ext = path.extension()?.to_str()?.to_lowercase();
            match ext.as_str() {
                "png" => Some(("image", "image/png")),
                "jpg" | "jpeg" => Some(("image", "image/jpeg")),
                "gif" => Some(("image", "image/gif")),
                "bmp" => Some(("image", "image/bmp")),
                "tiff" | "tif" => Some(("image", "image/tiff")),
                "ico" => Some(("image", "image/x-icon")),
                "webp" => Some(("image", "image/webp")),
                "mp4" | "m4v" => Some(("video", "video/mp4")),
                "mkv" => Some(("video", "video/x-matroska")),
                "avi" => Some(("video", "video/x-msvideo")),
                "webm" => Some(("video", "video/webm")),
                "mov" => Some(("video", "video/quicktime")),
                "flv" => Some(("video", "video/x-flv")),
                "wmv" => Some(("video", "video/x-ms-wmv")),
                "ts" | "mts" => Some(("video", "video/mp2t")),
                "mp3" => Some(("audio", "audio/mpeg")),
                "wav" => Some(("audio", "audio/wav")),
                "flac" => Some(("audio", "audio/flac")),
                "ogg" | "oga" => Some(("audio", "audio/ogg")),
                "aac" => Some(("audio", "audio/aac")),
                "wma" => Some(("audio", "audio/x-ms-wma")),
                "m4a" => Some(("audio", "audio/mp4")),
                "opus" => Some(("audio", "audio/opus")),
                _ => None,
            }
        })
        .ok_or_else(|| "Unsupported file format".to_string())?;

    let mut metadata = FileMetadata {
        file_type: file_type.to_string(),
        mime_type: mime_type.to_string(),
        codec: None,
        resolution: None,
        duration: None,
        bitrate: None,
        frame_rate: None,
        size: file_size,
        file_name,
    };

    if file_type == "video" || file_type == "audio" {
        let ffprobe_path = get_ffprobe_path(&app);
        if let Some(probe) = run_ffprobe(&file_path, &ffprobe_path) {
            let (codec, resolution, duration, bitrate, frame_rate) =
                parse_ffprobe_output(&probe, file_type);
            metadata.codec = codec;
            metadata.resolution = resolution;
            metadata.duration = duration;
            metadata.bitrate = bitrate;
            metadata.frame_rate = frame_rate;
        }
    }

    if file_type == "image" {
        if let Ok(dims) = image::image_dimensions(path) {
            metadata.resolution = Some(format!("{}x{}", dims.0, dims.1));
        }
    }

    Ok(metadata)
}

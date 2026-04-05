use crate::ffmpeg::{self, FfmpegOptions};
use image::{GenericImageView, ImageFormat};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub struct AppState {
    pub ffmpeg_process: Arc<Mutex<Option<u32>>>,
}

#[derive(Clone, Serialize)]
pub struct ConversionResult {
    pub output_path: String,
    pub output_size: u64,
}

fn build_output_path(
    input_path: &str,
    output_format: &str,
    output_dir: Option<&str>,
    output_name: Option<&str>,
) -> PathBuf {
    let path = Path::new(input_path);
    let default_stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let parent = path.parent().unwrap_or(Path::new("."));

    let name = match output_name {
        Some(n) if !n.trim().is_empty() => n.trim().to_string(),
        _ => default_stem.to_string(),
    };

    let dir = match output_dir {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => parent.to_path_buf(),
    };

    dir.join(format!("{}.{}", name, output_format))
}

/// Save a DynamicImage to disk in the given format
fn save_image(img: &image::DynamicImage, output_path: &Path, output_format: &str, quality: u32) -> Result<(), String> {
    match output_format {
        "png" => {
            img.save_with_format(output_path, ImageFormat::Png)
                .map_err(|e| format!("Failed to save PNG: {}", e))?;
        }
        "jpg" | "jpeg" => {
            let mut writer = std::fs::File::create(output_path)
                .map_err(|e| format!("Failed to create file: {}", e))?;
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, quality as u8);
            img.write_with_encoder(encoder)
                .map_err(|e| format!("Failed to save JPEG: {}", e))?;
        }
        "bmp" => {
            img.save_with_format(output_path, ImageFormat::Bmp)
                .map_err(|e| format!("Failed to save BMP: {}", e))?;
        }
        "tiff" | "tif" => {
            img.save_with_format(output_path, ImageFormat::Tiff)
                .map_err(|e| format!("Failed to save TIFF: {}", e))?;
        }
        "gif" => {
            img.save_with_format(output_path, ImageFormat::Gif)
                .map_err(|e| format!("Failed to save GIF: {}", e))?;
        }
        "ico" => {
            let resized = img.resize(256, 256, image::imageops::FilterType::Lanczos3);
            resized.save_with_format(output_path, ImageFormat::Ico)
                .map_err(|e| format!("Failed to save ICO: {}", e))?;
        }
        _ => {
            return Err(format!("Unsupported image format: {}", output_format));
        }
    }
    Ok(())
}

fn convert_image(input_path: &str, output_path: &Path, output_format: &str, quality: u32) -> Result<(), String> {
    let img = image::open(input_path).map_err(|e| format!("Failed to open image: {}", e))?;
    save_image(&img, output_path, output_format, quality)
}

/// Formats that must go through FFmpeg even for images
fn needs_ffmpeg_for_image(format: &str) -> bool {
    matches!(format, "webp")
}

/// Normalize file extensions
fn normalize_format(fmt: &str) -> &str {
    match fmt {
        "jpeg" => "jpg",
        "tif" => "tiff",
        _ => fmt,
    }
}

#[tauri::command]
pub async fn convert_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    file_id: String,
    file_path: String,
    file_type: String,
    output_format: String,
    quality: u32,
    duration: Option<f64>,
    output_dir: Option<String>,
    output_name: Option<String>,
    resolution: Option<String>,
    fps: Option<u32>,
    trim_start: Option<f64>,
    trim_end: Option<f64>,
    bitrate: Option<String>,
    preset: Option<String>,
) -> Result<ConversionResult, String> {
    let output_path = build_output_path(
        &file_path,
        &output_format,
        output_dir.as_deref(),
        output_name.as_deref(),
    );
    let output_path_str = output_path.to_string_lossy().to_string();

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create output directory: {}", e))?;
    }

    let opts = FfmpegOptions {
        quality,
        resolution,
        fps,
        trim_start,
        trim_end,
        bitrate,
        preset,
    };

    // Calculate effective duration for progress tracking
    let effective_duration = {
        let d = duration.unwrap_or(0.0);
        let start = opts.trim_start.unwrap_or(0.0);
        let end = opts.trim_end.unwrap_or(d);
        if end > start { end - start } else { d }
    };

    match file_type.as_str() {
        "image" => {
            if output_format == "gif" || needs_ffmpeg_for_image(&output_format) {
                // Route through FFmpeg
                let ffmpeg_path = ffmpeg::get_ffmpeg_path(&app);
                let args = ffmpeg::build_ffmpeg_args(
                    &file_path, &output_path_str, &output_format, "image", &opts,
                );
                let process_holder = state.ffmpeg_process.clone();
                ffmpeg::run_ffmpeg(app.clone(), &ffmpeg_path, args, 0.0, file_id.clone(), process_holder).await?;
            } else {
                convert_image(&file_path, &output_path, &output_format, quality)?;
            }

            use tauri::Emitter;
            let _ = app.emit("conversion-progress", ffmpeg::ProgressPayload {
                file_id,
                progress: 100.0,
                elapsed: "00:00".to_string(),
            });
        }
        "video" | "audio" => {
            let ffmpeg_path = ffmpeg::get_ffmpeg_path(&app);
            let args = ffmpeg::build_ffmpeg_args(
                &file_path, &output_path_str, &output_format, &file_type, &opts,
            );
            let process_holder = state.ffmpeg_process.clone();
            ffmpeg::run_ffmpeg(app.clone(), &ffmpeg_path, args, effective_duration, file_id.clone(), process_holder).await?;

            use tauri::Emitter;
            let _ = app.emit("conversion-progress", ffmpeg::ProgressPayload {
                file_id,
                progress: 100.0,
                elapsed: "00:00".to_string(),
            });
        }
        _ => {
            return Err(format!("Unsupported file type: {}", file_type));
        }
    }

    let output_size = std::fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(ConversionResult {
        output_path: output_path_str,
        output_size,
    })
}

#[tauri::command]
pub async fn resize_image(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    file_id: String,
    file_path: String,
    resize_mode: String,
    width: Option<u32>,
    height: Option<u32>,
    percentage: Option<f64>,
    keep_aspect: bool,
    output_format: String,
    quality: u32,
    output_dir: Option<String>,
    output_name: Option<String>,
) -> Result<ConversionResult, String> {
    let img = image::open(&file_path).map_err(|e| format!("Failed to open image: {}", e))?;
    let (orig_w, orig_h) = img.dimensions();

    // Calculate target dimensions
    let (target_w, target_h) = match resize_mode.as_str() {
        "percentage" => {
            let pct = percentage.unwrap_or(100.0) / 100.0;
            (
                ((orig_w as f64 * pct).round() as u32).max(1),
                ((orig_h as f64 * pct).round() as u32).max(1),
            )
        }
        _ => {
            // Pixel mode
            if keep_aspect {
                let ratio = orig_w as f64 / orig_h as f64;
                match (width, height) {
                    (Some(w), _) => {
                        (w.max(1), ((w as f64 / ratio).round() as u32).max(1))
                    }
                    (None, Some(h)) => {
                        (((h as f64 * ratio).round() as u32).max(1), h.max(1))
                    }
                    _ => (orig_w, orig_h),
                }
            } else {
                (width.unwrap_or(orig_w).max(1), height.unwrap_or(orig_h).max(1))
            }
        }
    };

    let fmt = normalize_format(&output_format);

    let output_path = build_output_path(
        &file_path,
        fmt,
        output_dir.as_deref(),
        output_name.as_deref(),
    );
    let output_path_str = output_path.to_string_lossy().to_string();

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create output directory: {}", e))?;
    }

    // WebP needs FFmpeg for encoding
    if fmt == "webp" {
        let ffmpeg_path = ffmpeg::get_ffmpeg_path(&app);
        let q_val = ((quality as f64 / 100.0) * 75.0).round() as u32;
        let args = vec![
            "-i".to_string(),
            file_path.clone(),
            "-vf".to_string(),
            format!("scale={}:{}", target_w, target_h),
            "-quality".to_string(),
            format!("{}", q_val),
            "-y".to_string(),
            output_path_str.clone(),
        ];
        let process_holder = state.ffmpeg_process.clone();
        ffmpeg::run_ffmpeg(app.clone(), &ffmpeg_path, args, 0.0, file_id.clone(), process_holder).await?;
    } else {
        // Use image crate
        let resized = img.resize_exact(target_w, target_h, image::imageops::FilterType::Lanczos3);
        save_image(&resized, &output_path, fmt, quality)?;
    }

    use tauri::Emitter;
    let _ = app.emit(
        "conversion-progress",
        ffmpeg::ProgressPayload {
            file_id,
            progress: 100.0,
            elapsed: "00:00".to_string(),
        },
    );

    let output_size = std::fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(ConversionResult {
        output_path: output_path_str,
        output_size,
    })
}

#[tauri::command]
pub async fn cancel_conversion(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Some(pid) = state.ffmpeg_process.lock().unwrap().take() {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output();
    }
    Ok(())
}

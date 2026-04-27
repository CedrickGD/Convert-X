use crate::ffmpeg::{self, CropRect, FfmpegOptions};
use image::{GenericImageView, ImageFormat};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::Manager;

pub struct AppState {
    pub ffmpeg_process: Arc<Mutex<Option<u32>>>,
    pub ytdlp_process: Arc<Mutex<Option<u32>>>,
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
fn save_image(
    img: &image::DynamicImage,
    output_path: &Path,
    output_format: &str,
    quality: u32,
) -> Result<(), String> {
    match output_format {
        "png" => {
            img.save_with_format(output_path, ImageFormat::Png)
                .map_err(|e| format!("Failed to save PNG: {}", e))?;
        }
        "jpg" | "jpeg" => {
            let mut writer = std::fs::File::create(output_path)
                .map_err(|e| format!("Failed to create file: {}", e))?;
            let encoder =
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, quality as u8);
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
            resized
                .save_with_format(output_path, ImageFormat::Ico)
                .map_err(|e| format!("Failed to save ICO: {}", e))?;
        }
        _ => {
            return Err(format!("Unsupported image format: {}", output_format));
        }
    }
    Ok(())
}

fn convert_image(
    input_path: &str,
    output_path: &Path,
    output_format: &str,
    quality: u32,
) -> Result<(), String> {
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

fn get_ffprobe_path(app: &tauri::AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
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

    PathBuf::from("ffprobe")
}

fn parse_resolution_width(resolution: &str) -> Option<u32> {
    resolution.split('x').next()?.parse().ok()
}

fn parse_frame_rate(rate: &str) -> Option<u32> {
    if let Some((num, den)) = rate.split_once('/') {
        let num: f64 = num.parse().ok()?;
        let den: f64 = den.parse().ok()?;
        if den > 0.0 {
            return Some((num / den).round().clamp(1.0, 60.0) as u32);
        }
    }

    rate.parse::<f64>()
        .ok()
        .map(|v| v.round().clamp(1.0, 60.0) as u32)
}

fn probe_video_width_and_fps(
    app: &tauri::AppHandle,
    file_path: &str,
) -> Option<(u32, Option<u32>)> {
    let output = std::process::Command::new(get_ffprobe_path(app))
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_streams",
            file_path,
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let probe: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let streams = probe.get("streams")?.as_array()?;
    let stream = streams.iter().find(|stream| {
        stream
            .get("codec_type")
            .and_then(|v| v.as_str())
            .map(|kind| kind == "video")
            .unwrap_or(false)
    })?;

    let width = stream.get("width").and_then(|v| v.as_u64())? as u32;
    let fps = stream
        .get("r_frame_rate")
        .and_then(|v| v.as_str())
        .and_then(parse_frame_rate);

    Some((width, fps))
}

#[derive(Clone, PartialEq)]
struct GifAttempt {
    width: Option<u32>,
    fps: Option<u32>,
    colors: u32,
    quality: u32,
}

fn clamp_even(value: u32, min: u32) -> u32 {
    let mut out = value.max(min);
    if out % 2 != 0 {
        out = out.saturating_sub(1).max(min);
    }
    out
}

fn lower_palette(current: u32, suggested_max: u32) -> u32 {
    const STOPS: [u32; 12] = [256, 224, 192, 160, 128, 96, 64, 48, 32, 24, 16, 8];

    let cap = suggested_max.clamp(8, 256);
    for stop in STOPS {
        if stop < current && stop <= cap {
            return stop;
        }
    }

    for stop in STOPS {
        if stop < current {
            return stop;
        }
    }

    current
}

fn next_gif_attempt(
    current: &GifAttempt,
    target_ratio: f64,
    allow_fps_reduction: bool,
    min_width: u32,
) -> Option<GifAttempt> {
    let ratio = target_ratio.clamp(0.2, 0.96);
    let mut next = current.clone();

    if let Some(width) = current.width {
        let scaled = clamp_even(
            ((width as f64 * (ratio * 0.92).sqrt()).round() as u32).max(min_width),
            min_width,
        );
        if scaled < width {
            next.width = Some(scaled);
        }
    }

    if allow_fps_reduction {
        if let Some(fps) = current.fps {
            let scaled = ((fps as f64 * ratio.powf(0.35)).round() as u32).clamp(5, fps.max(5));
            if scaled < fps {
                next.fps = Some(scaled);
            }
        }
    }

    let suggested_colors =
        ((current.colors as f64 * ratio.powf(0.55)).round() as u32).clamp(8, 256);
    let next_colors = lower_palette(current.colors, suggested_colors);
    if next_colors < current.colors {
        next.colors = next_colors;
    }

    let next_quality = ((current.quality as f64 * ratio.powf(0.25)).round() as u32).clamp(20, 100);
    if next_quality < current.quality {
        next.quality = next_quality;
    }

    if next == *current {
        if let Some(width) = current.width {
            let forced = clamp_even(width.saturating_sub(64), min_width);
            if forced < width {
                next.width = Some(forced);
            }
        }

        if allow_fps_reduction {
            if let Some(fps) = current.fps {
                let forced = if fps > 15 {
                    fps.saturating_sub(5)
                } else {
                    fps.saturating_sub(2)
                }
                .max(5);
                if forced < fps {
                    next.fps = Some(forced);
                }
            }
        }

        let forced_colors = lower_palette(current.colors, current.colors.saturating_sub(32));
        if forced_colors < current.colors {
            next.colors = forced_colors;
        }

        if next.quality == current.quality {
            next.quality = current.quality.saturating_sub(10).max(20);
        }
    }

    if next == *current {
        None
    } else {
        Some(next)
    }
}

fn format_megabytes(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0)
}

async fn run_gif_with_size_cap(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
    file_id: &str,
    file_path: &str,
    output_path: &Path,
    duration: f64,
    file_type: &str,
    opts: &FfmpegOptions,
) -> Result<(), String> {
    let target_mb = opts.gif_target_size_mb.unwrap_or(0);
    if target_mb == 0 {
        return Ok(());
    }

    let target_bytes = target_mb as u64 * 1024 * 1024;
    let allow_fps_reduction = file_type == "video";
    let min_width = if allow_fps_reduction { 160 } else { 96 };

    let mut attempt = GifAttempt {
        width: opts
            .gif_width
            .or_else(|| opts.resolution.as_deref().and_then(parse_resolution_width))
            .or_else(|| {
                if file_type == "image" {
                    image::image_dimensions(file_path).ok().map(|(w, _)| w)
                } else {
                    probe_video_width_and_fps(app, file_path).map(|(w, _)| w)
                }
            }),
        fps: if allow_fps_reduction {
            opts.gif_fps
                .or(opts.fps)
                .or_else(|| probe_video_width_and_fps(app, file_path).and_then(|(_, fps)| fps))
        } else {
            None
        },
        colors: opts.gif_colors.unwrap_or(256).clamp(8, 256),
        quality: opts.quality.clamp(1, 100),
    };

    let output_path_str = output_path.to_string_lossy().to_string();
    let ffmpeg_path = ffmpeg::get_ffmpeg_path(app);
    let process_holder = state.ffmpeg_process.clone();
    let mut best_size = u64::MAX;

    for _ in 0..7 {
        let mut attempt_opts = opts.clone();
        attempt_opts.quality = attempt.quality;
        attempt_opts.gif_colors = Some(attempt.colors);
        attempt_opts.gif_width = attempt.width;
        attempt_opts.gif_fps = attempt.fps;

        let args =
            ffmpeg::build_ffmpeg_args(file_path, &output_path_str, "gif", file_type, &attempt_opts);
        ffmpeg::run_ffmpeg(
            app.clone(),
            &ffmpeg_path,
            args,
            duration,
            file_id.to_string(),
            process_holder.clone(),
        )
        .await?;

        let size = std::fs::metadata(output_path)
            .map_err(|e| format!("Failed to inspect GIF output: {}", e))?
            .len();

        best_size = best_size.min(size);

        if size <= target_bytes {
            return Ok(());
        }

        let target_ratio = target_bytes as f64 / size as f64;
        let Some(next_attempt) =
            next_gif_attempt(&attempt, target_ratio, allow_fps_reduction, min_width)
        else {
            break;
        };
        attempt = next_attempt;
    }

    let _ = std::fs::remove_file(output_path);
    Err(format!(
        "Couldn't fit GIF under {} MB. Smallest result was {}.",
        target_mb,
        format_megabytes(best_size)
    ))
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
    strip_audio: Option<bool>,
    bitrate: Option<String>,
    preset: Option<String>,
    gif_colors: Option<u32>,
    gif_dither: Option<String>,
    gif_width: Option<u32>,
    gif_fps: Option<u32>,
    gif_target_size_mb: Option<u32>,
    crop: Option<CropRect>,
    rotate: Option<u32>,
    flip_h: Option<bool>,
    flip_v: Option<bool>,
    speed: Option<f64>,
    volume: Option<f64>,
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
        strip_audio: strip_audio.unwrap_or(false),
        bitrate,
        preset,
        gif_colors,
        gif_dither,
        gif_width,
        gif_fps,
        gif_target_size_mb,
        crop,
        rotate,
        flip_h: flip_h.unwrap_or(false),
        flip_v: flip_v.unwrap_or(false),
        speed,
        volume,
    };

    // Calculate effective duration for progress tracking
    let effective_duration = {
        let d = duration.unwrap_or(0.0);
        let start = opts.trim_start.unwrap_or(0.0);
        let end = opts.trim_end.unwrap_or(d);
        if end > start {
            end - start
        } else {
            d
        }
    };

    match file_type.as_str() {
        "image" => {
            if output_format == "gif" || needs_ffmpeg_for_image(&output_format) {
                if output_format == "gif" && opts.gif_target_size_mb.unwrap_or(0) > 0 {
                    run_gif_with_size_cap(
                        &app,
                        &state,
                        &file_id,
                        &file_path,
                        &output_path,
                        0.0,
                        "image",
                        &opts,
                    )
                    .await?;
                } else {
                    // Route through FFmpeg
                    let ffmpeg_path = ffmpeg::get_ffmpeg_path(&app);
                    let args = ffmpeg::build_ffmpeg_args(
                        &file_path,
                        &output_path_str,
                        &output_format,
                        "image",
                        &opts,
                    );
                    let process_holder = state.ffmpeg_process.clone();
                    ffmpeg::run_ffmpeg(
                        app.clone(),
                        &ffmpeg_path,
                        args,
                        0.0,
                        file_id.clone(),
                        process_holder,
                    )
                    .await?;
                }
            } else {
                convert_image(&file_path, &output_path, &output_format, quality)?;
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
        }
        "video" | "audio" => {
            if output_format == "gif"
                && file_type == "video"
                && opts.gif_target_size_mb.unwrap_or(0) > 0
            {
                run_gif_with_size_cap(
                    &app,
                    &state,
                    &file_id,
                    &file_path,
                    &output_path,
                    effective_duration,
                    "video",
                    &opts,
                )
                .await?;
            } else {
                let ffmpeg_path = ffmpeg::get_ffmpeg_path(&app);
                let args = ffmpeg::build_ffmpeg_args(
                    &file_path,
                    &output_path_str,
                    &output_format,
                    &file_type,
                    &opts,
                );
                let process_holder = state.ffmpeg_process.clone();
                ffmpeg::run_ffmpeg(
                    app.clone(),
                    &ffmpeg_path,
                    args,
                    effective_duration,
                    file_id.clone(),
                    process_holder,
                )
                .await?;
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
                    (Some(w), _) => (w.max(1), ((w as f64 / ratio).round() as u32).max(1)),
                    (None, Some(h)) => (((h as f64 * ratio).round() as u32).max(1), h.max(1)),
                    _ => (orig_w, orig_h),
                }
            } else {
                (
                    width.unwrap_or(orig_w).max(1),
                    height.unwrap_or(orig_h).max(1),
                )
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
        ffmpeg::run_ffmpeg(
            app.clone(),
            &ffmpeg_path,
            args,
            0.0,
            file_id.clone(),
            process_holder,
        )
        .await?;
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

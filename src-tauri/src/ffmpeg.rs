use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Clone, Serialize)]
pub struct ProgressPayload {
    pub file_id: String,
    pub progress: f64,
    pub elapsed: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FfmpegOptions {
    pub quality: u32,
    pub resolution: Option<String>,
    pub fps: Option<u32>,
    pub trim_start: Option<f64>,
    pub trim_end: Option<f64>,
    pub bitrate: Option<String>,
    pub preset: Option<String>,
}

impl Default for FfmpegOptions {
    fn default() -> Self {
        Self {
            quality: 75,
            resolution: None,
            fps: None,
            trim_start: None,
            trim_end: None,
            bitrate: None,
            preset: None,
        }
    }
}

pub fn get_ffmpeg_path(app: &tauri::AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("bin")
            .join("ffmpeg.exe");
        if dev_path.exists() {
            return dev_path;
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let prod_path = resource_dir.join("bin").join("ffmpeg.exe");
        if prod_path.exists() {
            return prod_path;
        }
    }

    PathBuf::from("ffmpeg")
}

/// Build FFmpeg arguments with full options support
pub fn build_ffmpeg_args(
    input_path: &str,
    output_path: &str,
    output_format: &str,
    file_type: &str,
    opts: &FfmpegOptions,
) -> Vec<String> {
    let mut args = vec!["-y".to_string()];

    // Trim: -ss before -i for fast seeking
    if let Some(start) = opts.trim_start {
        if start > 0.0 {
            args.extend(["-ss".to_string(), format!("{:.3}", start)]);
        }
    }

    args.extend(["-i".to_string(), input_path.to_string()]);

    // Trim end: -to after -i
    if let Some(end) = opts.trim_end {
        if end > 0.0 {
            args.extend(["-to".to_string(), format!("{:.3}", end)]);
        }
    }

    match file_type {
        "video" | "image" if output_format == "gif" => {
            build_gif_args(&mut args, opts);
        }
        "video" => {
            build_video_args(&mut args, output_format, opts);
        }
        "audio" => {
            build_audio_args(&mut args, output_format, opts);
        }
        "image" => {
            // Image-to-image via FFmpeg (webp, etc)
            if let Some(ref res) = opts.resolution {
                args.extend(["-vf".to_string(), format!("scale={}", res.replace('x', ":"))]);
            }
        }
        _ => {}
    }

    args.push(output_path.to_string());
    args
}

fn build_gif_args(args: &mut Vec<String>, opts: &FfmpegOptions) {
    let mut filters = Vec::new();

    if let Some(ref res) = opts.resolution {
        filters.push(format!("scale={}:flags=lanczos", res.replace('x', ":")));
    } else {
        filters.push("scale=480:-1:flags=lanczos".to_string());
    }

    if let Some(fps) = opts.fps {
        filters.push(format!("fps={}", fps));
    } else {
        filters.push("fps=15".to_string());
    }

    if !filters.is_empty() {
        args.extend(["-vf".to_string(), filters.join(",")]);
    }
    args.extend(["-loop".to_string(), "0".to_string()]);
}

fn build_video_args(args: &mut Vec<String>, format: &str, opts: &FfmpegOptions) {
    let mut filters = Vec::new();

    if let Some(ref res) = opts.resolution {
        filters.push(format!("scale={}", res.replace('x', ":")));
    }
    if let Some(fps) = opts.fps {
        filters.push(format!("fps={}", fps));
    }

    let preset = opts.preset.as_deref().unwrap_or("medium");

    match format {
        "mp4" | "m4v" => {
            if let Some(ref br) = opts.bitrate {
                args.extend([
                    "-c:v".to_string(), "libx264".to_string(),
                    "-b:v".to_string(), br.clone(),
                    "-preset".to_string(), preset.to_string(),
                    "-c:a".to_string(), "aac".to_string(),
                ]);
            } else {
                let crf = ((100 - opts.quality) as f64 * 51.0 / 100.0) as u32;
                args.extend([
                    "-c:v".to_string(), "libx264".to_string(),
                    "-crf".to_string(), crf.to_string(),
                    "-preset".to_string(), preset.to_string(),
                    "-c:a".to_string(), "aac".to_string(),
                ]);
            }
        }
        "mkv" => {
            let crf = ((100 - opts.quality) as f64 * 51.0 / 100.0) as u32;
            args.extend([
                "-c:v".to_string(), "libx264".to_string(),
                "-crf".to_string(), crf.to_string(),
                "-preset".to_string(), preset.to_string(),
                "-c:a".to_string(), "copy".to_string(),
            ]);
        }
        "avi" => {
            let q = ((100 - opts.quality) as f64 * 31.0 / 100.0) as u32 + 1;
            args.extend([
                "-c:v".to_string(), "mpeg4".to_string(),
                "-q:v".to_string(), q.to_string(),
                "-c:a".to_string(), "mp3".to_string(),
            ]);
        }
        "webm" => {
            let crf = ((100 - opts.quality) as f64 * 63.0 / 100.0) as u32;
            args.extend([
                "-c:v".to_string(), "libvpx-vp9".to_string(),
                "-crf".to_string(), crf.to_string(),
                "-b:v".to_string(), "0".to_string(),
                "-c:a".to_string(), "libopus".to_string(),
            ]);
        }
        "mov" => {
            let crf = ((100 - opts.quality) as f64 * 51.0 / 100.0) as u32;
            args.extend([
                "-c:v".to_string(), "libx264".to_string(),
                "-crf".to_string(), crf.to_string(),
                "-preset".to_string(), preset.to_string(),
                "-c:a".to_string(), "aac".to_string(),
            ]);
        }
        "flv" => {
            let crf = ((100 - opts.quality) as f64 * 51.0 / 100.0) as u32;
            args.extend([
                "-c:v".to_string(), "libx264".to_string(),
                "-crf".to_string(), crf.to_string(),
                "-c:a".to_string(), "aac".to_string(),
                "-f".to_string(), "flv".to_string(),
            ]);
        }
        "wmv" => {
            let q = ((100 - opts.quality) as f64 * 31.0 / 100.0) as u32 + 1;
            args.extend([
                "-c:v".to_string(), "wmv2".to_string(),
                "-q:v".to_string(), q.to_string(),
                "-c:a".to_string(), "wmav2".to_string(),
            ]);
        }
        "ts" => {
            let crf = ((100 - opts.quality) as f64 * 51.0 / 100.0) as u32;
            args.extend([
                "-c:v".to_string(), "libx264".to_string(),
                "-crf".to_string(), crf.to_string(),
                "-c:a".to_string(), "aac".to_string(),
                "-f".to_string(), "mpegts".to_string(),
            ]);
        }
        _ => {}
    }

    if let Some(ref br) = opts.bitrate {
        if format != "mp4" && format != "m4v" {
            // Bitrate already set for mp4/m4v above
            args.extend(["-b:v".to_string(), br.clone()]);
        }
    }

    if !filters.is_empty() {
        args.extend(["-vf".to_string(), filters.join(",")]);
    }
}

fn build_audio_args(args: &mut Vec<String>, format: &str, opts: &FfmpegOptions) {
    let bitrate = match opts.quality {
        0..=20 => "64k",
        21..=40 => "96k",
        41..=60 => "128k",
        61..=80 => "192k",
        81..=95 => "256k",
        _ => "320k",
    };

    // Use explicit bitrate if provided
    let br = opts.bitrate.as_deref().unwrap_or(bitrate);

    // Strip video tracks
    args.push("-vn".to_string());

    match format {
        "mp3" => {
            args.extend([
                "-c:a".to_string(), "libmp3lame".to_string(),
                "-b:a".to_string(), br.to_string(),
            ]);
        }
        "wav" => {
            args.extend(["-c:a".to_string(), "pcm_s16le".to_string()]);
        }
        "flac" => {
            let compression = ((100 - opts.quality) as f64 * 12.0 / 100.0) as u32;
            args.extend([
                "-c:a".to_string(), "flac".to_string(),
                "-compression_level".to_string(), compression.to_string(),
            ]);
        }
        "ogg" => {
            args.extend([
                "-c:a".to_string(), "libvorbis".to_string(),
                "-b:a".to_string(), br.to_string(),
            ]);
        }
        "aac" => {
            args.extend([
                "-c:a".to_string(), "aac".to_string(),
                "-b:a".to_string(), br.to_string(),
            ]);
        }
        "wma" => {
            args.extend([
                "-c:a".to_string(), "wmav2".to_string(),
                "-b:a".to_string(), br.to_string(),
            ]);
        }
        "m4a" => {
            args.extend([
                "-c:a".to_string(), "aac".to_string(),
                "-b:a".to_string(), br.to_string(),
            ]);
        }
        "opus" => {
            args.extend([
                "-c:a".to_string(), "libopus".to_string(),
                "-b:a".to_string(), br.to_string(),
            ]);
        }
        _ => {}
    }
}

fn parse_progress_line(line: &str, total_duration: f64) -> Option<f64> {
    if total_duration <= 0.0 {
        return None;
    }

    if let Some(time_idx) = line.find("time=") {
        let time_str = &line[time_idx + 5..];
        let time_end = time_str.find(' ').unwrap_or(time_str.len());
        let time_str = &time_str[..time_end];

        if let Some(seconds) = parse_time_to_seconds(time_str) {
            let progress = (seconds / total_duration * 100.0).min(100.0);
            return Some(progress);
        }
    }

    None
}

fn parse_time_to_seconds(time_str: &str) -> Option<f64> {
    let parts: Vec<&str> = time_str.split(':').collect();
    if parts.len() == 3 {
        let hours: f64 = parts[0].parse().ok()?;
        let minutes: f64 = parts[1].parse().ok()?;
        let seconds: f64 = parts[2].parse().ok()?;
        Some(hours * 3600.0 + minutes * 60.0 + seconds)
    } else {
        None
    }
}

pub async fn run_ffmpeg(
    app: tauri::AppHandle,
    ffmpeg_path: &Path,
    args: Vec<String>,
    total_duration: f64,
    file_id: String,
    process_holder: std::sync::Arc<std::sync::Mutex<Option<u32>>>,
) -> Result<(), String> {
    let mut child = Command::new(ffmpeg_path)
        .args(&args)
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start FFmpeg: {}", e))?;

    if let Some(id) = child.id() {
        *process_holder.lock().unwrap() = Some(id);
    }

    let stderr = child.stderr.take().ok_or("Failed to capture FFmpeg output")?;
    let reader = BufReader::new(stderr);
    let mut lines = reader.lines();

    let start_time = std::time::Instant::now();

    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(progress) = parse_progress_line(&line, total_duration) {
            let elapsed = start_time.elapsed();
            let elapsed_str = format!(
                "{:02}:{:02}",
                elapsed.as_secs() / 60,
                elapsed.as_secs() % 60
            );

            let _ = app.emit("conversion-progress", ProgressPayload {
                file_id: file_id.clone(),
                progress,
                elapsed: elapsed_str,
            });
        }
    }

    let status = child.wait().await.map_err(|e| format!("FFmpeg process error: {}", e))?;

    *process_holder.lock().unwrap() = None;

    if status.success() {
        Ok(())
    } else {
        Err(format!("FFmpeg exited with code: {}", status.code().unwrap_or(-1)))
    }
}

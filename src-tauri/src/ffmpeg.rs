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
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FfmpegOptions {
    pub quality: u32,
    pub resolution: Option<String>,
    pub fps: Option<u32>,
    pub trim_start: Option<f64>,
    pub trim_end: Option<f64>,
    pub strip_audio: bool,
    pub bitrate: Option<String>,
    pub preset: Option<String>,
    pub gif_colors: Option<u32>,
    pub gif_dither: Option<String>,
    pub gif_width: Option<u32>,
    pub gif_fps: Option<u32>,
    pub gif_target_size_mb: Option<u32>,
    pub crop: Option<CropRect>,
    pub rotate: Option<u32>,
    pub flip_h: bool,
    pub flip_v: bool,
    pub speed: Option<f64>,
    pub volume: Option<f64>,
}

impl Default for FfmpegOptions {
    fn default() -> Self {
        Self {
            quality: 75,
            resolution: None,
            fps: None,
            trim_start: None,
            trim_end: None,
            strip_audio: false,
            bitrate: None,
            preset: None,
            gif_colors: None,
            gif_dither: None,
            gif_width: None,
            gif_fps: None,
            gif_target_size_mb: None,
            crop: None,
            rotate: None,
            flip_h: false,
            flip_v: false,
            speed: None,
            volume: None,
        }
    }
}

fn volume_active(opts: &FfmpegOptions) -> Option<f64> {
    let v = opts.volume?;
    if (v - 1.0).abs() < 1e-6 { None } else { Some(v.clamp(0.0, 8.0)) }
}

fn speed_for_audio(opts: &FfmpegOptions) -> Option<f64> {
    if opts.strip_audio { return None; }
    speed_active(opts)
}

fn build_audio_filter_chain(opts: &FfmpegOptions) -> Option<String> {
    if opts.strip_audio { return None; }
    let mut parts: Vec<String> = Vec::new();
    if let Some(s) = speed_for_audio(opts) {
        for f in split_atempo(s) {
            parts.push(format!("atempo={}", f));
        }
    }
    if let Some(v) = volume_active(opts) {
        parts.push(format!("volume={}", v));
    }
    if parts.is_empty() { None } else { Some(parts.join(",")) }
}

fn split_atempo(speed: f64) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::new();
    let mut s = speed.clamp(0.1, 10.0);
    if (s - 1.0).abs() < 1e-6 {
        return out;
    }
    while s > 2.0 {
        out.push(2.0);
        s /= 2.0;
    }
    while s < 0.5 {
        out.push(0.5);
        s /= 0.5;
    }
    out.push((s * 10000.0).round() / 10000.0);
    out
}

fn build_edit_filters(opts: &FfmpegOptions) -> Vec<String> {
    let mut filters = Vec::new();
    if let Some(ref c) = opts.crop {
        if c.w > 0 && c.h > 0 {
            filters.push(format!("crop={}:{}:{}:{}", c.w, c.h, c.x, c.y));
        }
    }
    let rot = opts.rotate.unwrap_or(0) % 360;
    match rot {
        90 => filters.push("transpose=1".to_string()),
        180 => {
            filters.push("transpose=1".to_string());
            filters.push("transpose=1".to_string());
        }
        270 => filters.push("transpose=2".to_string()),
        _ => {}
    }
    if opts.flip_h {
        filters.push("hflip".to_string());
    }
    if opts.flip_v {
        filters.push("vflip".to_string());
    }
    filters
}

fn speed_active(opts: &FfmpegOptions) -> Option<f64> {
    let s = opts.speed?;
    if (s - 1.0).abs() > 1e-6 {
        Some(s.clamp(0.1, 10.0))
    } else {
        None
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

    // Trim end: use -t (duration) since -ss before -i makes -to relative to output start
    if let Some(end) = opts.trim_end {
        if end > 0.0 {
            let start = opts.trim_start.unwrap_or(0.0);
            let duration = end - start;
            if duration > 0.0 {
                args.extend(["-t".to_string(), format!("{:.3}", duration)]);
            }
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
                args.extend([
                    "-vf".to_string(),
                    format!("scale={}", res.replace('x', ":")),
                ]);
            }
        }
        _ => {}
    }

    args.push(output_path.to_string());
    args
}

fn clamp_quality(quality: u32) -> u32 {
    quality.clamp(1, 100)
}

fn gif_color_cap(quality: u32) -> u32 {
    let q = clamp_quality(quality);
    32 + ((q - 1) * 224 / 99)
}

fn gif_palette_strategy(quality: u32) -> (&'static str, bool) {
    let q = clamp_quality(quality);
    if q >= 90 {
        ("single", true)
    } else if q >= 60 {
        ("full", false)
    } else {
        ("diff", false)
    }
}

fn build_gif_args(args: &mut Vec<String>, opts: &FfmpegOptions) {
    // Strip audio — GIF doesn't support it
    args.push("-an".to_string());

    let mut filters = build_edit_filters(opts);

    // Scale: prefer gif_width, fall back to resolution
    if let Some(width) = opts.gif_width {
        filters.push(format!("scale={}:-1:flags=lanczos", width));
    } else if let Some(ref res) = opts.resolution {
        filters.push(format!("scale={}:flags=lanczos", res.replace('x', ":")));
    }

    // FPS: prefer gif_fps, fall back to fps
    if let Some(fps) = opts.gif_fps {
        filters.push(format!("fps={}", fps));
    } else if let Some(fps) = opts.fps {
        filters.push(format!("fps={}", fps));
    }

    if let Some(s) = speed_active(opts) {
        filters.push(format!("setpts=PTS/{}", s));
    }

    // Let the generic quality slider affect GIF fidelity instead of being ignored.
    let requested_colors = opts.gif_colors.unwrap_or(256).clamp(2, 256);
    let colors = requested_colors.min(gif_color_cap(opts.quality)).max(2);
    let dither = opts.gif_dither.as_deref().unwrap_or("sierra2_4a");
    let (stats_mode, use_per_frame_palette) = gif_palette_strategy(opts.quality);

    let prefix = if filters.is_empty() {
        String::new()
    } else {
        format!("{},", filters.join(","))
    };

    let mut paletteuse = format!("paletteuse=dither={}", dither);
    if use_per_frame_palette {
        paletteuse.push_str(":new=1");
    }

    args.extend([
        "-vf".to_string(),
        format!(
            "{}split[s0][s1];[s0]palettegen=max_colors={}:stats_mode={}[p];[s1][p]{}",
            prefix, colors, stats_mode, paletteuse
        ),
    ]);

    args.extend(["-loop".to_string(), "0".to_string()]);
}

fn build_video_args(args: &mut Vec<String>, format: &str, opts: &FfmpegOptions) {
    if opts.strip_audio {
        args.push("-an".to_string());
    } else if let Some(chain) = build_audio_filter_chain(opts) {
        args.extend(["-af".to_string(), chain]);
    }

    let mut filters = build_edit_filters(opts);

    if let Some(ref res) = opts.resolution {
        filters.push(format!("scale={}", res.replace('x', ":")));
    }
    if let Some(fps) = opts.fps {
        filters.push(format!("fps={}", fps));
    }
    if let Some(s) = speed_active(opts) {
        filters.push(format!("setpts=PTS/{}", s));
    }

    let preset = opts.preset.as_deref().unwrap_or("medium");

    match format {
        "mp4" | "m4v" => {
            if let Some(ref br) = opts.bitrate {
                args.extend([
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    "-b:v".to_string(),
                    br.clone(),
                    "-preset".to_string(),
                    preset.to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                ]);
            } else {
                let crf = ((100 - opts.quality) as f64 * 51.0 / 100.0) as u32;
                args.extend([
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    "-crf".to_string(),
                    crf.to_string(),
                    "-preset".to_string(),
                    preset.to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                ]);
            }
        }
        "mkv" => {
            let crf = ((100 - opts.quality) as f64 * 51.0 / 100.0) as u32;
            args.extend([
                "-c:v".to_string(),
                "libx264".to_string(),
                "-crf".to_string(),
                crf.to_string(),
                "-preset".to_string(),
                preset.to_string(),
                "-c:a".to_string(),
                "copy".to_string(),
            ]);
        }
        "avi" => {
            let q = ((100 - opts.quality) as f64 * 31.0 / 100.0) as u32 + 1;
            args.extend([
                "-c:v".to_string(),
                "mpeg4".to_string(),
                "-q:v".to_string(),
                q.to_string(),
                "-c:a".to_string(),
                "mp3".to_string(),
            ]);
        }
        "webm" => {
            let crf = ((100 - opts.quality) as f64 * 63.0 / 100.0) as u32;
            args.extend([
                "-c:v".to_string(),
                "libvpx-vp9".to_string(),
                "-crf".to_string(),
                crf.to_string(),
                "-b:v".to_string(),
                "0".to_string(),
                "-c:a".to_string(),
                "libopus".to_string(),
            ]);
        }
        "mov" => {
            let crf = ((100 - opts.quality) as f64 * 51.0 / 100.0) as u32;
            args.extend([
                "-c:v".to_string(),
                "libx264".to_string(),
                "-crf".to_string(),
                crf.to_string(),
                "-preset".to_string(),
                preset.to_string(),
                "-c:a".to_string(),
                "aac".to_string(),
            ]);
        }
        "flv" => {
            let crf = ((100 - opts.quality) as f64 * 51.0 / 100.0) as u32;
            args.extend([
                "-c:v".to_string(),
                "libx264".to_string(),
                "-crf".to_string(),
                crf.to_string(),
                "-c:a".to_string(),
                "aac".to_string(),
                "-f".to_string(),
                "flv".to_string(),
            ]);
        }
        "wmv" => {
            let q = ((100 - opts.quality) as f64 * 31.0 / 100.0) as u32 + 1;
            args.extend([
                "-c:v".to_string(),
                "wmv2".to_string(),
                "-q:v".to_string(),
                q.to_string(),
                "-c:a".to_string(),
                "wmav2".to_string(),
            ]);
        }
        "ts" => {
            let crf = ((100 - opts.quality) as f64 * 51.0 / 100.0) as u32;
            args.extend([
                "-c:v".to_string(),
                "libx264".to_string(),
                "-crf".to_string(),
                crf.to_string(),
                "-c:a".to_string(),
                "aac".to_string(),
                "-f".to_string(),
                "mpegts".to_string(),
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

    if let Some(chain) = build_audio_filter_chain(opts) {
        args.extend(["-af".to_string(), chain]);
    }

    match format {
        "mp3" => {
            args.extend([
                "-c:a".to_string(),
                "libmp3lame".to_string(),
                "-b:a".to_string(),
                br.to_string(),
            ]);
        }
        "wav" => {
            args.extend(["-c:a".to_string(), "pcm_s16le".to_string()]);
        }
        "flac" => {
            let compression = ((100 - opts.quality) as f64 * 12.0 / 100.0) as u32;
            args.extend([
                "-c:a".to_string(),
                "flac".to_string(),
                "-compression_level".to_string(),
                compression.to_string(),
            ]);
        }
        "ogg" => {
            args.extend([
                "-c:a".to_string(),
                "libvorbis".to_string(),
                "-b:a".to_string(),
                br.to_string(),
            ]);
        }
        "aac" => {
            args.extend([
                "-c:a".to_string(),
                "aac".to_string(),
                "-b:a".to_string(),
                br.to_string(),
            ]);
        }
        "wma" => {
            args.extend([
                "-c:a".to_string(),
                "wmav2".to_string(),
                "-b:a".to_string(),
                br.to_string(),
            ]);
        }
        "m4a" => {
            args.extend([
                "-c:a".to_string(),
                "aac".to_string(),
                "-b:a".to_string(),
                br.to_string(),
            ]);
        }
        "opus" => {
            args.extend([
                "-c:a".to_string(),
                "libopus".to_string(),
                "-b:a".to_string(),
                br.to_string(),
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

    let stderr = child
        .stderr
        .take()
        .ok_or("Failed to capture FFmpeg output")?;
    let reader = BufReader::new(stderr);
    let mut lines = reader.lines();

    let start_time = std::time::Instant::now();
    let mut last_error_line = String::new();

    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(progress) = parse_progress_line(&line, total_duration) {
            let elapsed = start_time.elapsed();
            let elapsed_str = format!(
                "{:02}:{:02}",
                elapsed.as_secs() / 60,
                elapsed.as_secs() % 60
            );

            let _ = app.emit(
                "conversion-progress",
                ProgressPayload {
                    file_id: file_id.clone(),
                    progress,
                    elapsed: elapsed_str,
                },
            );
        }
        // Keep the last non-empty line for error reporting
        let trimmed = line.trim().to_string();
        if !trimmed.is_empty() {
            last_error_line = trimmed;
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("FFmpeg process error: {}", e))?;

    *process_holder.lock().unwrap() = None;

    if status.success() {
        Ok(())
    } else {
        let detail = if last_error_line.is_empty() {
            String::new()
        } else {
            format!(": {}", last_error_line)
        };
        Err(format!(
            "FFmpeg failed (code {}){}",
            status.code().unwrap_or(-1),
            detail
        ))
    }
}

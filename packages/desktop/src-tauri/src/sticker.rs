//! Discord sticker / emoji "stealer" staging + transcode.
//!
//! The stealer fetches media (Discord/Tenor/Giphy CDNs, or a Lottie render
//! handed over as raw bytes) into a per-job staging dir under
//! `%TEMP%/convertx-sticker/<job>/`, transcodes it with the same bundled
//! FFmpeg the Convert tab uses, then moves the winning file into the user's
//! Downloads dir.
//!
//! Every path that crosses the IPC boundary is canonicalized and checked to be
//! inside the staging root before it is read or moved, and file ids / names
//! are collapsed to a single path component (no separators, no `..`) so a
//! crafted id can't escape the root.
//!
//! Transcodes register their PID in the SAME per-job download registry that
//! `cancel_download` kills, so `cancelDownload(fileId | null)` cancels an
//! in-flight sticker conversion exactly like a URL download — independent of
//! the Convert tab's own single FFmpeg slot.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tauri::ipc::{InvokeBody, Request};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::convert::AppState;

/// Output containers the transcoder will write to. APNG is produced through
/// the `png` extension with `-f apng` in the caller-supplied output args.
const OUTPUT_EXTS: &[&str] = &["gif", "png", "webp", "mp4", "jpg"];

// ── Paths + sanitising ───────────────────────────────────────────────────────

fn sticker_root() -> PathBuf {
    std::env::temp_dir().join(crate::downloader::STAGING_ROOT_STICKER)
}

/// The staging sub-directory for one job. `sanitize_job_id` keeps only safe
/// chars and appends an FNV hash, so the name is a single component, is stable
/// for a given `file_id`, and never collides with another id.
fn staging_dir_for(file_id: &str) -> PathBuf {
    sticker_root().join(crate::downloader::sanitize_job_id(file_id))
}

/// Collapse a caller-supplied file name to a single, safe path component.
/// Takes only the final path segment (so embedded separators are dropped),
/// strips control + Windows-illegal chars, caps the length, and rejects the
/// `.` / `..` traversal names.
fn sanitize_name(name: &str) -> String {
    const MAX: usize = 120;
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        .take(MAX)
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "sticker".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Give `name` the source file's extension when it has none, so a finalized
/// file stays openable even if the caller passed a bare stem.
fn ensure_ext(name: String, src: &Path) -> String {
    if Path::new(&name).extension().is_some() {
        return name;
    }
    match src.extension().and_then(|e| e.to_str()) {
        Some(ext) if !ext.is_empty() => format!("{}.{}", name, ext),
        _ => name,
    }
}

/// Canonicalize `path` and confirm it resolves inside the sticker staging
/// root. A crafted `input_path` must never let the transcoder read a file
/// elsewhere on disk.
fn canonical_within_root(path: &Path) -> Result<PathBuf, String> {
    let root = sticker_root();
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Failed to prepare staging area: {}", e))?;
    let canon_root = std::fs::canonicalize(&root)
        .map_err(|e| format!("Failed to resolve staging area: {}", e))?;
    let canon = std::fs::canonicalize(path)
        .map_err(|_| "That file is no longer available.".to_string())?;
    if canon.starts_with(&canon_root) {
        Ok(canon)
    } else {
        Err("Refusing to touch a file outside the sticker staging area.".to_string())
    }
}

/// Like `canonical_within_root`, but scoped to one job's sub-directory — the
/// only place that job's staged media and outputs ever live.
fn canonical_within_job(path: &Path, file_id: &str) -> Result<PathBuf, String> {
    let dir = staging_dir_for(file_id);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to prepare staging area: {}", e))?;
    let canon_dir = std::fs::canonicalize(&dir)
        .map_err(|e| format!("Failed to resolve staging area: {}", e))?;
    let canon = std::fs::canonicalize(path)
        .map_err(|_| "That staged file is no longer available.".to_string())?;
    if canon.starts_with(&canon_dir) {
        Ok(canon)
    } else {
        Err("Refusing to move a file from outside the sticker staging area.".to_string())
    }
}

// ── Staging commands ─────────────────────────────────────────────────────────

/// Create (and return) the staging dir for `file_id`. The fetch path hands
/// this to `download_direct` as its `destDir`.
#[tauri::command]
pub fn sticker_staging_dir(file_id: String) -> Result<String, String> {
    let dir = staging_dir_for(&file_id);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create staging directory: {}", e))?;
    Ok(dir.to_string_lossy().to_string())
}

/// Write a raw binary body (e.g. a Lottie-rendered APNG) into the job's
/// staging dir and return its path. The JS side calls
/// `invoke('write_staging_file', bytes, {headers:{'x-file-id':id,'x-file-name':name}})`.
#[tauri::command]
pub fn write_staging_file(request: Request<'_>) -> Result<String, String> {
    let file_id = request
        .headers()
        .get("x-file-id")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Missing x-file-id header".to_string())?
        .to_string();
    let file_name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("staged.bin");

    let bytes: &[u8] = match request.body() {
        InvokeBody::Raw(data) => data.as_slice(),
        _ => return Err("Expected a raw binary body".to_string()),
    };

    let dir = staging_dir_for(&file_id);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create staging directory: {}", e))?;
    let path = dir.join(sanitize_name(file_name));
    std::fs::write(&path, bytes)
        .map_err(|e| format!("Failed to write staging file: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// Remove a job's staging sub-directory. Best effort — a missing dir is
/// already "cleared".
#[tauri::command]
pub fn clear_staging(file_id: String) -> Result<(), String> {
    let dir = staging_dir_for(&file_id);
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}

// ── Finalize (move the winning output into Downloads) ────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizePayload {
    pub output_path: String,
    pub output_size: u64,
}

/// Move a finished staged file into `dest_dir` (default: the user's Downloads
/// dir, same as `download_direct`) under a sanitized name, appending " (2)",
/// " (3)", … on collision. Leaves the rest of the staging dir in place for a
/// later `clear_staging`.
#[tauri::command]
pub fn finalize_staged_file(
    file_id: String,
    staging_path: String,
    dest_dir: Option<String>,
    file_name: String,
) -> Result<FinalizePayload, String> {
    let src = canonical_within_job(Path::new(&staging_path), &file_id)?;

    let dest = match dest_dir.as_deref() {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => crate::downloader::dirs_downloads_or_cwd(),
    };
    std::fs::create_dir_all(&dest)
        .map_err(|e| format!("Failed to create output directory: {}", e))?;

    let final_name = ensure_ext(sanitize_name(&file_name), &src);
    let target = crate::convert::resolve_collision(dest.join(&final_name));

    // rename across the temp→output volume boundary falls back to copy+delete,
    // mirroring downloader::move_with_collision.
    match std::fs::rename(&src, &target) {
        Ok(()) => {}
        Err(_) => {
            std::fs::copy(&src, &target)
                .map_err(|e| format!("Failed to move sticker into output folder: {}", e))?;
            let _ = std::fs::remove_file(&src);
        }
    }

    let output_size = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    Ok(FinalizePayload {
        output_path: target.to_string_lossy().to_string(),
        output_size,
    })
}

// ── Transcode ────────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscodePayload {
    pub output_path: String,
    pub output_size: u64,
    pub cancelled: bool,
}

impl TranscodePayload {
    fn cancelled() -> Self {
        Self {
            output_path: String::new(),
            output_size: 0,
            cancelled: true,
        }
    }
}

/// Caller-supplied FFmpeg args are inserted verbatim around a fixed `-i`, so a
/// handful of flags that could redirect the input/output or read a script off
/// disk are rejected outright.
fn validate_ffmpeg_arg(arg: &str) -> Result<(), String> {
    if arg == "-i" || arg == "-y" {
        return Err(format!("Argument '{}' is not allowed.", arg));
    }
    if arg.starts_with("-filter_script")
        || arg.starts_with("-filter_complex_script")
        || arg.starts_with("-dump")
    {
        return Err(format!("Argument '{}' is not allowed.", arg));
    }
    Ok(())
}

/// Last `n` characters of `s` (trimmed) — the FFmpeg stderr tail attached to a
/// failure. Bounded input, so collecting the chars is cheap.
fn tail_chars(s: &str, n: usize) -> String {
    let s = s.trim();
    let count = s.chars().count();
    if count <= n {
        return s.to_string();
    }
    s.chars().skip(count - n).collect()
}

/// Run `ffmpeg -y -hide_banner -loglevel error <input_args> -i <input>
/// <output_args> <out>` into the job's staging dir. The input must already be
/// inside the staging root; the output ext is restricted to `OUTPUT_EXTS`.
///
/// The child PID is registered under `file_id` in the download registry so
/// `cancel_download` kills it; a cancel is surfaced as `cancelled: true` (with
/// the partial output removed), never as an error.
#[tauri::command]
pub async fn ffmpeg_transcode(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    file_id: String,
    input_path: String,
    input_args: Vec<String>,
    output_args: Vec<String>,
    output_ext: String,
) -> Result<TranscodePayload, String> {
    let ext = output_ext.trim().to_lowercase();
    if !OUTPUT_EXTS.contains(&ext.as_str()) {
        return Err(format!("Unsupported output type: {}", output_ext));
    }
    for arg in input_args.iter().chain(output_args.iter()) {
        validate_ffmpeg_arg(arg)?;
    }

    let input = canonical_within_root(Path::new(&input_path))?;

    let dir = staging_dir_for(&file_id);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create staging directory: {}", e))?;

    // One fresh output file per attempt so the size ladder can compare
    // candidates without clobbering a previous one.
    let mut n = 1u32;
    let output_path = loop {
        let candidate = dir.join(format!("out-{}.{}", n, ext));
        if !candidate.exists() {
            break candidate;
        }
        n += 1;
    };
    let output_path_str = output_path.to_string_lossy().to_string();

    let pids = state.downloads.clone();
    let cancelled = state.cancelled_downloads.clone();
    let active_jobs = state.active_jobs.clone();

    // Register BEFORE the first await — a cancel-all arriving before the child
    // spawns still finds the job in active_jobs and marks it cancelled.
    active_jobs.lock().unwrap().insert(file_id.clone());
    let res = run_transcode(
        &app,
        &file_id,
        &input,
        &input_args,
        &output_args,
        &output_path,
        &output_path_str,
        &pids,
        &cancelled,
    )
    .await;
    active_jobs.lock().unwrap().remove(&file_id);
    // A cancel that lands after the run drained the flag must not linger and
    // cancel the next transcode with the same id.
    cancelled.lock().unwrap().remove(&file_id);
    res
}

#[allow(clippy::too_many_arguments)]
async fn run_transcode(
    app: &tauri::AppHandle,
    file_id: &str,
    input: &Path,
    input_args: &[String],
    output_args: &[String],
    output_path: &Path,
    output_path_str: &str,
    pids: &Arc<Mutex<HashMap<String, u32>>>,
    cancelled: &Arc<Mutex<HashSet<String>>>,
) -> Result<TranscodePayload, String> {
    // Last gate before the child exists: a cancel that arrived during setup has
    // no PID to kill, so stop here.
    if cancelled.lock().unwrap().remove(file_id) {
        return Ok(TranscodePayload::cancelled());
    }

    let ffmpeg_path = crate::ffmpeg::get_ffmpeg_path(app);

    let mut args: Vec<String> = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
    ];
    args.extend(input_args.iter().cloned());
    args.push("-i".to_string());
    args.push(input.to_string_lossy().to_string());
    args.extend(output_args.iter().cloned());
    args.push(output_path_str.to_string());

    let mut cmd = Command::new(&ffmpeg_path);
    cmd.args(&args)
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .stdin(Stdio::null());
    crate::downloader::no_window(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start FFmpeg: {}", e))?;

    if let Some(id) = child.id() {
        pids.lock().unwrap().insert(file_id.to_string(), id);
    }

    let stderr = child
        .stderr
        .take()
        .ok_or("Failed to capture FFmpeg output")?;
    let mut stderr_buf = String::new();
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            stderr_buf.push_str(trimmed);
            stderr_buf.push('\n');
        }
        // Bound memory on a runaway log — keep only the tail.
        if stderr_buf.len() > 4096 {
            let cut = stderr_buf.len() - 2048;
            let mut idx = cut;
            while idx < stderr_buf.len() && !stderr_buf.is_char_boundary(idx) {
                idx += 1;
            }
            stderr_buf = stderr_buf[idx..].to_string();
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("FFmpeg process error: {}", e))?;

    pids.lock().unwrap().remove(file_id);
    let was_cancelled = cancelled.lock().unwrap().remove(file_id);

    // Cancel wins over any exit status — a killed FFmpeg exits non-zero.
    if was_cancelled {
        let _ = std::fs::remove_file(output_path);
        return Ok(TranscodePayload::cancelled());
    }

    if !status.success() {
        let _ = std::fs::remove_file(output_path);
        let tail = tail_chars(&stderr_buf, 600);
        let detail = if tail.is_empty() {
            String::new()
        } else {
            format!(": {}", tail)
        };
        return Err(format!(
            "FFmpeg failed (code {}){}",
            status.code().unwrap_or(-1),
            detail
        ));
    }

    let output_size = std::fs::metadata(output_path).map(|m| m.len()).unwrap_or(0);
    // FFmpeg can exit 0 while writing nothing (bad filter graph) — a 0-byte
    // "success" is a failure.
    if output_size == 0 {
        let _ = std::fs::remove_file(output_path);
        let tail = tail_chars(&stderr_buf, 600);
        let detail = if tail.is_empty() {
            String::new()
        } else {
            format!(" {}", tail)
        };
        return Err(format!("FFmpeg produced no output (0 bytes).{}", detail));
    }

    Ok(TranscodePayload {
        output_path: output_path_str.to_string(),
        output_size,
        cancelled: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_name_keeps_only_a_safe_basename() {
        assert_eq!(sanitize_name("emoji-catjam-123.gif"), "emoji-catjam-123.gif");
        assert_eq!(sanitize_name(r"..\..\Windows\evil.png"), "evil.png");
        assert_eq!(sanitize_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_name("a:b*c?d\"e<f>g|h.png"), "abcdefgh.png");
        assert_eq!(sanitize_name(".."), "sticker");
        assert_eq!(sanitize_name("dir/"), "sticker");
        assert_eq!(sanitize_name("   "), "sticker");
        assert_eq!(sanitize_name(&"x".repeat(500)).len(), 120);
    }

    #[test]
    fn ffmpeg_args_that_redirect_io_are_rejected() {
        for bad in ["-i", "-y", "-filter_script:v", "-filter_complex_script", "-dump_attachment"] {
            assert!(validate_ffmpeg_arg(bad).is_err(), "{bad} should be rejected");
        }
        for ok in ["-vf", "scale=320:320", "-loop", "0", "-plays", "-f", "apng", "-t", "5"] {
            assert!(validate_ffmpeg_arg(ok).is_ok(), "{ok} should be allowed");
        }
    }
}

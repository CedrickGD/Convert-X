//! Generic HTTP transport for the shared-JS probers + the direct-CDN download
//! lane. The webview enforces CORS, so prober requests (Twitter syndication,
//! Instagram private API) must go through Rust. reqwest is built WITHOUT a
//! cookie jar on purpose: cookies.txt is the single source of truth and the
//! JS side passes an explicit `Cookie` header when one is needed.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Emitter;

use crate::downloader::DownloadProgressPayload;

#[derive(Clone, Serialize)]
pub struct HttpResponsePayload {
    pub status: u16,
    pub body: String,
    /// Response headers, keys lowercased. Repeated headers joined with ", ".
    pub headers: HashMap<String, String>,
}

/// reqwest's `Display` prints only the kind + url and never the source, so a
/// timeout would otherwise read "error sending request for url (…)". The
/// shared probers match /timed?\s?-?out|timeout/i on this message to show
/// their friendly "took too long" copy, so the literal "timed out" is part of
/// the command contract. Dropping the reqwest string on that path also keeps
/// internal API URLs out of the error log.
fn net_err(prefix: &str, timeout_ms: u64, e: reqwest::Error) -> String {
    if e.is_timeout() {
        format!("Request timed out after {}ms", timeout_ms)
    } else {
        format!("{}: {}", prefix, e)
    }
}

/// Generic HTTP request for the shared probers. Resolves on ANY HTTP status —
/// rejects only on network errors / timeouts, mirroring fetch() semantics.
#[tauri::command]
pub async fn http_request(
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<HttpResponsePayload, String> {
    let timeout_ms = timeout_ms.unwrap_or(15_000);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("HTTP client init: {}", e))?;

    let method = reqwest::Method::from_bytes(
        method.as_deref().unwrap_or("GET").to_uppercase().as_bytes(),
    )
    .map_err(|e| format!("Invalid HTTP method: {}", e))?;

    let mut req = client.request(method, &url);
    if let Some(hs) = headers {
        for (k, v) in hs {
            req = req.header(&k, &v);
        }
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    let res = req
        .send()
        .await
        .map_err(|e| net_err("Request failed", timeout_ms, e))?;

    let status = res.status().as_u16();
    let mut out_headers: HashMap<String, String> = HashMap::new();
    for (name, value) in res.headers().iter() {
        let key = name.as_str().to_lowercase();
        let val = String::from_utf8_lossy(value.as_bytes()).to_string();
        out_headers
            .entry(key)
            .and_modify(|existing| {
                existing.push_str(", ");
                existing.push_str(&val);
            })
            .or_insert(val);
    }

    let body = res
        .text()
        .await
        .map_err(|e| net_err("Failed to read response body", timeout_ms, e))?;

    Ok(HttpResponsePayload {
        status,
        body,
        headers: out_headers,
    })
}

/// Typed result of a direct-CDN download. `status` is "done", "cancelled" or
/// "http_error" — none of these reject the invoke; only network/filesystem
/// failures do.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectDownloadResult {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
}

impl DirectDownloadResult {
    fn done(path: String) -> Self {
        Self { status: "done".to_string(), output_path: Some(path), http_status: None }
    }
    fn cancelled() -> Self {
        Self { status: "cancelled".to_string(), output_path: None, http_status: None }
    }
    fn http_error(code: u16) -> Self {
        Self { status: "http_error".to_string(), output_path: None, http_status: Some(code) }
    }
}

fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let trimmed = cleaned.trim().to_string();
    if trimmed.is_empty() {
        "download".to_string()
    } else {
        trimmed
    }
}

/// Direct-CDN HTTPS download: stream a prober-supplied media URL to a per-job
/// staging file, then move it into dest_dir with a collision-suffixed name.
/// Non-2xx responses return a typed http_error and the body is never saved as
/// media. Progress rides the same `download-progress` event as yt-dlp, with
/// -1 when the length is unknown.
#[tauri::command]
pub async fn download_direct(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::convert::AppState>,
    file_id: String,
    url: String,
    dest_dir: String,
    file_name: String,
    headers: Option<HashMap<String, String>>,
) -> Result<DirectDownloadResult, String> {
    let active_jobs = state.active_jobs.clone();
    let cancelled = state.cancelled_downloads.clone();

    active_jobs.lock().unwrap().insert(file_id.clone());
    let res = download_direct_inner(&app, &file_id, &url, &dest_dir, &file_name, headers, &cancelled).await;
    active_jobs.lock().unwrap().remove(&file_id);
    cancelled.lock().unwrap().remove(&file_id);
    res
}

fn is_cancelled(cancelled: &Arc<Mutex<HashSet<String>>>, file_id: &str) -> bool {
    cancelled.lock().unwrap().contains(file_id)
}

/// Idle-read budget for the direct lane. Not an overall deadline.
const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
/// How often a stalled read is interrupted to re-check the cancel flag.
/// `Response::chunk` keeps its state in the response, so dropping a pending
/// poll neither loses bytes nor resets reqwest's read timeout.
const CANCEL_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

async fn download_direct_inner(
    app: &tauri::AppHandle,
    file_id: &str,
    url: &str,
    dest_dir: &str,
    file_name: &str,
    headers: Option<HashMap<String, String>>,
    cancelled: &Arc<Mutex<HashSet<String>>>,
) -> Result<DirectDownloadResult, String> {
    if is_cancelled(cancelled, file_id) {
        return Ok(DirectDownloadResult::cancelled());
    }

    // No OVERALL timeout: a large media file may legitimately take minutes.
    // A per-read timeout is different — it resets on every received frame, so
    // it only fires when the socket has gone silent, which otherwise hangs the
    // whole batch forever (a blackholed CDN keeps the TCP connection alive).
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(READ_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("HTTP client init: {}", e))?;

    let mut req = client.get(url);
    if let Some(hs) = headers {
        for (k, v) in hs {
            req = req.header(&k, &v);
        }
    }

    let mut res = req
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !res.status().is_success() {
        // A 403/404 error page must never be saved as media.
        return Ok(DirectDownloadResult::http_error(res.status().as_u16()));
    }

    let dest_dir_path = PathBuf::from(dest_dir);
    std::fs::create_dir_all(&dest_dir_path)
        .map_err(|e| format!("Failed to create output directory: {}", e))?;

    let staging_dir = std::env::temp_dir()
        .join(crate::downloader::STAGING_ROOT_DIRECT)
        .join(crate::downloader::sanitize_job_id(file_id));
    let _ = std::fs::remove_dir_all(&staging_dir);
    std::fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("Failed to create staging directory: {}", e))?;
    let safe_name = sanitize_file_name(file_name);
    let staging_file = staging_dir.join(&safe_name);

    let total = res.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut last_pct: f64 = -2.0;
    let start_time = std::time::Instant::now();

    let mut file = match std::fs::File::create(&staging_file) {
        Ok(f) => f,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging_dir);
            return Err(format!("Failed to create file: {}", e));
        }
    };

    let mut failure: Option<String> = None;
    let mut was_cancelled = false;
    loop {
        if is_cancelled(cancelled, file_id) {
            was_cancelled = true;
            break;
        }
        let chunk = match tokio::time::timeout(CANCEL_POLL_INTERVAL, res.chunk()).await {
            // Stalled read: go back to the top so Cancel takes effect within
            // seconds instead of after the full read timeout.
            Err(_) => continue,
            Ok(Ok(c)) => c,
            Ok(Err(e)) => {
                failure = Some(if e.is_timeout() {
                    format!(
                        "Download stalled — no data for {}s.",
                        READ_TIMEOUT.as_secs()
                    )
                } else {
                    format!("Download read error: {}", e)
                });
                break;
            }
        };
        let Some(chunk) = chunk else { break; };
        if let Err(e) = file.write_all(&chunk) {
            failure = Some(format!("Failed to write file: {}", e));
            break;
        }
        downloaded += chunk.len() as u64;

        let progress = if total > 0 {
            ((downloaded as f64 / total as f64) * 100.0).min(100.0)
        } else {
            -1.0
        };
        let should_emit = if total > 0 {
            progress - last_pct >= 1.0 || progress >= 100.0
        } else {
            last_emit.elapsed().as_millis() >= 500
        };
        if should_emit {
            last_pct = progress;
            last_emit = std::time::Instant::now();
            let elapsed = start_time.elapsed();
            let _ = app.emit(
                "download-progress",
                DownloadProgressPayload {
                    file_id: file_id.to_string(),
                    progress,
                    elapsed: format!(
                        "{:02}:{:02}",
                        elapsed.as_secs() / 60,
                        elapsed.as_secs() % 60
                    ),
                    stage: "downloading".to_string(),
                },
            );
        }
    }
    if failure.is_none() && !was_cancelled {
        if let Err(e) = file.flush() {
            failure = Some(format!("Failed to flush file: {}", e));
        }
    }
    drop(file);

    // Never leave a partial file behind — cancel or transfer error.
    if was_cancelled {
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Ok(DirectDownloadResult::cancelled());
    }
    if let Some(e) = failure {
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err(e);
    }

    // An empty 2xx body (Content-Length: 0, a 204, or a zero-length
    // close-delimited response) is never valid media — the conversion lane
    // rejects 0-byte output the same way.
    if downloaded == 0 {
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err("Download produced no data (0 bytes).".to_string());
    }

    // Truncated transfers must not be reported as complete media.
    if total > 0 && downloaded != total {
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err(format!(
            "Download was incomplete ({} of {} bytes).",
            downloaded, total
        ));
    }

    let moved = crate::downloader::move_with_collision(&staging_file, &dest_dir_path);
    let _ = std::fs::remove_dir_all(&staging_dir);
    let final_path = moved?;

    Ok(DirectDownloadResult::done(
        final_path.to_string_lossy().to_string(),
    ))
}

/// Media bytes fetched for the Discord sticker/emoji stealer. The webview
/// enforces CORS, so the resolver's byte fetches (Discord/Tenor/Giphy CDNs)
/// route through Rust the same way the probers do. Bytes come back base64 so
/// the JSON IPC channel stays text; the JS side decodes with `atob`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchBytesPayload {
    pub status: u16,
    pub content_type: Option<String>,
    pub final_url: String,
    /// Response headers, keys lowercased. Repeated headers joined with ", ".
    pub headers: HashMap<String, String>,
    pub data_base64: String,
    /// Reading stopped at the byte cap — the body is incomplete.
    pub truncated: bool,
}

/// 8 MiB default read cap (a sticker/emoji is far smaller), 64 MiB hard cap so
/// a bad URL can't buffer the whole process into memory.
const FETCH_DEFAULT_MAX_BYTES: u64 = 8 * 1024 * 1024;
const FETCH_HARD_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// Standard base64 (RFC 4648, padded). Hand-written on purpose: `base64` is a
/// transitive dep only, and the contract says to keep Cargo.toml untouched.
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((n >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(n & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// Fetch a URL and return its bytes (base64) with status/headers. Resolves on
/// ANY HTTP status — rejects only on network errors / timeouts, like fetch().
/// Reading stops at `max_bytes` (default 8 MiB, hard cap 64 MiB) with
/// `truncated = true`, so an oversized or endless body can't exhaust memory.
#[tauri::command]
pub async fn http_fetch_bytes(
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    max_bytes: Option<u64>,
    timeout_ms: Option<u64>,
) -> Result<FetchBytesPayload, String> {
    let timeout_ms = timeout_ms.unwrap_or(30_000);
    let max = max_bytes
        .unwrap_or(FETCH_DEFAULT_MAX_BYTES)
        .min(FETCH_HARD_MAX_BYTES);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("HTTP client init: {}", e))?;

    let method = reqwest::Method::from_bytes(
        method.as_deref().unwrap_or("GET").to_uppercase().as_bytes(),
    )
    .map_err(|e| format!("Invalid HTTP method: {}", e))?;

    let mut req = client.request(method, &url);
    if let Some(hs) = headers {
        for (k, v) in hs {
            req = req.header(&k, &v);
        }
    }

    let mut res = req
        .send()
        .await
        .map_err(|e| net_err("Request failed", timeout_ms, e))?;

    let status = res.status().as_u16();
    let final_url = res.url().to_string();
    let content_type = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let mut out_headers: HashMap<String, String> = HashMap::new();
    for (name, value) in res.headers().iter() {
        let key = name.as_str().to_lowercase();
        let val = String::from_utf8_lossy(value.as_bytes()).to_string();
        out_headers
            .entry(key)
            .and_modify(|existing| {
                existing.push_str(", ");
                existing.push_str(&val);
            })
            .or_insert(val);
    }

    // Stream the body so an oversized response is capped instead of buffered
    // whole. `chunk()` keeps reqwest's read timeout; the overall client timeout
    // still bounds the total transfer.
    let cap = max as usize;
    let mut data: Vec<u8> = Vec::new();
    let mut truncated = false;
    loop {
        match res.chunk().await {
            Ok(Some(chunk)) => {
                let remaining = cap.saturating_sub(data.len());
                if chunk.len() > remaining {
                    data.extend_from_slice(&chunk[..remaining]);
                    truncated = true;
                    break;
                }
                data.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => return Err(net_err("Failed to read response body", timeout_ms, e)),
        }
    }

    let data_base64 = base64_encode(&data);

    Ok(FetchBytesPayload {
        status,
        content_type,
        final_url,
        headers: out_headers,
        data_base64,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::base64_encode;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        let cases: [(&[u8], &str); 7] = [
            (b"", ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (b"foob", "Zm9vYg=="),
            (b"fooba", "Zm9vYmE="),
            (b"foobar", "Zm9vYmFy"),
        ];
        for (input, want) in cases {
            assert_eq!(base64_encode(input), want);
        }
        // High bytes must survive intact (the reason this exists instead of http_request's lossy text).
        assert_eq!(base64_encode(&[0xff, 0x80, 0x00, 0xfe]), "/4AA/g==");
    }
}

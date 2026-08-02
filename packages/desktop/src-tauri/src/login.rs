//! WebView login flow.
//!
//! Opens a real browser window on the platform's login page, polls the
//! webview cookie store (tauri's `cookies_for_url` reads WebView2's
//! ICoreWebView2CookieManager, which includes HttpOnly cookies like
//! `sessionid`/`auth_token`) every ~750ms until every required cookie is
//! present, harvests ALL cookies for the platform's origins, closes the
//! window and returns them. The JS side merges them into the canonical
//! cookies.txt.
//!
//! Fresh session per call: WebView2 shares one profile per app identifier,
//! which would make switching accounts impossible — so every invocation gets
//! its own `data_directory` (old ones are cleaned up best-effort; the most
//! recent one stays locked by WebView2 until the process exits).

use serde::Serialize;
use std::collections::HashSet;
use tauri::webview::cookie::Expiration;
use tauri::Manager;

pub(crate) const LOGIN_LABEL: &str = "platform-login";

/// The only URLs a login window may load, mirroring `LOGIN_PLATFORMS` in
/// `packages/shared/src/lib/loginPlatforms.js`. The login webview loads a
/// REMOTE origin, so the URL must never be caller-controlled: a compromised or
/// buggy frontend would otherwise turn any origin into a privileged window.
/// Add a platform here whenever one is added to the JS registry.
const LOGIN_URLS: &[(&str, &str)] = &[
    ("instagram", "https://www.instagram.com/accounts/login/"),
    (
        "youtube",
        "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.youtube.com%2F",
    ),
    ("tiktok", "https://www.tiktok.com/login"),
    ("twitter", "https://x.com/i/flow/login"),
    ("reddit", "https://www.reddit.com/login/"),
    ("facebook", "https://www.facebook.com/login/"),
    ("linkedin", "https://www.linkedin.com/login"),
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarvestedCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    /// Unix seconds, or None for session cookies.
    pub expires: Option<i64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    /// "ok" | "cancelled"
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cookies: Option<Vec<HarvestedCookie>>,
}

fn harvest(cookie: &tauri::webview::Cookie<'_>) -> HarvestedCookie {
    HarvestedCookie {
        name: cookie.name().to_string(),
        value: cookie.value().to_string(),
        domain: cookie.domain().unwrap_or_default().to_string(),
        path: cookie.path().unwrap_or("/").to_string(),
        secure: cookie.secure().unwrap_or(false),
        http_only: cookie.http_only().unwrap_or(false),
        expires: match cookie.expires() {
            Some(Expiration::DateTime(dt)) => Some(dt.unix_timestamp()),
            _ => None,
        },
    }
}

/// Open a login window for a platform, wait until all `required_cookies` are
/// present on the given origins, harvest every cookie for those origins and
/// return them. The user closing the window early resolves as
/// `{status:"cancelled"}` — never an error. One login window at a time.
#[tauri::command]
pub async fn open_login_window(
    app: tauri::AppHandle,
    platform_key: String,
    login_url: String,
    cookie_origins: Vec<String>,
    required_cookies: Vec<String>,
    user_agent: Option<String>,
) -> Result<LoginResult, String> {
    if app.get_webview_window(LOGIN_LABEL).is_some() {
        return Err("A login window is already open. Finish or close it first.".to_string());
    }

    let expected = LOGIN_URLS
        .iter()
        .find(|(key, _)| *key == platform_key)
        .map(|(_, url)| *url)
        .ok_or_else(|| format!("Unknown login platform: {}", platform_key))?;
    if login_url.trim() != expected {
        return Err(format!("Login URL is not the known one for {}.", platform_key));
    }

    let parsed = tauri::Url::parse(expected).map_err(|e| format!("Invalid login URL: {}", e))?;

    let origins: Vec<tauri::Url> = cookie_origins
        .iter()
        .filter_map(|o| tauri::Url::parse(o).ok())
        .collect();
    if origins.is_empty() {
        return Err("No valid cookie origins supplied.".to_string());
    }

    // Fresh session per call so switching accounts is possible. Old profile
    // dirs are cleaned up best-effort — the one used by the previous login
    // window may still be locked by WebView2 and will be swept next time.
    let profiles_root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("No app data directory available: {}", e))?
        .join("login-profiles");
    if let Ok(entries) = std::fs::read_dir(&profiles_root) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    let profile_dir = profiles_root.join(format!(
        "s{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&profile_dir)
        .map_err(|e| format!("Failed to create login profile directory: {}", e))?;

    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        LOGIN_LABEL,
        tauri::WebviewUrl::External(parsed),
    )
    .title(format!("Log in to {}", platform_key))
    .inner_size(500.0, 760.0)
    .data_directory(profile_dir);

    if let Some(ua) = user_agent.as_deref().filter(|s| !s.trim().is_empty()) {
        builder = builder.user_agent(ua);
    }

    let _window = builder
        .build()
        .map_err(|e| format!("Failed to open login window: {}", e))?;

    let required: Vec<String> = required_cookies
        .iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();
    if required.is_empty() {
        if let Some(win) = app.get_webview_window(LOGIN_LABEL) {
            let _ = win.close();
        }
        return Err("No required cookies supplied — nothing to wait for.".to_string());
    }

    loop {
        tokio::time::sleep(std::time::Duration::from_millis(750)).await;

        // User closed the window before finishing the login.
        let Some(win) = app.get_webview_window(LOGIN_LABEL) else {
            return Ok(LoginResult { status: "cancelled".to_string(), cookies: None });
        };

        // Gather everything the webview holds for the platform origins.
        // NOTE: `cookies_for_url` must run off the main thread on Windows —
        // async commands run on the runtime's worker threads, which is safe.
        let mut all: Vec<HarvestedCookie> = Vec::new();
        for origin in &origins {
            if let Ok(cookies) = win.cookies_for_url(origin.clone()) {
                for c in &cookies {
                    all.push(harvest(c));
                }
            }
        }

        let have: HashSet<&str> = all.iter().map(|c| c.name.as_str()).collect();
        if !required.iter().all(|r| have.contains(r.as_str())) {
            continue;
        }

        // Dedupe (the same cookie shows up once per matching origin).
        let mut seen: HashSet<(String, String, String)> = HashSet::new();
        let mut cookies: Vec<HarvestedCookie> = Vec::new();
        for c in all {
            let key = (c.name.clone(), c.domain.clone(), c.path.clone());
            if seen.insert(key) {
                cookies.push(c);
            }
        }

        let _ = win.close();
        return Ok(LoginResult {
            status: "ok".to_string(),
            cookies: Some(cookies),
        });
    }
}

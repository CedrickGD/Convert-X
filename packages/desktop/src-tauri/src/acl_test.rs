//! Guards the app-level ACL wiring, which has no compile-time link to
//! `invoke_handler!`.
//!
//! Two ways it can silently break:
//!   * a command registered in `lib.rs` but missing from `build.rs`'s
//!     `APP_COMMANDS` has no `allow-*` permission — the main window is denied
//!     it at RUNTIME, and only when a user happens to trigger that feature;
//!   * a capability that stops being scoped to `main` re-exposes every command
//!     to the login webview, which loads a remote origin.
//!
//! So the command list is derived from `lib.rs` itself rather than repeated.

use tauri::ipc::Origin;

/// Command names inside `generate_handler![...]`, read from the source so this
/// test cannot drift out of sync with the real registration.
fn registered_commands() -> Vec<String> {
    let src = include_str!("lib.rs");
    let start = src
        .find("generate_handler![")
        .expect("invoke_handler not found in lib.rs");
    let body = &src[start + "generate_handler![".len()..];
    let end = body.find(']').expect("unterminated generate_handler!");
    body[..end]
        .split(',')
        .map(|entry| entry.trim())
        .filter(|entry| !entry.is_empty() && !entry.starts_with("//"))
        .map(|entry| entry.rsplit("::").next().unwrap().to_string())
        .collect()
}

#[test]
fn every_command_is_allowed_for_the_main_window_only() {
    let commands = registered_commands();
    assert!(commands.len() > 1, "command extraction failed: {commands:?}");

    let mut ctx: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let authority = ctx.runtime_authority_mut();

    // Sanity check that resolve_access is actually discriminating.
    assert!(
        authority
            .resolve_access("not_a_registered_command", "main", "main", &Origin::Local)
            .is_none(),
        "the ACL resolves commands it was never given"
    );

    let login_origin = tauri::Url::parse("https://www.instagram.com/accounts/login/").unwrap();
    for cmd in &commands {
        assert!(
            authority
                .resolve_access(cmd, "main", "main", &Origin::Local)
                .is_some(),
            "`{cmd}` is registered but not permitted for the main window — add it to \
             APP_COMMANDS in build.rs and as `allow-…` in capabilities/default.json"
        );
        assert!(
            authority
                .resolve_access(
                    cmd,
                    crate::login::LOGIN_LABEL,
                    crate::login::LOGIN_LABEL,
                    &Origin::Remote { url: login_origin.clone() },
                )
                .is_none(),
            "`{cmd}` is reachable from the remote login webview"
        );
    }
}

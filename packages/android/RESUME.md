# Convert-X Android — Resume Plan

Snapshot of where we left off, written to drop back in with zero ramp-up.

---

## Current state

**Latest release:** v0.7.4 (tag `v0.7.4`, CI green, installed + verified on
the user's S26 Ultra SM-S948B / Android 16).

Releases: https://github.com/CedrickGD/Convert-X/releases
Release flow: bump (`node scripts/bump-version.js <ver>`) → commit to `main`
→ push tag `v*` → the "Release Android APKs" workflow builds
`app-arm64-v8a-release.apk`. CI runs the gradle build only (no tsc/lint), so
**typecheck locally** (`npx tsc --noEmit` in `packages/android`) before
tagging. Local release gradle build fails on this machine (CMake 260-char
Windows path limit) — CI is the build path. The native `android/` project is
committed and CI does NOT run `expo prebuild`, so launcher-icon changes must
edit the committed `android/app/src/main/res/mipmap-*` PNGs directly (not
just `assets/`).

---

## Everything verified live on the S26 (v0.7.0 → v0.7.4)

Core (v0.7.0): dialog-free gallery save (native MediaStore insert, clean
names, routed by type), theme-toggle fix, download progress moves,
per-carousel-item `--playlist-items`, working yt-dlp updater.

v0.7.1: type-aware download options (probe → detect video/audio/image →
adaptive options); multi-platform login card + per-domain cookies.txt merge.

v0.7.2: YouTube + LinkedIn logins; real-UA + popup handling for social
logins; collapsible/editable accent-color card with merged quick picks.

v0.7.3: no double-save (removed redundant save button; done row shows
"Saved to gallery" + Share); Instagram first-attempt-while-logged-in fix
(on-disk cookies.txt is the source of truth — see `resolveCookiesPath`);
custom app-styled Toast + Confirm dialog (FeedbackProvider) replacing every
Alert.alert; permissions via OS Photo Picker (no custom nag); animated
sliding tab indicator; new silver-X-on-dark-grey launcher icon.

v0.7.4: account switching — every login wipes the WebView cookie store
first (`CookieManager.clearAll` gated behind a ready spinner), so logout →
login shows a fresh account chooser instead of auto-locking to the previous
(esp. Google) account. Downloads unaffected (they read cookies.txt).

**Live end-to-end proof (2026-07-16):** logged into Instagram/YouTube/
TikTok/X/LinkedIn; account-switch verified (logout → empty login form →
re-login → Connected); a **private Instagram story** probed on the FIRST
attempt, downloaded, and saved as a SINGLE file in Movies/Convert-X (no
duplicate).

---

## Open / not yet verified

- Reddit + Facebook logins (WebView built, user hasn't signed in).
- Google-based logins (YouTube worked live; "Sign in with Google" on X/
  Reddit may still be refused by Google — email/password is reliable).
- Nothing else outstanding — all 22 tracked tasks complete.

---

## Key files (Download / login / save / feedback)

```
src/lib/downloadQueue.ts     — probeUrl (detectMediaType, resolveCookiesPath),
                                downloadEntry/Batch, --playlist-items, updateYtDlp
src/lib/cookies.ts           — per-domain cookies.txt merge/remove + resolveCookiesPath
src/lib/loginPlatforms.ts    — platform registry + LOGIN_USER_AGENT
src/components/Feedback.tsx   — Toast + Confirm dialog (useFeedback)
src/components/Navbar.tsx      — sliding animated tab indicator
src/screens/DownloadScreen.tsx        — URL form + adaptive options + preview + done
src/screens/PlatformLoginScreen.tsx   — generic WebView login (clears session first)
src/screens/CreditsScreen.tsx         — PlatformLoginsCard, collapsible AccentColorCard
src/theme/ThemeProvider.tsx           — accent + quickPicks (editable, auto-add)
modules/convert-x-downloader/android/.../ConvertXDownloaderModule.kt
                              — Kotlin: probe/download/saveToGallery/updateYtDlp
```

Native module unchanged since v0.7.0 (v0.7.1–v0.7.4 are JS-only).
youtubedl-android 0.18.1 internals confirmed against the AAR bytecode.

---

## Device / environment

- S26 reconnect + ADB quirks (port rotates on wireless-debug toggle): see
  the `s26-wireless-adb-reconnect` memory.
- Java: `C:\Program Files\Android\openjdk\jdk-21.0.8`
- Android SDK: `C:\Users\cedri\AppData\Local\Android\Sdk`

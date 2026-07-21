# Convert-X Android — Resume Plan

Snapshot of where we left off, written to drop back in with zero ramp-up.

---

## In progress: EAS Update live-iteration loop (branch claude/phone-live-convert-x-odpny6)

Goal: iterate on the phone without a Metro tunnel (blocked in the Claude Code
cloud sandbox — its egress proxy resets ngrok's tunnel protocol). Instead:
`eas update` publishes JS to Expo's CDN over plain HTTPS; the dev client's
**Updates** tab loads it on the phone in ~1 min.

Done: `expo-updates@~29.0.19` installed; `app.json` has `runtimeVersion`
("0.7.5", fixed string — bump on native changes), `updates.url`, and
`extra.eas.projectId`; committed `android/` manifest wired by hand (CI never
runs prebuild): updates ENABLED=true, EXPO_RUNTIME_VERSION via
`@string/expo_runtime_version` (strings.xml), EXPO_UPDATE_URL, plus the
`exp+convert-x-android` deep-link scheme. Changes derived by diffing a
scratch `expo prebuild` against the committed project.

**Blocked on:** user's Expo access token (expo.dev → Account settings →
Access tokens). The projectId/updates URL are `00000000-…` placeholders until
`EXPO_TOKEN=<token> npx eas-cli init` creates the real project. Then:
substitute the real id in app.json + AndroidManifest.xml, push, re-run the
"Build Android dev client" workflow **on this branch**, user reinstalls the
dev APK once, and each iteration is `npx eas-cli update --branch dev`.

---

## Current state

**Latest release:** v0.7.5 (tag `v0.7.5`, CI green, installed + verified on
the user's S26 Ultra SM-S948B / Android 16).

v0.7.5 = two high-severity bugs an adversarial review caught in the
v0.7.0–v0.7.4 changes: (1) `download.reset()` (fired by "Download more" /
"Back") returned INITIAL, silently wiping settings — logins
(connectedPlatforms), cookiesPath, and Spotify creds — with no recovery on
next launch; now `reset` preserves `settings`. (2) The anonymous-Instagram
probe fallback gated on the shared cookies.txt merely existing, so being
logged into any non-IG platform broke PUBLIC Instagram downloads; now gated
on `hasCookiesForDomain('instagram.com')`. Fix (1) verified live (download →
"Download more" → all 5 logins still Connected).

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

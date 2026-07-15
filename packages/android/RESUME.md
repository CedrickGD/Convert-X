# Convert-X Android — Resume Plan

Snapshot of where we left off, written to drop back in with zero ramp-up.

---

## Current state

**Latest release:** v0.7.1 (tag `v0.7.1`, built by CI, installed & verified
on the user's S26 Ultra SM-S948B / Android 16).
**Prior release:** v0.7.0 (also verified on device).

Releases live at: https://github.com/CedrickGD/Convert-X/releases
(Android APKs now ship from the monorepo, not the old separate APK repo.)

Release flow: bump → commit to `main` → push tag `v*` → the "Release Android
APKs" workflow builds `app-arm64-v8a-release.apk`. CI runs the gradle build
only (no tsc/lint step), so **typecheck locally** (`npx tsc --noEmit` in
`packages/android`) before tagging. Local release gradle build fails on this
machine (CMake 260-char Windows path limit) — CI is the build path.

---

## What works today (verified live on S26)

- **Convert / Resize:** image + video + audio pipelines; GIF from video.
- **Gallery save (v0.7.0):** native MediaStore insert — **no per-file consent
  dialog**, clean display names, routed by type (Pictures / Movies / Music /
  Convert-X). Replaced the old expo-media-library album flow.
- **Theme toggle (v0.7.0):** header buttons + active tab pill repaint
  correctly on dark/light switch (was white-on-white in dark).
- **Download (v0.7.0/0.7.1):** yt-dlp probe → type-aware options → download →
  save. Progress bar moves (was stuck at 0%). Per-carousel-item selection via
  `--playlist-items` (was N× the same item). Verified: YouTube video → MP4 and
  → MP3 (Music/Convert-X).
- **Type-aware options (v0.7.1):** no video/audio question before the probe.
  After Find: video → Video/Audio toggle + quality/audio-format; audio source
  → audio-format only; image post → no format controls, button says "Save".
- **yt-dlp updater (v0.7.0):** real status/version, clears stale
  `dlpVersion`/`dlpVersionName` prefs on cache reset so post-recovery updates
  actually install; monthly auto-refresh; in-app "Update download engine" /
  "Log in" buttons on recoverable errors.
- **Platform logins (v0.7.1):** clean multi-platform card (Instagram, TikTok,
  X, Reddit, Facebook via WebView; YouTube via cookies.txt import). One clear
  action per row, green "Connected". Cookies merge per-domain into one
  cookies.txt (`src/lib/cookies.ts`), so platforms coexist.

---

## Open / not yet verified

### 1. Instagram (and other) login end-to-end — needs the user's credentials
Built and code-reviewed but NOT driven end-to-end: WebView sign-in →
`mergePlatformCookies` → yt-dlp `--cookies` → private/carousel download.
Requires the user to actually log in (won't do on their behalf).
**Next:** user does Credits → Platform logins → Instagram → Log in, then
downloads a private/carousel post. Watch for: cookies written to
`documentDirectory/cookies.txt`, `connectedPlatforms` gains `instagram`,
carousel expands with distinct items.

### 2. Other WebView platforms (TikTok / X / Reddit / Facebook)
`requiredCookies` per platform in `src/lib/loginPlatforms.ts` are best-guess
session-cookie names — confirm each real login lands the expected cookie and
the `onNavStateChange` "ready" check fires.

---

## Key files (Download / login / save)

```
src/lib/downloadQueue.ts     — probeUrl (detectMediaType), downloadEntry/Batch,
                                --playlist-items, updateYtDlp, MediaStore save
src/lib/cookies.ts           — per-domain cookies.txt merge/remove (NEW v0.7.1)
src/lib/loginPlatforms.ts    — platform registry (NEW v0.7.1)
src/lib/instagramScraper.ts  — anonymous /embed probe (sets mediaType)
src/screens/DownloadScreen.tsx        — URL form + adaptive options + preview
src/screens/PlatformLoginScreen.tsx   — generic WebView login (NEW v0.7.1)
src/screens/CreditsScreen.tsx         — PlatformLoginsCard, YtDlpUpdateCard
src/state/DownloadContext.tsx         — cookiesPath + connectedPlatforms hydrate
modules/convert-x-downloader/android/.../ConvertXDownloaderModule.kt
                              — Kotlin: probe/download/saveToGallery/updateYtDlp
```

The Kotlin native module is unchanged since v0.7.0 (v0.7.1 is JS-only).
youtubedl-android 0.18.1 internals confirmed against the AAR bytecode: prefs
file `youtubedl-android`, keys `dlpVersion`/`dlpVersionName`, `updateYoutubeDL`
returns an `UpdateStatus` enum.

---

## Device / environment

- S26 reconnect + ADB quirks: see the `s26-wireless-adb-reconnect` memory.
- Java: `C:\Program Files\Android\openjdk\jdk-21.0.8`
- Android SDK: `C:\Users\cedri\AppData\Local\Android\Sdk`

# Convert-X for Android — Implementation Plan

**Date:** 2026-05-21
**Branch baseline:** `master` @ `fb43efd` (initial commit)
**Scope:** Port the desktop Convert-X (Tauri + Svelte + Rust + FFmpeg) experience to a polished native Android APK with full feature parity — Convert, Resize, Download (multi-source via yt-dlp), GIF editor — and visual fidelity to the desktop design.
**Stack target:** Expo SDK 54 + React Native 0.81 + TypeScript. Native modules in Kotlin for FFmpeg and yt-dlp.

---

## Goals (in user's words)

1. The Android app should be the **APK version of Convert-X** — same identity, same features, mobile-native.
2. **Match the design as close as possible** to the desktop. The current Android scaffold uses a purple/glassmorphism aesthetic that diverges from desktop's near-black + emerald look — that scaffold is "total trash" and needs to be rebuilt.
3. **Full feature parity with desktop**, including the video editor (GIF timeline trim).
4. **Most complete downloader possible** — support as many sources as yt-dlp covers, including multi-asset posts (Instagram carousels, YouTube playlists) with per-asset selection.
5. **Local Gradle build** producing a signed APK that runs on a real Android device.

---

## Architectural facts (verified, not assumed)

| Fact | Source |
|---|---|
| Current Android scaffold is an Expo SDK 54 project, slug `convert-x-android` (renamed from `convertx-mobile` in Phase 0), Android package `com.cedrickgd.convertx`. | `app.json`, `package.json` |
| Existing screens: Home (Convert) + History + Settings. Existing components: GlassCard, GradientButton, FilePickTile, custom TabBar, etc. | `src/screens/`, `src/components/` |
| Image conversion works today via `expo-image-manipulator` for PNG/JPG/WebP. | `src/lib/image.ts` |
| Desktop's latest UI is Convert / Resize / Download / Credits & App. The Navbar shows a `busy-dot` per-mode when work is in-flight. | `Convert-X/packages/shared/src/components/Navbar.svelte` |
| Desktop design tokens: bg `#0a0a0a`, surface `#171717`, accent `#10b981`, text `#f0f0f0`, border `#222`, Inter font, radius 14/10/6 px. | `Convert-X/packages/shared/src/assets/styles.css:1-28` |
| Desktop has per-mode state slices (`convertState`, `resizeState`, `downloadState`) so tab-switching never cancels in-flight work. | `Convert-X/packages/shared/src/stores/fileStore.js`, desktop PLAN.md Phase 1 |
| Desktop's DownloadView already supports YouTube / Spotify / Twitter / Instagram with multi-asset probe → preview → select → download. | `Convert-X/packages/shared/src/components/DownloadView.svelte` |
| `arthenica/ffmpeg-kit` was retired April 2025. Binaries pulled from Maven Central / npm. Community forks exist (TheByteArray/ffmpeg-kit, pgahq/ffmpeg-kit-fork, RebootMotion/ffmpeg-kit-fork). | upstream announcements, search results |
| `yausername/youtubedl-android` is alive (v0.18.1, Nov 2025). No official React Native bridge — needs a custom Expo native module wrapper in Kotlin. | github.com/yausername/youtubedl-android |

---

## What transfers from desktop, and what does not

**Transfers (design / spec):**
- Color palette and design tokens (Phase 1).
- Format catalog and supported codecs.
- Nav layout, tab structure, busy-dot indicators.
- UX flows for Convert / Resize / Download / GIF editor.
- Per-mode state isolation (tab-switch must not kill in-flight work).
- Settings keys (Spotify creds, cookies path).

**Does not transfer (architecture):**
- Svelte components → must be re-implemented as React Native components.
- Rust commands (`platform.convertFile`, `platform.downloadMedia`) → must be re-implemented as Kotlin native modules.
- FFmpeg invoked as subprocess → on Android, FFmpeg is linked as a native library.
- `outputDir` filesystem semantics → on Android, output goes to MediaStore (gallery) or the share intent.

---

## Phase 0 — Rename + metadata (this session)

**What to do:**
- Rename folder `Android App` → `Convert-X-Android`.
- `package.json`: `name` → `convert-x-android`.
- `app.json`: `slug` → `convert-x-android`. Keep display `name: "Convert-X"`.
- Add `README.md` and `PLAN.md` at repo root.

**Out of scope here:** no design changes, no `src/` deletions, no dependency adds.

**Verification:**
- `git log` shows the existing initial commit intact.
- After folder rename, opening the repo in a fresh shell reveals the new path; Expo CLI resolves the project name correctly.

---

## Phase 1 — Rebuild design system to match desktop

**What to do:**
- Read every component file in `Convert-X/packages/shared/src/components/*.svelte` and extract the design language (spacing rhythm, border treatment, button states, hover/active states adapted to mobile press states).
- Rewrite `src/theme/palettes.ts` and `src/theme/tokens.ts` so:
  - Dark theme: `bg.primary: #0a0a0a`, `bg.secondary: #111111`, `bg.card: #171717`, `accent: #10b981`, etc., exact match to desktop.
  - Light theme: mirror desktop's light token block.
  - Radii: 14 / 10 / 6 px.
  - Typography: Inter, sizes mirroring desktop's `.tab` (0.78rem ≈ 12.5pt), body, headings.
- Bundle Inter via `expo-font`. Confirm font loads before splash hides.
- Build a small `StyleGuide` dev screen (gated behind a `__DEV__` flag) showing every token swatch so we can verify the rebuild against the desktop side-by-side.

**Anti-patterns to avoid:**
- Do **not** keep any existing component (GlassCard, GradientButton, etc.) — their visual style is incompatible with desktop. They get replaced in Phase 3.
- Do **not** introduce a new gradient or glassmorphism effect. Desktop is flat, with subtle shadows only.
- Do **not** ship the styleguide screen in release builds.

**Verification:**
- Visual diff: place desktop app screenshot next to Android styleguide screen — colors, font, radii match.
- Theme toggle works and matches desktop's animation timing (`0.35s ease` for background, per styles.css:73).

---

## Phase 2 — 4-tab navigation with per-mode persistent state

**What to do:**
- Replace current Tabs (Home/History/Settings) with desktop's nav: **Convert / Resize / Download / Credits & App**.
- Port `Navbar.svelte` → `Navbar.tsx`. Flat tab strip, busy-dot indicator per mode when in-flight.
- Create per-mode state slices (Zustand or React Context — pick whichever the rest of the app already leans on; lean toward Context + reducer to avoid a new dep):
  - `convertState` (files, settings, view, cancelled, progress)
  - `resizeState`
  - `downloadState`
  - `activeMode` (the visual tab selector — *never* clears state)
- `switchMode` only updates `activeMode`. Never `resetAll`-style logic on tab switch.
- Lift any conversion / download loops into module-level functions so they keep running across remounts.

**Anti-patterns to avoid:**
- Do **not** introduce a single global `currentlyConverting` flag — re-introduces the coupling desktop fixed in its PLAN.md Phase 1.
- Do **not** unmount mode screens on tab switch. Keep them mounted with `display: none` if RN allows, or persist their state externally.

**Verification:**
- Start an image conversion in Convert, switch to Resize, switch back — progress bar continues, file list intact.
- Cancel on Convert does not affect a Resize run started in parallel.

---

## Phase 3 — Port Convert mode UI from desktop Svelte → React Native

**Components to port (1:1 with desktop):**
- `Dropzone.svelte` → mobile equivalent: full-bleed picker tile that opens DocumentPicker / ImagePicker / share-intent receive.
- `FileList.svelte` → `FileList.tsx`. Same row layout: filename, size, source format chip, target format chip, per-file progress, action menu.
- `FilePreview.svelte` → image / video thumbnail tile.
- `FormatPicker.svelte` → bottom-sheet format chooser grouped by category (Image / Video / Audio).
- `OutputSettings.svelte` → mobile output: "Save to gallery" / "Share" toggle, filename template.
- `AdvancedSettings.svelte` → resolution, FPS, trim, bitrate, encoder preset.
- `GifSettings.svelte` → FPS, scale, dither.
- `ClipEditor.svelte` → timeline scrubber for video-to-GIF trim.
- `ProgressBar.svelte` → match desktop visual (thin bar, accent fill, elapsed time label).
- `OutputPanel.svelte` → recent-output list with share / save / delete actions.

**Mobile-specific adaptations:**
- Drag-drop → tap-to-pick + Android share-intent receiver (`expo-share-intent` or a custom intent filter).
- `outputDir` setting → not exposed; outputs go to Android MediaStore via `expo-media-library`, with optional share action.

**Anti-patterns to avoid:**
- Do **not** invent new visual treatments. Open `App.svelte` and copy class structure / spacing.
- Do **not** wire Convert to FFmpeg yet — that's Phase 4. This phase ships the UI on stub conversion (image-only via existing `expo-image-manipulator` path).

**Verification:**
- Side-by-side screenshots of desktop Convert view and mobile Convert view at idle, with-files, converting, and done states.

---

## Phase 4 — Integrate FFmpeg on Android (the hard one)

**Decision to make at the start:**
- **Path A:** Use a community fork of `arthenica/ffmpeg-kit` (TheByteArray, pgahq, or RebootMotion). Faster to integrate. Risk: bus factor on the fork.
- **Path B:** Bundle FFmpeg binaries via Gradle + NDK directly (using `mobile-ffmpeg`-style packaging). More work, fewer upstream dependencies.

Evaluate forks by: (a) last commit recency, (b) RN 0.81 support, (c) 16KB-page-size compatibility (required on Android 15+), (d) license clarity, (e) supported codec set (we need full-gpl variant for x264 / aac).

**What to do:**
- Install the chosen FFmpeg package.
- Write `src/lib/ffmpeg.ts` — a thin JS wrapper exposing `runCommand(args, onProgress)`, `cancel(sessionId)`, `probe(uri)`.
- Implement format conversion paths (video, audio, image expansion to BMP/TIFF/ICO/GIF).
- Per-file progress via parsing FFmpeg's `time=` token in stderr (ffmpeg-kit exposes a structured callback).
- Cancellation: wire each session ID to the Convert mode's `currentSession` field so the mode-scoped cancel button only kills its own sessions.
- Confirm APK size delta. Strip unused codecs if needed.

**Anti-patterns to avoid:**
- Do **not** ship the LGPL-only variant of FFmpeg if we need x264/AAC encoders — verify the codec list against desktop's feature set before locking in the variant.
- Do **not** call FFmpeg on the JS thread — all native module calls go to the bg thread by default in RN, keep it that way.
- Do **not** assume 16KB-page builds — explicitly check the fork supports `targetSdk 35` with 16KB pages.

**Verification:**
- Convert: MP4 → WebM, MOV → MP4, MP3 → FLAC, PNG → TIFF — all succeed on a real device.
- Cancel mid-convert leaves no orphaned `.tmp` files in app cache.
- APK installs and launches on Android 12, 13, 14, 15 devices.

---

## Phase 5 — Port Resize mode

**What to do:**
- Port `ResizeSettings.svelte` → `ResizeSettings.tsx`. Pixel mode (width / height inputs with lock-aspect toggle) and percentage mode (slider 1-200%).
- Wire to FFmpeg for video (`-vf scale=W:H`) and to `expo-image-manipulator` for images (already in `src/lib/image.ts`).
- Show before/after dimensions on the file row.
- Persist the resize spec per-file in `resizeState`.

**Anti-patterns to avoid:**
- Do **not** assume `scale=W:H` preserves aspect ratio — desktop's UX uses `-2` (auto) for the locked dimension. Mirror that.

**Verification:**
- Resize a 4K video to 50% — output is 1920×1080, file size drops appropriately.
- Lock aspect toggle changes width input as height changes.

---

## Phase 6 — Build the downloader

**The big new piece.** Desktop's `DownloadView.svelte` is already a probe → preview → multi-select → download flow. Port it, plus build the native module.

**Custom Expo native module:**
- Name: `convert-x-downloader` (in-repo, under `modules/`).
- Wrap `yausername/youtubedl-android` (Kotlin).
- Expose to JS:
  - `probe(url) → ProbeResult { site, entries: [{ key, title, thumbnail, duration, formats: [...] }] }`
  - `download({ entryKey, format, quality, outputUri, spotifyCreds, cookiesPath, onProgress, onStage }) → fileId`
  - `cancel(fileId)`
  - `onDownloadProgress(callback) → unlisten`
- Python runtime + yt-dlp bundled inside the AAR. Expect ~50–80 MB APK size increase.

**UI port (DownloadView.svelte → DownloadView.tsx):**
- URL input + site-detection chip (YouTube, Spotify, Twitter/X, Instagram, etc.).
- Category toggle (video / audio). Spotify forces audio-only.
- Format chip (mp4/mkv/webm/avi/mov video; mp3/m4a/wav/flac/ogg/opus audio).
- Quality dropdown (best / 1080p / 720p / 480p / audio bitrates).
- After probe: thumbnail carousel with multi-select checkboxes for multi-asset posts.
- During download: per-item progress, current item title, elapsed, stage.
- After done: results list with share / save / open actions.
- Downloader settings (gear icon): Spotify clientId + secret, cookies path.

**Anti-patterns to avoid:**
- Do **not** ship a downloader that only handles YouTube — the user explicitly asked for "as many sources as possible".
- Do **not** hardcode the yt-dlp binary version — make it updateable on first launch via `youtubedl-android`'s built-in update mechanism.
- Do **not** store Spotify credentials in plain `AsyncStorage` — use `expo-secure-store`.

**Verification:**
- YouTube single video: downloads, transcodes to chosen format, shows in gallery.
- YouTube playlist: lists entries, multi-select works, downloads all selected.
- Instagram carousel post: lists all images/videos in the post, user picks which.
- Spotify track with creds set: downloads audio.
- Twitter/X video: downloads.
- Cancel mid-download cleans up partial files.

---

## Phase 7 — Credits & App tab

**What to do:**
- Port `Credits.svelte` → `CreditsScreen.tsx`. Sections:
  - **Built by:** CedrickGD (links to github.com/CedrickGD).
  - **App version:** read at build time via `expo-constants`.
  - **Open source:** FFmpeg, yt-dlp, Expo, React Native, lucide-react-native, etc. — one line + link each.
  - **Source:** github.com/CedrickGD/Convert-X (desktop) + this Android repo (TBD on rename).
  - **Also on desktop:** small CTA linking to the latest desktop GitHub release.

**Anti-patterns to avoid:**
- Do **not** copy desktop's `DesktopDownload` CTA as-is — invert the framing: the Android user is *on* the mobile app; they don't need to "get the desktop app", just learn it exists.

**Verification:**
- All links open in the user's browser via Linking API.
- Version string matches `package.json` and `app.json` after a fresh build.

---

## Phase 8 — Local Gradle release APK pipeline

**What to do:**
- One-time: generate a release keystore (`convert-x-android-release.jks`) and store it **outside the repo** at a known path. Document the path and password handling (env var or local-only file).
- Configure `android/app/build.gradle` with a `release` signing config that reads from env / a local `gradle.properties` (gitignored).
- Add ProGuard rules to keep FFmpeg + yt-dlp native libs and Kotlin metadata.
- Add `npm run build:apk` script: `expo prebuild && cd android && ./gradlew clean assembleRelease && node scripts/copy-apk.js`.
- `scripts/copy-apk.js` copies the signed APK to `./release/Convert-X-Android-<version>.apk`.

**Anti-patterns to avoid:**
- Do **not** check the keystore into the repo. Ever.
- Do **not** disable ProGuard to "make it work" — fix the keep rules instead.
- Do **not** rely on `expo run:android --variant release` — it sometimes works but `gradlew assembleRelease` is the source of truth.

**Verification:**
- `npm run build:apk` produces an APK under `release/` from a clean checkout.
- The APK installs on a real device with `adb install` and launches without crashing.
- Version code increments on each release.

---

## Phase 9 — Real-device verification + polish

**What to do:**
- Sideload the latest APK on a real Android device (user's own).
- Run through every flow end-to-end. Track issues in this file.
- Fix any visual gaps vs desktop.
- Profile startup time, FFmpeg conversion time vs desktop, memory under load.
- Optimize APK size: strip unused FFmpeg codecs, enable R8 full mode, audit asset sizes.

**Manual verification matrix:**
- Convert: image (PNG/JPG/WebP/BMP/TIFF/ICO/GIF), video (MP4/MKV/AVI/WebM/MOV/GIF/FLV/WMV/TS), audio (MP3/WAV/FLAC/OGG/AAC/WMA/M4A/Opus).
- Resize: pixel mode and percentage mode for image + video.
- Download: YouTube single + playlist, Instagram carousel, Spotify (with creds), Twitter/X, generic site.
- GIF editor: timeline scrubbing, in/out points, FPS, scale, dither.
- Cross-mode: start Convert, switch to Download, switch to Resize, switch back — all in-flight work intact.
- Theme: dark/light toggle persists across launches.
- Share-intent receive: Android share sheet → Convert-X → file appears in active mode.
- Gallery save vs share: both paths work.
- Cancel: mid-convert, mid-download, mid-resize.

---

## Open questions to revisit per phase

1. **Phase 1:** Inter is a free font — confirm exact license file path inside the APK so we're licensing-compliant.
2. **Phase 4:** If no community FFmpeg fork is viable, do we move Phase 4 to NDK bundle (adds ~1 week) or freeze video/audio out of v1 and ship Phase 3 + image-only first?
3. **Phase 6:** Bundling Python + yt-dlp adds ~50–80 MB. Acceptable, or do we explore native NewPipeExtractor-style alternatives that cover fewer sites but ship leaner?
4. **Phase 8:** Where does the release keystore live? `C:\Users\cedri\keys\` or a password manager? Decide before Phase 8 starts.

---

## Anti-pattern grep sweep (run at end of every phase)

```bash
# Should return nothing once Phase 1 lands — no purple/glass remnants
grep -rn "glass\|GlassCard\|GradientButton\|LinearGradient" src/

# Should return nothing — design system uses tokens, never hardcoded hex
grep -rEn "#[0-9a-fA-F]{6}" src/ --include="*.tsx" --include="*.ts" \
  | grep -v "src/theme/"

# Should return nothing once Phase 2 lands — no global cancellation flag
grep -rn "globalCancelled\|isConverting\s*=" src/

# Should return nothing — no hardcoded yt-dlp binary versions
grep -rn "yt-dlp.*v0\." src/
```

---

## Phase execution order

Phases gated by dependencies (`blockedBy` set in the task list):

```
0 ──> 1 ──> 2 ──> 3 ──> 4
                  ├──> 5 ──┐
                  ├──> 7   ├──> 9 ──> (release-ready)
                  ├──> 8   │
                       6 ──┘
```

5, 7, 8 can start once 3 lands. 6 wants 5 done first (so the downloader's "download then convert" flow can reuse the resize logic). 9 is the final gate.

Each phase is sized to be 1 chat session if possible. Phases 4 and 6 are large enough they may need to span sessions — when that happens, the PLAN.md is the bridge across sessions, and the task list tracks granular progress.

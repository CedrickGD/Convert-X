# Convert-X Android — Resume Plan

Snapshot of where we left off, written to drop you back in with zero ramp-up.

---

## Current state

**Production version on GitHub:** v0.6.6 (latest published)
**CI building:** v0.6.7, then v0.6.8 — both queued after the session ended
**Latest tag pushed:** `v0.6.8` (commit `aa4e62a`)
**Installed on user's S26 Ultra (SM-S948B, Android 16):** v0.6.5

All releases live at:
https://github.com/CedrickGD/Convert-X-Android-APK/releases

---

## What works today (v0.6.5 verified on S26)

- App boots, header shows version, theme toggle, tab persistence.
- **Convert:** PNG/JPG/WebP (manipulator path), BMP/TIFF/ICO/GIF (FFmpeg
  path), all video formats except WebM, all audio formats except MP3.
- **Resize:** image-only, works.
- **Updater:** in-app prompt + install via FileProvider.
- **ClipEditor:** preview + timeline + trim handles for video sources.
- **Download:** yt-dlp init works (auto-recovery from bad-zip state),
  probe + JSON parse path runs.

## What's broken (open work)

### 1. Download probe returns no JSON for Instagram carousels
**Symptom:** Paste `https://www.instagram.com/p/<id>/?img_index=N`,
tap **Find**, screen shows red "yt-dlp returned no JSON" with no
stderr context.

**Root cause (high confidence):** The probe passes `--flat-playlist`
to yt-dlp, which collapses Instagram / TikTok / Reddit carousels into
nothing instead of expanding the individual items.

**Fix shipped in v0.6.8:** Dropped `--flat-playlist` from the probe.

**Fix shipped in v0.6.7:** Verbose error reporting — exit code +
stdout + stderr now propagate up so we can see *why* yt-dlp emitted
no JSON instead of just "no JSON".

### 2. (Confirmed open) Download itself failed in v0.6.4-and-below

Cause-of-failure was never pinned because probe always succeeded but
the actual download didn't produce a file. v0.6.5 redesigned the
download flow (`downloadBatch` + h264_mediacodec format ladder +
restrict-filenames + retries) but the user only got to the probe
stage, never confirmed download.

**Open:** After v0.6.8 lands and probe expands the carousel correctly,
test the actual download. The Done panel surfaces failure cause via
the FFmpeg log-tail / yt-dlp stderr now.

---

## Versions / changelog (most recent first)

| ver    | what                                                           |
|--------|----------------------------------------------------------------|
| 0.6.8  | Drop `--flat-playlist` so carousels expand (Instagram fix)     |
| 0.6.7  | Verbose probe error: exitCode + stdout + stderr always shown   |
| 0.6.6  | `?img_index=N` URL → pre-select that item; N/M badge per row   |
| 0.6.5  | Playlist multi-select + batch download + robust H.264 ladder   |
| 0.6.4  | yt-dlp `--print after_move:filepath` to resolve real output    |
| 0.6.3  | Tab-switch clears URL + GIF auto-mute + preview thumbnails +   |
|        |   permission flow + Save-to-Gallery via MediaLibrary + corrupt |
|        |   yt-dlp.zip auto-recovery in probe/download                   |
| 0.6.2  | (failed build — broken Kotlin SAM lambda for callback)         |
| 0.6.1  | formatKeyFromName skips unsupported formats; AVI audio → AAC   |
| 0.6.0  | Swap to `ffmpeg-kit-main-min-16kb` (dropping HID-symbol fail)  |
|        |   + flip `useLegacyPackaging=true` so `.zip.so` libs extract   |
| 0.5.x  | Visible version in header, FFmpeg load-error banner, downloader|
|        |   cause-chain `describe()` helper                               |
| 0.5.0  | ClipEditor: MediaPreview + TimelineTrack + Playhead + TrimHandle |

---

## Pick up here — exact next steps

### Step 1: install v0.6.8 on the user's S26
The user's S26 is wirelessly paired and visible to ADB as
`adb-RFGL21TZWYB-vukfuD._adb-tls-connect._tcp`. Wait for v0.6.8 CI:

```bash
gh run list --limit 1
# wait until "completed success" for v0.6.8
gh release view v0.6.8
# then:
curl -sL -o /tmp/v068.apk "https://github.com/CedrickGD/Convert-X-Android-APK/releases/download/v0.6.8/app-arm64-v8a-release.apk"
adb -s adb-RFGL21TZWYB-vukfuD._adb-tls-connect._tcp install -r /tmp/v068.apk
adb -s adb-RFGL21TZWYB-vukfuD._adb-tls-connect._tcp shell am force-stop com.cedrickgd.convertx
adb -s adb-RFGL21TZWYB-vukfuD._adb-tls-connect._tcp shell am start -n com.cedrickgd.convertx/com.cedrickgd.convertx.MainActivity
```

### Step 2: reproduce the Instagram probe
With the app open on the S26, tap Download tab (bounds `[728,378][1032,502]`,
center **(880, 440)** — NOT (725, 365), that's the theme toggle).

Paste the URL into the EditText (bounds `[244,740][1093,813]`,
center **(668, 776)**) — `adb shell input text` works for the URL as
long as you use single-quoted strings to avoid shell escaping:

```bash
adb -s adb-RFGL21TZWYB-vukfuD._adb-tls-connect._tcp shell input tap 668 776
adb -s adb-RFGL21TZWYB-vukfuD._adb-tls-connect._tcp shell 'input text "https://www.instagram.com/p/DYenI78nzS1/"'
adb -s adb-RFGL21TZWYB-vukfuD._adb-tls-connect._tcp shell input keyevent KEYCODE_BACK   # dismiss keyboard
adb -s adb-RFGL21TZWYB-vukfuD._adb-tls-connect._tcp shell input tap 720 1943            # Find button
```

### Step 3: screenshot the result
```bash
adb -s adb-RFGL21TZWYB-vukfuD._adb-tls-connect._tcp exec-out screencap -p > .claude/screenshots/s26-v068-probe.png
```

**Expected:** preview card with 10 thumbnails, each showing a `N/10`
badge. Only item 10 is pre-selected because of `img_index=9`.

**If still broken:** the red error text will now (v0.6.7+) contain
yt-dlp's actual stderr/stdout — paste that into the next prompt.

### Step 4: try the download
Tap **Download 1** (it'll be the only enabled action). Grant
MediaLibrary permission. Wait. If it succeeds → "Saved to Gallery ·
Convert-X album". File appears in `Gallery → Convert-X`.

### Step 5: tag a v0.7.0 if download works
If both probe and download work for the Instagram carousel, the v0.6.x
diagnostic cascade is done and we cut a clean v0.7.0 release marking
"playlist downloads functional".

---

## Files most-recently touched

```
src/lib/downloadQueue.ts                              — downloadBatch, format ladder, MediaLibrary save
src/screens/DownloadScreen.tsx                        — multi-select UI, checkboxes, N/M badges, img_index
modules/convert-x-downloader/android/.../Module.kt    — corruption recovery, no auto-update, --flat-playlist removed
modules/convert-x-ffmpeg/android/build.gradle         — ffmpeg-kit-main-min-16kb
src/lib/ffmpegArgs.ts                                 — h264_mediacodec, no libmp3lame, no libvorbis
src/lib/formats.ts                                    — MP3 + WebM marked supported=false; formatKeyFromName fallback
src/components/AppHeader.tsx                          — version display
src/components/convert/VideoEditControls.tsx          — audioForcedOff prop for GIF target
```

---

## Open feature requests (not yet shipped)

- **Carousel position number** on each entry — partially done (the N/M
  badge is from v0.6.6) but doesn't read carousel-image-N from yt-dlp's
  output yet; uses array index. Good enough for Instagram, may diverge
  for sites that reorder.
- **Cookie support** for sites that require login (Instagram private
  posts, paywalled YouTube, etc.) — `state.settings.cookiesPath` exists
  but no UI to set it. Would need an SAF file picker for cookies.txt.
- **GifSettings + AdvancedSettings panels** (task #46, deferred since
  v0.4.0). FPS / scale / dither for GIF; bitrate / preset for video.
  Buildable from `state.settings.gifWidth / gifFps / gifColors /
  gifDither` which already plumb through to FFmpeg.

---

## Active S26 ADB connection

```
adb-RFGL21TZWYB-vukfuD._adb-tls-connect._tcp    device
```

If it shows offline on reconnect, the user re-enables wireless
debugging on the phone (Settings → Developer options → Wireless
debugging) and the mDNS entry returns automatically — no re-pair.

---

## Environment

- Java: `C:\Program Files\Android\openjdk\jdk-21.0.8`
- Android SDK: `C:\Users\cedri\AppData\Local\Android\Sdk`
- Local Gradle release build fails (CMake 260-char Windows path limit).
  Use the CI release path — `git push --follow-tags` and `gh run watch`.

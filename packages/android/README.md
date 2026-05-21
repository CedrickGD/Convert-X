# Convert-X for Android

The Android APK port of [Convert-X](https://github.com/CedrickGD/Convert-X) — a fast, offline file converter and multi-source media downloader for video, audio, and images.

Built with Expo SDK 54 + React Native 0.81 + TypeScript. Native FFmpeg and yt-dlp wired through Kotlin modules.

## Status

Active development. See [PLAN.md](PLAN.md) for the 10-phase plan and current progress.

| Phase | What | State |
|---|---|---|
| 0 | Rename + metadata | done |
| 1 | Design system rebuild (Inter, `#0a0a0a` + `#10b981`) | done |
| 2 | 4-tab navigation (Convert / Resize / Download / Credits) | done |
| 3 | Port Convert mode UI from desktop Svelte | done |
| 4 | FFmpeg on Android (JamaisMagic full-gpl-16kb fork) | done |
| 5 | Resize mode (image today, video w/ Phase 4) | done |
| 6 | Downloader (yt-dlp via youtubedl-android native module) | done |
| 7 | Credits & App tab | done |
| 8 | Local Gradle release APK pipeline | done |
| 9 | Real-device verification + polish | ongoing |
| CI | GitHub Actions release workflow on `v*` tags | done |
| Updater | In-app APK self-update from GitHub Releases | done |

## Dev

Requires Node 20+, Android Studio with SDK 35+, and JDK 17.

```bash
npm install
npx expo prebuild        # one-time: regenerate android/
npm run android          # dev build to a connected device/emulator
```

## Build APK (planned — see Phase 8)

```bash
npm run build:apk        # cleans, builds signed release APK, copies to release/
```

Requires a release keystore configured per [PLAN.md](PLAN.md#phase-8). Generate once:

```bash
keytool -genkey -v \
  -keystore C:\Users\<you>\keys\convert-x-android-release.jks \
  -alias convert-x-release \
  -keyalg RSA -keysize 2048 -validity 10950 \
  -dname "CN=<your name>,O=Personal,L=,ST=,C=US"
```

Then copy `android/gradle.properties.example` to `android/gradle.properties.local` (gitignored) and fill in the keystore path + passwords.

## Auto-release on tag push

Pushing a `v*` tag (e.g. `git tag v0.2.0 && git push origin v0.2.0`) triggers `.github/workflows/release.yml`:
- Builds the per-ABI release APKs on ubuntu-latest.
- Signs them with the keystore from the repo secrets.
- Attaches `app-arm64-v8a-release.apk` + `app-armeabi-v7a-release.apk` to the GitHub Release.

The in-app updater (Credits tab) polls `https://api.github.com/repos/CedrickGD/Convert-X-Android-APK/releases/latest`, picks the APK matching the device's ABI, downloads to cache, and hands it to Android's system installer.

One-time secret setup in the GitHub repo (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `RELEASE_KEYSTORE_BASE64` | `base64 -w 0 your-release.jks` (single line, no wrap) |
| `RELEASE_KEYSTORE_PASSWORD` | store password |
| `RELEASE_KEY_ALIAS` | key alias (default `convert-x-release`) |
| `RELEASE_KEY_PASSWORD` | key password |

## Stack

- **Frontend:** Expo SDK 54, React Native 0.81, TypeScript
- **Image conversion:** `expo-image-manipulator` (PNG / JPG / WebP)
- **Video + audio conversion:** FFmpeg via `io.github.jamaismagic.ffmpeg:ffmpeg-kit-main-full-gpl-16kb:6.1.4` (Android 15+ 16KB-aligned community fork of `arthenica/ffmpeg-kit`), wrapped in the in-repo `convert-x-ffmpeg` Expo Module under `modules/`
- **Multi-source download (Phase 6, not yet shipped):** `yausername/youtubedl-android` (Kotlin) via a custom Expo native module — supports YouTube, Spotify, Instagram (incl. multi-asset carousels), Twitter/X, and ~1000 other sites that yt-dlp supports

## Relationship to desktop Convert-X

This is a design and feature port, not a code port. The desktop app is Tauri + Svelte + Rust; none of that runs on Android. The Android port aims for visual and functional fidelity to the latest desktop branch — same tabs, same flows, same design tokens — re-implemented in React Native and Kotlin.

Desktop source: https://github.com/CedrickGD/Convert-X

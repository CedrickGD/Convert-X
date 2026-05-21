# Convert-X for Android

The Android APK port of [Convert-X](https://github.com/CedrickGD/Convert-X) — a fast, offline file converter and multi-source media downloader for video, audio, and images.

Built with Expo SDK 54 + React Native 0.81 + TypeScript. Native FFmpeg and yt-dlp wired through Kotlin modules.

## Status

Active development. See [PLAN.md](PLAN.md) for the 10-phase plan and current progress.

| Phase | What | State |
|---|---|---|
| 0 | Rename + metadata | in progress |
| 1 | Design system rebuild (Inter, `#0a0a0a` + `#10b981`) | pending |
| 2 | 4-tab navigation (Convert / Resize / Download / Credits & App) | pending |
| 3 | Port Convert mode UI from desktop Svelte | pending |
| 4 | FFmpeg on Android (community fork or NDK bundle) | pending |
| 5 | Resize mode | pending |
| 6 | Downloader (yt-dlp via youtubedl-android native module) | pending |
| 7 | Credits & App tab | pending |
| 8 | Local Gradle release APK pipeline | pending |
| 9 | Real-device verification + polish | pending |

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

Requires a release keystore configured per [PLAN.md](PLAN.md#phase-8) — Phase 8 puts this in place.

## Stack

- **Frontend:** Expo SDK 54, React Native 0.81, TypeScript
- **Video / audio / image conversion:** FFmpeg (community fork of `arthenica/ffmpeg-kit`)
- **Multi-source download:** `yausername/youtubedl-android` (Kotlin) via a custom Expo native module — supports YouTube, Spotify, Instagram (incl. multi-asset carousels), Twitter/X, and ~1000 other sites that yt-dlp supports

## Relationship to desktop Convert-X

This is a design and feature port, not a code port. The desktop app is Tauri + Svelte + Rust; none of that runs on Android. The Android port aims for visual and functional fidelity to the latest desktop branch — same tabs, same flows, same design tokens — re-implemented in React Native and Kotlin.

Desktop source: https://github.com/CedrickGD/Convert-X

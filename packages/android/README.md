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
| 6 | Downloader (yt-dlp via youtubedl-android native module) | pending |
| 7 | Credits & App tab | done (Phase 2 wiring; release-fetch polish pending) |
| 8 | Local Gradle release APK pipeline | done (keystore: user-action) |
| 9 | Real-device verification + polish | ongoing |

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
- **Image conversion:** `expo-image-manipulator` (PNG / JPG / WebP)
- **Video + audio conversion:** FFmpeg via `io.github.jamaismagic.ffmpeg:ffmpeg-kit-main-full-gpl-16kb:6.1.4` (Android 15+ 16KB-aligned community fork of `arthenica/ffmpeg-kit`), wrapped in the in-repo `convert-x-ffmpeg` Expo Module under `modules/`
- **Multi-source download (Phase 6, not yet shipped):** `yausername/youtubedl-android` (Kotlin) via a custom Expo native module — supports YouTube, Spotify, Instagram (incl. multi-asset carousels), Twitter/X, and ~1000 other sites that yt-dlp supports

## Relationship to desktop Convert-X

This is a design and feature port, not a code port. The desktop app is Tauri + Svelte + Rust; none of that runs on Android. The Android port aims for visual and functional fidelity to the latest desktop branch — same tabs, same flows, same design tokens — re-implemented in React Native and Kotlin.

Desktop source: https://github.com/CedrickGD/Convert-X

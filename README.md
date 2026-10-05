# ConvertX

Fast, offline file converter. Drag, pick a format, done.

> **This is now a monorepo** containing all three surfaces — **desktop**
> (`packages/desktop`, Tauri v2 + Svelte + Rust), **web** (`packages/web`,
> Svelte + ffmpeg.wasm), and **android** (`packages/android`, Expo + React
> Native). See **[MONOREPO.md](MONOREPO.md)** for the layout, dev/build
> commands, and how releases + the in-app updater work. The rest of this
> README covers the desktop app specifically.

Built with **Tauri v2 + Svelte + Rust**. Uses FFmpeg under the hood.

## Download

| Platform | Get it | File |
|---|---|---|
| **Windows** | [Latest desktop release](https://github.com/CedrickGD/Convert-X/releases?q=desktop-v&expanded=true) | `Convert-X.exe` — portable, no install, no admin |
| **Android** (most phones) | [Latest release](https://github.com/CedrickGD/Convert-X/releases/latest) | `app-arm64-v8a-release.apk` — 64-bit ARM, sideload |
| **Android** (older / budget phones) | [Latest release](https://github.com/CedrickGD/Convert-X/releases/latest) | `app-armv7-release.apk` — 32-bit ARM (armeabi-v7a); use this if arm64 says *App not installed / isn't compatible* |

> Android requires **Android 7.0 (API 24)** or newer.

Desktop and Android are **versioned independently** (`desktop-v*` vs `v*`), so
their version numbers differ and the newest release of one is often not the
newest release overall. Every release page carries a Downloads table linking
both, so whichever one you land on will get you to the other. Each app also
self-updates from its own release line.

## Features

- **Convert** videos, images, and audio between formats
- **Resize** images by pixels or percentage
- **GIF editor** with timeline trimmer for video-to-GIF clips
- **Batch processing** with per-file progress tracking
- **Advanced options** — resolution, FPS, trim, bitrate, encoder preset
- **URL downloader** (yt-dlp) — desktop and Android run it locally; the web
  version uses a self-hosted backend unlocked with an access key
- **Discord sticker & emoji grabber** — paste a custom emoji, sticker, image or
  GIF link (Tenor / Giphy / Klipy too), `<:name:id>` markup or a sticker ID into
  the Download tab and save it as Original, GIF, PNG, APNG, WebP or MP4 — or
  ready to re-upload as a **Discord sticker** (320×320, ≤512 KB) or **Discord
  emoji** (128×128, ≤256 KB). Works on desktop, web (no key needed) and Android
- **Dark / Light theme**
- Conversion is fully offline, no uploads

### Supported Formats

| Type | Formats |
|-------|---------|
| Video | MP4, MKV, AVI, WebM, MOV, GIF, FLV, WMV, TS |
| Image | PNG, JPG, WebP, BMP, TIFF, ICO |
| Audio | MP3, WAV, FLAC, OGG, AAC, WMA, M4A, Opus |

## Build

**Requirements:** [Rust](https://rustup.rs), [Node.js](https://nodejs.org), FFmpeg binaries in `src-tauri/bin/`

```bash
npm install
npm run tauri build
```

Or use `build.bat` on Windows — it handles everything and copies output to `release/`.

## Dev

```bash
npm run tauri dev
```

## Stack

- **Frontend:** Svelte 5, Vite
- **Backend:** Rust, Tauri v2
- **Engine:** FFmpeg (video/audio), `image` crate (images)

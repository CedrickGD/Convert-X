# ConvertX

Fast, offline desktop file converter. Drag, pick a format, done.

Built with **Tauri v2 + Svelte + Rust**. Uses FFmpeg under the hood.

## Features

- **Convert** videos, images, and audio between formats
- **Resize** images by pixels or percentage
- **GIF editor** with timeline trimmer for video-to-GIF clips
- **Batch processing** with per-file progress tracking
- **Advanced options** — resolution, FPS, trim, bitrate, encoder preset
- **Dark / Light theme**
- Fully offline, no uploads

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

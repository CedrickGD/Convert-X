# Phase 2-8 Port Plans (reference)

Compiled from background research agents during Phase 1. Reference when starting each phase.

---

## Phase 2 — Per-mode state architecture

**Decision:** React Context + useReducer (no Zustand). Already-shipped dependency, easier inspection.

**Slices:**
- `convertState` — files, settings, view, progress, cancelled, currentSessionId
- `resizeState` — files, settings, view, progress, cancelled
- `downloadState` — files, settings (Spotify/cookies), view, progress, cancelled
- `sharedState` — activeMode, theme

**Files to create:**
- `src/state/SharedContext.tsx`
- `src/state/ConvertContext.tsx`
- `src/state/ResizeContext.tsx`
- `src/state/DownloadContext.tsx`
- `src/state/hooks.ts`
- `src/lib/conversionQueue.ts` — module-level async queue, sessionId-scoped
- `src/lib/resizeQueue.ts`
- `src/lib/downloadQueue.ts` (Phase 6)

**Critical:** the conversion loop lives at module level so tab unmount doesn't kill it. Each session has a unique sessionId; reducer ignores stale callbacks (whose sessionId no longer matches currentSessionId).

**Provider stack in App.tsx:**
```
<SharedProvider>
  <ConvertProvider>
    <ResizeProvider>
      <DownloadProvider>
        ...
```

`switchMode(mode)` only writes to `sharedState.activeMode`. NEVER touches per-mode slices.

---

## Phase 3 — Component ports (desktop Svelte → RN)

### Dropzone.tsx (`src/components/convert/Dropzone.tsx`)
Props: `{ onFilesDrop, mode? }`. Full-bleed dashed card. Tap → DocumentPicker or ImagePicker (mode-dependent). Long-press → paste. Tokens: `radius.md`, `theme.border.hover` dashed, `theme.bg.secondary`, `typography.bodyLg`, chips at `radius.round` with `bg.surface` + `border.subtle`.

### FileList.tsx (`src/components/convert/FileList.tsx`)
Props: `{ files, view, onRemoveFile, onAddFiles }`. FlatList max-height ~180. Per-row: color dot (#60a5fa / #c084fc / #34d399 — these are KEPT raw because they're media-type indicators, not theme), filename (typography.base semibold), inline progress bar 3px tall, status text. Status states: ready/queued/converting/done/error/skipped.

### FilePreview.tsx (`src/components/convert/FilePreview.tsx`)
Props: `{ metadata, filePath, fileObj?, compact? }`. Single-file detail. 16:9 image/video tile. Badge 40×40 `radius.xs` `accent.subtle` bg. Tags row at `radius.round` `bg.secondary` `typography.micro`.

### FormatPicker.tsx (`src/components/convert/FormatPicker.tsx`)
Props: `{ fileTypes, selectedFormat, onFormatSelect, sourceFormats?, hasEdits? }`. Grid of format chips grouped by category. Selected: `bg.accent.primary` + `text.onAccent`. Muted (same-format-no-edits): dashed border + opacity 0.45.

### OutputSettings.tsx (`src/components/convert/OutputSettings.tsx`)
Props: `{ outputDir, quality, selectedFormat, isBatch, singleOutputName, onNameChange, onDirChange, onQualityChange }`. TextInput for filename (with .ext badge), folder picker (Android ACTION_OPEN_DOCUMENT_TREE), quality slider with low/high labels.

### AdvancedSettings.tsx (`src/components/convert/AdvancedSettings.tsx`)
Collapsible card with chevron. Resolution, FPS, trim, bitrate, encoder preset.

### GifSettings.tsx (`src/components/convert/GifSettings.tsx`)
FPS, scale, dither, colors. Preset row (3-col grid) + custom controls. Animated reveal on toggle.

### ClipEditor.tsx (`src/components/convert/ClipEditor.tsx`)
Most complex. Sub-components:
- `TimelineTrack.tsx` — 36px track, 4px ticks
- `Playhead.tsx` — 16px wide, white line with glow
- `TrimHandle.tsx` — left/right with 12×28 grip
- `CropOverlay.tsx` — semi-transparent overlay with 1.5px border
- `MediaPreview.tsx` — `expo-video` (add dep)
- `AudioStripToggle.tsx`, `RotateFlipControls.tsx`, `SpeedControl.tsx`, `VolumeControl.tsx`

Use `react-native-gesture-handler` Pan for trim handles + crop, Tap for playhead seek.

### ProgressBar.tsx (`src/components/convert/ProgressBar.tsx`)
Props: `{ progress, elapsed, label }`. 6px track + shimmer glow effect (`react-native-reanimated` infinite withRepeat). Percentage as `typography.hero`.

### OutputPanel.tsx (`src/components/convert/OutputPanel.tsx`)
Done state. ScaleIn check ring (56px, `accent.subtle` bg). Results list (max-h 200, scrollable). Per-item share/save/open via expo-sharing + expo-media-library.

### ResizeSettings.tsx (`src/components/convert/ResizeSettings.tsx`)
2-mode toggle (pixels/percentage). Lock-aspect button 34×34 square `radius.xs`. Numeric TextInput with no spinners (`appearance: none`).

---

## Phase 4 — FFmpeg integration (see agent report)

Path A vs B decision waiting on the FFmpeg fork evaluation agent.

---

## Phase 6 — Downloader (see agent report)

Custom Expo native module wrapping `yausername/youtubedl-android` v0.18.1. Bundled python + yt-dlp. ~50-80 MB APK delta.

---

## Phase 7 — Credits & App tab

Port from `Credits.svelte` + `DesktopDownload.svelte`. Invert the desktop CTA: tell user about desktop, don't push them to install it. Use `expo-constants` for version, `Linking` for URLs.

---

## Phase 8 — Release pipeline

Keystore at `C:\Users\cedri\keys\convert-x-android-release.jks`. gradle.properties (gitignored) for storeFile/storePassword/keyAlias/keyPassword. ProGuard rules to keep FFmpeg/yt-dlp/Kotlin metadata. `npm run build:apk` chains: `expo prebuild && cd android && ./gradlew clean assembleRelease && node scripts/copy-apk.js`.

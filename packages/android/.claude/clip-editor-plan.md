# ClipEditor Port Plan — Convert-X-Android

Port of `packages/shared/src/components/ClipEditor.svelte` from the desktop
Convert-X to React Native for the Convert-X-Android-APK. Touch-first redesign:
desktop mouse-drag handles become 48px touch targets, CSS `clip-path` becomes
RN `Animated.View` masks, `<video>` becomes `<VideoView>` from `expo-video`.

Source reference: `C:\Users\cedri\source\repos\CedrickGD\Convert-X\packages\shared\src\components\ClipEditor.svelte` (1503 lines).

---

## 1. Sub-components

All under `src/components/convert/clip/`. One component per file, default-export
function component, named-export prop types.

### `ClipEditor.tsx` (orchestrator)
- Props: `{ file: FileEntry; settings: ConvertSettings; onChange: (patch: Partial<ConvertSettings>) => void; targetFormat: FormatDef | null }`
- Owns local refs: `videoRef`, `playbackState` ({ playing, currentTime }).
- Loads `duration` from `<VideoView>` `onLoad`, initializes `trimStart=0`,
  `trimEnd=duration` if null.
- Reads `srcW`/`srcH` from the video's `naturalSize` (expo-video reports this
  via the `onPlaybackStateChange` / `onLoad` callback on `videoSource`).
- Hides crop/transform/volume sub-sections when `targetFormat?.key === 'gif'`
  (matches desktop's `showVideoEdits = !isGif`).
- Lays out children vertically:
  1. Header (title + clip duration badge)
  2. `<MediaPreview />` — fixed max-height 50% of screen height
  3. `<TimelineTrack />` with `<TrimHandle />` ×2 and `<Playhead />` overlaid
  4. Time row (start / duration / end — read-only on mobile, no keyboard input)
  5. `<AudioToggle />` (hidden for GIF target)
  6. Collapsible: `<CropOverlay />` toggle + body (hidden for GIF)
  7. Collapsible: `<TransformControls />` (hidden for GIF)
  8. Collapsible: `<SpeedControl />`
  9. `<VolumeControl />` (hidden if `stripAudio` or GIF)
- Estimated: ~180 lines.

### `TimelineTrack.tsx`
- Props: `{ duration: number; trimStart: number; trimEnd: number; playheadTime: number; trackWidth: number; onTrackPress: (time: number) => void; children?: ReactNode }`
- Renders the 36px-tall horizontal track with rounded corners.
- Tick marks above the track:
  - `<= 10s`: every 1s
  - `<= 30s`: every 5s
  - `<= 120s`: every 10s
  - `<= 300s`: every 30s
  - else: every 60s
  - Use absolute positioning with `left: ${pct}%`.
- Dim regions (left of `trimStart`, right of `trimEnd`): `backgroundColor: rgba(0,0,0,0.6)` absolute fills.
- Selection band: `accent-subtle` fill between `trimStart` and `trimEnd`, with
  `borderTopWidth: 2` + `borderBottomWidth: 2` in accent color.
- `onLayout` reports the rendered width to the parent so handles/playhead can
  use absolute pixel math (more reliable than `%` with RN gestures).
- Tap-anywhere on track invokes `onTrackPress(time)` — translates `event.locationX` to a clamped time in `[trimStart, trimEnd]`.
- Estimated: ~120 lines.

### `Playhead.tsx`
- Props: `{ time: number; trimStart: number; trimEnd: number; trackWidth: number; duration: number; onSeek: (time: number) => void }`
- Visual: 3px white line, `box-shadow` simulated via `shadowColor: #fff`,
  `shadowOpacity: 0.5`, `shadowRadius: 6`, `elevation: 4`. Hit-slop 12px each side.
- `useSharedValue<number>` for `translateX`. Drives an `Animated.View` style.
- `Gesture.Pan()`:
  - `onStart`: capture initial `translateX`.
  - `onUpdate`: `translateX = clamp(initial + e.translationX, trimStart_px, trimEnd_px)`.
  - `onEnd`: `runOnJS(onSeek)(pxToTime(translateX))`.
- During drag, the parent can also live-seek via `runOnJS` if perf permits, but
  start with end-only commit to keep the worklet snappy.
- Estimated: ~90 lines.

### `TrimHandle.tsx`
- Props: `{ side: 'start' | 'end'; time: number; otherTime: number; duration: number; trackWidth: number; onCommit: (time: number) => void; onLiveSeek: (time: number) => void }`
- 48px-wide hit area centered on the trim point (translateX = trim_px - 24).
- Inside: 12px-wide accent-colored "grip" rectangle (24px tall), 3 horizontal
  white lines as visual affordance (matches desktop's `.grip-line`).
- `Gesture.Pan()`:
  - On update, compute new `time`:
    - `side === 'start'`: `clamp(0, otherTime - 0.1)`.
    - `side === 'end'`: `clamp(otherTime + 0.1, duration)`.
  - Calls `runOnJS(onLiveSeek)(time)` to scrub video alongside drag.
- On end, `runOnJS(onCommit)(finalTime)` writes to settings.
- Visual feedback: scale to `1.15` while dragging.
- Estimated: ~110 lines.

### `MediaPreview.tsx`
- Props: `{ uri: string; trimStart: number; trimEnd: number; speed: number; volume: number; stripAudio: boolean; rotate: 0|90|180|270; flipH: boolean; flipV: boolean; crop: CropRect | null; isGifTarget: boolean; onLoad: (meta: { duration: number; width: number; height: number }) => void; videoRef: RefObject<VideoView> }`
- Wraps `expo-video`'s `<VideoView>` with a `useVideoPlayer(uri)` player.
- Sets:
  - `player.muted = stripAudio || isGifTarget`
  - `player.volume = Math.min(1, volume / 100)` (note: above 100% can't be done
    natively on Android — see Risks §9)
  - `player.playbackRate = clamp(speed, 0.1, 10)` (capped by Android's
    `MediaCodec` — typical safe range is 0.25–2.0)
- Transform via `style.transform`:
  ```ts
  const transform = [
    { rotate: `${rotate}deg` },
    { scaleX: flipH ? -1 : 1 },
    { scaleY: flipV ? -1 : 1 },
  ];
  ```
- Crop preview: wrap `<VideoView>` in a parent `<View overflow="hidden">` that
  scales the video so the crop fills the parent. Use the formula:
  - displayed scale_x = parentW / (crop.w / srcW * displayedVideoW)
  - translate_x = -crop.x * (displayedVideoW / srcW)
  - This is fiddly; a simpler v1 just draws a non-modal accent-bordered rect
    overlay (no actual masking) and lets the user trust the bounding box.
- Floating play/pause button bottom-left (36px circle, semi-transparent black).
- Floating current-time badge bottom-right.
- Estimated: ~160 lines.

### `CropOverlay.tsx`
- Props: `{ srcW: number; srcH: number; displayRect: { x: number; y: number; w: number; h: number }; crop: CropRect | null; onChange: (rect: CropRect | null) => void }`
- 8 corner/edge handles around the crop rect, each a 24×24 view with a 10×10
  visible square + 14px transparent hit-slop ring.
- Center body: `Gesture.Pan()` translates the whole rect, clamped to source.
- Each handle: `Gesture.Pan()` resizes from that anchor (logic ported from
  desktop `onCropMove` resize branch — preserves the L/R/T/B "has" booleans).
- Creation gesture: tap-and-drag in empty space when `crop === null` produces
  a new rect.
- Aspect-ratio chips: "Free", "1:1", "16:9", "9:16" — re-applies the ratio
  when changed and on each resize.
- Coordinates in source pixels stored in settings; `displayRect` is computed
  by parent (object-fit-contain math, ported from desktop's `getDisplayRect`).
- Estimated: ~200 lines.

### `AudioToggle.tsx`
- Props: `{ value: boolean; onChange: (v: boolean) => void }`
- A native `<Switch />` from `react-native` (uses system styling) or a custom
  track+thumb to match desktop's pill toggle (recommended for visual parity).
- Label text flips between "Audio included" / "Audio removed".
- `value === true` means audio is **stripped** (matches desktop's `stripAudio` semantics).
- Estimated: ~50 lines.

### `TransformControls.tsx`
- Props: `{ rotate: 0|90|180|270; flipH: boolean; flipV: boolean; onChange: (patch: Partial<{rotate, flipH, flipV}>) => void }`
- Row of icon-chips:
  - "90° CCW" → `onChange({ rotate: ((rotate + 270) % 360) as RotateDeg })`
  - "90° CW" → `onChange({ rotate: ((rotate + 90) % 360) as RotateDeg })`
  - "Flip H" (toggleable active) → `onChange({ flipH: !flipH })`
  - "Flip V" (toggleable active) → `onChange({ flipV: !flipV })`
  - "Reset" — disabled when all defaults.
- Uses `@expo/vector-icons` (Feather) — `rotate-ccw`, `rotate-cw`, `flip-horizontal-2`, `flip-vertical-2`.
- Estimated: ~80 lines.

### `SpeedControl.tsx`
- Props: `{ value: number; onChange: (v: number) => void }`
- Preset chips: `[0.25, 0.5, 1, 1.5, 2, 4]` — active when `Math.abs(value - preset) < 0.001`.
- Slider below (use `@react-native-community/slider` — already a likely dep;
  if not, add it): min 0.1, max 10, step 0.05.
- Custom input: skip on mobile (no numeric keyboard ergonomics needed; slider
  + presets is enough).
- Estimated: ~80 lines.

### `VolumeControl.tsx`
- Props: `{ value: number; onChange: (v: number) => void }`
- Preset chips: `[0, 50, 100, 150, 200]`.
- Slider: min 0, max 200, step 1.
- Below slider: 3 tick labels ("0%", "100%", "200%") in a `flex` row.
- Reset button next to header (`100%`).
- Estimated: ~80 lines.

---

## 2. State changes — `src/state/types.ts`

Add to `ConvertSettings`:

```ts
export type RotateDeg = 0 | 90 | 180 | 270;
export type CropRect = { x: number; y: number; w: number; h: number };

export type ConvertSettings = {
  format: string | null;
  quality: number;
  /** Trim points in seconds. null = no trim from this side. */
  trimStart: number | null;
  trimEnd: number | null;
  /** Drop the audio stream (`-an`). */
  stripAudio: boolean;
  /** Playback speed multiplier. 0.1..10. 1 = no change. */
  speed: number;
  /** Audio gain percent. 0..200. 100 = no change. */
  volume: number;
  /** Rotation in degrees, clockwise. */
  rotate: RotateDeg;
  /** Horizontal flip (mirror). */
  flipH: boolean;
  /** Vertical flip. */
  flipV: boolean;
  /** Crop in source-pixel coordinates. null = no crop. */
  crop: CropRect | null;
};

export const CONVERT_DEFAULTS: ConvertSettings = {
  format: null,
  quality: 90,
  trimStart: null,
  trimEnd: null,
  stripAudio: false,
  speed: 1,
  volume: 100,
  rotate: 0,
  flipH: false,
  flipV: false,
  crop: null,
};
```

Reducer notes:
- Whenever a new file is selected, reset trim/crop/transform/speed/volume to
  defaults (so old crop coords don't apply to a new resolution).
- `setConvertSettings` action is sufficient; no new action types needed.

---

## 3. FFmpeg arg builder — `src/lib/ffmpegArgs.ts`

### New opts on `FfmpegBuildOpts`

```ts
export type FfmpegBuildOpts = {
  inputPath: string;
  outputPath: string;
  target: FormatDef;
  quality: number;
  stripAudio?: boolean;
  resizeWidth?: number | null;
  resizeHeight?: number | null;
  // NEW:
  trimStart?: number | null;
  trimEnd?: number | null;
  speed?: number;          // default 1
  volume?: number;         // default 100 (percent)
  rotate?: RotateDeg;      // default 0
  flipH?: boolean;
  flipV?: boolean;
  crop?: CropRect | null;
};
```

### Arg ordering (critical)

```
ffmpeg -y
  [-ss <trimStart>]          # fast seek — BEFORE -i
  -i <input>
  [-to <trimEnd>]            # absolute end time (NOT duration when paired with -ss)
                             # NOTE: ffmpeg `-to` after -i is measured from the
                             # start of the input, but combined with -ss before -i
                             # the seek offset is honored. Equivalent and safer:
                             # use `-t <duration>` where duration = trimEnd - trimStart.
  -hide_banner
  [video codec + crf]
  [-vf "<filter chain>"]      # crop, scale, transpose, hflip, vflip
  [-filter:a "atempo=..."]    # OR fold into -filter_complex if speed != 1 with video
  [-af "volume=<n>"]          # audio-only path
  [-an]                       # if stripAudio
  [-c:a aac -b:a 160k] etc.
  output.mp4
```

### Helper: build the `-vf` chain

```ts
function buildVideoFilterChain(opts: FfmpegBuildOpts): string[] {
  const filters: string[] = [];
  if (opts.crop) {
    const { x, y, w, h } = opts.crop;
    filters.push(`crop=${w}:${h}:${x}:${y}`);
  }
  if (opts.rotate) {
    // transpose: 0=90CCW+vflip, 1=90CW, 2=90CCW, 3=90CW+vflip
    // chain for 180 (two 1s) and 270 (one 2)
    if (opts.rotate === 90) filters.push('transpose=1');
    else if (opts.rotate === 180) filters.push('transpose=1,transpose=1');
    else if (opts.rotate === 270) filters.push('transpose=2');
  }
  if (opts.flipH) filters.push('hflip');
  if (opts.flipV) filters.push('vflip');
  // scale (resize) comes AFTER crop so the user's resize target applies to
  // the cropped frame, not the original.
  if (opts.resizeWidth || opts.resizeHeight) {
    const w = opts.resizeWidth ?? -2;
    const h = opts.resizeHeight ?? -2;
    filters.push(`scale=${w}:${h}`);
  }
  // Speed (video side): setpts=PTS/<speed>
  if (opts.speed && Math.abs(opts.speed - 1) > 0.001) {
    filters.push(`setpts=PTS/${opts.speed}`);
  }
  return filters;
}
```

### Helper: build `-af` chain

```ts
function buildAudioFilterChain(opts: FfmpegBuildOpts): string[] {
  const filters: string[] = [];
  // atempo only supports 0.5..2.0 — chain multiple stages for outside range.
  if (opts.speed && Math.abs(opts.speed - 1) > 0.001) {
    let remaining = opts.speed;
    while (remaining > 2.0) {
      filters.push('atempo=2.0');
      remaining /= 2.0;
    }
    while (remaining < 0.5) {
      filters.push('atempo=0.5');
      remaining /= 0.5;
    }
    if (Math.abs(remaining - 1) > 0.001) {
      filters.push(`atempo=${remaining.toFixed(4)}`);
    }
  }
  if (opts.volume != null && opts.volume !== 100) {
    filters.push(`volume=${(opts.volume / 100).toFixed(3)}`);
  }
  return filters;
}
```

### Trim insertion

In `buildArgs`:
```ts
const pre: string[] = ['-y'];
if (opts.trimStart != null && opts.trimStart > 0) {
  pre.push('-ss', String(opts.trimStart));
}
pre.push('-i', inputPath, '-hide_banner');
if (opts.trimStart != null && opts.trimEnd != null && opts.trimEnd > opts.trimStart) {
  pre.push('-t', String(opts.trimEnd - opts.trimStart));
} else if (opts.trimEnd != null) {
  pre.push('-to', String(opts.trimEnd));
}
```

### Wire into `buildVideoArgs` and `buildGifArgs`

- Replace the existing `-vf scale=...` block with a call to `buildVideoFilterChain` and emit `-vf "<chain joined by comma>"`.
- In `buildAudioArgs`, append `buildAudioFilterChain` via `-af`.
- In `buildVideoArgs` when audio is kept and speed != 1, emit `-filter:a "atempo=..."`.
- `buildGifArgs` already has a complex `-vf`; prepend crop/rotate/flip before the existing `fps,scale,split[...]` chain.

### Defaults & no-op short-circuit

Treat missing fields as defaults. If every editor field is at default,
the function should produce **byte-identical** output to today's args (so
existing tests stay green). Add a flag in tests to verify this.

---

## 4. Gestures — `react-native-gesture-handler`

Use the new v2 `Gesture.Pan()` API + `react-native-reanimated` shared values.

### Common pattern

```ts
const offset = useSharedValue(0);
const start = useSharedValue(0);
const pan = Gesture.Pan()
  .onStart(() => { start.value = offset.value; })
  .onUpdate((e) => {
    'worklet';
    offset.value = clamp(start.value + e.translationX, MIN_PX, MAX_PX);
  })
  .onEnd(() => {
    'worklet';
    runOnJS(commit)(pxToTime(offset.value));
  });
```

### Per-component constraints

- **TrimHandle (start)**: clamp `[0, otherTime_px - MIN_GAP_PX]` where
  `MIN_GAP_PX = (0.1 / duration) * trackWidth`.
- **TrimHandle (end)**: clamp `[otherTime_px + MIN_GAP_PX, trackWidth]`.
- **Playhead**: clamp `[trimStart_px, trimEnd_px]`. Worklet reads JS-thread
  values `trimStart` and `trimEnd` — pass them via `useDerivedValue` or as
  `useSharedValue`s so the worklet can read fresh values without a JS hop.
- **CropOverlay body**: clamp `x ∈ [0, srcW - w]`, `y ∈ [0, srcH - h]`.
- **CropOverlay handle**: full source-pixel clamping per side as in desktop.

### Worklet ↔ JS boundary

- `commit` callbacks must use `runOnJS(fn)(...)` from inside the worklet.
- Don't call zustand dispatch inside `onUpdate` — too chatty. Use a local
  shared value during drag and dispatch only on `onEnd`. For playhead seek
  during drag, throttle: only `runOnJS` every Nth frame (or use
  `useDerivedValue` + an effect on the JS side).
- Live video scrub during trim drag: call `videoRef.current.seek(time)` via
  `runOnJS` on every Pan update — `expo-video` handles flooding by coalescing
  seeks, but if jank shows up, throttle to every other update.

---

## 5. expo-video integration

### Package
```
npm install expo-video@~3.0.0   # match Expo SDK 54
```
- SDK 54 ships with `expo-video` 3.x. Check `package.json` for the current
  Expo SDK version before pinning.
- Already configured `app.json` plugin? If not, add:
  ```json
  "plugins": ["expo-video"]
  ```
  Then `npx expo prebuild` (managed) or just `npx expo run:android` to rebuild.

### Usage

```tsx
import { VideoView, useVideoPlayer } from 'expo-video';

const player = useVideoPlayer(uri, (p) => {
  p.muted = stripAudio;
  p.loop = false;
  p.volume = Math.min(1, volume / 100);
  p.playbackRate = speed;
});

useEffect(() => { player.muted = stripAudio; }, [stripAudio, player]);
useEffect(() => { player.volume = Math.min(1, volume / 100); }, [volume, player]);
useEffect(() => { player.playbackRate = speed; }, [speed, player]);

// Listen for status/duration:
useEvent(player, 'statusChange', (status) => {
  if (status === 'readyToPlay') onLoad({ duration: player.duration, ... });
});

return (
  <VideoView
    ref={videoRef}
    player={player}
    style={[styles.preview, { transform }]}
    contentFit="contain"
    nativeControls={false}
  />
);
```

- Source URI: pass `file.uri` directly. On Android, ensure the URI is either
  a `file://`, `content://`, or HTTPS URL — expo-video handles all three.
- Transform via `style.transform` — RN's RCTViewManager applies a CSS-like
  affine transform on the native view layer; no remux needed.
- `seek(time)` via `player.currentTime = time` (expo-video 3.x setter).

---

## 6. UI integration — `ConvertScreen.tsx`

### Current flow
- Files selected → `view === 'ready'` → user picks format → `FormatPicker` shows quality slider → presses convert.

### New flow
After `FormatPicker` selects the target and BEFORE quality:

```tsx
{state.view === 'ready' &&
 state.files[0]?.mediaType === 'video' &&
 (
  <ClipEditor
    file={state.files[0]}
    settings={state.settings}
    targetFormat={resolvedTarget}
    onChange={(patch) => dispatch(setConvertSettings(patch))}
  />
)}
```

- Position: directly above `<FormatPicker />` (or below, depending on visual
  flow — desktop places editor above settings). On mobile, put it ABOVE since
  the timeline is the largest visual element and benefits from being the first
  thing the user sees after picking the file.
- Hide entirely if the source is not a video (`mediaType !== 'video'`).
- Multi-file: only show for the first video. (Phase later: per-file trim.)

### GIF cross-mode

When `targetFormat?.key === 'gif'`:
- `ClipEditor` passes `isGifTarget` through to children.
- Audio-related UI (AudioToggle, VolumeControl) is hidden — GIF has no audio.
- Crop/Transform/Speed still apply.
- Continue to show `GifSettings` (`fps`, `scale`, `colors`) below `ClipEditor`
  — those are GIF-specific encoder knobs separate from the source-side edits.

### Export to args

In the conversion runner (wherever `buildArgs` is called):
```ts
const args = buildArgs({
  inputPath: file.uri,
  outputPath,
  target: resolvedTarget,
  quality: settings.quality,
  stripAudio: settings.stripAudio,
  resizeWidth: ...,
  resizeHeight: ...,
  trimStart: settings.trimStart,
  trimEnd: settings.trimEnd,
  speed: settings.speed,
  volume: settings.volume,
  rotate: settings.rotate,
  flipH: settings.flipH,
  flipV: settings.flipV,
  crop: settings.crop,
});
```

---

## 7. Phasing

Each phase ships independently — every commit is releasable.

### Phase v0.4.0 — State + arg builder (no UI yet)
- Add new `ConvertSettings` fields and defaults.
- Extend `buildArgs` to consume them, fully covered by unit tests.
- Add temporary inline buttons in `ConvertScreen` (or hide entirely) for quick
  manual testing: a single "Mute audio" toggle + "Trim to first 5s" button.
- **Acceptance**: golden-file FFmpeg arg snapshots for representative combos
  (trim-only, mute, speed 2x, rotate 90, crop, all-combined).
- **Files**: `types.ts`, `ffmpegArgs.ts`, `ffmpegArgs.test.ts`, reducer if needed.

### Phase v0.5.0 — Core ClipEditor UI
- `ClipEditor.tsx`, `MediaPreview.tsx`, `TimelineTrack.tsx`, `Playhead.tsx`,
  `TrimHandle.tsx`, `AudioToggle.tsx`, `SpeedControl.tsx`, `VolumeControl.tsx`.
- Wire into `ConvertScreen` above `FormatPicker`.
- Skip crop/transform UI (settings remain at defaults).
- **Acceptance**: user can scrub, trim, mute, set speed/volume, and convert.
  Output reflects all settings.

### Phase v0.6.0 — Crop + Transform
- `CropOverlay.tsx`, `TransformControls.tsx`.
- Add collapsible sub-sections to `ClipEditor`.
- **Acceptance**: rotated/flipped/cropped output matches preview within ±1px.

### Phase v0.7.0 — Polish (optional follow-ups)
- Editable time inputs (Start/End) via a modal numeric picker.
- Aspect-lock toggle for crop with 1:1, 16:9, 9:16 presets.
- Tap-and-drag to create new crop rect (vs. presets).
- Multi-file independent trim.

---

## 8. Files to touch (line-count estimates)

| File | Change | Est lines |
|---|---|---|
| `src/state/types.ts` | Add fields to `ConvertSettings` + defaults | +35 |
| `src/state/reducer.ts` (or store) | Reset edits on new file | +10 |
| `src/lib/ffmpegArgs.ts` | Filter-chain builders, trim insertion, args wiring | +120 |
| `src/lib/ffmpegArgs.test.ts` | Golden args for combos | +180 |
| `src/components/convert/index.ts` | Re-export `ClipEditor` | +1 |
| `src/components/convert/clip/ClipEditor.tsx` | NEW | ~180 |
| `src/components/convert/clip/TimelineTrack.tsx` | NEW | ~120 |
| `src/components/convert/clip/Playhead.tsx` | NEW | ~90 |
| `src/components/convert/clip/TrimHandle.tsx` | NEW | ~110 |
| `src/components/convert/clip/MediaPreview.tsx` | NEW | ~160 |
| `src/components/convert/clip/CropOverlay.tsx` | NEW | ~200 |
| `src/components/convert/clip/AudioToggle.tsx` | NEW | ~50 |
| `src/components/convert/clip/TransformControls.tsx` | NEW | ~80 |
| `src/components/convert/clip/SpeedControl.tsx` | NEW | ~80 |
| `src/components/convert/clip/VolumeControl.tsx` | NEW | ~80 |
| `src/components/convert/clip/types.ts` | Shared `CropRect`, `RotateDeg` | +20 |
| `src/screens/ConvertScreen.tsx` | Mount `<ClipEditor />` | +25 |
| `package.json` | Add `expo-video`, maybe `@react-native-community/slider` | +2 |
| `app.json` | Plugin entry for `expo-video` | +1 |
| **Total** | | **~1,460** |

---

## 9. Risks & gotchas

### expo-video on long videos
- `expo-video` keeps the source in memory while playing. A 30-minute 4K video
  can spike RSS by 200+ MB. Mitigation: only play during active scrub /
  preview, `player.pause()` on `ClipEditor` unmount, don't auto-preload.
- For very long sources, consider generating a thumbnail strip on the timeline
  via `expo-video-thumbnails` instead of keeping a live preview.

### Reanimated worklet limits
- Worklets cannot capture JS closures of objects with non-serializable members.
  Pass primitives (`number`, `boolean`) or shared values into the worklet,
  never `videoRef.current`.
- `runOnJS` has overhead — don't call it 60×/sec during a Pan. Throttle to
  ≤30Hz for live seek, or commit only on `onEnd`.
- Hot-reload sometimes leaves stale worklets; if you see "Reanimated cannot
  determine UI runtime", reload the JS bundle (not Metro).

### FFmpeg filter graph complexity
- When **both** video and audio filters need to coexist with crop+rotate+speed,
  the `-vf` and `-af` flags work for simple cases. For complex graphs (e.g.,
  multiple inputs or audio splits), use `-filter_complex` with explicit
  `[0:v]` / `[0:a]` labeling — but for our use case (single input, no audio
  splits), `-vf` + `-af` is always sufficient.
- The `setpts` filter changes only the video clock; without `atempo` on the
  audio side, audio drifts out of sync. Always pair them.
- `transpose=1,transpose=1` for 180° is one stable way; `rotate=PI` is another
  but it bilinear-interpolates and softens the image. Prefer `transpose`.
- `crop` must come BEFORE `scale` in the filter chain (otherwise the crop
  rect is interpreted in scaled coords — usually not what the user wants).

### atempo chaining for speeds outside [0.5, 2]
- Documented above in `buildAudioFilterChain`. Validate with manual test:
  ```
  ffmpeg -i in.mp4 -filter:a "atempo=2.0,atempo=2.0" -vn -y out.mp4   # 4x
  ffmpeg -i in.mp4 -filter:a "atempo=0.5,atempo=0.5" -vn -y out.mp4   # 0.25x
  ```
- Quality degrades audibly past 4x speed or below 0.25x — that's an
  inherent atempo limitation, not our bug.

### expo-video volume above 100%
- Android's `ExoPlayer.setVolume(float)` clamps at 1.0. We can preview ≤100%
  faithfully; 100–200% in the preview will sound at 100% (no clipping, no
  amplification). The exported FFmpeg output, however, correctly applies
  `volume=1.5` etc.
- Document this divergence in the UI with a small subscript: "Above 100% is
  applied in the output but preview is capped at 100%."

### Rotation and preview vs. output
- CSS-style `rotate(90deg)` rotates the rendered view but the video frames
  themselves are unchanged. The FFmpeg `transpose=` filter rotates the
  actual pixels. Preview will match output as long as `contentFit="contain"`
  and the parent view doesn't constrain aspect ratio.
- When rotation is 90 or 270, swap perceived width/height when calculating
  the crop overlay's display rect.

### Crop overlay display math
- The desktop code's `getDisplayRect()` translates "video pixels" to
  "displayed CSS pixels" assuming `object-fit: contain`. RN's `contentFit`
  has the same behavior, so the same math works — but the source dimensions
  need to be read from `player.videoSource` or the load event, not from the
  view itself (no `naturalSize` API).

### Multi-file behavior
- Today's `ConvertScreen` supports a list. ClipEditor in v0.5 only edits the
  first file's settings — multi-file independent trim is parked for v0.7 to
  avoid a refactor of `ConvertSettings` into per-file slices right now.

### TypeScript narrowing
- `RotateDeg` as a numeric literal union forces casts at modulo boundaries:
  ```ts
  const next = ((rotate + 90) % 360) as RotateDeg;
  ```
  Acceptable — alternative is a type-guard helper, but the cast is honest.

---

## Appendix A — Visual style tokens (RN)

Match the desktop's accent + dim aesthetic. Define once in
`src/components/convert/clip/styles.ts`:

```ts
export const C = {
  bgCard: '#1a1a1f',
  bgInput: '#22232a',
  border: '#33343d',
  borderHover: '#46474f',
  accent: '#6ea8fe',
  accentSubtle: 'rgba(110, 168, 254, 0.18)',
  accentGlow: 'rgba(110, 168, 254, 0.45)',
  textPrimary: '#ededf0',
  textSecondary: '#c5c5cb',
  textMuted: '#7d7e87',
  white: '#ffffff',
  dim: 'rgba(0, 0, 0, 0.6)',
};
```

(Use the project's existing theme tokens if they exist — check
`src/theme` or `src/lib/theme.ts` before defining new ones.)

## Appendix B — Test plan

Per phase:

- **v0.4.0**: Jest snapshot tests in `ffmpegArgs.test.ts` for 8 combos:
  defaults, trim only, mute only, speed 2x, speed 0.25x (atempo chain),
  rotate 90, crop only, all-combined. Each snapshot is the exact `string[]`.
- **v0.5.0**: Manual smoke test on Android device: pick 30s video, trim to
  10s, set speed 1.5x, set volume 50%, mute, convert. Verify output duration,
  audio level, and that conversion succeeded.
- **v0.6.0**: Pick 1080p video, crop to 500×500 centered, rotate 90, convert.
  Verify output is 500×500, content matches crop region, orientation correct.

## Appendix C — Out of scope

These are deliberately NOT in this plan:
- Per-file independent edits (only first file edits).
- Editable time text inputs (mobile keyboards make this awkward — use slider).
- Aspect-ratio crop presets beyond the 4 listed.
- Frame-stepping (←/→ arrow buttons for one-frame nudges).
- Undo/redo of edits.
- Visual waveform on the timeline (desktop doesn't have this either).
- A live-preview "with crop applied" mode (preview shows uncropped video with
  a bounding box; cropping happens at export time only).

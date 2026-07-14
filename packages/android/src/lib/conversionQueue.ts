/**
 * Module-level conversion queue.
 *
 * The conversion loop lives here, NOT inside a React component, so that
 * switching tabs (and unmounting the Convert view) does not abort the
 * in-flight work.
 *
 * Phase 4: dispatches three paths depending on media type:
 *   - image → expo-image-manipulator (existing src/lib/image.ts path)
 *   - video → FFmpeg via convert-x-ffmpeg native module
 *   - audio → FFmpeg via convert-x-ffmpeg native module
 *
 * Each session is identified by a string sessionId. Cancellation flips an
 * in-memory flag AND signals the native FFmpeg session to abort.
 */

import * as FileSystem from 'expo-file-system/legacy';

import { addProgressListener, cancel as ffmpegCancel, executeAsync, getMediaInfo } from '../../modules/convert-x-ffmpeg/src';
import { buildArgs } from './ffmpegArgs';
import { FORMATS } from './formats';
import { convertImage, ResizeSpec } from './image';
import type { ConvertSettings, FileEntry } from '../state/types';

const cancelled = new Set<string>();

export function cancelSession(sessionId: string): void {
  cancelled.add(sessionId);
  // Best effort: also tell FFmpeg to abort the underlying native session.
  try {
    ffmpegCancel(sessionId);
  } catch {
    // not yet running, that's fine
  }
}

export function isCancelled(sessionId: string): boolean {
  return cancelled.has(sessionId);
}

function clearSession(sessionId: string): void {
  cancelled.delete(sessionId);
}

/** Strip filesystem-hostile characters from a user-typed output name. */
function sanitizeStem(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_').trim();
}

export type ConvertRunOpts = {
  sessionId: string;
  files: FileEntry[];
  targetFormatKey: string;
  /** Full editor settings — trim / strip / speed / volume / rotate / etc.
   *  conversionQueue handles routing image-fast-path vs FFmpeg. */
  settings: ConvertSettings;
  resize?: ResizeSpec;
  onFileStart: (id: string) => void;
  onFileProgress: (id: string, percent: number) => void;
  onFileDone: (id: string, outputUri: string, outputName: string, outputBytes: number) => void;
  onFileError: (id: string, error: string) => void;
  onFileSkipped: (id: string) => void;
};

/**
 * Run a Convert session — fan-files-out, dispatching each to the right
 * underlying engine (image vs FFmpeg).
 */
export async function runConvertSession(opts: ConvertRunOpts): Promise<void> {
  const fmt = FORMATS.find((f) => f.key === opts.targetFormatKey);
  if (!fmt) {
    for (const file of opts.files) opts.onFileError(file.id, `Unknown format: ${opts.targetFormatKey}`);
    clearSession(opts.sessionId);
    return;
  }

  // Single-file rename support: the OutputSettings "FILE NAME" field sets
  // settings.customName. Only applies when converting exactly one file.
  const customStem =
    opts.files.length === 1 && opts.settings.customName
      ? sanitizeStem(opts.settings.customName) || null
      : null;

  try {
    for (const file of opts.files) {
      if (isCancelled(opts.sessionId)) break;
      if (file.status === 'error') continue;
      if (!fmt.accepts.includes(file.mediaType)) {
        opts.onFileSkipped(file.id);
        continue;
      }
      if (!fmt.supported) {
        opts.onFileError(file.id, `${fmt.label} not supported on mobile yet`);
        continue;
      }

      opts.onFileStart(file.id);

      try {
        // expo-image-manipulator handles PNG / JPG / WebP only. Everything
        // else — including GIF (animated palette work) — goes through FFmpeg.
        const useManipulator =
          file.mediaType === 'image' &&
          fmt.category === 'image' &&
          (fmt.key === 'png' || fmt.key === 'jpg' || fmt.key === 'webp');
        if (useManipulator) {
          opts.onFileProgress(file.id, 25);
          const result = await convertImage({
            sourceUri: file.uri,
            sourceName: file.name,
            targetFormat: fmt,
            quality: opts.settings.quality,
            resize: opts.resize ?? { kind: 'none' },
            outputBaseName: customStem,
          });
          if (isCancelled(opts.sessionId)) break;
          opts.onFileDone(file.id, result.outputUri, result.outputName, result.bytes);
        } else {
          // FFmpeg path — video, audio, GIF, BMP/TIFF, etc.
          await runFfmpegFile({ ...opts, file, fmt, customStem });
          if (isCancelled(opts.sessionId)) break;
        }
      } catch (e) {
        if (isCancelled(opts.sessionId)) break;
        opts.onFileError(file.id, e instanceof Error ? e.message : String(e));
      }
    }
  } finally {
    clearSession(opts.sessionId);
  }
}

async function runFfmpegFile(
  opts: ConvertRunOpts & {
    file: FileEntry;
    fmt: import('./formats').FormatDef;
    customStem?: string | null;
  }
): Promise<void> {
  const { file, fmt } = opts;

  // Probe the input so we can compute progress percent.
  let durationMs = 0;
  try {
    const info = await getMediaInfo(file.uri);
    durationMs = info.durationMs;
  } catch {
    // Best effort — if probe fails we'll still run, but progress stays at 0.
  }

  // Output path — app cache dir, randomized name to avoid collisions.
  const outputDir = `${FileSystem.documentDirectory}exports`;
  await FileSystem.makeDirectoryAsync(outputDir, { intermediates: true }).catch(() => {});
  const stem = opts.customStem ?? (file.name.replace(/\.[^.]+$/, '') || 'output');
  const outputName = `${stem}.${fmt.ext}`;
  const outputPath = `${outputDir}/${Date.now()}-${outputName}`;
  // FFmpeg needs filesystem paths, not file:// URIs, so strip the scheme.
  const inputPath = file.uri.replace(/^file:\/\//, '');
  const cleanOutput = outputPath.replace(/^file:\/\//, '');

  // Resize spec (image-flow's ResizeSpec) — Phase 5 routes resize-mode files
  // through resizeQueue, so for convert mode here we only act on `pixels`.
  const r = opts.resize;
  const resizeWidth = r?.kind === 'pixels' ? r.width ?? null : null;
  const resizeHeight = r?.kind === 'pixels' ? r.height ?? null : null;

  const s = opts.settings;
  const args = buildArgs({
    inputPath,
    outputPath: cleanOutput,
    target: fmt,
    quality: s.quality,
    resizeWidth,
    resizeHeight,
    trimStart: s.trimStart,
    trimEnd: s.trimEnd,
    stripAudio: s.stripAudio,
    speed: s.speed,
    volume: s.volume,
    rotate: s.rotate,
    flipH: s.flipH,
    flipV: s.flipV,
    crop: s.crop,
    gifWidth: s.gifWidth,
    gifFps: s.gifFps,
    gifColors: s.gifColors,
    gifDither: s.gifDither,
  });

  // Subscribe progress for this session only. Rate-limit to ~10Hz (always
  // letting 100% through) so a chatty native emitter doesn't dispatch a
  // reducer action — and re-render every screen + the Navbar — many times per
  // displayed percent. The reducer additionally dedupes identical values.
  let lastEmit = 0;
  const sub = addProgressListener((evt) => {
    if (evt.sessionId !== opts.sessionId) return;
    const pct = Math.round(evt.percent);
    const now = Date.now();
    if (pct < 100 && now - lastEmit < 100) return;
    lastEmit = now;
    opts.onFileProgress(file.id, pct);
  });

  try {
    const result = await executeAsync(opts.sessionId, args, durationMs);
    if (isCancelled(opts.sessionId)) {
      // Cancelled mid-encode — FFmpeg may have written a partial file.
      await FileSystem.deleteAsync(outputPath, { idempotent: true }).catch(() => {});
      return;
    }
    // Last meaningful FFmpeg stderr lines — shows what FFmpeg actually
    // complained about (codec not found, invalid input, empty stream, …)
    // instead of just an exit code or a bare "no output".
    const logTail = (logs?: string): string => {
      const tail = (logs ?? '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .slice(-3)
        .join(' · ');
      return tail ? ` — ${tail}` : '';
    };
    if (result.returnCode !== 0) {
      await FileSystem.deleteAsync(outputPath, { idempotent: true }).catch(() => {});
      opts.onFileError(file.id, `FFmpeg exited ${result.returnCode}${logTail(result.logs)}`);
      return;
    }
    // Read output size for the result panel.
    const info = await FileSystem.getInfoAsync(outputPath);
    const bytes = info.exists && 'size' in info ? info.size ?? 0 : 0;
    if (!info.exists || bytes <= 0) {
      // FFmpeg can exit 0 yet write nothing (empty filtergraph, a mediacodec
      // container that never received frames). Don't hand the user a 0-byte
      // file to Save/Share — surface it as a real failure.
      await FileSystem.deleteAsync(outputPath, { idempotent: true }).catch(() => {});
      opts.onFileError(file.id, `FFmpeg produced no output (0 bytes).${logTail(result.logs)}`);
      return;
    }
    opts.onFileDone(file.id, outputPath, outputName, bytes);
  } finally {
    sub.remove();
  }
}

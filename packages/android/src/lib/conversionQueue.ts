/**
 * Module-level conversion queue.
 *
 * The conversion loop lives here, NOT inside a React component, so that
 * switching tabs (and unmounting the Convert view) does not abort the
 * in-flight work.
 *
 * Each session is identified by a string sessionId. Cancellation flips
 * an in-memory flag. The runner checks the flag between files so cancel
 * is best-effort but quick (we can't interrupt an individual
 * expo-image-manipulator call).
 *
 * Phase 4 will swap out the underlying converter for FFmpeg-backed
 * sessions — the queue API stays the same.
 */

import { FORMATS } from './formats';
import { convertImage, ResizeSpec } from './image';
import type { FileEntry } from '../state/types';

const cancelled = new Set<string>();

/** Cancel a session. Idempotent. */
export function cancelSession(sessionId: string): void {
  cancelled.add(sessionId);
}

export function isCancelled(sessionId: string): boolean {
  return cancelled.has(sessionId);
}

/** Drop the cancellation flag once the session is fully drained. */
function clearSession(sessionId: string): void {
  cancelled.delete(sessionId);
}

export type ConvertRunOpts = {
  sessionId: string;
  files: FileEntry[];
  targetFormatKey: string;
  quality: number;
  resize?: ResizeSpec;
  onFileStart: (id: string) => void;
  onFileProgress: (id: string, percent: number) => void;
  onFileDone: (id: string, outputUri: string, outputName: string, outputBytes: number) => void;
  onFileError: (id: string, error: string) => void;
  onFileSkipped: (id: string) => void;
};

/**
 * Run the queue. Returns when all files are processed or the session is
 * cancelled. Callers should NOT await this from a component that may
 * unmount mid-run; just fire it and rely on the callbacks.
 */
export async function runConvertSession(opts: ConvertRunOpts): Promise<void> {
  const fmt = FORMATS.find((f) => f.key === opts.targetFormatKey);
  if (!fmt) {
    for (const file of opts.files) opts.onFileError(file.id, `Unknown format: ${opts.targetFormatKey}`);
    clearSession(opts.sessionId);
    return;
  }

  try {
    for (const file of opts.files) {
      if (isCancelled(opts.sessionId)) break;
      if (file.status === 'error') continue;
      if (!fmt.accepts.includes(file.mediaType)) {
        opts.onFileSkipped(file.id);
        continue;
      }
      if (!fmt.supported) {
        opts.onFileError(file.id, `${fmt.label} not supported on mobile yet — Phase 4`);
        continue;
      }

      opts.onFileStart(file.id);
      // expo-image-manipulator doesn't expose progress so we report 50% halfway
      // (visual progress feedback only; Phase 4 will get real progress).
      opts.onFileProgress(file.id, 25);

      try {
        const result = await convertImage({
          sourceUri: file.uri,
          sourceName: file.name,
          targetFormat: fmt,
          quality: opts.quality,
          resize: opts.resize ?? { kind: 'none' },
        });

        if (isCancelled(opts.sessionId)) break;
        opts.onFileDone(file.id, result.outputUri, result.outputName, result.bytes);
      } catch (e) {
        if (isCancelled(opts.sessionId)) break;
        opts.onFileError(file.id, e instanceof Error ? e.message : String(e));
      }
    }
  } finally {
    clearSession(opts.sessionId);
  }
}

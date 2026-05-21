/**
 * Module-level resize queue — mirror of conversionQueue.ts but specialized
 * for the Resize tab. Image-only via expo-image-manipulator (Phase 5);
 * video resize will be added in the same module once FFmpeg lands.
 */

import { FORMATS } from './formats';
import { convertImage, ResizeSpec } from './image';
import type { FileEntry, ResizeSettings } from '../state/types';

const cancelled = new Set<string>();

export function cancelResizeSession(sessionId: string): void {
  cancelled.add(sessionId);
}

function clear(sessionId: string): void {
  cancelled.delete(sessionId);
}

export type ResizeRunOpts = {
  sessionId: string;
  files: FileEntry[];
  settings: ResizeSettings;
  onFileStart: (id: string) => void;
  onFileProgress: (id: string, percent: number) => void;
  onFileDone: (id: string, outputUri: string, outputName: string, outputBytes: number) => void;
  onFileError: (id: string, error: string) => void;
  onFileSkipped: (id: string) => void;
};

function specFromSettings(s: ResizeSettings): ResizeSpec {
  if (s.mode === 'percentage') {
    return { kind: 'percentage', percent: s.percent };
  }
  if (s.width || s.height) {
    return {
      kind: 'pixels',
      width: s.width ?? undefined,
      height: s.height ?? undefined,
    };
  }
  return { kind: 'none' };
}

/**
 * Apply resize + optional re-encode. If `settings.outputFormat` is null,
 * the source extension is preserved.
 */
export async function runResizeSession(opts: ResizeRunOpts): Promise<void> {
  try {
    for (const file of opts.files) {
      if (cancelled.has(opts.sessionId)) break;
      if (file.status === 'error') continue;
      if (file.mediaType !== 'image') {
        opts.onFileSkipped(file.id);
        continue;
      }

      const targetKey =
        opts.settings.outputFormat ?? file.name.split('.').pop()?.toLowerCase() ?? 'png';
      const fmt = FORMATS.find((f) => f.key === targetKey) ?? FORMATS[0];
      if (!fmt.supported) {
        opts.onFileError(file.id, `${fmt.label} not supported on mobile yet — Phase 4`);
        continue;
      }

      opts.onFileStart(file.id);
      opts.onFileProgress(file.id, 25);

      try {
        const result = await convertImage({
          sourceUri: file.uri,
          sourceName: file.name,
          targetFormat: fmt,
          quality: opts.settings.quality,
          resize: specFromSettings(opts.settings),
        });
        if (cancelled.has(opts.sessionId)) break;
        opts.onFileDone(file.id, result.outputUri, result.outputName, result.bytes);
      } catch (e) {
        if (cancelled.has(opts.sessionId)) break;
        opts.onFileError(file.id, e instanceof Error ? e.message : String(e));
      }
    }
  } finally {
    clear(opts.sessionId);
  }
}

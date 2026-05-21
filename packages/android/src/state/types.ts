/**
 * Shared state types for Convert / Resize / Download / Credits modes.
 *
 * Modeled after desktop's fileStore.js — each mode owns its own slice of
 * { files, settings, view, cancelled }. The slices are independent so
 * switching tabs never resets in-flight work.
 */

import { MediaType } from '../lib/formats';

export type Mode = 'convert' | 'resize' | 'download' | 'credits';

export type FileStatus =
  | 'ready'
  | 'queued'
  | 'converting'
  | 'done'
  | 'error'
  | 'skipped';

/** A row in any mode's file list. */
export type FileEntry = {
  id: string;
  uri: string;
  name: string;
  bytes: number;
  mediaType: MediaType;
  width?: number;
  height?: number;
  status: FileStatus;
  progress: number; // 0..100
  outputUri?: string;
  outputName?: string;
  outputBytes?: number;
  error?: string;
};

/** Top-level view a mode is currently in. */
export type ModeView = 'idle' | 'ready' | 'converting' | 'done';

// ── Convert ────────────────────────────────────────────────────────────────

export type ConvertSettings = {
  /** Target format key — see src/lib/formats.ts. */
  format: string | null;
  /** 0..100. */
  quality: number;
};

export const CONVERT_DEFAULTS: ConvertSettings = {
  format: null,
  quality: 90,
};

// ── Resize ─────────────────────────────────────────────────────────────────

export type ResizeMode = 'percentage' | 'pixels';

export type ResizeSettings = {
  mode: ResizeMode;
  /** Used when mode === 'percentage'. 1..200. */
  percent: number;
  /** Used when mode === 'pixels'. */
  width: number | null;
  height: number | null;
  keepAspect: boolean;
  /** Output format key — defaults to the source's extension. */
  outputFormat: string | null;
  /** Re-encode quality 0..100. */
  quality: number;
};

export const RESIZE_DEFAULTS: ResizeSettings = {
  mode: 'percentage',
  percent: 50,
  width: null,
  height: null,
  keepAspect: true,
  outputFormat: null,
  quality: 92,
};

// ── Download ───────────────────────────────────────────────────────────────

export type DownloadCategory = 'video' | 'audio';

export type DownloadSettings = {
  url: string;
  category: DownloadCategory;
  format: string | null;
  quality: string | null;
  spotifyClientId: string;
  spotifyClientSecret: string;
  cookiesPath: string;
};

export const DOWNLOAD_DEFAULTS: DownloadSettings = {
  url: '',
  category: 'video',
  format: null,
  quality: 'best',
  spotifyClientId: '',
  spotifyClientSecret: '',
  cookiesPath: '',
};

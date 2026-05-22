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
  /** Duration in seconds (for video / audio). Populated by ffprobe. */
  duration?: number;
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

/** Rectangle in source-pixel coords used by the crop overlay. */
export type CropSpec = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type ConvertSettings = {
  /** Target format key — see src/lib/formats.ts. */
  format: string | null;
  /** 0..100 — image/audio quality knob (CRF for video, bitrate for audio). */
  quality: number;

  // ── Video editor fields (Phase v0.4 wires the args, v0.5 ships the UI) ──
  /** Trim in-point (seconds). null = source start. */
  trimStart: number | null;
  /** Trim out-point (seconds). null = source end. */
  trimEnd: number | null;
  /** Mute the output (strip the audio track entirely). */
  stripAudio: boolean;
  /** Playback speed multiplier. 1 = unchanged. atempo handles 0.5-2 directly;
   *  values outside that range get chained. */
  speed: number;
  /** Audio gain as a percentage of source. 0 = mute, 100 = unchanged, 200 = +6dB. */
  volume: number;
  /** Output rotation in degrees clockwise. 0 / 90 / 180 / 270. */
  rotate: 0 | 90 | 180 | 270;
  /** Horizontal flip (mirror). */
  flipH: boolean;
  /** Vertical flip. */
  flipV: boolean;
  /** Crop rectangle in source-pixel coords, or null = no crop. */
  crop: CropSpec | null;

  // ── GIF-specific (when target == 'gif') — defaults applied in ffmpegArgs. ──
  /** Target width for GIF output. null = 480 (default). */
  gifWidth: number | null;
  /** Target framerate for GIF output. null = 15. */
  gifFps: number | null;
  /** Palette colors 2-256. null = 256. */
  gifColors: number | null;
  /** Dither algorithm. null = sierra2_4a. */
  gifDither: 'none' | 'bayer' | 'floyd_steinberg' | 'sierra2_4a' | null;
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
  gifWidth: null,
  gifFps: null,
  gifColors: null,
  gifDither: null,
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

/**
 * Build FFmpeg arg arrays for each Convert-X target.
 *
 * Quality is a 0..100 user-facing knob. For video → CRF (lower CRF = better
 * quality). For audio → bitrate (kbps).
 */

import type { FormatDef } from './formats';

const VIDEO_CRF_HI = 18; // quality=100
const VIDEO_CRF_LO = 32; // quality=0
const AUDIO_BITRATE_HI = 320;
const AUDIO_BITRATE_LO = 64;

function videoCrf(quality: number): number {
  const clamped = Math.max(0, Math.min(100, quality));
  return Math.round(VIDEO_CRF_LO + (VIDEO_CRF_HI - VIDEO_CRF_LO) * (clamped / 100));
}

function audioBitrate(quality: number): number {
  const clamped = Math.max(0, Math.min(100, quality));
  return Math.round(AUDIO_BITRATE_LO + (AUDIO_BITRATE_HI - AUDIO_BITRATE_LO) * (clamped / 100));
}

export type FfmpegBuildOpts = {
  inputPath: string;
  outputPath: string;
  target: FormatDef;
  quality: number;
  /** Strip audio if the source is video and the target is also video (mute). */
  stripAudio?: boolean;
  /** Optional resize in pixels — applied via `-vf scale`. */
  resizeWidth?: number | null;
  resizeHeight?: number | null;
};

export function buildArgs(opts: FfmpegBuildOpts): string[] {
  const { target, inputPath, outputPath } = opts;

  // GIF target is special: needs a palette-aware encoder regardless of
  // whether the source is image or video. Single-pass with the bundled
  // palette filter — quality is good enough for the common case.
  if (target.key === 'gif') {
    return buildGifArgs(opts);
  }

  const base = ['-y', '-i', inputPath, '-hide_banner'];
  if (target.category === 'video') {
    return [...base, ...buildVideoArgs(opts), outputPath];
  }
  if (target.category === 'audio') {
    return [...base, ...buildAudioArgs(opts), outputPath];
  }
  // Image-via-FFmpeg (BMP/TIFF/etc) — Phase 9 polish.
  return [...base, ...buildImageArgs(opts), outputPath];
}

function buildGifArgs(opts: FfmpegBuildOpts): string[] {
  const { inputPath, outputPath, resizeWidth } = opts;
  // Sensible defaults — desktop's GifSettings exposes these as user knobs;
  // Phase 7b ports the full panel.
  const width = resizeWidth ?? 480;
  const fps = 15;
  // Single-pass with split+palettegen/paletteuse — best quality without
  // a second invocation. `split` duplicates the stream so the palettegen
  // can see the whole input.
  const filter =
    `fps=${fps},scale=${width}:-2:flags=lanczos,split[s0][s1];` +
    `[s0]palettegen=max_colors=256:reserve_transparent=0[p];` +
    `[s1][p]paletteuse=dither=sierra2_4a`;
  return ['-y', '-i', inputPath, '-hide_banner', '-vf', filter, '-loop', '0', outputPath];
}

function buildVideoArgs(opts: FfmpegBuildOpts): string[] {
  const { target, quality, stripAudio, resizeWidth, resizeHeight } = opts;
  const args: string[] = [];

  // Codec per container
  switch (target.key) {
    case 'mp4':
    case 'mov':
    case 'mkv':
      args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', String(videoCrf(quality)));
      args.push('-pix_fmt', 'yuv420p');
      break;
    case 'webm':
      args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(videoCrf(quality)));
      break;
    default:
      args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', String(videoCrf(quality)));
  }

  // Resize filter
  if (resizeWidth || resizeHeight) {
    const w = resizeWidth ?? -2; // -2 = auto-keep-aspect (must be even)
    const h = resizeHeight ?? -2;
    args.push('-vf', `scale=${w}:${h}`);
  }

  // Audio
  if (stripAudio) {
    args.push('-an');
  } else {
    if (target.key === 'webm') {
      args.push('-c:a', 'libopus', '-b:a', '128k');
    } else {
      args.push('-c:a', 'aac', '-b:a', '160k');
    }
  }

  // Tagged moov atom up-front so the file plays before fully downloaded.
  if (target.key === 'mp4' || target.key === 'mov') {
    args.push('-movflags', '+faststart');
  }

  return args;
}

function buildAudioArgs(opts: FfmpegBuildOpts): string[] {
  const { target, quality } = opts;
  const args: string[] = ['-vn']; // drop video stream if input is a video

  const br = `${audioBitrate(quality)}k`;
  switch (target.key) {
    case 'mp3':
      args.push('-c:a', 'libmp3lame', '-b:a', br);
      break;
    case 'wav':
      args.push('-c:a', 'pcm_s16le');
      break;
    case 'flac':
      args.push('-c:a', 'flac');
      break;
    case 'ogg':
      args.push('-c:a', 'libvorbis', '-b:a', br);
      break;
    case 'opus':
      args.push('-c:a', 'libopus', '-b:a', br);
      break;
    case 'm4a':
      args.push('-c:a', 'aac', '-b:a', br);
      break;
    default:
      args.push('-c:a', 'libmp3lame', '-b:a', br);
  }

  return args;
}

function buildImageArgs(opts: FfmpegBuildOpts): string[] {
  // Most image conversion still flows through expo-image-manipulator —
  // this branch only handles formats the manipulator can't (BMP/TIFF).
  const { resizeWidth, resizeHeight } = opts;
  const args: string[] = [];
  if (resizeWidth || resizeHeight) {
    args.push('-vf', `scale=${resizeWidth ?? -2}:${resizeHeight ?? -2}`);
  }
  return args;
}

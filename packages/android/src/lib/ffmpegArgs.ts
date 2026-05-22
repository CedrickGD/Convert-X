/**
 * Build FFmpeg arg arrays for each Convert-X target.
 *
 * Quality is a 0..100 user-facing knob. For video → CRF (lower CRF = better
 * quality). For audio → bitrate (kbps).
 *
 * Editor fields (trim, stripAudio, speed, volume, rotate, flip, crop) are
 * applied here when the source is a video; image-only conversions ignore
 * them. GIF target takes its own palette-based path.
 */

import type { FormatDef } from './formats';
import type { ConvertSettings, CropSpec } from '../state/types';

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
  /** Optional resize in pixels — applied via `-vf scale`. */
  resizeWidth?: number | null;
  resizeHeight?: number | null;

  // Video editor fields — applied when the source is video. Optional;
  // callers can omit to take the defaults (no edits).
  trimStart?: number | null;
  trimEnd?: number | null;
  stripAudio?: boolean;
  speed?: number;
  volume?: number;
  rotate?: 0 | 90 | 180 | 270;
  flipH?: boolean;
  flipV?: boolean;
  crop?: CropSpec | null;

  // GIF-specific knobs (when target is 'gif').
  gifWidth?: number | null;
  gifFps?: number | null;
  gifColors?: number | null;
  gifDither?: 'none' | 'bayer' | 'floyd_steinberg' | 'sierra2_4a' | null;
};

/**
 * Spread the full ConvertSettings into FfmpegBuildOpts. Saves the caller
 * having to wire each field by hand.
 */
export function fromConvertSettings(
  s: ConvertSettings,
  fields: { inputPath: string; outputPath: string; target: FormatDef }
): FfmpegBuildOpts {
  return {
    ...fields,
    quality: s.quality,
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
  };
}

export function buildArgs(opts: FfmpegBuildOpts): string[] {
  const { target, inputPath, outputPath } = opts;

  // GIF target is special: needs a palette-aware encoder regardless of
  // whether the source is image or video.
  if (target.key === 'gif') {
    return buildGifArgs(opts);
  }

  // Trim args go BEFORE -i for fast seek when possible.
  const pre: string[] = ['-y', '-hide_banner'];
  if (opts.trimStart != null && opts.trimStart > 0) {
    pre.push('-ss', opts.trimStart.toString());
  }
  if (opts.trimEnd != null && opts.trimEnd > 0) {
    pre.push('-to', opts.trimEnd.toString());
  }
  pre.push('-i', inputPath);

  if (target.category === 'video') {
    return [...pre, ...buildVideoArgs(opts), outputPath];
  }
  if (target.category === 'audio') {
    return [...pre, ...buildAudioArgs(opts), outputPath];
  }
  return [...pre, ...buildImageArgs(opts), outputPath];
}

// ── Video ──────────────────────────────────────────────────────────────────

function buildVideoArgs(opts: FfmpegBuildOpts): string[] {
  const { target, quality } = opts;
  const args: string[] = [];

  // Hardware H.264 bitrate ladder. h264_mediacodec uses -b:v, not -crf
  // (mediacodec does NOT support rate-distortion-optimized quality knobs).
  // We map quality 0..100 to a sensible bitrate band for 1080p sources.
  // Lower bitrate at quality=0 keeps small clips small; quality=100
  // produces ~12 Mbps which is visually transparent for most footage.
  const h264Bitrate = `${Math.round(2_000_000 + (quality / 100) * 10_000_000)}`;

  // Video codec
  switch (target.key) {
    case 'mp4':
    case 'mov':
    case 'mkv':
      // h264_mediacodec is Android's hardware H.264 encoder — built into
      // FFmpeg via the mediacodec wrapper, no libx264 needed. Faster than
      // libx264 (it's hardware) and produces good quality.
      args.push('-c:v', 'h264_mediacodec', '-b:v', h264Bitrate);
      break;
    case 'avi':
      args.push('-c:v', 'mpeg4', '-q:v', String(31 - Math.round(quality / 5)));
      break;
    case 'flv':
      args.push('-c:v', 'flv1', '-q:v', String(31 - Math.round(quality / 5)));
      break;
    case 'wmv':
      args.push('-c:v', 'msmpeg4v3', '-q:v', String(31 - Math.round(quality / 5)));
      break;
    case 'ts':
      args.push('-c:v', 'h264_mediacodec', '-b:v', h264Bitrate);
      args.push('-f', 'mpegts');
      break;
    default:
      args.push('-c:v', 'h264_mediacodec', '-b:v', h264Bitrate);
  }

  // Video filters — resize, crop, rotate, flip — composed into one -vf chain.
  const vf = buildVideoFilterChain(opts);
  if (vf) args.push('-vf', vf);

  // Speed (video side): setpts wraps the timestamps. atempo on audio is
  // applied in the audio block.
  if (opts.speed && opts.speed !== 1) {
    // Append to the filter chain. If we already have -vf, fold setpts in.
    if (vf) {
      // pop the just-added -vf <chain> and replace with the chain + setpts
      args.pop();
      args.pop();
      args.push('-vf', `${vf},setpts=PTS/${opts.speed}`);
    } else {
      args.push('-vf', `setpts=PTS/${opts.speed}`);
    }
  }

  // Audio
  if (opts.stripAudio) {
    args.push('-an');
  } else {
    // Choose audio codec per container — all built-in in ffmpeg-kit-main-min
    // (no external lame / libopus needed). AAC is the default since it's
    // the broadest codec compatibility on Android; WMA pairs with WMV
    // because legacy players expect that combo.
    const audioCodec =
      target.key === 'wmv'  ? ['-c:a', 'wmav2', '-b:a', '160k'] :
                              ['-c:a', 'aac', '-b:a', '160k'];
    args.push(...audioCodec);

    // Audio filter chain — speed (atempo) + volume.
    const af = buildAudioFilterChain(opts);
    if (af) args.push('-af', af);
  }

  if (target.key === 'mp4' || target.key === 'mov') {
    args.push('-movflags', '+faststart');
  }

  return args;
}

function buildVideoFilterChain(opts: FfmpegBuildOpts): string {
  const parts: string[] = [];
  // Crop must come first while we still have original coords.
  if (opts.crop) {
    const c = opts.crop;
    parts.push(`crop=${c.w}:${c.h}:${c.x}:${c.y}`);
  }
  if (opts.flipH) parts.push('hflip');
  if (opts.flipV) parts.push('vflip');
  if (opts.rotate) {
    // transpose: 1 = 90cw, 2 = 90ccw. For 180 = two 90cw. For 270 = 90ccw.
    if (opts.rotate === 90) parts.push('transpose=1');
    else if (opts.rotate === 180) parts.push('transpose=1,transpose=1');
    else if (opts.rotate === 270) parts.push('transpose=2');
  }
  if (opts.resizeWidth || opts.resizeHeight) {
    const w = opts.resizeWidth ?? -2;
    const h = opts.resizeHeight ?? -2;
    parts.push(`scale=${w}:${h}`);
  }
  return parts.join(',');
}

function buildAudioFilterChain(opts: FfmpegBuildOpts): string {
  const parts: string[] = [];
  // atempo accepts 0.5..2 per filter; chain to handle larger ranges.
  if (opts.speed && opts.speed !== 1) {
    let remaining = opts.speed;
    while (remaining > 2) {
      parts.push('atempo=2');
      remaining /= 2;
    }
    while (remaining < 0.5) {
      parts.push('atempo=0.5');
      remaining /= 0.5;
    }
    if (Math.abs(remaining - 1) > 1e-3) {
      parts.push(`atempo=${remaining.toFixed(3)}`);
    }
  }
  if (opts.volume != null && opts.volume !== 100) {
    parts.push(`volume=${(opts.volume / 100).toFixed(3)}`);
  }
  return parts.join(',');
}

// ── Audio ──────────────────────────────────────────────────────────────────

function buildAudioArgs(opts: FfmpegBuildOpts): string[] {
  const { target, quality } = opts;
  const args: string[] = ['-vn']; // drop video stream if input is a video

  const br = `${audioBitrate(quality)}k`;
  switch (target.key) {
    // Built-in FFmpeg encoders only — main-min variant has no lame / libopus /
    // libvorbis. The native encoders are present under the same codec names
    // (no `lib` prefix) so we just swap.
    case 'wav':  args.push('-c:a', 'pcm_s16le'); break;
    case 'flac': args.push('-c:a', 'flac'); break;
    case 'ogg':  args.push('-c:a', 'vorbis', '-strict', 'experimental', '-b:a', br); break;
    case 'opus': args.push('-c:a', 'opus', '-strict', 'experimental', '-b:a', br); break;
    case 'm4a':  args.push('-c:a', 'aac', '-b:a', br); break;
    case 'aac':  args.push('-c:a', 'aac', '-b:a', br); break;
    case 'wma':  args.push('-c:a', 'wmav2', '-b:a', br); break;
    // mp3 falls through to default — see formats.ts, MP3 is marked unsupported.
    default:     args.push('-c:a', 'aac', '-b:a', br);
  }

  // Audio filters (speed + volume) apply on audio-only outputs too.
  const af = buildAudioFilterChain(opts);
  if (af) args.push('-af', af);

  return args;
}

// ── Image ──────────────────────────────────────────────────────────────────

function buildImageArgs(opts: FfmpegBuildOpts): string[] {
  // BMP / TIFF / ICO via FFmpeg. The codec is implied by the file extension
  // so we only need to wire resize.
  const vf = buildVideoFilterChain(opts);
  const args: string[] = [];
  if (vf) args.push('-vf', vf);
  // For ICO, force pixel format that the encoder accepts.
  if (opts.target.key === 'ico') {
    args.push('-pix_fmt', 'rgba');
  }
  // Single-frame for image outputs.
  args.push('-frames:v', '1');
  return args;
}

// ── GIF (palette pipeline) ─────────────────────────────────────────────────

function buildGifArgs(opts: FfmpegBuildOpts): string[] {
  const { inputPath, outputPath } = opts;
  const pre: string[] = ['-y', '-hide_banner'];
  if (opts.trimStart != null && opts.trimStart > 0) {
    pre.push('-ss', opts.trimStart.toString());
  }
  if (opts.trimEnd != null && opts.trimEnd > 0) {
    pre.push('-to', opts.trimEnd.toString());
  }
  pre.push('-i', inputPath);

  const width = opts.gifWidth ?? opts.resizeWidth ?? 480;
  const fps = opts.gifFps ?? 15;
  const colors = opts.gifColors ?? 256;
  const dither = opts.gifDither ?? 'sierra2_4a';

  // Compose the editor filters in front of the palette pipeline.
  const editorChain: string[] = [];
  if (opts.crop) {
    const c = opts.crop;
    editorChain.push(`crop=${c.w}:${c.h}:${c.x}:${c.y}`);
  }
  if (opts.flipH) editorChain.push('hflip');
  if (opts.flipV) editorChain.push('vflip');
  if (opts.rotate === 90) editorChain.push('transpose=1');
  else if (opts.rotate === 180) editorChain.push('transpose=1,transpose=1');
  else if (opts.rotate === 270) editorChain.push('transpose=2');
  if (opts.speed && opts.speed !== 1) {
    editorChain.push(`setpts=PTS/${opts.speed}`);
  }

  const editorPrefix = editorChain.length > 0 ? editorChain.join(',') + ',' : '';
  const filter =
    `${editorPrefix}fps=${fps},scale=${width}:-2:flags=lanczos,split[s0][s1];` +
    `[s0]palettegen=max_colors=${colors}:reserve_transparent=0[p];` +
    `[s1][p]paletteuse=dither=${dither}`;

  return [...pre, '-vf', filter, '-loop', '0', outputPath];
}

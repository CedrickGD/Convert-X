/**
 * Build FFmpeg arg arrays for each Convert-X target.
 *
 * Quality is a 0..100 user-facing knob. For video → CRF (lower CRF = better
 * quality). For audio → bitrate (kbps). When targetSizeMb is set and the
 * clip duration is known, video targets switch to a computed bitrate budget
 * instead — the two rate-control modes are mutually exclusive.
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

// Target-size mode: the size budget assumes this audio bitrate (0 when
// stripAudio), and the video bitrate never drops below the floor — a
// too-small target should degrade, not produce unplayable output.
const TARGET_SIZE_AUDIO_KBIT = 128;
const TARGET_SIZE_MIN_VIDEO_KBIT = 100;

function videoCrf(quality: number): number {
  const clamped = Math.max(0, Math.min(100, quality));
  return Math.round(VIDEO_CRF_LO + (VIDEO_CRF_HI - VIDEO_CRF_LO) * (clamped / 100));
}

function audioBitrate(quality: number): number {
  const clamped = Math.max(0, Math.min(100, quality));
  return Math.round(AUDIO_BITRATE_LO + (AUDIO_BITRATE_HI - AUDIO_BITRATE_LO) * (clamped / 100));
}

/** Map quality 0..100 → mpeg4/flv1/msmpeg4 qscale 31..1 (lower = better). The
 *  old `31 - quality/5` topped out at 11, so best quality was never reachable. */
function mpeg4Qscale(quality: number): number {
  const q = Math.max(0, Math.min(100, quality));
  return Math.max(1, Math.round(31 - (q / 100) * 30));
}

/** H.264 hardware-encoder (h264_mediacodec) targets — everything except the
 *  legacy software-codec containers (avi/flv/wmv, which use mpeg4/flv1/
 *  msmpeg4v3). mediacodec rejects odd width/height; the software encoders are
 *  more forgiving. */
function usesMediacodec(key: string): boolean {
  return !['avi', 'flv', 'wmv'].includes(key);
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
  // callers can omit to take the defaults (no edits). Trim is per-file
  // (FileEntry.trimStart/trimEnd), not a settings field.
  trimStart?: number | null;
  trimEnd?: number | null;
  /** Source duration in seconds (editor probe or ffprobe). Enables the
   *  target-size bitrate computation; unknown = quality mode. */
  sourceDurationSec?: number | null;
  /** Target output size in MB for video targets. null/undefined = off. */
  targetSizeMb?: number | null;
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
 * having to wire each field by hand. Trim + duration are per-file, so they
 * ride in `fields` rather than settings.
 */
export function fromConvertSettings(
  s: ConvertSettings,
  fields: {
    inputPath: string;
    outputPath: string;
    target: FormatDef;
    trimStart?: number | null;
    trimEnd?: number | null;
    sourceDurationSec?: number | null;
  }
): FfmpegBuildOpts {
  return {
    ...fields,
    quality: s.quality,
    targetSizeMb: s.targetSizeMb,
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

  // Trim args go BEFORE -i for fast seek when possible. Non-GIF image
  // targets only ever accept image inputs (FORMATS.accepts) — a still frame
  // has no timeline, so -ss/-to must never reach them.
  const pre: string[] = ['-y', '-hide_banner'];
  if (target.category !== 'image') {
    if (opts.trimStart != null && opts.trimStart > 0) {
      pre.push('-ss', opts.trimStart.toString());
    }
    if (opts.trimEnd != null && opts.trimEnd > 0) {
      pre.push('-to', opts.trimEnd.toString());
    }
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

/** Seconds of OUTPUT the size budget must cover — the trim window capped to
 *  the known source duration, stretched by speed (2× speed halves the
 *  output). null = unknown, which makes the caller keep quality mode. */
function outputDurationSec(opts: FfmpegBuildOpts): number | null {
  const start = opts.trimStart != null && opts.trimStart > 0 ? opts.trimStart : 0;
  const end = opts.trimEnd != null && opts.trimEnd > 0 ? opts.trimEnd : null;
  const src =
    opts.sourceDurationSec != null && opts.sourceDurationSec > 0
      ? opts.sourceDurationSec
      : null;
  let clip: number | null = null;
  if (src != null) {
    clip = (end != null ? Math.min(end, src) : src) - start;
  } else if (end != null) {
    clip = end - start;
  }
  if (clip == null || clip <= 0) return null;
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  return clip / speed;
}

/** -b:v in kbit/s that fits targetSizeMb, or null when target-size mode is
 *  off / the duration is unknown (silent fallback to the quality knob). */
function targetVideoKbit(opts: FfmpegBuildOpts): number | null {
  if (opts.targetSizeMb == null || opts.targetSizeMb <= 0) return null;
  const seconds = outputDurationSec(opts);
  if (seconds == null) return null;
  // 3% shaved off the budget for container overhead.
  const totalKbit = opts.targetSizeMb * 8192 * 0.97;
  const audioKbit = opts.stripAudio ? 0 : TARGET_SIZE_AUDIO_KBIT;
  return Math.max(
    TARGET_SIZE_MIN_VIDEO_KBIT,
    Math.round(totalKbit / seconds - audioKbit)
  );
}

function buildVideoArgs(opts: FfmpegBuildOpts): string[] {
  const { target, quality } = opts;
  const args: string[] = [];

  // Hardware H.264 bitrate ladder. h264_mediacodec uses -b:v, not -crf
  // (mediacodec does NOT support rate-distortion-optimized quality knobs).
  // We map quality 0..100 to a sensible bitrate band for 1080p sources.
  // Lower bitrate at quality=0 keeps small clips small; quality=100
  // produces ~12 Mbps which is visually transparent for most footage.
  const h264Bitrate = `${Math.round(2_000_000 + (quality / 100) * 10_000_000)}`;

  // Target-size mode replaces the quality knob entirely — a fixed -b:v and
  // the quality-derived -q:v / bitrate band are conflicting rate controls,
  // so exactly one set is emitted per file.
  const sizeKbit = targetVideoKbit(opts);
  const sizeRate =
    sizeKbit != null
      ? [
          '-b:v', `${sizeKbit}k`,
          '-maxrate', `${Math.round(sizeKbit * 1.45)}k`,
          '-bufsize', `${sizeKbit * 2}k`,
        ]
      : null;

  // Video codec
  switch (target.key) {
    case 'mp4':
    case 'mov':
    case 'mkv':
      // h264_mediacodec is Android's hardware H.264 encoder — built into
      // FFmpeg via the mediacodec wrapper, no libx264 needed. Faster than
      // libx264 (it's hardware) and produces good quality.
      args.push('-c:v', 'h264_mediacodec', ...(sizeRate ?? ['-b:v', h264Bitrate]));
      break;
    case 'avi':
      args.push('-c:v', 'mpeg4', ...(sizeRate ?? ['-q:v', String(mpeg4Qscale(quality))]));
      break;
    case 'flv':
      args.push('-c:v', 'flv1', ...(sizeRate ?? ['-q:v', String(mpeg4Qscale(quality))]));
      break;
    case 'wmv':
      args.push('-c:v', 'msmpeg4v3', ...(sizeRate ?? ['-q:v', String(mpeg4Qscale(quality))]));
      break;
    case 'ts':
      args.push('-c:v', 'h264_mediacodec', ...(sizeRate ?? ['-b:v', h264Bitrate]));
      args.push('-f', 'mpegts');
      break;
    default:
      args.push('-c:v', 'h264_mediacodec', ...(sizeRate ?? ['-b:v', h264Bitrate]));
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
    // because legacy players expect that combo. Target-size mode budgets
    // TARGET_SIZE_AUDIO_KBIT for audio, so emit that instead of the fixed
    // 160k or the size math wouldn't hold.
    const abr = sizeKbit != null ? `${TARGET_SIZE_AUDIO_KBIT}k` : '160k';
    const audioCodec =
      target.key === 'wmv'  ? ['-c:a', 'wmav2', '-b:a', abr] :
                              ['-c:a', 'aac', '-b:a', abr];
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
  // h264_mediacodec (used for every mp4/mov/mkv/ts target) rejects odd
  // width/height — common after a crop or rotate, or from an odd-sized
  // source. Force even final dimensions. Video targets only: the image
  // encoders (bmp/tiff/ico) share this chain and accept odd dimensions.
  if (opts.target.category === 'video' && usesMediacodec(opts.target.key)) {
    parts.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
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

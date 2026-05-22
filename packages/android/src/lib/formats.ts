export type MediaType = 'image' | 'video' | 'audio' | 'unknown';

export type FormatDef = {
  key: string;
  label: string;
  ext: string;
  mime: string;
  category: MediaType;
  /** Which input categories can be converted to this format right now. */
  accepts: readonly MediaType[];
  /** If true, conversion to this format is implemented by the mobile app today. */
  supported: boolean;
};

/**
 * Mobile format catalog — desktop Convert-X parity.
 *
 * - Image conversion: PNG / JPG / WebP go through expo-image-manipulator
 *   (no FFmpeg roundtrip needed). Everything else routes through FFmpeg
 *   full-gpl (already in the convert-x-ffmpeg native module).
 * - Video + audio conversion: FFmpeg.
 * - GIF: FFmpeg's palettegen + paletteuse pipeline (sierra2_4a dither).
 */
export const FORMATS: readonly FormatDef[] = [
  // ── Images ────────────────────────────────────────────────────────────
  { key: 'png',  label: 'PNG',  ext: 'png',  mime: 'image/png',  category: 'image', accepts: ['image'],          supported: true },
  { key: 'jpg',  label: 'JPG',  ext: 'jpg',  mime: 'image/jpeg', category: 'image', accepts: ['image'],          supported: true },
  { key: 'webp', label: 'WebP', ext: 'webp', mime: 'image/webp', category: 'image', accepts: ['image'],          supported: true },
  { key: 'bmp',  label: 'BMP',  ext: 'bmp',  mime: 'image/bmp',  category: 'image', accepts: ['image'],          supported: true },
  { key: 'tiff', label: 'TIFF', ext: 'tiff', mime: 'image/tiff', category: 'image', accepts: ['image'],          supported: true },
  { key: 'ico',  label: 'ICO',  ext: 'ico',  mime: 'image/x-icon', category: 'image', accepts: ['image'],        supported: true },
  { key: 'gif',  label: 'GIF',  ext: 'gif',  mime: 'image/gif',  category: 'image', accepts: ['image', 'video'], supported: true },

  // ── Video (FFmpeg) ────────────────────────────────────────────────────
  { key: 'mp4',  label: 'MP4',  ext: 'mp4',  mime: 'video/mp4',         category: 'video', accepts: ['video'], supported: true },
  { key: 'webm', label: 'WebM', ext: 'webm', mime: 'video/webm',        category: 'video', accepts: ['video'], supported: true },
  { key: 'mov',  label: 'MOV',  ext: 'mov',  mime: 'video/quicktime',   category: 'video', accepts: ['video'], supported: true },
  { key: 'mkv',  label: 'MKV',  ext: 'mkv',  mime: 'video/x-matroska',  category: 'video', accepts: ['video'], supported: true },
  { key: 'avi',  label: 'AVI',  ext: 'avi',  mime: 'video/x-msvideo',   category: 'video', accepts: ['video'], supported: true },
  { key: 'flv',  label: 'FLV',  ext: 'flv',  mime: 'video/x-flv',       category: 'video', accepts: ['video'], supported: true },
  { key: 'wmv',  label: 'WMV',  ext: 'wmv',  mime: 'video/x-ms-wmv',    category: 'video', accepts: ['video'], supported: true },
  { key: 'ts',   label: 'TS',   ext: 'ts',   mime: 'video/mp2t',        category: 'video', accepts: ['video'], supported: true },

  // ── Audio (FFmpeg) ────────────────────────────────────────────────────
  { key: 'mp3',  label: 'MP3',  ext: 'mp3',  mime: 'audio/mpeg',  category: 'audio', accepts: ['audio', 'video'], supported: true },
  { key: 'wav',  label: 'WAV',  ext: 'wav',  mime: 'audio/wav',   category: 'audio', accepts: ['audio', 'video'], supported: true },
  { key: 'flac', label: 'FLAC', ext: 'flac', mime: 'audio/flac',  category: 'audio', accepts: ['audio', 'video'], supported: true },
  { key: 'ogg',  label: 'OGG',  ext: 'ogg',  mime: 'audio/ogg',   category: 'audio', accepts: ['audio', 'video'], supported: true },
  { key: 'opus', label: 'Opus', ext: 'opus', mime: 'audio/opus',  category: 'audio', accepts: ['audio', 'video'], supported: true },
  { key: 'm4a',  label: 'M4A',  ext: 'm4a',  mime: 'audio/mp4',   category: 'audio', accepts: ['audio', 'video'], supported: true },
  { key: 'aac',  label: 'AAC',  ext: 'aac',  mime: 'audio/aac',   category: 'audio', accepts: ['audio', 'video'], supported: true },
  { key: 'wma',  label: 'WMA',  ext: 'wma',  mime: 'audio/x-ms-wma', category: 'audio', accepts: ['audio', 'video'], supported: true },
];

export function mediaTypeFromMime(mime: string | null | undefined): MediaType {
  if (!mime) return 'unknown';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'unknown';
}

export function mediaTypeFromName(name: string): MediaType {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const f = FORMATS.find((x) => x.ext === ext);
  return f?.category ?? 'unknown';
}

export function formatsFor(input: MediaType): FormatDef[] {
  return FORMATS.filter((f) => f.accepts.includes(input));
}

export function formatsByCategory(input: MediaType): Record<MediaType, FormatDef[]> {
  const available = formatsFor(input);
  return {
    image: available.filter((f) => f.category === 'image'),
    video: available.filter((f) => f.category === 'video'),
    audio: available.filter((f) => f.category === 'audio'),
    unknown: [],
  };
}

export function prettyBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

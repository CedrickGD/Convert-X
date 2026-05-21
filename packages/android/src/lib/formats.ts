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
 * On mobile we currently implement image format conversion via expo-image-manipulator.
 * Video and audio entries are catalogued for UI completeness but marked `supported: false`
 * so the UI can dim them and explain they're coming in a future release.
 */
export const FORMATS: readonly FormatDef[] = [
  // Images — implemented today
  {
    key: 'png',
    label: 'PNG',
    ext: 'png',
    mime: 'image/png',
    category: 'image',
    accepts: ['image'],
    supported: true,
  },
  {
    key: 'jpg',
    label: 'JPG',
    ext: 'jpg',
    mime: 'image/jpeg',
    category: 'image',
    accepts: ['image'],
    supported: true,
  },
  {
    key: 'webp',
    label: 'WebP',
    ext: 'webp',
    mime: 'image/webp',
    category: 'image',
    accepts: ['image'],
    supported: true,
  },
  // Images — planned
  {
    key: 'bmp',
    label: 'BMP',
    ext: 'bmp',
    mime: 'image/bmp',
    category: 'image',
    accepts: ['image'],
    supported: false,
  },
  {
    key: 'tiff',
    label: 'TIFF',
    ext: 'tiff',
    mime: 'image/tiff',
    category: 'image',
    accepts: ['image'],
    supported: false,
  },
  {
    key: 'gif',
    label: 'GIF',
    ext: 'gif',
    mime: 'image/gif',
    category: 'image',
    accepts: ['image', 'video'],
    supported: false,
  },
  // Video — planned
  {
    key: 'mp4',
    label: 'MP4',
    ext: 'mp4',
    mime: 'video/mp4',
    category: 'video',
    accepts: ['video', 'image'],
    supported: false,
  },
  {
    key: 'webm',
    label: 'WebM',
    ext: 'webm',
    mime: 'video/webm',
    category: 'video',
    accepts: ['video'],
    supported: false,
  },
  {
    key: 'mov',
    label: 'MOV',
    ext: 'mov',
    mime: 'video/quicktime',
    category: 'video',
    accepts: ['video'],
    supported: false,
  },
  // Audio — planned
  {
    key: 'mp3',
    label: 'MP3',
    ext: 'mp3',
    mime: 'audio/mpeg',
    category: 'audio',
    accepts: ['audio', 'video'],
    supported: false,
  },
  {
    key: 'wav',
    label: 'WAV',
    ext: 'wav',
    mime: 'audio/wav',
    category: 'audio',
    accepts: ['audio', 'video'],
    supported: false,
  },
  {
    key: 'flac',
    label: 'FLAC',
    ext: 'flac',
    mime: 'audio/flac',
    category: 'audio',
    accepts: ['audio', 'video'],
    supported: false,
  },
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

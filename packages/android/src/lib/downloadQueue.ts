/**
 * Module-level downloader queue. Mirrors conversionQueue + resizeQueue.
 *
 * Each Download session goes through:
 *   1. probe(url) — yt-dlp --dump-json
 *   2. download(entry, format, quality) — yt-dlp -f <fmt> -o <path>
 *
 * The native module emits onProgress events while download() runs; we
 * relay them to the UI via the registered listener.
 */

import * as FileSystem from 'expo-file-system/legacy';

import * as Downloader from '../../modules/convert-x-downloader/src';

export type DownloadEntry = {
  id: string;
  title: string;
  thumbnail?: string;
  duration?: number;
  webpageUrl: string;
};

export type ProbeResult = {
  site: string | null;
  isPlaylist: boolean;
  entries: DownloadEntry[];
};

let inflight: { sessionId: string; cancel: () => void } | null = null;

export function isDownloading(): boolean {
  return inflight !== null;
}

export function cancelActive(): void {
  if (inflight) {
    Downloader.cancel(inflight.sessionId);
    inflight = null;
  }
}

export async function probeUrl(
  url: string,
  opts?: {
    cookies?: string;
    spotifyClientId?: string;
    spotifyClientSecret?: string;
  }
): Promise<ProbeResult> {
  const site = Downloader.detectSite(url);
  const raw = await Downloader.probe(url, opts);
  const isPlaylist = Boolean(raw.isPlaylist);
  const entries: DownloadEntry[] = [];

  if (isPlaylist && Array.isArray(raw.entries)) {
    for (const e of raw.entries as Array<Record<string, unknown>>) {
      entries.push({
        id: String(e.id ?? e.url ?? Date.now()),
        title: String(e.title ?? 'Untitled'),
        thumbnail: typeof e.thumbnail === 'string' ? e.thumbnail : undefined,
        duration: typeof e.duration === 'number' ? e.duration : undefined,
        webpageUrl: String(e.url ?? raw.url ?? url),
      });
    }
  } else {
    entries.push({
      id: String((raw as Record<string, unknown>).id ?? Date.now()),
      title: String((raw as Record<string, unknown>).title ?? 'Untitled'),
      thumbnail: typeof (raw as Record<string, unknown>).thumbnail === 'string'
        ? ((raw as Record<string, unknown>).thumbnail as string)
        : undefined,
      duration: typeof (raw as Record<string, unknown>).duration === 'number'
        ? ((raw as Record<string, unknown>).duration as number)
        : undefined,
      webpageUrl: String((raw as Record<string, unknown>).url ?? url),
    });
  }

  return { site, isPlaylist, entries };
}

export async function downloadEntry(opts: {
  sessionId: string;
  entry: DownloadEntry;
  audioOnly: boolean;
  format: string | null;
  quality: string | null;
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  cookies?: string;
  onProgress: (pct: number) => void;
}): Promise<{ outputPath?: string; cancelled?: boolean }> {
  const outDir = `${FileSystem.documentDirectory}downloads`;
  await FileSystem.makeDirectoryAsync(outDir, { intermediates: true }).catch(() => {});

  // yt-dlp template — let yt-dlp pick the final extension.
  const outputTemplate = `${outDir.replace(/^file:\/\//, '')}/%(title)s.%(ext)s`;

  const sub = Downloader.addProgressListener((evt) => {
    if (evt.sessionId === opts.sessionId) opts.onProgress(Math.round(evt.percent));
  });

  inflight = { sessionId: opts.sessionId, cancel: () => Downloader.cancel(opts.sessionId) };

  try {
    const result = await Downloader.download(opts.sessionId, {
      url: opts.entry.webpageUrl,
      outputPath: outputTemplate,
      audioOnly: opts.audioOnly,
      audioFormat: opts.audioOnly ? opts.format ?? 'mp3' : undefined,
      format: opts.audioOnly ? undefined : opts.format ?? undefined,
      quality: opts.quality ?? undefined,
      cookies: opts.cookies,
      spotifyClientId: opts.spotifyClientId,
      spotifyClientSecret: opts.spotifyClientSecret,
    });
    return result;
  } finally {
    sub.remove();
    inflight = null;
  }
}

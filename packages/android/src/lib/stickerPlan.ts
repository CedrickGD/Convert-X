// Pure, dependency-free helpers for the Discord "sticker stealer" on
// Android. Everything here is framework-agnostic (no React Native, no
// expo, no globals) so it can be unit-tested directly under Node 22's
// type-stripping. The stateful pieces — networking, FFmpeg, the gallery
// save — live in discordNet.ts / stickerQueue.ts and call into these.
//
// Keep this file to erasable TypeScript (type aliases, annotations, `as`
// — no enums/namespaces/parameter-properties) so `node --test` can import
// it without a build step, exactly like discordMedia.ts.

import type { Attempt, DiscordMedia } from './discordMedia';
import type { DownloadEntry } from './downloadQueue';

export type DiscordSite = 'Discord' | 'Tenor' | 'Giphy' | 'Klipy';

// The chip label a single media kind maps to. `direct` covers Klipy static
// media and recovered image-proxy URLs — bucket it under Discord, the most
// neutral label, since the original paste decided the surface.
export function siteForKind(kind: DiscordMedia['kind']): DiscordSite {
  switch (kind) {
    case 'tenor':
      return 'Tenor';
    case 'giphy':
      return 'Giphy';
    case 'klipy':
      return 'Klipy';
    default:
      return 'Discord';
  }
}

// One label for the whole probe: the shared site when every item agrees,
// otherwise 'Discord' (a mixed paste of e.g. an emoji and a Tenor GIF).
export function pickSite(media: DiscordMedia[]): DiscordSite {
  if (media.length === 0) return 'Discord';
  const first = siteForKind(media[0].kind);
  for (const m of media) {
    if (siteForKind(m.kind) !== first) return 'Discord';
  }
  return first;
}

// A short, human description for the preview badge, e.g.
// "Animated sticker · GIF · 320×320" or "Emoji · PNG".
export function mediaBadge(media: DiscordMedia): string {
  const kindWord =
    media.kind === 'emoji'
      ? 'Emoji'
      : media.kind === 'sticker'
      ? 'Sticker'
      : media.kind === 'tenor'
      ? 'Tenor'
      : media.kind === 'giphy'
      ? 'Giphy'
      : media.kind === 'klipy'
      ? 'Klipy'
      : media.kind === 'attachment'
      ? 'Attachment'
      : 'Media';
  const motion = media.animated ? 'Animated ' : '';
  const fmt = media.sourceFormat.toUpperCase();
  const dims =
    media.width && media.height ? ` · ${media.width}×${media.height}` : '';
  return `${motion}${kindWord} · ${fmt}${dims}`;
}

// Source formats ExpoImage can render straight off the CDN as a preview.
const PREVIEWABLE: ReadonlySet<string> = new Set(['png', 'apng', 'gif', 'webp', 'jpeg']);

// The preview image for one item. Attachments and direct links only carry
// a `thumbnail` when the URL is CORS-safe, a browser-only concern (Android
// fetches the CDN directly), so fall back to the original rendition, but
// only for image formats: an mp4/webm/lottie URL would be a broken tile.
export function previewUrl(media: DiscordMedia): string | undefined {
  if (media.thumbnail) return media.thumbnail;
  if (!PREVIEWABLE.has(media.sourceFormat)) return undefined;
  return media.renditions.original?.url;
}

// Give every item in one probe a distinct title. Output file names are
// built from `media.title` (discordMedia.outputFileName), so two pasted
// attachments both named image.png would otherwise target one file. The
// first item to use a title keeps it; repeats become "image-2", "image-3",
// … (the shared discordScraper's scheme), skipping any suffixed title
// another item in the paste already owns. Compared case-insensitively.
// Items that keep their title are returned as-is; renamed ones are copies.
export function dedupeMediaTitles(media: DiscordMedia[]): DiscordMedia[] {
  const baseOf = (m: DiscordMedia) => m.title || m.key;
  const taken = new Set(media.map((m) => baseOf(m).toLowerCase()));
  const kept = new Set<string>();
  return media.map((m) => {
    const base = baseOf(m);
    if (!kept.has(base.toLowerCase())) {
      kept.add(base.toLowerCase());
      return m;
    }
    let n = 2;
    while (taken.has(`${base}-${n}`.toLowerCase())) n += 1;
    const title = `${base}-${n}`;
    taken.add(title.toLowerCase());
    kept.add(title.toLowerCase());
    return { ...m, title };
  });
}

// Reserve an output file name no earlier claim in `claimed` holds:
// "image.png", then "image-2.png", "image-3.png", … The winner is added to
// `claimed` (lower-cased) before returning, so concurrent batch workers
// calling this synchronously can never be handed the same name.
export function claimFileName(name: string, claimed: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  for (let n = 2; claimed.has(candidate.toLowerCase()); n += 1) {
    candidate = `${stem}-${n}${ext}`;
  }
  claimed.add(candidate.toLowerCase());
  return candidate;
}

// Build a router-compatible DownloadEntry for one resolved media item.
// mediaType is forced to 'image' so the entry can never slip into the
// audio→yt-dlp detour in downloadBatch; the real work is driven off the
// attached `discord` payload by stickerQueue. directUrl/thumbnail are for
// the generic preview/fallback only.
export function mediaToEntry(media: DiscordMedia): DownloadEntry {
  const original = media.renditions.original;
  return {
    id: media.key,
    title: media.title,
    thumbnail: previewUrl(media),
    mediaType: 'image',
    webpageUrl: media.pageUrl,
    directUrl: original ? original.url : undefined,
    discord: media,
  };
}

// Assemble the exact FFmpeg argument vector for one transcode attempt.
// Mirrors the runner contract in DESIGN.md §2.6: the leading `ffmpeg`
// token is NOT included (ffmpeg-kit's executeAsync adds none), and paths
// are plain filesystem paths (callers strip any file:// first).
export function buildTranscodeArgs(
  inputPath: string,
  outputPath: string,
  attempt: Attempt
): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    ...attempt.inputArgs,
    '-i',
    inputPath,
    ...attempt.outputArgs,
    outputPath,
  ];
}

export type AttemptOutcome = {
  index: number;
  /** Output size in bytes; -1 when the attempt failed to produce a file. */
  size: number;
  path: string;
  outExt: string;
};

export type WinnerResult = {
  outcome: AttemptOutcome;
  /** True when the winner actually fits under maxBytes (or there was no cap). */
  underBudget: boolean;
};

// Pick the attempt to keep from a ladder's outcomes.
//  - maxBytes == null: the first successful attempt wins (ladders are
//    ordered best-quality-first).
//  - maxBytes set: the first successful attempt that fits wins; if none
//    fits, keep the SMALLEST successful output and flag it as over budget
//    so the caller can surface a "could not get under N" warning.
// Returns null only when every attempt failed to produce a file.
export function selectWinner(
  outcomes: AttemptOutcome[],
  maxBytes: number | null
): WinnerResult | null {
  const ok = outcomes.filter((o) => o.size >= 0);
  if (ok.length === 0) return null;
  if (maxBytes == null) {
    return { outcome: ok[0], underBudget: true };
  }
  for (const o of ok) {
    if (o.size <= maxBytes) return { outcome: o, underBudget: true };
  }
  let smallest = ok[0];
  for (const o of ok) if (o.size < smallest.size) smallest = o;
  return { outcome: smallest, underBudget: false };
}

// Byte count → friendly "512 KB" / "1.3 MB" for warnings.
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

// "Could not get under 512 KB (got 640 KB)" for a ladder that never fit.
export function overBudgetWarning(maxBytes: number, gotBytes: number): string {
  return `Could not get under ${formatBytes(maxBytes)} (got ${formatBytes(gotBytes)})`;
}

// The gallery display name for a finished export. Convert plans carry a
// stem only (the extension comes from the winning attempt); fetch plans
// already carry a full filename with its extension.
export function galleryName(stemOrName: string, ext: string | null): string {
  if (!ext) return stemOrName;
  const lower = stemOrName.toLowerCase();
  if (lower.endsWith('.' + ext.toLowerCase())) return stemOrName;
  return `${stemOrName}.${ext}`;
}

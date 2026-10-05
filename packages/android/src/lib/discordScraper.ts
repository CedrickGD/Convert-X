/**
 * Discord / Tenor / Giphy / Klipy "sticker stealer" prober.
 *
 * The user pastes anything that points at a custom emoji, sticker,
 * image/GIF attachment, or a GIF-picker link (Tenor/Giphy/Klipy) — emoji
 * markup `<:name:id>`, a bare sticker/emoji ID, a CDN URL, or a page URL.
 * We classify every token (discordMedia.extractMediaRefs), resolve each
 * over plain HTTPS (no yt-dlp, no cookies), and hand the download queue a
 * router-compatible ProbeResult whose entries carry the resolved
 * `discord` payload. stickerQueue, not yt-dlp, does the actual save.
 *
 * Modeled on twitterScraper.ts: a host-anchored URL claim, a JS fetch
 * path, friendly thrown errors on total failure, deterministic ids.
 */

import { extractMediaRefs, resolveMediaInput } from './discordMedia';
import { discordNet } from './discordNet';
import type { DownloadEntry, ProbeResult } from './downloadQueue';
import { dedupeMediaTitles, mediaToEntry, pickSite } from './stickerPlan';

/**
 * True when `text` contains at least one recognizable media reference.
 * The router calls this BEFORE every other prober and commits to the
 * Discord path with no fall-through, so the claim must be precise: it
 * reuses discordMedia's host-anchored classifier, which never matches a
 * plain YouTube/Instagram/Twitter URL. A standalone 17–20 digit snowflake
 * (a pasted sticker/emoji ID) is deliberately claimed.
 */
export function isDiscordInputToken(text: string): boolean {
  if (!text) return false;
  return extractMediaRefs(text).length > 0;
}

/**
 * Resolve every media reference in `text` and build a ProbeResult. The
 * resolver runs with concurrency 4 and never throws for a single bad item
 * — those land in `errors`. We only throw when NOTHING resolved, so the
 * UI shows a real message (e.g. the "Discord message links need a login"
 * hint) instead of an empty preview.
 */
export async function probeDiscordInput(text: string): Promise<ProbeResult> {
  const { media, errors } = await resolveMediaInput(text, discordNet);

  if (media.length === 0) {
    const message =
      errors.length > 0
        ? errors[0].message
        : 'No Discord emoji, sticker or GIF link found — paste a link, <:name:id>, or a sticker ID.';
    throw new Error(message);
  }

  // Distinct titles per probe. File names are built from the `discord`
  // payload's title, so the deduped title must live there, not just on the
  // entry; two attachments both named image.png become image / image-2.
  const entries: DownloadEntry[] = dedupeMediaTitles(media).map(mediaToEntry);
  return {
    site: pickSite(media),
    isPlaylist: entries.length > 1,
    entries,
  };
}

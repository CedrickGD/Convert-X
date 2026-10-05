/**
 * Discord / Tenor / Giphy / Klipy prober for the shared download router.
 *
 * Turns pasted text — emoji markup (`<:name:id>`, `<a:name:id>`), CDN links,
 * bare emoji/sticker IDs, attachment links, GIF-picker links — into
 * router-compatible DownloadEntry objects. All classification, network
 * resolution and planning lives in the pure core (core/discordMedia.js);
 * this module only adapts it to the router's ProbeResult contract and the
 * platform's `discordNet`.
 *
 * Every entry carries the resolved DiscordMedia descriptor as `discord`, so
 * the UI can offer "Save as" targets and the sticker runner (stickerBatch.js)
 * can plan fetches/conversions. `mediaType` stays 'image' (even for GIF/MP4
 * sources) so nothing ever routes these entries to the yt-dlp lane.
 *
 * Works on every surface WITHOUT a downloader key: the web adapter's
 * discordNet fetches CORS-safe CDNs directly and everything else through the
 * public gateway relay.
 */

import { getPlatform } from "../platform.js";
import { extractMediaRefs, isMediaRefToken, resolveMediaInput } from "../core/discordMedia.js";

const IMAGE_PREVIEW_EXTS = new Set(["png", "gif", "jpg", "jpeg", "webp"]);

/**
 * True when `text` is Discord-stealer input: a single recognised media URL,
 * or any text containing emoji markup / media links / bare IDs (a pasted
 * Discord message line). Plain non-media URLs (YouTube, …) are false so they
 * keep their normal router path.
 */
export function isDiscordInputToken(text) {
  const s = String(text ?? "").trim();
  if (!s) return false;
  if (/^https?:\/\/\S+$/i.test(s)) return isMediaRefToken(s);
  return extractMediaRefs(s).length > 0;
}

function siteFor(media) {
  switch (media.kind) {
    case "tenor":
      return "Tenor";
    case "giphy":
      return "Giphy";
    case "klipy":
      return "Klipy";
    case "direct":
      return /(^|\.)klipy\.com$/i.test(hostOf(media.renditions?.original?.url)) ? "Klipy" : "Discord";
    default:
      return "Discord";
  }
}

function hostOf(url) {
  const m = String(url || "").match(/^https?:\/\/([^/?#:]+)/i);
  return m ? m[1].toLowerCase() : "";
}

function extOf(url) {
  const path = String(url || "").split(/[?#]/)[0];
  const m = path.match(/\.([A-Za-z0-9]{2,5})$/);
  return m ? m[1].toLowerCase() : "";
}

/** Preview URL for an entry: the core's CORS-safe thumbnail, else the
 *  original itself when it is a still/animated image (attachments, direct
 *  links). Lottie and video originals get none — the UI renders those. */
function previewFor(media) {
  if (media.thumbnail) return media.thumbnail;
  if (media.sourceFormat === "lottie") return null;
  const orig = media.renditions?.original;
  if (!orig?.url) return null;
  const ext = String(orig.ext || extOf(orig.url)).toLowerCase();
  return IMAGE_PREVIEW_EXTS.has(ext) ? orig.url : null;
}

function toEntry(media, title) {
  const pageUrl = media.pageUrl || media.renditions?.original?.url || "";
  return {
    id: media.key,
    title,
    url: pageUrl,
    sourceUrl: pageUrl,
    playlistIndex: null,
    mediaType: "image",
    thumbnail: previewFor(media),
    directUrl: media.renditions?.original?.url ?? null,
    variants: null,
    duration: null,
    uploader: null,
    partialCarousel: false,
    discord: media,
  };
}

/**
 * Resolve pasted text into a prober result:
 *   { site, isPlaylist, entries, failures: [{ url, message }] }
 * Throws (with the core's friendly copy) when nothing could be resolved.
 * `failures` lists the tokens that failed when others succeeded.
 */
export async function probeDiscordInput(text) {
  const platform = getPlatform();
  const net = platform.discordNet;
  if (!net) throw new Error("Discord stickers and emoji aren't supported here yet.");

  const { media, errors } = await resolveMediaInput(String(text ?? ""), net);
  if (media.length === 0) {
    if (errors.length === 0) {
      throw new Error("Nothing to grab there — paste an emoji, sticker or GIF link, <:name:id>, or a sticker ID.");
    }
    const messages = [...new Set(errors.map((e) => e.message).filter(Boolean))];
    throw new Error(messages.join("\n") || "That link could not be loaded.");
  }

  // Titles become filenames and list labels — keep them unique per probe.
  const seenTitles = new Map();
  const entries = media.map((m) => {
    const base = m.title || m.key;
    const n = (seenTitles.get(base) || 0) + 1;
    seenTitles.set(base, n);
    return toEntry(m, n === 1 ? base : `${base}-${n}`);
  });

  const sites = new Set(media.map(siteFor));
  return {
    site: sites.size === 1 ? [...sites][0] : "Discord",
    isPlaylist: entries.length > 1,
    entries,
    failures: errors.map((e) => ({ url: e.input, message: e.message })),
  };
}

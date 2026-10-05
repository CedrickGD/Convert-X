// Framework-agnostic Discord / Tenor / Giphy / Klipy media module — the brain
// of the Convert-X "sticker stealer".
//
// This is a line-for-line TypeScript port of
// packages/shared/src/core/discordMedia.js. The two files are kept
// byte-for-byte equivalent in behaviour; a parity test asserts it. Node 22
// imports this .ts directly via type stripping, so every construct here is
// erasable (type aliases, annotations, `as` assertions — no enums, namespaces,
// parameter properties or decorators). Keep the two files in lockstep.
//
// Facts (hosts, status codes, rendition codes, size whitelist, sniff offsets)
// come from the live research in convertx-scratch/maps/discord.md §1–§9.

// ── exported types ────────────────────────────────────────────────────────

export type Caps = {
  gif: boolean;
  apng: boolean;
  png: boolean;
  webpStatic: boolean;
  webpAnimated: boolean;
  mp4Encoders: string[];
  lottie: boolean;
  decodeAnimatedWebp: boolean;
};

export type SourceFormat = 'png' | 'apng' | 'gif' | 'webp' | 'jpeg' | 'mp4' | 'webm' | 'lottie';
export type SniffFormat = 'png' | 'apng' | 'gif' | 'webp' | 'jpeg' | 'mp4' | 'webm' | 'json' | 'unknown';
export type KlipyType = 'gifs' | 'stickers' | 'clips' | 'memes';

export type MediaRef =
  | { kind: 'emoji'; key: string; id: string; name: string | null; animatedHint: boolean | null; input: string }
  | { kind: 'sticker'; key: string; id: string; formatHint: 'lottie' | 'gif' | 'png' | null; input: string }
  | { kind: 'snowflake'; key: string; id: string; input: string }
  | { kind: 'attachment'; key: string; url: string; channelId: string; attachmentId: string; filename: string; ext: string | null; expiresAt: number | null; input: string }
  | { kind: 'tenor'; key: string; postId: string | null; shortCode: string | null; mediaBase: string | null; mediaCode: string | null; input: string }
  | { kind: 'giphy'; key: string; id: string; input: string }
  | { kind: 'klipy'; key: string; type: KlipyType; slug: string; input: string }
  | { kind: 'direct'; key: string; url: string; ext: string | null; input: string }
  | { kind: 'discord-message'; key: string; input: string };

export type SniffResult = {
  format: SniffFormat;
  animated: boolean | null;
  width: number | null;
  height: number | null;
};

export type Rendition = { url: string; ext: string; corsSafe: boolean; animated: boolean };
export type RenditionKey = 'original' | 'gif' | 'png' | 'webp' | 'mp4' | 'webm';
export type ConvertSource = { url: string; ext: string; format: SourceFormat; corsSafe: boolean };

export type DiscordMedia = {
  key: string;
  kind: 'emoji' | 'sticker' | 'attachment' | 'tenor' | 'giphy' | 'klipy' | 'direct';
  id: string;
  name: string | null;
  title: string;
  pageUrl: string;
  sourceFormat: SourceFormat;
  animated: boolean;
  width: number | null;
  height: number | null;
  thumbnail: string | null;
  renditions: Partial<Record<RenditionKey, Rendition>>;
  convertSources: { large: ConvertSource; small: ConvertSource };
};

export type Attempt = { inputArgs: string[]; outputArgs: string[]; outExt: string; label: string };

export type PlanSource = { url: string; ext: string; format: SourceFormat; animated: boolean; corsSafe: boolean };

export type ExportPlan =
  | { mode: 'fetch'; url: string; ext: string; corsSafe: boolean; fileName: string }
  | { mode: 'convert'; source: PlanSource; attempts: Attempt[]; maxBytes: number | null; fileName: string }
  | { mode: 'unsupported'; reason: string };

export type TargetAvailability = { key: string; enabled: boolean; reason: string | null };

export type NetBytes = { status: number; contentType: string | null; bytes: Uint8Array; finalUrl: string | null };
export type NetText = { status: number; contentType: string | null; text: string; finalUrl: string | null };
export type NetHead = { status: number; contentType: string | null };
export type NetKlipy = { status: number; json: any };

export type Net = {
  getBytes(url: string, opts?: { maxBytes?: number; headers?: Record<string, string> }): Promise<NetBytes>;
  getText(url: string, opts?: { headers?: Record<string, string> }): Promise<NetText>;
  head(url: string): Promise<NetHead>;
  klipyResolve(type: string, slug: string): Promise<NetKlipy>;
};

type EmojiRef = Extract<MediaRef, { kind: 'emoji' }>;
type StickerRef = Extract<MediaRef, { kind: 'sticker' }>;
type SnowflakeRef = Extract<MediaRef, { kind: 'snowflake' }>;
type AttachmentRef = Extract<MediaRef, { kind: 'attachment' }>;
type TenorRef = Extract<MediaRef, { kind: 'tenor' }>;
type GiphyRef = Extract<MediaRef, { kind: 'giphy' }>;
type KlipyRef = Extract<MediaRef, { kind: 'klipy' }>;
type DirectRef = Extract<MediaRef, { kind: 'direct' }>;
type IdRef = { key: string; id: string; input: string };
type UrlParts = { scheme: string; host: string; port: string | null; path: string; userinfo: boolean; ipv6: boolean };

// ── 2.1 constants ──────────────────────────────────────────────────────────

export const CDN = 'https://cdn.discordapp.com';
export const MEDIA = 'https://media.discordapp.net';

export const TARGETS: ReadonlyArray<{ key: string; label: string; hint: string | null }> = [
  { key: 'original', label: 'Original', hint: 'As uploaded' },
  { key: 'gif', label: 'GIF', hint: null },
  { key: 'png', label: 'PNG', hint: 'Still image' },
  { key: 'apng', label: 'APNG', hint: 'Animated PNG' },
  { key: 'webp', label: 'WebP', hint: null },
  { key: 'mp4', label: 'MP4', hint: 'Video' },
  { key: 'sticker', label: 'Discord sticker', hint: '320×320 · ≤512 KB' },
  { key: 'emoji', label: 'Discord emoji', hint: '128×128 · ≤256 KB' },
];

export const PRESETS: { sticker: { size: number; maxBytes: number; maxSeconds: number | null }; emoji: { size: number; maxBytes: number; maxSeconds: number | null } } = {
  sticker: { size: 320, maxBytes: 512000, maxSeconds: 5 },
  emoji: { size: 128, maxBytes: 256000, maxSeconds: null },
};

export const CAPS: { desktop: Caps; web: Caps; android: Caps } = {
  desktop: { gif: true, apng: true, png: true, webpStatic: true, webpAnimated: true, mp4Encoders: ['libx264'], lottie: true, decodeAnimatedWebp: true },
  web: { gif: true, apng: true, png: true, webpStatic: true, webpAnimated: true, mp4Encoders: ['libx264'], lottie: true, decodeAnimatedWebp: false },
  android: { gif: true, apng: true, png: true, webpStatic: false, webpAnimated: false, mp4Encoders: ['h264_mediacodec', 'mpeg4'], lottie: false, decodeAnimatedWebp: false },
};

// Emoji CDN only serves these pixel sizes; anything else returns 400 and it
// never upscales past the ~128px stored size (discord.md §1).
export const EMOJI_SIZES: number[] = [16, 20, 22, 24, 28, 32, 40, 44, 48, 56, 60, 64, 80, 96, 100, 128, 160, 240, 256, 300, 320, 480, 512, 600, 640, 1024, 1280, 1536, 2048, 3072, 4096];

// Tenor's 5-character rendition codes — the code alone sets the format, the
// filename and extension are ignored (discord.md §4).
export const TENOR_CODES: Record<string, string> = {
  gif: 'AAAAC',
  mediumgif: 'AAAAd',
  tinygif: 'AAAAM',
  mp4: 'AAAPo',
  tinymp4: 'AAAP1',
  webm: 'AAAPs',
  webp: 'AAAAx',
  tinywebp: 'AAAA1',
  webpTransparent: 'AAAAl',
  still: 'AAAAe',
  png: 'AAAAN',
};

// ── classifier regexes (discord.md §9) ───────────────────────────────────────

const SNOW = '\\d{17,20}';

export const RX: Record<string, RegExp> = {
  emojiMarkup: new RegExp('<(a)?:(\\w{1,32})(?:~\\d+)?:(' + SNOW + ')>', 'i'),
  emojiCdn: new RegExp('^https?://(?:cdn\\.discordapp\\.com|media\\.discordapp\\.net)/emojis/(' + SNOW + ')(?:\\.(png|jpe?g|webp|gif|avif))?/?(?:[?#]|$)', 'i'),
  sticker: new RegExp('^https?://(?:cdn\\.discordapp\\.com|media\\.discordapp\\.net|(?:ptb\\.|canary\\.)?discord\\.com)/stickers/(' + SNOW + ')(?:/[0-9a-f]{32})?(?:\\.(png|apng|gif|webp|json|jpe?g|avif))?/?(?:[?#]|$)', 'i'),
  attachment: new RegExp('^https?://(?:cdn\\.discordapp\\.com|media\\.discordapp\\.net)/(attachments|ephemeral-attachments)/(' + SNOW + ')/(' + SNOW + ')/([^/?#]+)', 'i'),
  fakeNitroGifSticker: new RegExp('/attachments/\\d+/\\d+/(' + SNOW + ')\\.gif(?:[?#]|$)', 'i'),
  extProxy: /^https?:\/\/(?:images-ext-\d+\.discordapp\.net|media\.discordapp\.net)\/external\/[^/]+\/(?:(%3F[^/]*)\/)?(https?)\/([^?]+)(?:\?.*)?$/i,
  discordMessage: new RegExp('^https?://(?:(?:ptb|canary)\\.)?discord(?:app)?\\.com/channels/(@me|' + SNOW + ')/(' + SNOW + ')(?:/(' + SNOW + '))?', 'i'),
  tenorView: /^https?:\/\/(?:www\.)?tenor\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?view\/(?:[^/?#]*-)?(\d+)\/?(?:[?#]|$)/i,
  tenorShort: /^https?:\/\/(?:www\.)?tenor\.com\/([A-Za-z0-9]{3,12})\.gif(?:[?#]|$)/i,
  tenorMedia: /^https?:\/\/(?:media\d*|c)\.tenor\.com\/(?:m\/)?([A-Za-z0-9_-]{11})([A-Za-z0-9_-]{5})(?:\/|$)/i,
  giphyPage: /^https?:\/\/(?:www\.)?giphy\.com\/(?:gifs|stickers|clips|embed)\/(?:[^/?#]*-)?([A-Za-z0-9]+)\/?(?:[/?#]|$)/i,
  giphyMedia: /^https?:\/\/(?:media\d*|i)\.giphy\.com\/(?:media\/(?:v1\.[^/]+\/)?)?([A-Za-z0-9]+)(?:\/|\.(?:gif|webp|mp4)(?:[?#]|$))/i,
  klipyPage: /^https?:\/\/(?:www\.)?klipy\.com?\/(gifs|stickers|clips|memes)\/([a-z0-9-]+)\/?(?:[?#]|$)/i,
  klipyMedia: /^https?:\/\/static\d*\.klipy\.com\/ii\/[0-9a-f]{32}\/[0-9a-f]{2}\/[0-9a-f]{2}\/[A-Za-z0-9]+\.(gif|webp|mp4|webm|jpg|png)(?:[?#]|$)/i,
  bareId: new RegExp('^(' + SNOW + ')$'),
};

// ── small pure helpers ───────────────────────────────────────────────────────

function queryParam(url: string, key: string): string | null {
  const q = String(url || '').split('#')[0].split('?')[1];
  if (!q) return null;
  for (const pair of q.split('&')) {
    const eq = pair.indexOf('=');
    const k = eq >= 0 ? pair.slice(0, eq) : pair;
    if (k.toLowerCase() === key.toLowerCase()) {
      const v = eq >= 0 ? pair.slice(eq + 1) : '';
      try { return decodeURIComponent(v.replace(/\+/g, ' ')); } catch { return v; }
    }
  }
  return null;
}

function extOfName(name: string | null | undefined): string | null {
  if (!name) return null;
  const clean = String(name).split('#')[0].split('?')[0];
  const dot = clean.lastIndexOf('.');
  if (dot < 0 || dot === clean.length - 1) return null;
  return clean.slice(dot + 1).toLowerCase();
}

function stemOfName(name: string | null | undefined): string {
  if (!name) return '';
  const clean = String(name).split('#')[0].split('?')[0];
  const slash = clean.lastIndexOf('/');
  const base = slash >= 0 ? clean.slice(slash + 1) : clean;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

// Filename-safe stem/name: collapse anything outside [A-Za-z0-9._-] to _ and
// cap the length so no surface chokes on it.
function safeName(name: string | null | undefined, max?: number): string {
  const cap = max || 120;
  let s = String(name == null ? '' : name).replace(/[^A-Za-z0-9._-]/g, '_');
  if (s.length > cap) s = s.slice(0, cap);
  return s;
}

function escapeRe(s: string): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtmlEntities(s: string | null): string | null {
  if (s == null) return s;
  return String(s)
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/gi, "'");
}

function parseUrlParts(url: string): UrlParts | null {
  const m = String(url || '').match(/^(https?):\/\/([^/?#]+)([^?#]*)(.*)$/i);
  if (!m) return null;
  const authority = m[2];
  const userinfo = authority.indexOf('@') >= 0;
  const hostport = userinfo ? authority.slice(authority.indexOf('@') + 1) : authority;
  const ipv6 = hostport.indexOf('[') >= 0;
  let host = hostport;
  let port: string | null = null;
  if (!ipv6) {
    const colon = hostport.lastIndexOf(':');
    if (colon >= 0) { port = hostport.slice(colon + 1); host = hostport.slice(0, colon); }
  }
  return { scheme: m[1].toLowerCase(), host: host.toLowerCase(), port, path: m[3] || '/', userinfo, ipv6 };
}

function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function countChar(s: string, c: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) if (s.charAt(i) === c) n += 1;
  return n;
}

// Chat prose wraps links in brackets, quotes, markdown and spoiler bars and ends
// sentences right after them: "see (https://…).", "[cat](https://…)!",
// "<https://…>", "||https://…||". Peel that off until the token is stable.
// A trailing closer is only dropped while the token leaves it unbalanced, so a
// URL that really ends in ')' (…/cat_(1)) keeps it; a leading '<' is kept for
// emoji markup <:name:id> / <a:name:id>.
const LEAD_PUNCT = '([{"\'<“‘«|*`';
const TRAIL_PUNCT = '.,!?;:"\'”’»|*`';
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '>': '<', '}': '{' };

function stripTokenPunct(token: string): string {
  let t = String(token).trim();
  for (;;) {
    const before = t;
    // markdown [text](url), or the "text](url)" tail of a link whose text had
    // spaces (the tokenizer split it); the url keeps its closing ')' for now
    const md = t.match(/^(?:\[[^\]]*|[^\s()[\]:\/]*)\]\((.+)$/);
    if (md) t = md[1];
    const first = t.charAt(0);
    if (first && LEAD_PUNCT.indexOf(first) >= 0 && !(first === '<' && /^<a?:/i.test(t))) t = t.slice(1);
    const last = t.charAt(t.length - 1);
    if (last && TRAIL_PUNCT.indexOf(last) >= 0) t = t.slice(0, -1);
    else if (last && CLOSERS[last] && countChar(t, last) > countChar(t, CLOSERS[last])) t = t.slice(0, -1);
    t = t.trim();
    if (t === before) return t;
  }
}

// ── 2.2 parsing ──────────────────────────────────────────────────────────────

export function classifyMediaRef(token: string | null | undefined, _depth?: number): MediaRef | null {
  const depth = _depth || 0;
  if (token == null) return null;
  // Strips prose wrappers + sentence punctuation; this also unwraps markdown
  // [text](url) and Discord's no-embed <url>, never emoji markup <:name:id>.
  const t = stripTokenPunct(token);
  if (!t) return null;

  // emoji markup (anchored to the start of the token)
  const mk = t.match(new RegExp('^' + RX.emojiMarkup.source, 'i'));
  if (mk) {
    const id = mk[3];
    return { kind: 'emoji', key: 'emoji:' + id, id, name: mk[2] || null, animatedHint: mk[1] === 'a' || mk[1] === 'A', input: t };
  }

  // external image proxy: decode and re-classify the original first
  const ep = t.match(RX.extProxy);
  if (ep && depth < 4) {
    const decoded = decodeExternalProxyUrl(t);
    if (decoded) {
      const inner = classifyMediaRef(decoded, depth + 1);
      if (inner) return { ...inner, input: t } as MediaRef;
      const dext = extOfName(decoded);
      if (dext && /^(gif|png|jpe?g|webp|mp4|webm|mov)$/i.test(dext)) {
        return { kind: 'direct', key: 'direct:' + decoded, url: decoded, ext: dext.toLowerCase(), input: t };
      }
    }
    return null;
  }

  // discord message links — cannot be fetched, surfaced as a hint
  const dm = t.match(RX.discordMessage);
  if (dm) {
    const messageId = dm[3] || dm[2];
    return { kind: 'discord-message', key: 'msg:' + messageId, input: t };
  }

  const ec = t.match(RX.emojiCdn);
  if (ec) {
    const id = ec[1];
    const ext = ec[2] ? ec[2].toLowerCase() : null;
    const name = queryParam(t, 'name');
    let hint: boolean | null = null;
    if (ext === 'gif') hint = true;
    else if ((queryParam(t, 'animated') || '').toLowerCase() === 'true') hint = true;
    return { kind: 'emoji', key: 'emoji:' + id, id, name: name || null, animatedHint: hint, input: t };
  }

  const st = t.match(RX.sticker);
  if (st) {
    const id = st[1];
    const ext = st[2] ? st[2].toLowerCase() : null;
    let formatHint: 'lottie' | 'gif' | 'png' | null = null;
    if (ext === 'json') formatHint = 'lottie';
    else if (ext === 'gif') formatHint = 'gif';
    else if (ext) formatHint = 'png';
    return { kind: 'sticker', key: 'sticker:' + id, id, formatHint, input: t };
  }

  const at = t.match(RX.attachment);
  if (at) {
    const type = at[1].toLowerCase();
    const channelId = at[2];
    const attachmentId = at[3];
    const filename = at[4];
    const qIndex = t.indexOf('?');
    const query = qIndex >= 0 ? t.slice(qIndex + 1).split('#')[0] : '';
    const url = CDN + '/' + type + '/' + channelId + '/' + attachmentId + '/' + filename + (query ? '?' + query : '');
    const exHex = queryParam(t, 'ex');
    let expiresAt: number | null = null;
    if (exHex && /^[0-9a-f]+$/i.test(exHex)) {
      const secs = parseInt(exHex, 16);
      if (!isNaN(secs)) expiresAt = secs * 1000;
    }
    return { kind: 'attachment', key: 'att:' + attachmentId, url, channelId, attachmentId, filename, ext: extOfName(filename), expiresAt, input: t };
  }

  const tm = t.match(RX.tenorMedia);
  if (tm) {
    return { kind: 'tenor', key: 'tenor-media:' + tm[1], postId: null, shortCode: null, mediaBase: tm[1], mediaCode: tm[2], input: t };
  }
  const tv = t.match(RX.tenorView);
  if (tv) {
    return { kind: 'tenor', key: 'tenor:' + tv[1], postId: tv[1], shortCode: null, mediaBase: null, mediaCode: null, input: t };
  }
  const ts = t.match(RX.tenorShort);
  if (ts) {
    return { kind: 'tenor', key: 'tenor-short:' + ts[1], postId: null, shortCode: ts[1], mediaBase: null, mediaCode: null, input: t };
  }

  const gm = t.match(RX.giphyMedia);
  if (gm) {
    return { kind: 'giphy', key: 'giphy:' + gm[1], id: gm[1], input: t };
  }
  const gp = t.match(RX.giphyPage);
  if (gp) {
    return { kind: 'giphy', key: 'giphy:' + gp[1], id: gp[1], input: t };
  }

  const km = t.match(RX.klipyMedia);
  if (km) {
    return { kind: 'direct', key: 'direct:' + t, url: t, ext: km[1].toLowerCase(), input: t };
  }
  const kp = t.match(RX.klipyPage);
  if (kp) {
    const type = kp[1].toLowerCase() as KlipyType;
    const slug = kp[2];
    return { kind: 'klipy', key: 'klipy:' + type + ':' + slug, type, slug, input: t };
  }

  const bid = t.match(RX.bareId);
  if (bid) {
    return { kind: 'snowflake', key: 'id:' + bid[1], id: bid[1], input: t };
  }

  return null;
}

export function extractMediaRefs(text: string | null | undefined): MediaRef[] {
  if (text == null) return [];
  const s = String(text);
  const found: { index: number; ref: MediaRef }[] = [];
  const seen = new Set<string>();
  const add = (index: number, ref: MediaRef | null): void => {
    if (!ref || seen.has(ref.key)) return;
    seen.add(ref.key);
    found.push({ index, ref });
  };

  // 1. emoji markup scanned over the raw text (it can be adjacent to prose)
  const mk = new RegExp(RX.emojiMarkup.source, 'gi');
  const spans: number[][] = [];
  let m: RegExpExecArray | null;
  while ((m = mk.exec(s)) !== null) {
    add(m.index, classifyMediaRef(m[0]));
    spans.push([m.index, m.index + m[0].length]);
    if (m.index === mk.lastIndex) mk.lastIndex += 1;
  }

  // 2. blank out the markup spans, then split the rest and classify each token
  let masked = s;
  for (const sp of spans) {
    masked = masked.slice(0, sp[0]) + ' '.repeat(sp[1] - sp[0]) + masked.slice(sp[1]);
  }
  const tokenRx = /[^\s,]+/g;
  while ((m = tokenRx.exec(masked)) !== null) {
    add(m.index, classifyMediaRef(m[0]));
  }

  found.sort((a, b) => a.index - b.index);
  return found.slice(0, 50).map((x) => x.ref);
}

export function isMediaRefToken(token: string): boolean {
  return classifyMediaRef(token) !== null;
}

export function decodeExternalProxyUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const s = String(url).trim();
  const re = /.*\/external\/[^/]*\/(?:([^/]*)\/)?(https?)\/(.*?)(?:\?[^/]*)?$/i;
  const m = s.match(re);
  if (!m) return null;
  const recombined = m[2] + '://' + m[3] + (m[1] || '');
  try { return decodeURIComponent(recombined); } catch { return recombined; }
}

export function attachmentExpired(ref: MediaRef | null | undefined, nowMs: number): boolean {
  if (!ref || ref.kind !== 'attachment' || ref.expiresAt == null) return false;
  return ref.expiresAt <= nowMs;
}

// ── 2.3 byte sniffing ─────────────────────────────────────────────────────────

function u8(bytes: Uint8Array, i: number): number {
  return bytes[i] & 0xff;
}

function ascii(bytes: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i += 1) {
    if (off + i >= bytes.length) break;
    s += String.fromCharCode(u8(bytes, off + i));
  }
  return s;
}

function readU32BE(bytes: Uint8Array, off: number): number {
  return (u8(bytes, off) * 0x1000000) + (u8(bytes, off + 1) << 16) + (u8(bytes, off + 2) << 8) + u8(bytes, off + 3);
}

function sniffPng(bytes: Uint8Array): SniffResult {
  const width = bytes.length >= 24 ? readU32BE(bytes, 16) : null;
  const height = bytes.length >= 24 ? readU32BE(bytes, 20) : null;
  let animated = false;
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = readU32BE(bytes, off);
    const type = ascii(bytes, off + 4, 4);
    if (type === 'acTL') { animated = true; break; }
    if (type === 'IDAT') break;
    if (type === 'IEND') break;
    off += 12 + len;
    if (len < 0) break;
  }
  return { format: animated ? 'apng' : 'png', animated, width: width || null, height: height || null };
}

function sniffGif(bytes: Uint8Array): SniffResult {
  const width = bytes.length >= 10 ? (u8(bytes, 6) | (u8(bytes, 7) << 8)) : null;
  const height = bytes.length >= 10 ? (u8(bytes, 8) | (u8(bytes, 9) << 8)) : null;
  let off = 10;
  let imageCount = 0;
  let netscape = false;
  let truncated = false;
  let completed = false;
  if (bytes.length < 13) {
    truncated = true;
  } else {
    const packed = u8(bytes, 10);
    // Data blocks start after the 13-byte header, past the global colour table.
    off = 13;
    if (packed & 0x80) off += 3 * (1 << ((packed & 0x07) + 1));
    while (off < bytes.length) {
      const block = u8(bytes, off);
      if (block === 0x3b) { completed = true; break; }
      if (block === 0x21) {
        // extension: label + sub-blocks terminated by 0x00
        const label = off + 1 < bytes.length ? u8(bytes, off + 1) : -1;
        let p = off + 2;
        if (label === 0xff) {
          // application extension; peek for NETSCAPE2.0
          if (p < bytes.length) {
            const idLen = u8(bytes, p);
            const idStr = ascii(bytes, p + 1, idLen);
            if (/NETSCAPE2\.0/i.test(idStr)) netscape = true;
          }
        }
        while (p < bytes.length) {
          const sub = u8(bytes, p);
          if (sub === 0x00) { p += 1; break; }
          p += 1 + sub;
        }
        if (p > bytes.length) { truncated = true; break; }
        off = p;
      } else if (block === 0x2c) {
        imageCount += 1;
        if (imageCount > 1) break;
        // image descriptor: 10 bytes header incl. block byte
        let p = off + 10;
        const idpacked = off + 9 < bytes.length ? u8(bytes, off + 9) : 0;
        if (idpacked & 0x80) p += 3 * (1 << ((idpacked & 0x07) + 1));
        p += 1; // LZW min code size
        while (p < bytes.length) {
          const sub = u8(bytes, p);
          if (sub === 0x00) { p += 1; break; }
          p += 1 + sub;
        }
        if (p > bytes.length) { truncated = true; break; }
        off = p;
      } else {
        break;
      }
    }
    if (off >= bytes.length && !completed) truncated = true;
  }
  let animated: boolean | null;
  if (imageCount > 1) animated = true;
  else if (netscape) animated = true;
  else if (truncated) animated = null;
  else animated = false;
  return { format: 'gif', animated, width: width || null, height: height || null };
}

function sniffWebp(bytes: Uint8Array): SniffResult {
  const fourcc = ascii(bytes, 12, 4);
  if (fourcc === 'VP8X') {
    const flags = u8(bytes, 20);
    const animated = (flags & 0x02) !== 0;
    const width = 1 + (u8(bytes, 24) | (u8(bytes, 25) << 8) | (u8(bytes, 26) << 16));
    const height = 1 + (u8(bytes, 27) | (u8(bytes, 28) << 8) | (u8(bytes, 29) << 16));
    return { format: 'webp', animated, width, height };
  }
  if (fourcc === 'VP8 ') {
    // lossy frame header: start code 0x9d 0x01 0x2a at offset 23
    const width = (u8(bytes, 26) | (u8(bytes, 27) << 8)) & 0x3fff;
    const height = (u8(bytes, 28) | (u8(bytes, 29) << 8)) & 0x3fff;
    return { format: 'webp', animated: false, width: width || null, height: height || null };
  }
  if (fourcc === 'VP8L') {
    // lossless: 1 signature byte (0x2f) then packed 14-bit dims
    const b1 = u8(bytes, 21);
    const b2 = u8(bytes, 22);
    const b3 = u8(bytes, 23);
    const b4 = u8(bytes, 24);
    const width = 1 + (((b2 & 0x3f) << 8) | b1);
    const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
    return { format: 'webp', animated: false, width, height };
  }
  return { format: 'webp', animated: false, width: null, height: null };
}

function sniffJpeg(bytes: Uint8Array): SniffResult {
  let off = 2;
  while (off + 9 < bytes.length) {
    if (u8(bytes, off) !== 0xff) { off += 1; continue; }
    let marker = u8(bytes, off + 1);
    while (marker === 0xff && off + 1 < bytes.length) { off += 1; marker = u8(bytes, off + 1); }
    // standalone markers without a length payload
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { off += 2; continue; }
    const len = (u8(bytes, off + 2) << 8) | u8(bytes, off + 3);
    const isSof = (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = (u8(bytes, off + 5) << 8) | u8(bytes, off + 6);
      const width = (u8(bytes, off + 7) << 8) | u8(bytes, off + 8);
      return { format: 'jpeg', animated: false, width: width || null, height: height || null };
    }
    if (len <= 0) break;
    off += 2 + len;
  }
  return { format: 'jpeg', animated: false, width: null, height: null };
}

export function sniffMedia(bytes: Uint8Array): SniffResult {
  const unknown: SniffResult = { format: 'unknown', animated: null, width: null, height: null };
  if (!bytes || bytes.length == null || bytes.length < 2) return unknown;
  try {
    // PNG / APNG
    if (bytes.length >= 8 && u8(bytes, 0) === 0x89 && u8(bytes, 1) === 0x50 && u8(bytes, 2) === 0x4e && u8(bytes, 3) === 0x47) {
      return sniffPng(bytes);
    }
    // GIF
    if (bytes.length >= 6 && ascii(bytes, 0, 3) === 'GIF') {
      return sniffGif(bytes);
    }
    // RIFF/WEBP
    if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
      return sniffWebp(bytes);
    }
    // JPEG
    if (u8(bytes, 0) === 0xff && u8(bytes, 1) === 0xd8) {
      return sniffJpeg(bytes);
    }
    // MP4 (ftyp box)
    if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
      return { format: 'mp4', animated: true, width: null, height: null };
    }
    // WebM / Matroska (EBML header)
    if (bytes.length >= 4 && u8(bytes, 0) === 0x1a && u8(bytes, 1) === 0x45 && u8(bytes, 2) === 0xdf && u8(bytes, 3) === 0xa3) {
      return { format: 'webm', animated: true, width: null, height: null };
    }
    // JSON (Lottie)
    let i = 0;
    while (i < bytes.length && (u8(bytes, i) === 0x20 || u8(bytes, i) === 0x09 || u8(bytes, i) === 0x0a || u8(bytes, i) === 0x0d || u8(bytes, i) === 0xef || u8(bytes, i) === 0xbb || u8(bytes, i) === 0xbf)) i += 1;
    if (i < bytes.length && u8(bytes, i) === 0x7b) {
      const head = ascii(bytes, i, Math.min(4096, bytes.length - i));
      if (/"layers"|"v"\s*:/.test(head)) return { format: 'json', animated: null, width: null, height: null };
    }
  } catch { /* never throw */ }
  return unknown;
}

// ── 2.4 URL helpers ───────────────────────────────────────────────────────────

export function emojiUrl(id: string, opts?: { ext?: string | null; animated?: boolean; lossless?: boolean; size?: number | null }): string {
  const o = opts || {};
  let url = MEDIA + '/emojis/' + id;
  if (o.ext) url += '.' + o.ext;
  const params: string[] = [];
  if (o.size != null && EMOJI_SIZES.indexOf(o.size) >= 0) params.push('size=' + o.size);
  if (o.animated && o.ext === 'webp') params.push('animated=true');
  if (o.lossless) params.push('quality=lossless');
  if (params.length) url += '?' + params.join('&');
  return url;
}

export function stickerUrls(id: string): {
  mediaPng: string; mediaStill: string; mediaGif: string; mediaWebpStatic: string;
  mediaWebpAnimated: string; cdnRawGif: string; lottieJson: string; thumb: string;
} {
  return {
    mediaPng: MEDIA + '/stickers/' + id + '.png',
    mediaStill: MEDIA + '/stickers/' + id + '.png?passthrough=false&size=320',
    mediaGif: MEDIA + '/stickers/' + id + '.gif?size=4096',
    mediaWebpStatic: MEDIA + '/stickers/' + id + '.webp?size=320',
    mediaWebpAnimated: MEDIA + '/stickers/' + id + '.webp?animated=true&size=320',
    cdnRawGif: CDN + '/stickers/' + id,
    lottieJson: CDN + '/stickers/' + id + '.json',
    thumb: MEDIA + '/stickers/' + id + '.png?size=160',
  };
}

export function tenorRenditionUrl(base: string, code: string, ext: string): string {
  return 'https://media.tenor.com/' + base + code + '/tenor.' + ext;
}

export function parseTenorPage(html: string | null | undefined): { postId: string | null; base: string | null; title: string | null; width: number | null; height: number | null } | null {
  if (!html) return null;
  const s = String(html);
  const metaContent = (prop: string): string | null => {
    const p = escapeRe(prop);
    let m = s.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + p + '["\'][^>]*content=["\']([^"\']*)["\']', 'i'));
    if (m) return decodeHtmlEntities(m[1]);
    m = s.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + p + '["\']', 'i'));
    if (m) return decodeHtmlEntities(m[1]);
    return null;
  };

  const ogImage = metaContent('og:image');
  const ogVideo = metaContent('og:video');
  let base: string | null = null;
  const candidates = [ogImage, ogVideo];
  for (const u of candidates) {
    if (!u) continue;
    const mm = u.match(RX.tenorMedia);
    if (mm) { base = mm[1]; break; }
  }

  const wRaw = metaContent('og:image:width');
  const hRaw = metaContent('og:image:height');
  const w = wRaw ? parseInt(wRaw, 10) : NaN;
  const h = hRaw ? parseInt(hRaw, 10) : NaN;

  let title = metaContent('og:title');
  if (title) title = title.replace(/\s+GIF\s+-\s+.*$/i, '').replace(/\s+-\s+Discover\s+.*$/i, '').trim();

  let postId: string | null = null;
  let can = s.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
  if (!can) can = s.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
  if (can) {
    const cm = can[1].match(/-(\d+)\/?(?:[?#]|$)/);
    if (cm) postId = cm[1];
  }

  if (!base && !postId) return null;
  return { postId, base, title: title || null, width: isNaN(w) ? null : w, height: isNaN(h) ? null : h };
}

export function giphyRenditions(id: string): { gif: string; webp: string; mp4: string; still: string; small: string } {
  return {
    gif: 'https://i.giphy.com/' + id + '.gif',
    webp: 'https://i.giphy.com/' + id + '.webp',
    mp4: 'https://media.giphy.com/media/' + id + '/giphy.mp4',
    still: 'https://media.giphy.com/media/' + id + '/giphy_s.gif',
    small: 'https://media.giphy.com/media/' + id + '/200.gif',
  };
}

export function isCorsSafeUrl(url: string): boolean {
  const p = parseUrlParts(url);
  if (!p) return false;
  const h = p.host;
  if (h === 'media.discordapp.net') return /^\/(emojis|stickers)\//i.test(p.path);
  if (h === 'cdn.discordapp.com') return /^\/emojis\//i.test(p.path);
  if (/^(?:media\d*|c)\.tenor\.com$/.test(h)) return true;
  if (h === 'i.giphy.com' || /^media\d*\.giphy\.com$/.test(h)) return true;
  if (/^static\d*\.klipy\.com$/.test(h)) return true;
  return false;
}

export function isAllowedMediaHost(url: string): boolean {
  const p = parseUrlParts(url);
  if (!p) return false;
  if (p.scheme !== 'https') return false;
  if (p.userinfo) return false;
  if (p.ipv6) return false;
  if (p.port && p.port !== '443') return false;
  const h = p.host;
  if (isIpv4Literal(h)) return false;
  const exact: Record<string, number> = {
    'cdn.discordapp.com': 1, 'media.discordapp.net': 1,
    'images-ext-1.discordapp.net': 1, 'images-ext-2.discordapp.net': 1,
    'media.tenor.com': 1, 'media1.tenor.com': 1, 'c.tenor.com': 1,
    'i.giphy.com': 1, 'media.giphy.com': 1,
    'media0.giphy.com': 1, 'media1.giphy.com': 1, 'media2.giphy.com': 1, 'media3.giphy.com': 1, 'media4.giphy.com': 1,
    'static.klipy.com': 1, 'static2.klipy.com': 1,
  };
  if (exact[h]) return true;
  if (h === 'tenor.com') {
    const path = p.path;
    if (/^\/oembed(?:[?#/]|$)/i.test(path)) return true;
    if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?view\//i.test(path)) return true;
    if (/^\/[A-Za-z0-9]{3,12}\.gif(?:[?#/]|$)/i.test(path)) return true;
    return false;
  }
  return false;
}

// ── 2.5 resolution ─────────────────────────────────────────────────────────

function err(message: string): Error {
  return new Error(message);
}

function rendition(url: string, ext: string, corsSafe: boolean, animated: boolean): Rendition {
  return { url, ext, corsSafe, animated };
}

function originalCt(contentType: string | null, animated: boolean): 'gif' | 'jpeg' | 'webp' | 'png' {
  const ct = (contentType || '').toLowerCase();
  if (ct.indexOf('gif') >= 0) return 'gif';
  if (ct.indexOf('jpeg') >= 0 || ct.indexOf('jpg') >= 0) return 'jpeg';
  if (ct.indexOf('webp') >= 0) return 'webp';
  if (ct.indexOf('png') >= 0) return 'png';
  return animated ? 'gif' : 'png';
}

// Only a second frame (or NETSCAPE2.0) proves a GIF animated, so a first frame
// larger than the sniff prefix leaves it undetermined (animated: null). Re-sniff
// a much larger prefix before deciding; resolvers then never downgrade a still-
// undetermined GIF to a static image.
const SNIFF_BYTES = 262144;
const SNIFF_BYTES_LARGE = 4 * 1024 * 1024;

async function sniffRemote(net: Net, url: string, first: NetBytes): Promise<SniffResult> {
  let sn = sniffMedia(first.bytes);
  if ((sn.format === 'gif' || sn.format === 'webp') && sn.animated == null) {
    try {
      const big = await net.getBytes(url, { maxBytes: SNIFF_BYTES_LARGE });
      if (big.status === 200) {
        const again = sniffMedia(big.bytes);
        if (again.format === sn.format) sn = again;
      }
    } catch { /* keep the undetermined sniff */ }
  }
  return sn;
}

async function resolveEmoji(ref: EmojiRef, net: Net): Promise<DiscordMedia> {
  const id = ref.id;
  const probe = await net.getBytes(emojiUrl(id, { ext: 'webp', animated: true, size: 16 }), { maxBytes: 262144 });
  if (probe.status !== 200) throw err('Emoji not found — it may have been deleted');
  let animated = false;
  const sn = sniffMedia(probe.bytes);
  if (sn.format === 'webp' && sn.animated != null) animated = sn.animated;
  else if (ref.animatedHint === true) animated = true;

  let ct: string | null = null;
  try { ct = (await net.head(MEDIA + '/emojis/' + id)).contentType; } catch { ct = null; }
  const orig = originalCt(ct, animated);

  const renditions: Partial<Record<RenditionKey, Rendition>> = {};
  if (orig === 'gif') renditions.original = rendition(emojiUrl(id, { ext: 'gif' }), 'gif', true, true);
  else if (orig === 'webp') renditions.original = rendition(emojiUrl(id, { ext: 'webp', animated, lossless: true }), 'webp', true, animated);
  else if (orig === 'jpeg') renditions.original = rendition(emojiUrl(id, { ext: 'jpg' }), 'jpg', true, false);
  else renditions.original = rendition(emojiUrl(id, { ext: 'png' }), 'png', true, animated && false);

  renditions.png = rendition(emojiUrl(id, { ext: 'png' }), 'png', true, false);
  renditions.webp = rendition(emojiUrl(id, { ext: 'webp', animated, lossless: true }), 'webp', true, animated);
  if (animated) renditions.gif = rendition(emojiUrl(id, { ext: 'gif' }), 'gif', true, true);

  const convLarge: ConvertSource = animated
    ? { url: emojiUrl(id, { ext: 'gif' }), ext: 'gif', format: 'gif', corsSafe: true }
    : { url: emojiUrl(id, { ext: 'png' }), ext: 'png', format: 'png', corsSafe: true };

  const sourceFormat: SourceFormat = animated ? (orig === 'webp' ? 'webp' : 'gif') : (orig === 'jpeg' ? 'jpeg' : (orig === 'webp' ? 'webp' : 'png'));
  const name = ref.name || null;
  const title = name ? safeName('emoji-' + name + '-' + id) : 'emoji-' + id;
  const thumbnail = emojiUrl(id, { ext: animated ? 'gif' : 'png', size: 128 });

  return {
    key: ref.key, kind: 'emoji', id, name, title, pageUrl: ref.input,
    sourceFormat, animated, width: null, height: null, thumbnail,
    renditions,
    convertSources: { large: convLarge, small: convLarge },
  };
}

function buildStickerMedia(ref: IdRef, sourceFormat: SourceFormat, animated: boolean, width: number | null, height: number | null): DiscordMedia {
  const id = ref.id;
  const u = stickerUrls(id);
  const renditions: Partial<Record<RenditionKey, Rendition>> = {};
  let convLarge: ConvertSource;
  let convSmall: ConvertSource;
  let thumbnail: string | null = u.thumb;

  if (sourceFormat === 'png') {
    renditions.original = rendition(u.mediaPng, 'png', true, false);
    renditions.png = rendition(u.mediaPng, 'png', true, false);
    renditions.webp = rendition(u.mediaWebpStatic, 'webp', true, false);
    convLarge = { url: u.mediaPng, ext: 'png', format: 'png', corsSafe: true };
    convSmall = { url: u.mediaStill, ext: 'png', format: 'png', corsSafe: true };
  } else if (sourceFormat === 'apng') {
    renditions.original = rendition(u.mediaPng, 'png', true, true);
    renditions.png = rendition(u.mediaStill, 'png', true, false);
    renditions.webp = rendition(u.mediaWebpStatic, 'webp', true, false);
    convLarge = { url: u.mediaPng, ext: 'png', format: 'apng', corsSafe: true };
    convSmall = convLarge;
  } else if (sourceFormat === 'gif') {
    renditions.original = rendition(u.cdnRawGif, 'gif', false, true);
    renditions.gif = rendition(u.mediaGif, 'gif', true, true);
    renditions.png = rendition(u.mediaStill, 'png', true, false);
    renditions.webp = rendition(u.mediaWebpAnimated, 'webp', true, true);
    convLarge = { url: u.mediaGif, ext: 'gif', format: 'gif', corsSafe: true };
    convSmall = convLarge;
  } else {
    // lottie
    renditions.original = rendition(u.lottieJson, 'json', false, true);
    convLarge = { url: u.lottieJson, ext: 'json', format: 'lottie', corsSafe: false };
    convSmall = convLarge;
    thumbnail = null;
  }

  return {
    key: ref.key, kind: 'sticker', id, name: null, title: 'sticker-' + id, pageUrl: ref.input,
    sourceFormat, animated, width: width || null, height: height || null, thumbnail,
    renditions,
    convertSources: { large: convLarge, small: convSmall },
  };
}

async function resolveStickerById(ref: StickerRef, net: Net, notFoundMessage: string | null): Promise<DiscordMedia> {
  const id = ref.id;
  const u = stickerUrls(id);
  if (ref.formatHint === 'lottie') {
    return buildStickerMedia(ref, 'lottie', true, 320, 320);
  }
  const head = await net.head(MEDIA + '/stickers/' + id);
  const ct = (head.contentType || '').toLowerCase();
  if (head.status === 200 && ct.indexOf('png') >= 0) {
    const r = await net.getBytes(u.mediaPng, { maxBytes: 8 * 1024 * 1024 });
    const sn = sniffMedia(r.bytes);
    const isApng = sn.format === 'apng';
    return buildStickerMedia(ref, isApng ? 'apng' : 'png', isApng, sn.width, sn.height);
  }
  if (head.status === 200 && ct.indexOf('gif') >= 0) {
    let w: number | null = null;
    let h: number | null = null;
    try {
      const r = await net.getBytes(u.mediaGif, { maxBytes: 65536 });
      const sn = sniffMedia(r.bytes);
      w = sn.width; h = sn.height;
    } catch { /* dims optional */ }
    return buildStickerMedia(ref, 'gif', true, w, h);
  }
  if (head.status === 404) {
    const lj = await net.head(u.lottieJson);
    if (lj.status === 200) return buildStickerMedia(ref, 'lottie', true, 320, 320);
    throw err(notFoundMessage || 'That sticker could not be found — it may have been deleted.');
  }
  throw err(notFoundMessage || 'That sticker could not be found — it may have been deleted.');
}

async function resolveSnowflake(ref: SnowflakeRef, net: Net): Promise<DiscordMedia> {
  const id = ref.id;
  let emojiOk = false;
  try {
    const probe = await net.getBytes(emojiUrl(id, { ext: 'webp', animated: true, size: 16 }), { maxBytes: 262144 });
    emojiOk = probe.status === 200;
  } catch { emojiOk = false; }
  if (emojiOk) {
    return resolveEmoji({ kind: 'emoji', key: 'emoji:' + id, id, name: null, animatedHint: null, input: ref.input }, net);
  }
  return resolveStickerById({ kind: 'sticker', key: 'sticker:' + id, id, formatHint: null, input: ref.input }, net, 'No emoji or sticker with that ID.');
}

async function resolveAttachment(ref: AttachmentRef, net: Net, now: number): Promise<DiscordMedia> {
  if (attachmentExpired(ref, now)) {
    throw err('That attachment link has expired — copy it again in Discord (links last about 24 h).');
  }
  const ext = (ref.ext || '').toLowerCase();
  let sourceFormat: SourceFormat = 'png';
  let animated = false;
  const corsSafe = isCorsSafeUrl(ref.url);

  if (ext === 'mp4' || ext === 'webm' || ext === 'mov') {
    sourceFormat = ext === 'webm' ? 'webm' : 'mp4';
    animated = true;
  } else if (ext === 'jpg' || ext === 'jpeg') {
    sourceFormat = 'jpeg';
    animated = false;
  } else if (ext === 'png' || ext === 'gif' || ext === 'webp' || !ext) {
    const r = await net.getBytes(ref.url, { maxBytes: SNIFF_BYTES });
    if (r.status === 404) throw err('That attachment is no longer available — copy the link again in Discord (links last about 24 h).');
    if (r.status !== 200) throw err('That attachment could not be loaded (HTTP ' + r.status + ').');
    const sn = await sniffRemote(net, ref.url, r);
    if (sn.format === 'apng') { sourceFormat = 'apng'; animated = true; }
    else if (sn.format === 'gif') { sourceFormat = 'gif'; animated = sn.animated !== false; }
    else if (sn.format === 'webp') { sourceFormat = 'webp'; animated = sn.animated === true; }
    else if (sn.format === 'jpeg') { sourceFormat = 'jpeg'; animated = false; }
    else if (sn.format === 'mp4') { sourceFormat = 'mp4'; animated = true; }
    else if (sn.format === 'webm') { sourceFormat = 'webm'; animated = true; }
    else { sourceFormat = 'png'; animated = false; }
  } else {
    sourceFormat = 'png';
  }

  const original = rendition(ref.url, ext || sourceFormat, corsSafe, animated);
  const conv: ConvertSource = { url: ref.url, ext: ext || sourceFormat, format: sourceFormat, corsSafe };
  const title = safeName(stemOfName(ref.filename) || ('attachment-' + ref.attachmentId));

  return {
    key: ref.key, kind: 'attachment', id: ref.attachmentId, name: ref.filename || null, title, pageUrl: ref.input,
    sourceFormat, animated, width: null, height: null, thumbnail: corsSafe ? ref.url : null,
    renditions: { original },
    convertSources: { large: conv, small: conv },
  };
}

function buildTenorMedia(ref: TenorRef, base: string, postId: string | null, pageTitle: string | null, width: number | null, height: number | null): DiscordMedia {
  const renditions: Partial<Record<RenditionKey, Rendition>> = {
    original: rendition(tenorRenditionUrl(base, TENOR_CODES.gif, 'gif'), 'gif', true, true),
    gif: rendition(tenorRenditionUrl(base, TENOR_CODES.gif, 'gif'), 'gif', true, true),
    mp4: rendition(tenorRenditionUrl(base, TENOR_CODES.mp4, 'mp4'), 'mp4', true, true),
    webm: rendition(tenorRenditionUrl(base, TENOR_CODES.webm, 'webm'), 'webm', true, true),
    webp: rendition(tenorRenditionUrl(base, TENOR_CODES.webp, 'webp'), 'webp', true, true),
    png: rendition(tenorRenditionUrl(base, TENOR_CODES.png, 'png'), 'png', true, false),
  };
  const convLarge: ConvertSource = { url: tenorRenditionUrl(base, TENOR_CODES.mp4, 'mp4'), ext: 'mp4', format: 'mp4', corsSafe: true };
  const convSmall: ConvertSource = { url: tenorRenditionUrl(base, TENOR_CODES.tinygif, 'gif'), ext: 'gif', format: 'gif', corsSafe: true };
  const id = postId || base;
  const title = postId ? 'tenor-' + postId : safeName('tenor-' + base);

  return {
    key: ref.key, kind: 'tenor', id, name: pageTitle || null, title, pageUrl: ref.input,
    sourceFormat: 'gif', animated: true, width: width || null, height: height || null,
    thumbnail: tenorRenditionUrl(base, TENOR_CODES.tinygif, 'gif'),
    renditions,
    convertSources: { large: convLarge, small: convSmall },
  };
}

async function resolveTenor(ref: TenorRef, net: Net): Promise<DiscordMedia> {
  if (ref.mediaBase) {
    return buildTenorMedia(ref, ref.mediaBase, null, null, null, null);
  }
  let base: string | null = null;
  let postId: string | null = ref.postId || null;
  let title: string | null = null;
  let width: number | null = null;
  let height: number | null = null;

  if (ref.postId) {
    const r = await net.getText('https://tenor.com/view/' + ref.postId);
    if (r.status === 200 && r.text) {
      const pp = parseTenorPage(r.text);
      if (pp) { base = pp.base; title = pp.title; width = pp.width; height = pp.height; if (pp.postId) postId = pp.postId; }
    }
  } else if (ref.shortCode) {
    const r = await net.getText('https://tenor.com/' + ref.shortCode + '.gif');
    if (r.status === 200 && r.text) {
      const pp = parseTenorPage(r.text);
      if (pp) { base = pp.base; title = pp.title; width = pp.width; height = pp.height; if (pp.postId) postId = pp.postId; }
    }
    if (!postId && r.finalUrl) {
      const fm = r.finalUrl.match(/-(\d+)\/?(?:[?#]|$)/);
      if (fm) postId = fm[1];
    }
  }

  if (!base && postId) {
    const o = await net.getText('https://tenor.com/oembed?url=https://tenor.com/view/' + postId);
    if (o.status === 200 && o.text) {
      try {
        const j = JSON.parse(o.text);
        const tu = String(j.thumbnail_url || '');
        const mm = tu.match(RX.tenorMedia);
        if (mm) base = mm[1];
        if (!title && j.title) title = String(j.title);
        if (width == null && j.width) width = parseInt(j.width, 10) || null;
        if (height == null && j.height) height = parseInt(j.height, 10) || null;
      } catch { /* ignore malformed oembed */ }
    }
  }

  if (!base) throw err('That Tenor link could not be loaded — open the GIF and copy its image address instead.');
  return buildTenorMedia(ref, base, postId, title, width, height);
}

async function resolveGiphy(ref: GiphyRef, net: Net): Promise<DiscordMedia> {
  const id = ref.id;
  const r = giphyRenditions(id);
  const head = await net.head(r.gif);
  if (head.status !== 200) throw err('That Giphy GIF could not be found.');
  const renditions: Partial<Record<RenditionKey, Rendition>> = {
    original: rendition(r.gif, 'gif', true, true),
    gif: rendition(r.gif, 'gif', true, true),
    webp: rendition(r.webp, 'webp', true, true),
    mp4: rendition(r.mp4, 'mp4', true, true),
  };
  return {
    key: ref.key, kind: 'giphy', id, name: null, title: 'giphy-' + id, pageUrl: ref.input,
    sourceFormat: 'gif', animated: true, width: null, height: null, thumbnail: r.still,
    renditions,
    convertSources: {
      large: { url: r.mp4, ext: 'mp4', format: 'mp4', corsSafe: true },
      small: { url: r.small, ext: 'gif', format: 'gif', corsSafe: true },
    },
  };
}

function klipyPick(files: any): any {
  if (!files || typeof files !== 'object') return null;
  return files.hd || files.md || files.sm || files.xs || null;
}

function klipyNodeUrl(tier: any, kinds: string[]): { url: string; width: number | null; height: number | null } | null {
  if (!tier) return null;
  for (const k of kinds) {
    const node = tier[k];
    if (node && node.url) return { url: String(node.url), width: node.width || null, height: node.height || null };
  }
  return null;
}

async function resolveKlipy(ref: KlipyRef, net: Net): Promise<DiscordMedia> {
  const res = await net.klipyResolve(ref.type, ref.slug);
  if (!res || res.status !== 200 || !res.json) {
    throw err("Klipy GIF links can't be looked up right now — open the GIF in your browser and copy the image address (static.klipy.com/…) instead.");
  }
  const json = res.json;
  const files = json.files || (json.file ? json.file : null) || {};
  const tier = klipyPick(files);
  const small = klipyPick({ sm: files.sm, xs: files.xs }) || tier;
  if (!tier) {
    throw err("Klipy GIF links can't be looked up right now — open the GIF in your browser and copy the image address (static.klipy.com/…) instead.");
  }

  const gifNode = klipyNodeUrl(tier, ['gif']);
  const webpNode = klipyNodeUrl(tier, ['webp']);
  const mp4Node = klipyNodeUrl(tier, ['mp4']);
  const webmNode = klipyNodeUrl(tier, ['webm']);
  const jpgNode = klipyNodeUrl(tier, ['jpg', 'jpeg']);
  const smallGif = klipyNodeUrl(small, ['gif', 'webp', 'jpg']);

  const renditions: Partial<Record<RenditionKey, Rendition>> = {};
  const originalNode = gifNode || webpNode || mp4Node || jpgNode;
  if (!originalNode) {
    throw err("Klipy GIF links can't be looked up right now — open the GIF in your browser and copy the image address (static.klipy.com/…) instead.");
  }
  const animated = !!(gifNode || webpNode || mp4Node || webmNode);
  let originalExt = 'gif';
  if (!gifNode && webpNode) originalExt = 'webp';
  else if (!gifNode && !webpNode && mp4Node) originalExt = 'mp4';
  else if (!gifNode && !webpNode && !mp4Node) originalExt = 'jpg';

  renditions.original = rendition(originalNode.url, originalExt, true, animated && originalExt !== 'jpg');
  if (gifNode) renditions.gif = rendition(gifNode.url, 'gif', true, true);
  if (webpNode) renditions.webp = rendition(webpNode.url, 'webp', true, true);
  if (mp4Node) renditions.mp4 = rendition(mp4Node.url, 'mp4', true, true);
  if (webmNode) renditions.webm = rendition(webmNode.url, 'webm', true, true);

  const convLarge: ConvertSource = mp4Node
    ? { url: mp4Node.url, ext: 'mp4', format: 'mp4', corsSafe: true }
    : (gifNode ? { url: gifNode.url, ext: 'gif', format: 'gif', corsSafe: true } : { url: originalNode.url, ext: originalExt, format: originalExt === 'webp' ? 'webp' : (originalExt === 'mp4' ? 'mp4' : 'jpeg'), corsSafe: true });
  const convSmall: ConvertSource = smallGif
    ? { url: smallGif.url, ext: extOfName(smallGif.url) || 'gif', format: 'gif', corsSafe: true }
    : convLarge;

  const dims = gifNode || webpNode || jpgNode || originalNode;
  const title = safeName('klipy-' + ref.slug);
  const thumbUrl = (smallGif && smallGif.url) || (jpgNode && jpgNode.url) || originalNode.url;

  return {
    key: ref.key, kind: 'klipy', id: ref.slug, name: json.title ? String(json.title) : null, title, pageUrl: ref.input,
    sourceFormat: gifNode ? 'gif' : (mp4Node ? 'mp4' : (webpNode ? 'webp' : 'jpeg')),
    animated, width: (dims && dims.width) || null, height: (dims && dims.height) || null,
    thumbnail: thumbUrl,
    renditions,
    convertSources: { large: convLarge, small: convSmall },
  };
}

async function resolveDirect(ref: DirectRef, net: Net): Promise<DiscordMedia> {
  const ext = (ref.ext || '').toLowerCase();
  const corsSafe = isCorsSafeUrl(ref.url);
  let sourceFormat: SourceFormat = 'png';
  let animated = false;

  if (ext === 'mp4' || ext === 'mov') { sourceFormat = 'mp4'; animated = true; }
  else if (ext === 'webm') { sourceFormat = 'webm'; animated = true; }
  else if (ext === 'jpg' || ext === 'jpeg') { sourceFormat = 'jpeg'; animated = false; }
  else if (ext === 'png' || ext === 'gif' || ext === 'webp') {
    const r = await net.getBytes(ref.url, { maxBytes: SNIFF_BYTES });
    if (r.status !== 200) throw err('That link could not be loaded (HTTP ' + r.status + ').');
    const sn = await sniffRemote(net, ref.url, r);
    if (sn.format === 'apng') { sourceFormat = 'apng'; animated = true; }
    else if (sn.format === 'gif') { sourceFormat = 'gif'; animated = sn.animated !== false; }
    else if (sn.format === 'webp') { sourceFormat = 'webp'; animated = sn.animated === true; }
    else if (sn.format === 'png') { sourceFormat = 'png'; animated = false; }
    else if (sn.format === 'jpeg') { sourceFormat = 'jpeg'; animated = false; }
  }

  const original = rendition(ref.url, ext || sourceFormat, corsSafe, animated);
  const conv: ConvertSource = { url: ref.url, ext: ext || sourceFormat, format: sourceFormat, corsSafe };
  const title = safeName(stemOfName(ref.url) || 'media');

  return {
    key: ref.key, kind: 'direct', id: title, name: null, title, pageUrl: ref.input,
    sourceFormat, animated, width: null, height: null, thumbnail: corsSafe ? ref.url : null,
    renditions: { original },
    convertSources: { large: conv, small: conv },
  };
}

export async function resolveMediaRef(ref: MediaRef, net: Net, opts?: { now?: number }): Promise<DiscordMedia> {
  const options = opts || {};
  const now = options.now != null ? options.now : Date.now();
  if (!ref) throw err('Nothing to resolve.');
  switch (ref.kind) {
    case 'emoji': return resolveEmoji(ref, net);
    case 'sticker': return resolveStickerById(ref, net, null);
    case 'snowflake': return resolveSnowflake(ref, net);
    case 'attachment': return resolveAttachment(ref, net, now);
    case 'tenor': return resolveTenor(ref, net);
    case 'giphy': return resolveGiphy(ref, net);
    case 'klipy': return resolveKlipy(ref, net);
    case 'direct': return resolveDirect(ref, net);
    case 'discord-message':
      throw err('Discord message links need a login. Right-click the image, sticker or GIF in Discord → Copy Link (or type \\:emoji: to get <:name:id>) and paste that instead.');
    default:
      throw err('That link is not supported.');
  }
}

export async function resolveMediaInput(text: string | null | undefined, net: Net, opts?: { now?: number }): Promise<{ media: DiscordMedia[]; errors: { input: string; message: string }[] }> {
  const refs = extractMediaRefs(text);
  const media: DiscordMedia[] = [];
  const errors: { input: string; message: string }[] = [];
  type ResolveResult = { ok: true; value: DiscordMedia } | { ok: false; value: { input: string; message: string } };
  const results: (ResolveResult | undefined)[] = new Array(refs.length);
  let next = 0;
  const concurrency = Math.min(4, refs.length);

  async function worker(): Promise<void> {
    while (true) {
      const i = next;
      next += 1;
      if (i >= refs.length) return;
      const ref = refs[i];
      try {
        results[i] = { ok: true, value: await resolveMediaRef(ref, net, opts) };
      } catch (e: any) {
        results[i] = { ok: false, value: { input: ref.input, message: (e && e.message) ? e.message : String(e) } };
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let k = 0; k < concurrency; k += 1) workers.push(worker());
  await Promise.all(workers);

  for (const r of results) {
    if (!r) continue;
    if (r.ok) media.push(r.value);
    else errors.push(r.value);
  }
  return { media, errors };
}

// ── 2.6 planning ───────────────────────────────────────────────────────────

const FIT_SUFFIX = ':force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=';

function fitFilter(size: number): string {
  return 'scale=' + size + ':' + size + FIT_SUFFIX + size + ':' + size + ':(ow-iw)/2:(oh-ih)/2:color=0x00000000';
}

function gifFilter(size: number | null, fps: number | null, colors: number): string {
  const parts: string[] = [];
  if (size) parts.push(fitFilter(size));
  if (fps) parts.push('fps=' + fps);
  const prefix = parts.length ? parts.join(',') + ',' : '';
  return prefix + 'split[s0][s1];[s0]palettegen=max_colors=' + colors + ':reserve_transparent=1:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle:alpha_threshold=128';
}

function apngFilterBase(size: number | null, fps: number | null): string {
  const parts: string[] = [];
  if (size) parts.push(fitFilter(size));
  if (fps) parts.push('fps=' + fps);
  return parts.join(',');
}

function apngFilterPal(size: number | null, fps: number | null, colors: number): string {
  const base = apngFilterBase(size, fps);
  const prefix = base ? base + ',' : '';
  return prefix + 'split[s0][s1];[s0]palettegen=max_colors=' + colors + ':reserve_transparent=1:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle:alpha_threshold=128';
}

function pngStillFilter(size: number | null, colors: number | null): string {
  const base = size ? fitFilter(size) : '';
  if (!colors) return base;
  const prefix = base ? base + ',' : '';
  return prefix + 'split[s0][s1];[s0]palettegen=max_colors=' + colors + ':reserve_transparent=1:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle:alpha_threshold=128';
}

const MP4_FILTER = 'format=rgba,split[a][b];[a]drawbox=c=black:t=fill[bg];[bg][b]overlay=format=auto,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p';

function inputArgsFor(sourceFormat: SourceFormat): string[] {
  return (sourceFormat === 'apng' || sourceFormat === 'lottie') ? ['-f', 'apng'] : [];
}

function gifAttempt(inputArgs: string[], size: number | null, fps: number | null, colors: number, seconds: number | null, label: string): Attempt {
  const out = ['-vf', gifFilter(size, fps, colors), '-loop', '0'];
  if (seconds) out.push('-t', String(seconds));
  return { inputArgs, outputArgs: out, outExt: 'gif', label };
}

function apngAttempt(inputArgs: string[], size: number | null, fps: number | null, colors: number | null, seconds: number | null, label: string): Attempt {
  const filter = colors ? apngFilterPal(size, fps, colors) : apngFilterBase(size, fps);
  const out: string[] = [];
  if (filter) { out.push('-vf', filter); }
  out.push('-plays', '0', '-f', 'apng');
  if (seconds) out.push('-t', String(seconds));
  return { inputArgs, outputArgs: out, outExt: 'png', label };
}

function pngAttempt(inputArgs: string[], size: number | null, colors: number | null, label: string): Attempt {
  const filter = pngStillFilter(size, colors);
  const out: string[] = [];
  if (filter) { out.push('-vf', filter); }
  out.push('-frames:v', '1', '-update', '1');
  return { inputArgs, outputArgs: out, outExt: 'png', label };
}

function webpAttempt(inputArgs: string[], size: number | null, animated: boolean, label: string): Attempt {
  const out: string[] = [];
  if (size) out.push('-vf', fitFilter(size));
  if (animated) out.push('-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', '80', '-loop', '0');
  else out.push('-c:v', 'libwebp', '-q:v', '90', '-frames:v', '1');
  return { inputArgs, outputArgs: out, outExt: 'webp', label };
}

function mp4Attempts(inputArgs: string[], encoders: string[]): Attempt[] {
  const attempts: Attempt[] = [];
  for (const enc of encoders) {
    const out = ['-vf', MP4_FILTER, '-an', '-movflags', '+faststart'];
    if (enc === 'libx264') out.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23');
    else if (enc === 'h264_mediacodec') out.push('-c:v', 'h264_mediacodec', '-b:v', '2M');
    else if (enc === 'mpeg4') out.push('-c:v', 'mpeg4', '-q:v', '4');
    else out.push('-c:v', enc);
    attempts.push({ inputArgs, outputArgs: out, outExt: 'mp4', label: 'MP4 (' + enc + ')' });
  }
  return attempts;
}

function stickerAnimatedLadder(inputArgs: string[]): Attempt[] {
  const s = PRESETS.sticker.size;
  const t = PRESETS.sticker.maxSeconds;
  return [
    apngAttempt(inputArgs, s, null, null, t, 'APNG 320 RGBA'),
    apngAttempt(inputArgs, s, null, 256, t, 'APNG 320 · 256 colours'),
    apngAttempt(inputArgs, s, 20, 256, t, 'APNG 320 · 256 · 20 fps'),
    apngAttempt(inputArgs, s, 15, 128, t, 'APNG 320 · 128 · 15 fps'),
    apngAttempt(inputArgs, s, 12, 64, t, 'APNG 320 · 64 · 12 fps'),
    gifAttempt(inputArgs, s, 20, 256, t, 'GIF 320 · 256 · 20 fps'),
    gifAttempt(inputArgs, s, 15, 128, t, 'GIF 320 · 128 · 15 fps'),
    gifAttempt(inputArgs, s, 12, 64, t, 'GIF 320 · 64 · 12 fps'),
    gifAttempt(inputArgs, s, 10, 32, t, 'GIF 320 · 32 · 10 fps'),
  ];
}

function stickerStaticLadder(inputArgs: string[]): Attempt[] {
  const s = PRESETS.sticker.size;
  return [
    pngAttempt(inputArgs, s, null, 'PNG 320 RGBA'),
    pngAttempt(inputArgs, s, 256, 'PNG 320 · 256 colours'),
    pngAttempt(inputArgs, s, 128, 'PNG 320 · 128 colours'),
    pngAttempt(inputArgs, s, 64, 'PNG 320 · 64 colours'),
  ];
}

function emojiAnimatedLadder(inputArgs: string[]): Attempt[] {
  const s = PRESETS.emoji.size;
  return [
    gifAttempt(inputArgs, s, null, 256, null, 'GIF 128 · 256 colours'),
    gifAttempt(inputArgs, s, 20, 256, null, 'GIF 128 · 256 · 20 fps'),
    gifAttempt(inputArgs, s, 15, 128, null, 'GIF 128 · 128 · 15 fps'),
    gifAttempt(inputArgs, s, 12, 96, null, 'GIF 128 · 96 · 12 fps'),
    gifAttempt(inputArgs, s, 10, 64, null, 'GIF 128 · 64 · 10 fps'),
    gifAttempt(inputArgs, s, 8, 32, null, 'GIF 128 · 32 · 8 fps'),
  ];
}

function emojiStaticLadder(inputArgs: string[]): Attempt[] {
  const s = PRESETS.emoji.size;
  return [
    pngAttempt(inputArgs, s, null, 'PNG 128 RGBA'),
    pngAttempt(inputArgs, s, 256, 'PNG 128 · 256 colours'),
    pngAttempt(inputArgs, s, 128, 'PNG 128 · 128 colours'),
    pngAttempt(inputArgs, s, 64, 'PNG 128 · 64 colours'),
  ];
}

function outputStem(media: DiscordMedia, target: string): string {
  const suffix = target === 'sticker' ? '-sticker' : target === 'emoji' ? '-emoji' : '';
  return safeName(media.title + suffix);
}

export function outputFileName(media: DiscordMedia, target: string, ext: string): string {
  const suffix = target === 'sticker' ? '-sticker' : target === 'emoji' ? '-emoji' : '';
  return safeName(media.title + suffix + '.' + ext);
}

export function targetLabel(key: string): string {
  for (const t of TARGETS) if (t.key === key) return t.label;
  return key;
}

function unsupported(reason: string): ExportPlan {
  return { mode: 'unsupported', reason };
}

function fetchPlan(media: DiscordMedia, target: string, rend: Rendition): ExportPlan {
  return { mode: 'fetch', url: rend.url, ext: rend.ext, corsSafe: rend.corsSafe, fileName: outputFileName(media, target, rend.ext) };
}

// Pick the convert source usable under these caps (handles lottie + animated
// webp decode limits). Returns the source descriptor, or a reason string when
// no usable source exists on this surface.
function convertSource(media: DiscordMedia, caps: Caps): PlanSource | string {
  const large = media.convertSources.large;
  if (large.format === 'lottie') {
    if (!caps.lottie) return 'Lottie stickers can only be converted in the desktop or web app.';
    return { url: large.url, ext: large.ext, format: 'lottie', animated: media.animated, corsSafe: large.corsSafe };
  }
  if (large.format === 'webp' && media.animated && !caps.decodeAnimatedWebp) {
    const small = media.convertSources.small;
    if (small && small.format !== 'webp') {
      return { url: small.url, ext: small.ext, format: small.format, animated: media.animated, corsSafe: small.corsSafe };
    }
    return 'Animated WebP can only be converted in the desktop app.';
  }
  return { url: large.url, ext: large.ext, format: large.format, animated: media.animated, corsSafe: large.corsSafe };
}

export function planExport(media: DiscordMedia, target: string, caps: Caps): ExportPlan {
  if (!media || !caps) return unsupported('No media.');
  const R = media.renditions || {};
  const isLottie = media.sourceFormat === 'lottie';

  if (target === 'original') {
    const o = R.original;
    if (!o) return unsupported('No original available.');
    return fetchPlan(media, 'original', o);
  }

  // Lottie: only 'original' unless the surface can render it.
  if (isLottie && !caps.lottie) {
    return unsupported('Lottie stickers can only be converted in the desktop or web app.');
  }

  if (target === 'png') {
    if (R.png && !isLottie) return fetchPlan(media, 'png', R.png);
    if (!caps.png) return unsupported('PNG is not supported here.');
    const cs = convertSource(media, caps);
    if (typeof cs === 'string') return unsupported(cs);
    const attempts = [pngAttempt(inputArgsFor(cs.format), null, null, 'PNG still')];
    return { mode: 'convert', source: cs, attempts, maxBytes: null, fileName: outputStem(media, 'png') };
  }

  if (target === 'gif') {
    if (!caps.gif) return unsupported('GIF is not supported here.');
    if (R.gif && R.gif.animated === media.animated) return fetchPlan(media, 'gif', R.gif);
    if (R.gif && media.animated) return fetchPlan(media, 'gif', R.gif);
    const cs = convertSource(media, caps);
    if (typeof cs === 'string') return unsupported(cs);
    const attempts = [gifAttempt(inputArgsFor(cs.format), null, null, 256, null, 'GIF')];
    return { mode: 'convert', source: cs, attempts, maxBytes: null, fileName: outputStem(media, 'gif') };
  }

  if (target === 'apng') {
    if (!media.animated) return unsupported('Already a still image — pick PNG.');
    if (media.sourceFormat === 'apng' && R.original) return fetchPlan(media, 'apng', R.original);
    if (!caps.apng) return unsupported('APNG is not supported here.');
    const cs = convertSource(media, caps);
    if (typeof cs === 'string') return unsupported(cs);
    const attempts = [apngAttempt(inputArgsFor(cs.format), null, null, null, null, 'APNG')];
    return { mode: 'convert', source: cs, attempts, maxBytes: null, fileName: outputStem(media, 'apng') };
  }

  if (target === 'webp') {
    if (R.webp && R.webp.animated === media.animated) return fetchPlan(media, 'webp', R.webp);
    if (media.animated) {
      if (caps.webpAnimated) {
        const cs = convertSource(media, caps);
        if (typeof cs !== 'string') {
          const attempts = [webpAttempt(inputArgsFor(cs.format), null, true, 'Animated WebP')];
          return { mode: 'convert', source: cs, attempts, maxBytes: null, fileName: outputStem(media, 'webp') };
        }
      }
      if (R.webp) return fetchPlan(media, 'webp', R.webp);
      return unsupported('WebP export needs the desktop or web app.');
    }
    // static
    if (caps.webpStatic && !isLottie) {
      const cs = convertSource(media, caps);
      if (typeof cs !== 'string') {
        const attempts = [webpAttempt(inputArgsFor(cs.format), null, false, 'WebP')];
        return { mode: 'convert', source: cs, attempts, maxBytes: null, fileName: outputStem(media, 'webp') };
      }
    }
    if (R.webp) return fetchPlan(media, 'webp', R.webp);
    return unsupported('WebP export needs the desktop or web app.');
  }

  if (target === 'mp4') {
    if (!media.animated) return unsupported('MP4 needs an animated source.');
    if (R.mp4) return fetchPlan(media, 'mp4', R.mp4);
    if (!caps.mp4Encoders || caps.mp4Encoders.length === 0) return unsupported('MP4 is not supported here.');
    const cs = convertSource(media, caps);
    if (typeof cs === 'string') return unsupported(cs);
    const attempts = mp4Attempts(inputArgsFor(cs.format), caps.mp4Encoders);
    return { mode: 'convert', source: cs, attempts, maxBytes: null, fileName: outputStem(media, 'mp4') };
  }

  if (target === 'sticker' || target === 'emoji') {
    const preset = target === 'sticker' ? PRESETS.sticker : PRESETS.emoji;
    const cs = convertSource(media, caps);
    if (typeof cs === 'string') return unsupported(cs);
    const ia = inputArgsFor(cs.format);
    let attempts: Attempt[];
    if (target === 'sticker') attempts = media.animated ? stickerAnimatedLadder(ia) : stickerStaticLadder(ia);
    else attempts = media.animated ? emojiAnimatedLadder(ia) : emojiStaticLadder(ia);
    return { mode: 'convert', source: cs, attempts, maxBytes: preset.maxBytes, fileName: outputStem(media, target) };
  }

  return unsupported('Unknown target.');
}

export function availableTargets(media: DiscordMedia, caps: Caps): TargetAvailability[] {
  return TARGETS.map((t) => {
    const plan = planExport(media, t.key, caps);
    return { key: t.key, enabled: plan.mode !== 'unsupported', reason: plan.mode === 'unsupported' ? plan.reason : null };
  });
}

// node:test suite for the sticker-stealer batch runner (src/lib/stickerBatch.js).
//
// The runner is exercised end-to-end against a FAKE platform adapter: real
// DiscordMedia descriptors come from the core resolver (fed by a fake `net`
// with synthetic PNG/APNG/GIF/WebP bytes), and the fake adapter records every
// fetchMedia / transcodeMedia / finalizeMedia / discardMedia / cancelDownload
// call so the plan → execute → cleanup contract can be asserted exactly.
//
// Run: node --test "packages/shared/test/*.test.mjs"

import test from "node:test";
import assert from "node:assert/strict";

import { setPlatform } from "../src/platform.js";
import { CAPS, PRESETS, resolveMediaRef, classifyMediaRef } from "../src/core/discordMedia.js";
import { runStickerBatch, cancelStickerBatch, isStickerBatchRunning, formatBytes } from "../src/lib/stickerBatch.js";

// ── synthetic media bytes ────────────────────────────────────────────────────

function flat(parts) {
  const arr = [];
  for (const p of parts) {
    if (typeof p === "string") for (let i = 0; i < p.length; i += 1) arr.push(p.charCodeAt(i) & 0xff);
    else if (Array.isArray(p)) for (const b of p) arr.push(b & 0xff);
    else arr.push(p & 0xff);
  }
  return arr;
}
const bytes = (...parts) => Uint8Array.from(flat(parts));
const u32be = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16le = (n) => [n & 0xff, (n >>> 8) & 0xff];
const u32le = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u24le = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];

function makePng(w, h, apng) {
  const parts = [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32be(13), "IHDR", u32be(w), u32be(h), [8, 6, 0, 0, 0], u32be(0)];
  if (apng) parts.push(u32be(8), "acTL", u32be(2), u32be(0), u32be(0));
  parts.push(u32be(0), "IDAT", u32be(0), u32be(0), "IEND", u32be(0));
  return bytes(...parts);
}
function makeGif(w, h, frames) {
  const parts = ["GIF89a", u16le(w), u16le(h), [0x00, 0x00, 0x00]];
  for (let i = 0; i < frames; i += 1) parts.push([0x2c], u16le(0), u16le(0), u16le(w), u16le(h), [0x00], [0x02], [0x00]);
  parts.push([0x3b]);
  return bytes(...parts);
}
function makeWebp(animated) {
  const chunk = ["VP8X", u32le(10), [animated ? 0x12 : 0x10], [0, 0, 0], u24le(15), u24le(15)];
  return bytes("RIFF", u32le(4 + flat(chunk).length), "WEBP", ...chunk);
}

// ── fake net (resolver input) ────────────────────────────────────────────────

const IDS = {
  apng: "781291131828699156",
  png: "781291131828699157",
  gif: "1216467563744198836",
  lottie: "796140620111544330",
  emoji: "396521773144866826",
  emojiAnim: "506956736113147909",
};

function fakeNet() {
  const res = (status, contentType, body) => ({ status, contentType, bytes: body || new Uint8Array(0), finalUrl: null });
  return {
    async getBytes(url) {
      if (url.includes(`/emojis/${IDS.emoji}.webp`)) return res(200, "image/webp", makeWebp(false));
      if (url.includes(`/emojis/${IDS.emojiAnim}.webp`)) return res(200, "image/webp", makeWebp(true));
      if (url.includes("/emojis/")) return res(404, "application/json");
      if (url.includes(`/stickers/${IDS.apng}.png`)) return res(200, "image/png", makePng(320, 320, true));
      if (url.includes(`/stickers/${IDS.png}.png`)) return res(200, "image/png", makePng(320, 320, false));
      if (url.includes(`/stickers/${IDS.gif}.gif`)) return res(200, "image/gif", makeGif(160, 128, 3));
      return res(404, null);
    },
    async getText() {
      return { status: 404, contentType: null, text: "", finalUrl: null };
    },
    async head(url) {
      if (url.endsWith(`/emojis/${IDS.emoji}`)) return { status: 200, contentType: "image/png" };
      if (url.endsWith(`/emojis/${IDS.emojiAnim}`)) return { status: 200, contentType: "image/gif" };
      if (url.endsWith(`/stickers/${IDS.apng}`) || url.endsWith(`/stickers/${IDS.png}`)) return { status: 200, contentType: "image/png" };
      if (url.endsWith(`/stickers/${IDS.gif}`)) return { status: 200, contentType: "image/gif" };
      if (url.endsWith(`/stickers/${IDS.lottie}.json`)) return { status: 200, contentType: "application/json" };
      return { status: 404, contentType: null };
    },
    async klipyResolve() {
      return { status: 501, json: null };
    },
  };
}

async function mediaFor(token) {
  return resolveMediaRef(classifyMediaRef(token), fakeNet(), { now: 0 });
}

async function entryFor(token, title) {
  const media = await mediaFor(token);
  return { id: media.key, title: title || media.title, mediaType: "image", discord: media };
}

// ── fake platform adapter ────────────────────────────────────────────────────

function fakePlatform(overrides = {}) {
  const calls = { fetch: [], transcode: [], finalize: [], discard: [], cancel: [], importBytes: [] };
  let seq = 0;
  const p = {
    platformType: "web",
    stickerCaps: CAPS.web,
    discordNet: fakeNet(),
    async fetchMedia(args) {
      calls.fetch.push(args);
      return { blob: { fake: args.url }, size: 1000, name: args.fileName };
    },
    async importMediaBytes(args) {
      calls.importBytes.push(args);
      return { blob: { fake: "bytes" }, size: args.bytes.length, name: args.fileName };
    },
    async transcodeMedia(args) {
      calls.transcode.push(args);
      seq += 1;
      return { handle: { blob: { out: seq }, size: 100, name: `output.${args.outputExt}` }, size: 100 };
    },
    async finalizeMedia(args) {
      calls.finalize.push(args);
      return { outputPath: args.fileName, outputSize: args.handle.size ?? 0, outputBlob: { saved: args.fileName } };
    },
    async discardMedia(fileId) {
      calls.discard.push(fileId);
    },
    cancelDownload(fileId) {
      calls.cancel.push(fileId ?? null);
    },
    ...overrides,
  };
  setPlatform(p);
  return { platform: p, calls };
}

// ── tests ────────────────────────────────────────────────────────────────────

test("formatBytes uses Discord's 1000-based units", () => {
  assert.equal(formatBytes(512000), "512 KB");
  assert.equal(formatBytes(256000), "256 KB");
  assert.equal(formatBytes(640123), "640 KB");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(5_780_000), "5.8 MB");
});

test("fetch plan: original emoji is fetched, finalized and staging discarded", async () => {
  const { calls } = fakePlatform();
  const entry = await entryFor(`<:catjam:${IDS.emoji}>`);
  const progress = [];
  const done = [];
  const out = await runStickerBatch({
    entries: [entry],
    target: "original",
    outputDir: "C:/out",
    onProgress: (pct, label) => progress.push([pct, label]),
    onItemDone: (e, r) => done.push([e.id, r]),
  });
  assert.equal(out.cancelled, false);
  assert.deepEqual(out.errors, []);
  assert.equal(out.results.length, 1);
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].url, entry.discord.renditions.original.url);
  assert.equal(calls.transcode.length, 0);
  assert.equal(calls.finalize.length, 1);
  assert.equal(calls.finalize[0].fileName, "emoji-catjam-396521773144866826.png");
  assert.equal(calls.finalize[0].outputDir, "C:/out");
  assert.deepEqual(calls.discard, [calls.fetch[0].fileId]);
  assert.match(calls.fetch[0].fileId, /^stk-[a-z0-9]+-0$/);
  const r = out.results[0];
  assert.equal(r.id, entry.id);
  assert.equal(r.outputPath, "emoji-catjam-396521773144866826.png");
  assert.deepEqual(r.outputBlob, { saved: "emoji-catjam-396521773144866826.png" });
  assert.equal(r.warning, null);
  assert.equal(done.length, 1);
  assert.equal(progress.at(-1)[0], 100);
  assert.equal(isStickerBatchRunning(), false);
});

test("convert plan: APNG sticker → GIF runs the single attempt with -f apng", async () => {
  const { calls } = fakePlatform();
  const entry = await entryFor(IDS.apng);
  assert.equal(entry.discord.sourceFormat, "apng");
  const labels = [];
  const out = await runStickerBatch({ entries: [entry], target: "gif", onProgress: (_p, l) => labels.push(l) });
  assert.deepEqual(out.errors, []);
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].url, entry.discord.convertSources.large.url);
  assert.equal(calls.fetch[0].fileName, "source.png");
  assert.equal(calls.transcode.length, 1);
  const t = calls.transcode[0];
  assert.deepEqual(t.inputArgs, ["-f", "apng"]);
  assert.equal(t.outputExt, "gif");
  assert.ok(t.outputArgs.includes("-loop"));
  assert.equal(t.input.size, 1000, "transcodes the fetched source handle");
  assert.equal(calls.finalize[0].fileName, `sticker-${IDS.apng}.gif`);
  assert.ok(labels.includes("Converting…"));
  assert.equal(out.results[0].warning, null);
});

test("size ladder: first attempt under maxBytes wins and stops the ladder", async () => {
  const sizes = [900_000, 700_000, 400_000, 100_000];
  let n = 0;
  const { calls } = fakePlatform({
    async transcodeMedia(args) {
      calls.transcode.push(args);
      const size = sizes[n] ?? 50;
      n += 1;
      return { handle: { blob: { n }, size, name: `o.${args.outputExt}` }, size };
    },
  });
  const entry = await entryFor(IDS.apng);
  const labels = [];
  const out = await runStickerBatch({ entries: [entry], target: "sticker", onProgress: (_p, l) => labels.push(l) });
  assert.deepEqual(out.errors, []);
  assert.equal(calls.transcode.length, 3, "stops at the first rung under 512 000 B");
  assert.equal(calls.finalize[0].handle.size, 400_000);
  assert.equal(calls.finalize[0].fileName, `sticker-${IDS.apng}-sticker.png`);
  assert.equal(out.results[0].warning, null);
  assert.ok(labels.includes("Fitting under 512 KB…"), "later rungs say they're fitting under the cap");
});

test("size ladder: nothing fits → smallest output kept with a warning", async () => {
  let n = 0;
  const { calls } = fakePlatform({
    async transcodeMedia(args) {
      calls.transcode.push(args);
      n += 1;
      // 9 rungs; the 7th is the smallest.
      const size = n === 7 ? 520_000 : 800_000 + n;
      return { handle: { blob: { n }, size, name: `o.${args.outputExt}` }, size };
    },
  });
  const entry = await entryFor(IDS.apng);
  const out = await runStickerBatch({ entries: [entry], target: "sticker" });
  assert.equal(calls.transcode.length, 9);
  assert.equal(calls.finalize[0].handle.size, 520_000);
  // Rung 7 is a GIF rung of the sticker ladder.
  assert.equal(calls.finalize[0].fileName, `sticker-${IDS.apng}-sticker.gif`);
  assert.equal(out.results[0].warning, "Could not get under 512 KB (got 520 KB)");
});

test("size ladder: failing rungs are skipped, a later success still wins", async () => {
  let n = 0;
  const { calls } = fakePlatform({
    async transcodeMedia(args) {
      calls.transcode.push(args);
      n += 1;
      if (n <= 2) throw new Error("Conversion failed: something odd");
      return { handle: { blob: { n }, size: 200_000, name: `o.${args.outputExt}` }, size: 200_000 };
    },
  });
  const entry = await entryFor(`<a:dance:${IDS.emojiAnim}>`);
  const out = await runStickerBatch({ entries: [entry], target: "emoji" });
  assert.deepEqual(out.errors, []);
  assert.equal(calls.transcode.length, 3);
  assert.equal(out.results[0].fileName, `emoji-dance-${IDS.emojiAnim}-emoji.gif`);
  assert.ok(PRESETS.emoji.maxBytes >= 200_000);
});

test("unsupported target falls back to the original with a warning", async () => {
  const { calls } = fakePlatform();
  const entry = await entryFor(IDS.png);
  assert.equal(entry.discord.animated, false);
  const out = await runStickerBatch({ entries: [entry], target: "apng" });
  assert.deepEqual(out.errors, []);
  assert.equal(calls.transcode.length, 0);
  assert.equal(calls.fetch[0].url, entry.discord.renditions.original.url);
  assert.equal(out.results[0].fileName, `sticker-${IDS.png}.png`);
  assert.equal(out.results[0].warning, "Saved the original instead of APNG (already a still image — pick PNG).");
});

test("every conversion attempt failing falls back to the original", async () => {
  const { calls } = fakePlatform({
    async transcodeMedia(args) {
      calls.transcode.push(args);
      throw new Error("Conversion failed: Invalid data found when processing input");
    },
  });
  const entry = await entryFor(IDS.apng);
  const out = await runStickerBatch({ entries: [entry], target: "webp" });
  assert.deepEqual(out.errors, []);
  assert.equal(calls.transcode.length, 1);
  assert.equal(calls.fetch.length, 2, "source fetch, then the original");
  assert.equal(calls.fetch[1].url, entry.discord.renditions.original.url);
  assert.equal(out.results[0].fileName, `sticker-${IDS.apng}.png`);
  assert.equal(out.results[0].warning, "Couldn't convert to WebP — saved the original instead.");
});

test("an empty transcode output counts as a failed attempt", async () => {
  let n = 0;
  const { calls } = fakePlatform({
    async transcodeMedia(args) {
      calls.transcode.push(args);
      n += 1;
      if (n === 1) return { handle: { blob: {}, size: 0, name: "x" }, size: 0 };
      return { handle: { blob: { n }, size: 10, name: "y" }, size: 10 };
    },
  });
  const entry = await entryFor(IDS.apng);
  const out = await runStickerBatch({ entries: [entry], target: "sticker" });
  assert.equal(calls.transcode.length, 2);
  assert.equal(calls.finalize[0].handle.size, 10);
  assert.equal(out.results[0].warning, null);
});

test("per-item errors don't stop the batch; the failing item reports its message", async () => {
  const { calls } = fakePlatform({
    async fetchMedia(args) {
      calls.fetch.push(args);
      if (args.url.includes(IDS.emoji)) {
        const e = new Error("That file is no longer available (HTTP 404).");
        e.httpStatus = 404;
        throw e;
      }
      return { blob: { url: args.url }, size: 1000, name: args.fileName };
    },
  });
  const a = await entryFor(IDS.emoji, "first");
  const b = await entryFor(IDS.apng, "second");
  const out = await runStickerBatch({ entries: [a, b], target: "original" });
  assert.equal(out.cancelled, false);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].title, "second");
  assert.deepEqual(out.errors, [{ id: a.id, title: "first", message: "That file is no longer available (HTTP 404)." }]);
  assert.equal(calls.discard.length, 2, "staging is cleaned for failed items too");
});

test("a relay-only original falls back to a CORS-safe sibling of the same type", async () => {
  const { calls } = fakePlatform({
    async fetchMedia(args) {
      calls.fetch.push(args);
      if (!args.corsSafe) throw new Error("Couldn't reach the Convert-X relay this link needs.");
      return { blob: { url: args.url }, size: 1000, name: args.fileName };
    },
  });
  const entry = await entryFor(IDS.gif);
  const orig = entry.discord.renditions.original;
  assert.equal(orig.corsSafe, false, "GIF sticker original is the raw cdn file");
  const out = await runStickerBatch({ entries: [entry], target: "original" });
  assert.deepEqual(out.errors, []);
  assert.equal(calls.fetch.length, 2);
  assert.equal(calls.fetch[0].url, orig.url);
  assert.equal(calls.fetch[1].url, entry.discord.renditions.gif.url);
  assert.equal(out.results[0].fileName, `sticker-${IDS.gif}.gif`);
});

test("404 on a relay-only original is final (no sibling retry)", async () => {
  const { calls } = fakePlatform({
    async fetchMedia(args) {
      calls.fetch.push(args);
      const e = new Error("That file is no longer available (HTTP 404).");
      e.httpStatus = 404;
      throw e;
    },
  });
  const entry = await entryFor(IDS.gif);
  const out = await runStickerBatch({ entries: [entry], target: "original" });
  assert.equal(calls.fetch.length, 1);
  assert.equal(out.errors.length, 1);
});

test("runs at most two items at a time", async () => {
  let active = 0;
  let peak = 0;
  const { calls } = fakePlatform({
    async fetchMedia(args) {
      calls.fetch.push(args);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
      return { blob: {}, size: 1, name: args.fileName };
    },
  });
  const entries = [];
  for (let i = 0; i < 5; i += 1) entries.push(await entryFor(IDS.emoji, `e${i}`));
  // distinct ids so nothing is deduped
  entries.forEach((e, i) => (e.id = `${e.id}#${i}`));
  const out = await runStickerBatch({ entries, target: "original" });
  assert.equal(out.results.length, 5);
  assert.equal(peak, 2);
  assert.equal(new Set(calls.fetch.map((c) => c.fileId)).size, 5, "one fileId per item");
});

test("results and errors follow input order, not completion order", async () => {
  const { calls } = fakePlatform({
    async fetchMedia(args) {
      calls.fetch.push(args);
      // Item 0 is slow; item 1 finishes first.
      await new Promise((r) => setTimeout(r, args.fileId.endsWith("-0") ? 30 : 1));
      if (args.fileId.endsWith("-2")) throw new Error("boom");
      return { blob: {}, size: 1, name: args.fileName };
    },
  });
  const entries = [];
  for (let i = 0; i < 4; i += 1) entries.push(await entryFor(IDS.emoji, `t${i}`));
  entries.forEach((e, i) => (e.id = `${e.id}#${i}`));
  const out = await runStickerBatch({ entries, target: "original" });
  assert.deepEqual(out.results.map((r) => r.title), ["t0", "t1", "t3"]);
  assert.deepEqual(out.errors.map((e) => e.title), ["t2"]);
});

test("cancel: kills in-flight work by fileId, stops the batch, cleans up", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { calls } = fakePlatform({
    async transcodeMedia(args) {
      calls.transcode.push(args);
      await gate;
      return { handle: null, size: 0, cancelled: true };
    },
    cancelDownload(fileId) {
      calls.cancel.push(fileId ?? null);
      release();
    },
  });
  const entries = [await entryFor(IDS.apng, "a"), await entryFor(IDS.apng, "b"), await entryFor(IDS.apng, "c")];
  entries.forEach((e, i) => (e.id = `${e.id}#${i}`));
  const running = runStickerBatch({ entries, target: "gif" });
  // Let both workers reach their transcode.
  while (calls.transcode.length < 2) await new Promise((r) => setTimeout(r, 1));
  assert.equal(isStickerBatchRunning(), true);
  cancelStickerBatch();
  const out = await running;
  assert.equal(out.cancelled, true);
  assert.equal(out.results.length, 0);
  assert.equal(out.errors.length, 0, "a cancel is never an error");
  assert.deepEqual(new Set(calls.cancel), new Set(calls.transcode.map((t) => t.fileId)));
  assert.equal(calls.transcode.length, 2, "the third item never starts");
  assert.equal(calls.discard.length, 2);
  assert.equal(isStickerBatchRunning(), false);

  // A fresh batch after a cancel runs normally.
  fakePlatform();
  const again = await runStickerBatch({ entries: [entries[0]], target: "original" });
  assert.equal(again.cancelled, false);
  assert.equal(again.results.length, 1);
});

test("lottie: original is a plain fetch of the JSON; conversions need a renderer", async () => {
  const { calls } = fakePlatform({ discordNet: { ...fakeNet(), async getText() { return { status: 200, text: '{"v":"5.6.2","fr":60,"ip":0,"op":120,"w":320,"h":320,"layers":[]}' }; } } });
  const entry = await entryFor(IDS.lottie);
  assert.equal(entry.discord.sourceFormat, "lottie");
  const orig = await runStickerBatch({ entries: [entry], target: "original" });
  assert.deepEqual(orig.errors, []);
  assert.equal(orig.results[0].fileName, `sticker-${IDS.lottie}.json`);
  // Under Node there is no DOM to render on: the item fails with a clear
  // message instead of silently saving the JSON.
  const conv = await runStickerBatch({ entries: [entry], target: "gif" });
  assert.equal(conv.results.length, 0);
  assert.equal(conv.errors.length, 1);
  assert.match(conv.errors[0].message, /Lottie/);
  assert.equal(calls.transcode.length, 0);
});

test("lottie on a surface without a renderer saves the original with a warning", async () => {
  const { calls } = fakePlatform({ stickerCaps: CAPS.android });
  const entry = await entryFor(IDS.lottie);
  const out = await runStickerBatch({ entries: [entry], target: "sticker" });
  assert.deepEqual(out.errors, []);
  assert.equal(calls.transcode.length, 0);
  assert.equal(out.results[0].fileName, `sticker-${IDS.lottie}.json`);
  assert.match(out.results[0].warning, /^Saved the original instead of Discord sticker \(lottie stickers can only be converted/);
});

test("refuses a second concurrent batch and handles empty input", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  fakePlatform({
    async fetchMedia(args) {
      await gate;
      return { blob: {}, size: 1, name: args.fileName };
    },
  });
  const entry = await entryFor(IDS.emoji);
  const first = runStickerBatch({ entries: [entry], target: "original" });
  await assert.rejects(runStickerBatch({ entries: [entry], target: "original" }), /Already saving/);
  release();
  await first;
  assert.deepEqual(await runStickerBatch({ entries: [], target: "gif" }), { results: [], errors: [], cancelled: false });
});

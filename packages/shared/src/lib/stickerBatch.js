/**
 * Sticker-stealer batch runner (web + desktop).
 *
 * Takes Discord-stealer entries (each carrying its resolved DiscordMedia as
 * `entry.discord`) and a "Save as" target, plans every item with the pure
 * core (planExport), and executes the plan through the platform adapter:
 *
 *   fetch   → fetchMedia → finalizeMedia
 *   convert → fetchMedia(source) [Lottie: getText → render APNG →
 *             importMediaBytes] → transcodeMedia per attempt (the size
 *             ladder: first output under maxBytes wins, else the smallest
 *             one with a warning) → finalizeMedia
 *   then always discardMedia (staging cleanup).
 *
 * A target an item can't do falls back to its Original with a warning; a
 * conversion where every attempt fails also falls back to the Original.
 * Items run two at a time. Errors are per item — one bad link never stops
 * the rest. Cancel is cooperative (flag between steps) AND hard (the
 * adapter kills in-flight fetches/transcodes for the item's fileId).
 */

import { getPlatform } from "../platform.js";
import { PRESETS, planExport, targetLabel } from "../core/discordMedia.js";
import { renderLottieToApng } from "./lottieRender.js";
import { logError } from "./errorLog.js";

const CONCURRENCY = 2;

let batchActive = false;
let cancelRequested = false;
let batchAbort = null;
const inflight = new Set(); // fileIds with work in progress

/** Human size with 1000-based units (Discord's limits are 512 000 / 256 000 B). */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1000) return `${Math.round(n)} B`;
  if (n < 1000 * 1000) return `${Math.round(n / 1000)} KB`;
  return `${(n / (1000 * 1000)).toFixed(1)} MB`;
}

export function isStickerBatchRunning() {
  return batchActive;
}

/** Stop the running batch: flag the workers and kill in-flight native work. */
export function cancelStickerBatch() {
  if (!batchActive) return;
  cancelRequested = true;
  try {
    batchAbort?.abort();
  } catch {
    // ignore
  }
  let platform;
  try {
    platform = getPlatform();
  } catch {
    return;
  }
  if (typeof platform.cancelDownload !== "function") return;
  for (const fileId of inflight) {
    try {
      const r = platform.cancelDownload(fileId);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch {
      // Best-effort — the flag still stops the batch between steps.
    }
  }
}

class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
    this.cancelled = true;
  }
}

/** Every conversion attempt failed — the caller may fall back to Original. */
class ConversionFailedError extends Error {
  constructor(cause) {
    super(cause?.message || "Conversion failed.");
    this.name = "ConversionFailedError";
    this.cause = cause;
  }
}

function checkCancel() {
  if (cancelRequested) throw new CancelledError();
}

function isCancellation(e) {
  return cancelRequested || e instanceof CancelledError || e?.cancelled === true || e?.name === "AbortError";
}

function presetFor(target) {
  if (target === "sticker") return PRESETS.sticker;
  if (target === "emoji") return PRESETS.emoji;
  return null;
}

/** Lower-case the first letter of a sentence so it reads inside another. */
function inline(reason) {
  const s = String(reason || "").trim().replace(/[.\s]+$/, "");
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : "";
}

/**
 * Run a batch. Resolves { results, errors, cancelled } where results are
 * [{ id, title, outputPath, outputBlob, outputSize, warning, fileName }] and
 * errors [{ id, title, message }]. Never rejects for per-item failures.
 *
 * onProgress(pct 0–100, label, currentTitle) — label is e.g. "Converting…".
 * onItemDone(entry, result) fires after each success.
 */
export async function runStickerBatch({ entries, target = "original", outputDir = null, onProgress, onItemDone } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return { results: [], errors: [], cancelled: false };
  // Filled by input index so the outcome lists follow the paste order, not
  // the order two concurrent workers happened to finish in.
  const results = new Array(list.length);
  const errors = new Array(list.length);
  if (batchActive) throw new Error("Already saving — wait for the current batch to finish.");

  const platform = getPlatform();
  const caps = platform.stickerCaps;
  if (!caps) throw new Error("Saving Discord media isn't supported here yet.");

  batchActive = true;
  cancelRequested = false;
  batchAbort = typeof AbortController === "function" ? new AbortController() : null;
  inflight.clear();

  const batchId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const fraction = new Array(list.length).fill(0);
  let lastLabel = "Downloading…";
  let lastTitle = list[0]?.title ?? "";

  const report = (i, f, label) => {
    if (typeof f === "number") fraction[i] = Math.max(fraction[i], Math.min(1, f));
    if (label) lastLabel = label;
    if (typeof onProgress !== "function") return;
    const pct = Math.round((fraction.reduce((a, b) => a + b, 0) / list.length) * 100);
    try {
      onProgress(pct, lastLabel, lastTitle);
    } catch {
      // A broken progress callback must not kill the batch.
    }
  };

  const keepAwake = (on) => {
    try {
      const r = platform.setKeepAwake?.(on);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch {
      // cosmetic
    }
  };

  /** Fetch a 'fetch' plan, retrying CORS-safe sibling renditions of the same
   *  file type when the preferred (relay-only) URL can't be reached. */
  const fetchPlanned = async (fileId, media, plan) => {
    const candidates = [{ url: plan.url, corsSafe: plan.corsSafe }];
    if (!plan.corsSafe) {
      const want = media.renditions?.original;
      for (const r of Object.values(media.renditions || {})) {
        if (!r || r.url === plan.url || !r.corsSafe || r.ext !== plan.ext) continue;
        if (want && r.animated !== want.animated) continue;
        if (!candidates.some((c) => c.url === r.url)) candidates.push({ url: r.url, corsSafe: true });
      }
    }
    let lastErr = null;
    for (const c of candidates) {
      checkCancel();
      try {
        return await platform.fetchMedia({ fileId, url: c.url, fileName: plan.fileName, corsSafe: c.corsSafe });
      } catch (e) {
        if (isCancellation(e)) throw new CancelledError();
        lastErr = e;
        // A definitive "gone" answer won't change with a sibling URL.
        if (e?.httpStatus === 404 || e?.httpStatus === 410) break;
      }
    }
    throw lastErr || new Error("Couldn't download that file.");
  };

  const runFetchPlan = async (i, fileId, media, plan) => {
    report(i, 0.1, "Downloading…");
    const handle = await fetchPlanned(fileId, media, plan);
    checkCancel();
    report(i, 0.85, "Saving…");
    const fin = await platform.finalizeMedia({ fileId, handle, fileName: plan.fileName, outputDir });
    return { ...fin, fileName: plan.fileName };
  };

  const runConvertPlan = async (i, fileId, media, plan, preset) => {
    const src = plan.source;
    let input;
    report(i, 0.05, "Downloading…");
    if (src.format === "lottie") {
      const res = await platform.discordNet.getText(src.url);
      checkCancel();
      if (res.status !== 200 || !res.text) {
        const e = new Error(`Couldn't download the Lottie sticker (HTTP ${res.status}).`);
        e.httpStatus = res.status;
        throw e;
      }
      report(i, 0.15, "Rendering animation…");
      const apng = await renderLottieToApng(res.text, {
        size: preset ? preset.size : 320,
        fps: 30,
        maxSeconds: preset ? preset.maxSeconds : null,
        signal: batchAbort?.signal,
        onProgress: (f) => report(i, 0.15 + 0.2 * f),
      });
      checkCancel();
      input = await platform.importMediaBytes({ fileId, bytes: apng, fileName: "lottie-render.png" });
    } else {
      try {
        input = await platform.fetchMedia({ fileId, url: src.url, fileName: `source.${src.ext}`, corsSafe: src.corsSafe });
      } catch (e) {
        if (isCancellation(e)) throw new CancelledError();
        throw e;
      }
    }
    checkCancel();

    const attempts = plan.attempts || [];
    const maxBytes = typeof plan.maxBytes === "number" ? plan.maxBytes : null;
    const fitLabel = maxBytes != null ? `Fitting under ${formatBytes(maxBytes)}…` : "Converting…";
    let winner = null;
    let smallest = null;
    let lastErr = null;
    for (let a = 0; a < attempts.length; a += 1) {
      checkCancel();
      const att = attempts[a];
      report(i, 0.35 + 0.55 * (a / attempts.length), a === 0 ? "Converting…" : fitLabel);
      let r;
      try {
        r = await platform.transcodeMedia({
          fileId,
          input,
          inputArgs: att.inputArgs,
          outputArgs: att.outputArgs,
          outputExt: att.outExt,
        });
      } catch (e) {
        if (isCancellation(e)) throw new CancelledError();
        lastErr = e;
        continue;
      }
      if (r?.cancelled) throw new CancelledError();
      if (!r?.handle || !(r.size > 0)) {
        lastErr = new Error("Conversion produced an empty file.");
        continue;
      }
      const candidate = { handle: r.handle, size: r.size, attempt: att };
      if (maxBytes == null || r.size <= maxBytes) {
        winner = candidate;
        break;
      }
      if (!smallest || candidate.size < smallest.size) smallest = candidate;
    }

    let warning = null;
    if (!winner && smallest) {
      winner = smallest;
      warning = `Could not get under ${formatBytes(maxBytes)} (got ${formatBytes(smallest.size)})`;
    }
    if (!winner) throw new ConversionFailedError(lastErr);

    checkCancel();
    report(i, 0.92, "Saving…");
    const fileName = `${plan.fileName}.${winner.attempt.outExt}`;
    const fin = await platform.finalizeMedia({ fileId, handle: winner.handle, fileName, outputDir });
    return { ...fin, fileName, warning };
  };

  const processOne = async (i) => {
    const entry = list[i];
    const media = entry?.discord;
    const fileId = `stk-${batchId}-${i}`;
    lastTitle = entry?.title ?? "";
    inflight.add(fileId);
    try {
      if (!media) throw new Error("This item isn't Discord media.");
      checkCancel();

      let plan = planExport(media, target, caps);
      let warning = null;
      if (plan.mode === "unsupported") {
        const fallback = planExport(media, "original", caps);
        if (fallback.mode === "unsupported") throw new Error(plan.reason || fallback.reason);
        warning = `Saved the original instead of ${targetLabel(target)} (${inline(plan.reason)}).`;
        plan = fallback;
      }

      let out;
      if (plan.mode === "fetch") {
        out = await runFetchPlan(i, fileId, media, plan);
      } else {
        try {
          out = await runConvertPlan(i, fileId, media, plan, presetFor(target));
        } catch (e) {
          if (!(e instanceof ConversionFailedError) || isCancellation(e)) throw e;
          const fallback = planExport(media, "original", caps);
          if (fallback.mode !== "fetch") throw e;
          logError("convert", e.cause || e, entry.title);
          out = await runFetchPlan(i, fileId, media, fallback);
          out.warning = `Couldn't convert to ${targetLabel(target)} — saved the original instead.`;
        }
        if (out.warning) warning = warning ? `${warning} ${out.warning}` : out.warning;
      }
      checkCancel();

      report(i, 1);
      const result = {
        id: entry.id,
        title: entry.title,
        outputPath: out.outputPath ?? null,
        outputBlob: out.outputBlob ?? null,
        outputSize: typeof out.outputSize === "number" ? out.outputSize : null,
        warning,
        fileName: out.fileName ?? null,
      };
      results[i] = result;
      if (typeof onItemDone === "function") {
        try {
          onItemDone(entry, result);
        } catch {
          // History/UI hook failures must not fail the item.
        }
      }
    } catch (e) {
      if (isCancellation(e)) {
        cancelRequested = true;
        return;
      }
      // Count the failed slot as finished so the bar can reach 100%.
      report(i, 1);
      logError("download", e, entry?.title);
      errors[i] = {
        id: entry?.id,
        title: entry?.title ?? "Item",
        message: e instanceof Error ? e.message : String(e),
      };
    } finally {
      inflight.delete(fileId);
      try {
        const r = platform.discardMedia?.(fileId);
        if (r && typeof r.catch === "function") await r.catch(() => {});
      } catch {
        // Staging cleanup is best-effort (the desktop sweeps stale dirs).
      }
    }
  };

  keepAwake(true);
  try {
    let cursor = 0;
    const worker = async () => {
      while (!cancelRequested && cursor < list.length) {
        const i = cursor;
        cursor += 1;
        await processOne(i);
      }
    };
    report(0, 0, "Downloading…");
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
    return {
      results: results.filter(Boolean),
      errors: errors.filter(Boolean),
      cancelled: cancelRequested,
    };
  } finally {
    keepAwake(false);
    batchActive = false;
    cancelRequested = false;
    batchAbort = null;
    inflight.clear();
  }
}

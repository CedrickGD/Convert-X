/**
 * Sticker-stealer batch runner.
 *
 * Takes the Discord/Tenor/Giphy/Klipy entries a probe produced (each
 * carrying a resolved `discord` payload) plus a chosen target format, and
 * for every item either fetches an exact server rendition or transcodes
 * the source through FFmpeg down a size-capped ladder, then saves the
 * result to the gallery. Mirrors downloadQueue's batch shape (overall
 * percent + per-item callbacks) so DownloadScreen can reuse its progress
 * and done views, and lands the finished file in the same persistent
 * `downloads/` dir so Share, History and the 48 h purge all work unchanged.
 *
 * FFmpeg notes (ffmpeg-kit main-min 6.1.4, see maps/androidDownload.md
 * §4.2): executeAsync takes args WITHOUT a leading 'ffmpeg'; paths are
 * plain filesystem paths (file:// stripped); each attempt gets a UNIQUE
 * session id because the Kotlin id map overwrites a reused key; durationMs
 * may be 0 for images, so progress falls back to stage stepping.
 */

import * as FileSystem from 'expo-file-system/legacy';

import * as Downloader from '../../modules/convert-x-downloader/src';
import * as Ffmpeg from '../../modules/convert-x-ffmpeg/src';
import {
  CAPS,
  planExport,
  targetLabel,
  type Attempt,
  type ExportPlan,
} from './discordMedia';
import type { DownloadEntry } from './downloadQueue';
import { logError } from './errorLog';
import {
  buildTranscodeArgs,
  claimFileName,
  galleryName,
  overBudgetWarning,
  selectWinner,
  type AttemptOutcome,
} from './stickerPlan';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export type StickerItemResult = {
  outputPath?: string;
  publicPath?: string;
  warning?: string;
  cancelled?: boolean;
};

export type StickerBatchResult = {
  done: number;
  failed: number;
  cancelled: boolean;
  lastPublicPath?: string;
  errors: Array<{ id: string; title: string; message: string }>;
  warnings: Array<{ id: string; title: string; message: string }>;
};

// How many items transcode at once. Each ffmpeg-kit run is CPU-heavy on a
// budget phone, so 2 keeps a multi-emoji paste moving without thrashing.
const CONCURRENCY = 2;

// ── cancellation plumbing (module-level, mirrors downloadQueue) ──────────────
let cancelRequested = false;
let batchRunning = false;
// Abort closures for in-flight createDownloadResumable transfers, keyed so a
// Cancel tap aborts every concurrent worker, not just the last.
const activeDownloadCancels = new Map<string, () => void>();
// Unique ffmpeg session ids currently executing — Cancel kills each.
const activeFfmpeg = new Set<string>();

export function isStickerBatchRunning(): boolean {
  return batchRunning;
}

export function cancelStickerBatch(): void {
  cancelRequested = true;
  for (const abort of activeDownloadCancels.values()) abort();
  activeDownloadCancels.clear();
  for (const id of activeFfmpeg) {
    try {
      Ffmpeg.cancel(id);
    } catch {
      /* best-effort */
    }
  }
}

function sanitizeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'x';
}

function stripScheme(uri: string): string {
  return uri.replace(/^file:\/\//, '');
}

// ── FFmpeg one attempt ───────────────────────────────────────────────────────
async function runAttempt(
  ffSession: string,
  args: string[],
  durationMs: number,
  onPct: (pct: number) => void
): Promise<{ returnCode: number; logs: string; cancelled: boolean }> {
  const sub = Ffmpeg.addProgressListener((evt) => {
    if (evt.sessionId === ffSession && evt.durationMs > 0 && evt.percent >= 0) {
      onPct(Math.min(100, evt.percent));
    }
  });
  activeFfmpeg.add(ffSession);
  try {
    const res = (await Ffmpeg.executeAsync(ffSession, args, durationMs)) as {
      returnCode: number;
      logs: string;
      cancelled?: boolean;
    };
    return { returnCode: res.returnCode, logs: res.logs, cancelled: res.cancelled === true };
  } finally {
    sub.remove();
    activeFfmpeg.delete(ffSession);
  }
}

// ── a single download to a file:// URI ───────────────────────────────────────
// Resolves with the URI, or null when a Cancel aborted it. Throws on a
// genuine fetch failure / non-2xx status.
async function fetchToFile(
  url: string,
  fileUri: string,
  cancelKey: string,
  onPct: (pct: number) => void
): Promise<string | null> {
  let aborted = false;
  const dl = FileSystem.createDownloadResumable(
    url,
    fileUri,
    { headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' } },
    (p) => {
      const total = p.totalBytesExpectedToWrite || 0;
      if (total > 0) onPct(Math.round((p.totalBytesWritten / total) * 100));
    }
  );
  activeDownloadCancels.set(cancelKey, () => {
    aborted = true;
    dl.cancelAsync().catch(() => {});
  });
  try {
    const result = await dl.downloadAsync();
    if (aborted || cancelRequested) {
      await FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
      return null;
    }
    if (!result || !result.uri) {
      throw new Error('The media could not be downloaded.');
    }
    if (typeof result.status === 'number' && (result.status < 200 || result.status >= 300)) {
      await FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
      throw new Error(`The media link returned HTTP ${result.status} — try Find again to refresh it.`);
    }
    return fileUri;
  } catch (e) {
    await FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
    throw e;
  } finally {
    activeDownloadCancels.delete(cancelKey);
  }
}

async function saveOutput(fileUri: string, displayName: string): Promise<string> {
  // saveToGallery runs ensureLegacyWriteAccess (API < 29 storage permission)
  // before the MediaStore insert. The display name's extension decides the
  // album (.png/.gif/.webp → Pictures, .mp4 → Movies, .json → Download).
  const saved = await Downloader.saveToGallery(stripScheme(fileUri), displayName);
  return saved.publicPath;
}

async function sizeOf(fileUri: string): Promise<number> {
  const info = await FileSystem.getInfoAsync(fileUri).catch(() => null);
  return info && info.exists ? info.size : -1;
}

export async function runStickerBatch(opts: {
  sessionId: string;
  entries: DownloadEntry[];
  target: string;
  onProgress: (overallPct: number, currentIndex: number) => void;
  onItemStart?: (index: number, entry: DownloadEntry) => void;
  onItemDone?: (entry: DownloadEntry, result: StickerItemResult) => void;
}): Promise<StickerBatchResult> {
  const total = opts.entries.length;
  if (total === 0) {
    return { done: 0, failed: 0, cancelled: false, errors: [], warnings: [] };
  }

  let done = 0;
  let failed = 0;
  let cancelled = false;
  let lastPublicPath: string | undefined;
  const errors: StickerBatchResult['errors'] = [];
  const warnings: StickerBatchResult['warnings'] = [];
  const perItemPct = new Array<number>(total).fill(0);

  const reportOverall = (idx: number) => {
    const sum = perItemPct.reduce((a, b) => a + b, 0);
    opts.onProgress(Math.round(sum / total), idx);
  };
  const setPct = (i: number, pct: number) => {
    perItemPct[i] = Math.max(perItemPct[i], Math.max(0, Math.min(100, Math.round(pct))));
    reportOverall(i);
  };
  const finishSlot = (i: number) => {
    perItemPct[i] = 100;
    reportOverall(i);
  };

  // Finished files land in the persistent downloads dir (same as yt-dlp /
  // direct downloads) so Share and History work and the 48 h purge reclaims
  // them. Intermediates stage in the cache dir and are deleted per item.
  const downloadsDir = `${FileSystem.documentDirectory ?? ''}downloads`;
  const stageBase = `${FileSystem.cacheDirectory ?? ''}stickers/${sanitizeSegment(opts.sessionId)}`;
  await FileSystem.makeDirectoryAsync(downloadsDir, { intermediates: true }).catch(() => {});

  // Every item gets its own output name: unique within this batch (two
  // items can share a title; CONCURRENCY workers overlap) and never one an
  // earlier batch left in downloads/ (History/Share still point at it).
  // Each candidate is claimed synchronously BEFORE the existence check
  // awaits, so no two workers can ever test or win the same name.
  const claimed = new Set<string>();
  const claimOutputName = async (name: string): Promise<string> => {
    for (;;) {
      const candidate = claimFileName(name, claimed);
      const info = await FileSystem.getInfoAsync(`${downloadsDir}/${candidate}`).catch(() => null);
      if (!info || !info.exists) return candidate;
      // Taken on disk: it stays claimed, so the next pass tries the next suffix.
    }
  };

  const runOne = async (i: number): Promise<void> => {
    const entry = opts.entries[i];
    opts.onItemStart?.(i, entry);
    if (cancelRequested) {
      cancelled = true;
      return;
    }
    const media = entry.discord;
    if (!media) {
      failed += 1;
      finishSlot(i);
      errors.push({ id: entry.id, title: entry.title, message: 'Not a Discord media item.' });
      return;
    }

    // Plan, with a graceful fall back to the original when the chosen target
    // isn't possible on Android (e.g. animated WebP, Lottie).
    let plan: ExportPlan = planExport(media, opts.target, CAPS.android);
    let warning: string | undefined;
    if (plan.mode === 'unsupported') {
      const fallback = planExport(media, 'original', CAPS.android);
      if (fallback.mode === 'unsupported') {
        failed += 1;
        finishSlot(i);
        errors.push({ id: entry.id, title: entry.title, message: plan.reason });
        return;
      }
      warning = `${targetLabel(opts.target)} isn't available on Android — saved the original instead.`;
      plan = fallback;
    }

    const stageDir = `${stageBase}/${i}`;

    try {
      if (plan.mode === 'fetch') {
        const fileName = await claimOutputName(plan.fileName);
        const finalUri = `${downloadsDir}/${fileName}`;
        const got = await fetchToFile(plan.url, finalUri, `${opts.sessionId}-${i}`, (p) =>
          setPct(i, p)
        );
        if (got == null) {
          cancelled = true;
          return;
        }
        const publicPath = await saveOutput(finalUri, fileName);
        finishSlot(i);
        done += 1;
        lastPublicPath = publicPath;
        if (warning) warnings.push({ id: entry.id, title: entry.title, message: warning });
        opts.onItemDone?.(entry, { outputPath: finalUri, publicPath, warning });
        return;
      }

      // convert
      await FileSystem.makeDirectoryAsync(stageDir, { intermediates: true }).catch(() => {});
      const source = plan.source;
      const srcUri = `${stageDir}/src.${source.ext || 'bin'}`;
      const got = await fetchToFile(source.url, srcUri, `${opts.sessionId}-${i}`, (p) =>
        setPct(i, p * 0.45)
      );
      if (got == null) {
        cancelled = true;
        return;
      }

      let durationMs = 0;
      try {
        durationMs = (await Ffmpeg.getMediaInfo(srcUri)).durationMs || 0;
      } catch {
        durationMs = 0;
      }

      const outcomes: AttemptOutcome[] = [];
      const attempts: Attempt[] = plan.attempts;
      for (let a = 0; a < attempts.length; a += 1) {
        if (cancelRequested) {
          cancelled = true;
          return;
        }
        const attempt = attempts[a];
        const outUri = `${stageDir}/out-${a}.${attempt.outExt}`;
        const args = buildTranscodeArgs(stripScheme(srcUri), stripScheme(outUri), attempt);
        // Nudge the bar so a 0-duration (image) attempt never looks stuck.
        setPct(i, 45 + (a / attempts.length) * 10);
        const rc = await runAttempt(`${opts.sessionId}-${i}-${a}`, args, durationMs, (p) =>
          setPct(i, 45 + p * 0.5)
        );
        if (rc.cancelled || cancelRequested) {
          cancelled = true;
          return;
        }
        if (rc.returnCode !== 0) {
          // Record the tail once so a totally-failing item is diagnosable.
          if (a === attempts.length - 1 && outcomes.length === 0) {
            logError('download', new Error(rc.logs.slice(-400) || 'ffmpeg failed'), entry.title);
          }
          continue;
        }
        const size = await sizeOf(outUri);
        if (size <= 0) continue;
        outcomes.push({ index: a, size, path: outUri, outExt: attempt.outExt });
        if (plan.maxBytes == null) break; // first success wins
        if (size <= plan.maxBytes) break; // best rung that fits
        // over budget — keep walking down the (smaller) ladder
      }

      const winner = selectWinner(outcomes, plan.maxBytes);
      if (!winner) {
        failed += 1;
        finishSlot(i);
        errors.push({
          id: entry.id,
          title: entry.title,
          message: 'Could not convert this item on Android — try Original or GIF.',
        });
        return;
      }
      if (!winner.underBudget && plan.maxBytes != null) {
        warning = overBudgetWarning(plan.maxBytes, winner.outcome.size);
      }

      setPct(i, 97);
      // A freshly claimed name is guaranteed unused, so nothing to delete first.
      const displayName = await claimOutputName(galleryName(plan.fileName, winner.outcome.outExt));
      const finalUri = `${downloadsDir}/${displayName}`;
      await FileSystem.moveAsync({ from: winner.outcome.path, to: finalUri });
      const publicPath = await saveOutput(finalUri, displayName);
      finishSlot(i);
      done += 1;
      lastPublicPath = publicPath;
      if (warning) warnings.push({ id: entry.id, title: entry.title, message: warning });
      opts.onItemDone?.(entry, { outputPath: finalUri, publicPath, warning });
    } catch (e) {
      if (cancelRequested) {
        cancelled = true;
        return;
      }
      failed += 1;
      finishSlot(i);
      logError('download', e, entry.title);
      errors.push({
        id: entry.id,
        title: entry.title,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      await FileSystem.deleteAsync(stageDir, { idempotent: true }).catch(() => {});
    }
  };

  cancelRequested = false;
  batchRunning = true;
  try {
    let cursor = 0;
    const worker = async () => {
      while (!cancelRequested && cursor < total) {
        const idx = cursor;
        cursor += 1;
        await runOne(idx);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
    return {
      done,
      failed,
      cancelled: cancelled || cancelRequested,
      lastPublicPath,
      errors,
      warnings,
    };
  } finally {
    batchRunning = false;
    cancelRequested = false;
    // Tidy the session's whole staging tree (per-item dirs are already gone).
    await FileSystem.deleteAsync(stageBase, { idempotent: true }).catch(() => {});
  }
}

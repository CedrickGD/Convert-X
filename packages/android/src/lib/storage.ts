/**
 * App-private storage housekeeping.
 *
 * Conversions and downloads write a persistent copy into exports/ and
 * downloads/. Nothing ever deleted them, so a regular user silently
 * accumulated a copy of every media file they ever touched. This purges
 * entries older than a cutoff on launch — saved-to-gallery copies live in
 * MediaStore (separate), so the app-private working copy is safe to reclaim.
 */
import * as FileSystem from 'expo-file-system/legacy';

/** Files older than this are reclaimed on launch. */
const MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48h

async function purgeDir(dir: string, now: number): Promise<void> {
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists || !info.isDirectory) return;
  const names = await FileSystem.readDirectoryAsync(dir);
  for (const name of names) {
    const p = `${dir}/${name}`;
    const fi = await FileSystem.getInfoAsync(p);
    if (!fi.exists) continue;
    // legacy getInfoAsync returns modificationTime in seconds since epoch.
    const mtime = 'modificationTime' in fi ? fi.modificationTime : undefined;
    if (typeof mtime === 'number' && now - mtime * 1000 > MAX_AGE_MS) {
      await FileSystem.deleteAsync(p, { idempotent: true }).catch(() => {});
    }
  }
}

/** Reclaim stale self-update APKs from cache (large; left after install/cancel). */
async function purgeUpdateApks(cacheDir: string, now: number): Promise<void> {
  const info = await FileSystem.getInfoAsync(cacheDir);
  if (!info.exists || !info.isDirectory) return;
  const names = await FileSystem.readDirectoryAsync(cacheDir);
  for (const name of names) {
    if (!/^update-.*\.apk$/.test(name)) continue;
    const p = `${cacheDir}${name}`;
    const fi = await FileSystem.getInfoAsync(p);
    if (!fi.exists) continue;
    const mtime = 'modificationTime' in fi ? fi.modificationTime : undefined;
    // Reclaim an hour after download — long past any in-progress install.
    if (typeof mtime === 'number' && now - mtime * 1000 > 60 * 60 * 1000) {
      await FileSystem.deleteAsync(p, { idempotent: true }).catch(() => {});
    }
  }
}

/** Reclaim stale exports/downloads + leftover update APKs. Fire-and-forget on launch. */
export async function purgeOldExports(now: number = Date.now()): Promise<void> {
  const base = FileSystem.documentDirectory;
  if (base) {
    await purgeDir(`${base}exports`, now).catch(() => {});
    await purgeDir(`${base}downloads`, now).catch(() => {});
  }
  const cache = FileSystem.cacheDirectory;
  if (cache) await purgeUpdateApks(cache, now).catch(() => {});
}

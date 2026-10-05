// node:test guards for the Download view's lifecycle fixes. These live in
// Svelte components (App.svelte, DownloadView.svelte) which need the Svelte
// compiler + a DOM to execute, so the behaviour is asserted against source —
// targeting the exact contracts the fixes establish:
//
//   • App.svelte keeps DownloadView mounted-and-hidden on web too (not just
//     desktop), so a running batch survives a tab switch, and it is mounted
//     only ONCE (no second <DownloadView/> in the mode branch).
//   • DownloadView.onDestroy releases thumbnail blob URLs AND cancels any
//     running batch, so a real teardown never strands an ffmpeg.wasm batch.
//   • runDownload shows a toast instead of silently no-opping when a batch
//     is still finishing.
//
// Run: node --test "packages/shared/test/*.test.mjs"

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const APP = read("../src/components/App.svelte");
const VIEW = read("../src/components/DownloadView.svelte");

test("App.svelte mounts DownloadView once, in a persistent hidden tab-pane", () => {
  // Exactly one instance in the markup.
  const mounts = APP.match(/<DownloadView\s*\/>/g) || [];
  assert.equal(mounts.length, 1, "DownloadView mounted exactly once");

  // The single mount lives in a tab-pane that is only hidden (never
  // unmounted) when off the Download tab.
  assert.match(
    APP,
    /<div class="tab-pane" class:hidden=\{mode !== "download"\}>\s*<DownloadView \/>\s*<\/div>/,
    "DownloadView sits in a hide-don't-unmount tab-pane"
  );
});

test("App.svelte no longer gates the persistent pane on isDesktop", () => {
  // The old bug kept the persistent pane behind {#if isDesktop}, so web
  // unmounted the view on tab switch. That guard must be gone from around
  // the DownloadView mount.
  const idx = APP.indexOf("<DownloadView />");
  const before = APP.slice(Math.max(0, idx - 400), idx);
  assert.ok(!/\{#if isDesktop\}\s*$/.test(before.trimEnd().slice(-40)), "no isDesktop gate directly wrapping the mount");
});

test("DownloadView.onDestroy clears thumbnails and cancels a running batch", () => {
  const m = VIEW.match(/onDestroy\(\(\) => \{([\s\S]*?)\}\);/);
  assert.ok(m, "onDestroy block found");
  const body = m[1];
  assert.match(body, /clearThumbBlobs\(\)/, "revokes thumbnail blob URLs");
  assert.match(body, /cancelStickerBatch\(\)/, "cancels the sticker lane");
  assert.match(body, /cancelActiveBatch\(\)/, "cancels the download lane");
});

test("runDownload toasts instead of silently no-opping while a batch is live", () => {
  const m = VIEW.match(
    /if \(isDownloading\(\) \|\| isStickerBatchRunning\(\) \|\| downloadActive\) \{([\s\S]*?)\}/
  );
  assert.ok(m, "the batch-still-running guard is present");
  assert.match(m[1], /toast\(\s*"A download is still finishing/, "shows a 'still finishing' toast");
  assert.match(m[1], /return;/, "still bails out of a second concurrent batch");
});

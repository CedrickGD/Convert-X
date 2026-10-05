// node:test suite for the web platform adapter's download lanes
// (packages/web/src/platform-web.js), exercised from the shared test runner.
//
// Two fixes are guarded here:
//   • downloadDirect must treat an upstream 401/503 passthrough (a response
//     carrying X-Upstream-Status) as an http_error the shared queue can
//     re-probe, NOT as a gateway "access key rejected" / "offline" error.
//     This is driven behaviourally with a stubbed global.fetch.
//   • The sticker transcode lane must run on its OWN ffmpeg.wasm core so a
//     Convert-tab cancelConversion() can never terminate a running sticker
//     batch (and vice-versa). ffmpeg.wasm throws on construction under node,
//     so that isolation is asserted against the adapter source.
//
// Run: node --test "packages/shared/test/*.test.mjs"

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createWebAdapter } from "../../web/src/platform-web.js";

const WEB_SRC = fileURLToPath(new URL("../../web/src/platform-web.js", import.meta.url));

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers || {}) },
  });
}

function withFetch(fn, impl) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  return (async () => {
    try {
      return await fn();
    } finally {
      globalThis.fetch = prev;
    }
  })();
}

test("downloadDirect: upstream 401 passthrough (X-Upstream-Status) → http_error for re-probe", async () => {
  const adapter = createWebAdapter();
  adapter.gateway.setKey("test-key");
  const res = await withFetch(
    () => adapter.downloadDirect({ fileId: "a", url: "https://cdn.example/x.jpg", fileName: "x.jpg" }),
    async () =>
      jsonResponse({ error: "Upstream returned HTTP 401" }, 401, { "x-upstream-status": "401" })
  );
  assert.deepEqual(res, { status: "http_error", httpStatus: 401 });
});

test("downloadDirect: upstream 503 passthrough → http_error (not 'downloader offline')", async () => {
  const adapter = createWebAdapter();
  adapter.gateway.setKey("test-key");
  const res = await withFetch(
    () => adapter.downloadDirect({ fileId: "b", url: "https://cdn.example/x.jpg", fileName: "x.jpg" }),
    async () =>
      jsonResponse({ error: "Upstream returned HTTP 503" }, 503, { "x-upstream-status": "503" })
  );
  assert.deepEqual(res, { status: "http_error", httpStatus: 503 });
});

test("downloadDirect: gateway's OWN 401 (no X-Upstream-Status) still surfaces the key error", async () => {
  const adapter = createWebAdapter();
  adapter.gateway.setKey("test-key");
  await assert.rejects(
    withFetch(
      () => adapter.downloadDirect({ fileId: "c", url: "https://cdn.example/x.jpg", fileName: "x.jpg" }),
      async () => jsonResponse({ error: "Invalid access key" }, 401)
    ),
    /access key was rejected/i
  );
});

test("downloadDirect: gateway's OWN 503 (no X-Upstream-Status) still reports offline", async () => {
  const adapter = createWebAdapter();
  adapter.gateway.setKey("test-key");
  await assert.rejects(
    withFetch(
      () => adapter.downloadDirect({ fileId: "d", url: "https://cdn.example/x.jpg", fileName: "x.jpg" }),
      async () => jsonResponse({ error: "Downloader offline" }, 503)
    ),
    /offline/i
  );
});

// ── Sticker lane isolation (source-level; ffmpeg.wasm can't run under node) ──

/** Body of `function <name>(...) {  … }` at the adapter's 2-space indent. */
function fnBody(src, header) {
  const m = src.match(new RegExp(header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([\\s\\S]*?)\\n  \\}"));
  assert.ok(m, `${header} not found`);
  return m[1];
}
/** Body of a `async <name>() { … },` adapter method at its 4-space indent. */
function methodBody(src, name) {
  const m = src.match(new RegExp("async " + name + "\\(\\) \\{([\\s\\S]*?)\\n    \\}"));
  assert.ok(m, `${name} not found`);
  return m[1];
}

test("sticker transcodes run on a dedicated ffmpeg core, not the Convert core", () => {
  const src = readFileSync(WEB_SRC, "utf8");
  // A separate instance + loader exists for the sticker lane.
  assert.match(src, /let stickerFF = null;/, "stickerFF instance declared");
  assert.match(src, /async function ensureStickerFFmpeg\(\)/, "ensureStickerFFmpeg loader declared");
  // runTranscode acquires the sticker core, not the Convert core.
  assert.match(src, /const ff = await ensureStickerFFmpeg\(\);/, "runTranscode uses ensureStickerFFmpeg");

  // cancelTranscodes (sticker cancel) terminates the sticker core only.
  const cancelTranscodes = fnBody(src, "function cancelTranscodes(fileId) {");
  assert.match(cancelTranscodes, /stickerFF\.terminate\(\)/, "cancelTranscodes terminates stickerFF");
  assert.doesNotMatch(
    cancelTranscodes,
    /\bffmpeg\.terminate\(\)/,
    "cancelTranscodes must NOT terminate the Convert core"
  );

  // cancelConversion (Convert cancel) terminates the Convert core only.
  const cancelConversion = methodBody(src, "cancelConversion");
  assert.match(cancelConversion, /ffmpeg\.terminate\(\)/, "cancelConversion terminates the Convert core");
  assert.doesNotMatch(cancelConversion, /stickerFF/, "cancelConversion must NOT touch the sticker core");
});

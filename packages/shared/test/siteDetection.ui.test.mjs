// node:test suite for Discord source detection.
//
// The sticker/emoji resolver (core/discordMedia.js) already accepts emoji
// names of 1–32 chars (<:a:ID>), but the DownloadView "source" chip had its
// own SITE_PATTERNS regex stuck at \w{2,32}, so a single-char-named emoji
// resolved and downloaded yet showed "Unknown source". This asserts the two
// are back in parity: the live regex is read straight out of the component
// source and exercised, so it fails if the {2,32} bound ever returns.
//
// Run: node --test "packages/shared/test/*.test.mjs"

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { extractMediaRefs, isMediaRefToken } from "../src/core/discordMedia.js";

const DOWNLOAD_VIEW = fileURLToPath(
  new URL("../src/components/DownloadView.svelte", import.meta.url)
);

/** Pull the live Discord entry's regex literal out of SITE_PATTERNS. */
function discordSitePattern() {
  const src = readFileSync(DOWNLOAD_VIEW, "utf8");
  const m = src.match(/match:\s*\/([^\n]*?)\/i,\s*\r?\n\s*name:\s*"Discord"/);
  assert.ok(m, "Discord SITE_PATTERNS entry not found");
  return { body: m[1], regex: new RegExp(m[1], "i") };
}

const SNOW = "123456789012345678"; // a valid 18-digit snowflake

test("core resolver accepts a single-char emoji name (the canonical bound)", () => {
  assert.equal(extractMediaRefs(`<:a:${SNOW}>`).length, 1);
  assert.equal(extractMediaRefs(`<a:x:${SNOW}>`).length, 1);
  assert.ok(isMediaRefToken(`<:a:${SNOW}>`) !== false);
});

test("DownloadView chip regex matches a single-char emoji name", () => {
  const { regex } = discordSitePattern();
  assert.ok(regex.test(`<:a:${SNOW}>`), "static 1-char emoji");
  assert.ok(regex.test(`<a:x:${SNOW}>`), "animated 1-char emoji");
  assert.ok(regex.test(`<:emoji_name:${SNOW}>`), "multi-char emoji still matches");
  assert.ok(regex.test(SNOW), "bare snowflake id");
  assert.ok(regex.test("https://discord.com/channels/1/2/3"), "discord.com url");
});

test("DownloadView chip regex rejects a plainly non-Discord url", () => {
  const { regex } = discordSitePattern();
  assert.equal(regex.test("https://youtube.com/watch?v=abc"), false);
});

test("the {2,32} lower bound has not crept back in", () => {
  const { body } = discordSitePattern();
  assert.ok(body.includes("\\w{1,32}"), "emoji-name quantifier is \\w{1,32}");
  assert.ok(!body.includes("\\w{2,32}"), "regressed to \\w{2,32}");
});

// Stand-in for yt-dlp in the route tests. Behaviour is chosen by the URL path
// (or `v=` for YouTube URLs); state lives in $FAKE_YTDLP_STATE:
//   version          → printed by --version (default 2026.01.01)
//   args-<n>.json    → argv of each download run
//   pid-<slug>       → pid of a run that sleeps (cancel/timeout tests)
//   child-<slug>     → pid of a grandchild it spawned (process-group kill test)
// Download slugs beyond the default success: fail, lost, empty, slow, family,
// live (the !is_live skip line), huge (a finished file over the size cap),
// leak (an error quoting the --proxy URL), flood (writes to tmp/ until killed).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const state = process.env.FAKE_YTDLP_STATE || ".";
const FIXTURES = path.dirname(fileURLToPath(import.meta.url));

if (args.includes("--version")) {
  let v = "2026.01.01";
  try {
    v = fs.readFileSync(path.join(state, "version"), "utf8").trim();
  } catch {
    /* default */
  }
  process.stdout.write(`${v}\n`);
  process.exit(0);
}

const probe = args.includes("--dump-single-json");
const url = probe ? args[args.length - 1] : args[0];
const u = new URL(url);
const slug = u.searchParams.get("v") || u.pathname.replace(/^\//, "") || "root";
const withCookies = args.includes("--cookies");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg, code = 1) => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};

if (probe) {
  if (slug === "fail") fail("ERROR: Unsupported URL: " + url);
  if (slug === "lost" && withCookies) fail("ERROR: [youtube] lost: Requested format is not available. Use --list-formats");
  if (slug === "garbage") {
    process.stdout.write("this is not json");
    process.exit(0);
  }
  if (slug === "hang") {
    fs.writeFileSync(path.join(state, `pid-${slug}`), String(process.pid));
    await sleep(60_000);
  }
  const name = slug === "playlist" ? "probe-youtube-playlist.json" : "probe-youtube.json";
  process.stdout.write(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
  process.exit(0);
}

// ── download mode ──
const home = args[args.indexOf("--paths") + 1].replace(/^home:/, "");
let n = 0;
while (fs.existsSync(path.join(state, `args-${n}.json`))) n++;
fs.writeFileSync(path.join(state, `args-${n}.json`), JSON.stringify(args));

const say = (line) => process.stdout.write(line + "\n");

if (slug === "fail") fail("ERROR: [generic] Unsupported URL: " + url);
if (slug === "lost" && withCookies) {
  say("[youtube] lost: Downloading webpage");
  fail("ERROR: [youtube] lost: Requested format is not available. Use --list-formats for a list of available formats");
}
if (slug === "empty") {
  say("[info] empty: nothing");
  process.exit(0);
}
if (slug === "live") {
  // What yt-dlp prints when --match-filters "!is_live" skips the entry.
  say("[youtube] live: Downloading webpage");
  say("[download] Live Show does not pass filter (!is_live), skipping ..");
  process.exit(0);
}
if (slug === "huge") {
  // Finishes faster than any watchdog poll, but bigger than the size cap.
  fs.writeFileSync(path.join(home, "Huge.mp4"), Buffer.alloc(Number(process.env.FAKE_HUGE_BYTES || 200_000), 5));
  process.exit(0);
}
if (slug === "leak") {
  // An error line that quotes the proxy URL (with EGRESS_TOKEN in it).
  fail(`ERROR: [generic] leak: request via ${args[args.indexOf("--proxy") + 1]} failed`);
}
if (slug === "flood") {
  // A stream with no size up front that never ends: writes until killed.
  const tmp = args[args.lastIndexOf("--paths") + 1].replace(/^temp:/, "");
  fs.writeFileSync(path.join(state, `pid-${slug}`), String(process.pid));
  const fd = fs.openSync(path.join(tmp, "flood.mp4.part"), "a");
  const chunk = Buffer.alloc(64 * 1024, 9);
  say("[info] flood: Downloading 1 format(s)");
  for (;;) {
    fs.writeSync(fd, chunk);
    say("[download]   1.0% of ~ Unknown at 10.00MiB/s ETA Unknown");
    await sleep(5);
  }
}
if (slug === "slow" || slug === "family") {
  fs.writeFileSync(path.join(state, `pid-${slug}`), String(process.pid));
  if (slug === "family") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(path.join(state, `child-${slug}`), String(child.pid));
  }
  say("[info] slow: Downloading 1 format(s)");
  for (let i = 0; i < 600; i++) {
    say(`[download]  ${(i / 10).toFixed(1)}% of ~ 10.00MiB at 1.00MiB/s ETA 00:10`);
    await sleep(100);
  }
  process.exit(0);
}

// default: success with a progress trail, a main file and a smaller leftover
say(`[youtube] ${slug}: Downloading webpage`);
say(`[info] ${slug}: Downloading 1 format(s): 18`);
for (const p of ["0.0", "12.5", "50.0", "100"]) {
  say(`[download]  ${p}% of    5.00KiB at  1.00MiB/s ETA 00:00`);
  await sleep(20);
}
say('[Merger] Merging formats into "x"');
const fmt = args.includes("--audio-format") ? args[args.indexOf("--audio-format") + 1] : "mp4";
const title = slug === "unicode" ? "Zoë – ünïcode 🎉" : "Fake Title";
fs.writeFileSync(path.join(home, `${title}.${fmt}`), Buffer.alloc(5000, 7));
fs.writeFileSync(path.join(home, `${title}.webp`), Buffer.alloc(9000, 1)); // bigger, but not the expected ext
fs.writeFileSync(path.join(home, `${title}.${fmt}.part`), "partial"); // must be ignored
process.exit(0);

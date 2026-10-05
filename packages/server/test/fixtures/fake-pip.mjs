// Stand-in for `pip install -U yt-dlp[default]`: bumps the version the fake
// yt-dlp reports, unless $FAKE_YTDLP_STATE/pip-noop exists (already latest)
// or pip-fail exists (network error).

import fs from "node:fs";
import path from "node:path";

const state = process.env.FAKE_YTDLP_STATE || ".";
const args = process.argv.slice(2);
if (!(args.includes("install") && args.includes("--upgrade") && args.includes("yt-dlp[default]"))) {
  process.stderr.write(`unexpected pip args: ${args.join(" ")}\n`);
  process.exit(2);
}
if (fs.existsSync(path.join(state, "pip-fail"))) {
  process.stderr.write("ERROR: Could not find a version that satisfies the requirement yt-dlp\n");
  process.exit(1);
}
if (!fs.existsSync(path.join(state, "pip-noop"))) {
  fs.writeFileSync(path.join(state, "version"), "2026.09.30");
}
process.exit(0);

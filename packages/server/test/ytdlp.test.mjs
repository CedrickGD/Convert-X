// The expected values below are worked out by hand from
// packages/desktop/src-tauri/src/downloader.rs (build_video_selector,
// build_ytdlp_args, parse_ytdlp_progress, friendly_error,
// move_staging_outputs, title_from_path) — the web downloader must produce
// exactly what the desktop produces for the same request.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  FFMPEG_INPUT_ARGS,
  FFMPEG_INPUT_FORMATS,
  FFMPEG_INPUT_PROTOCOLS,
  LIVE_SKIPPED_RE,
  buildProbeArgs,
  buildServerYtdlpArgs,
  buildVideoSelector,
  buildYtdlpArgs,
  collectStagingFiles,
  expectedExts,
  formatElapsed,
  friendlyError,
  isSpotifyUrl,
  isYoutubeUrl,
  parseYtdlpProgress,
  pickPrimaryOutput,
  pushTailLine,
  serverFriendlyError,
  stripCookieArgs,
  titleFromPath,
  ytdlpLostFormats,
} from "../src/ytdlp.mjs";
import { tmpDir } from "./helpers.mjs";

const U = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
const OUT = "/data/jobs/j1/out";
const TMP = "/data/jobs/j1/tmp";
const FF = "/usr/bin";

const BASE = (tpl = "%(title)s.%(ext)s", url = U) => [
  url,
  "-o",
  tpl,
  "--paths",
  `home:${OUT}`,
  "--paths",
  `temp:${TMP}`,
  "--newline",
  "--no-warnings",
  "--no-colors",
  "--ffmpeg-location",
  FF,
  "--embed-metadata",
];

const opts = (o) => ({
  url: U,
  format: "mp4",
  quality: "best",
  playlistItems: null,
  noPlaylist: false,
  dedupeNames: false,
  cookiesPath: null,
  ...o,
});

describe("buildVideoSelector (Rust build_video_selector)", () => {
  const S = {
    mp4Best:
      "best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/bv*[ext=mp4]/bv*",
    webmBest:
      "best[ext=webm][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/bv*[ext=webm]+ba[ext=webm]/bv*+ba/bv*[ext=webm]/bv*",
    anyBest: "best[acodec!=none][vcodec!=none]/bv*+ba/bv*",
    mp4At: (h) =>
      `best[height<=${h}][ext=mp4][acodec!=none][vcodec!=none]/best[height<=${h}][acodec!=none][vcodec!=none]/bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/bv*[height<=${h}]+ba/bv*+ba/best[acodec!=none][vcodec!=none]/bv*[height<=${h}]/bv*`,
    webmAt: (h) =>
      `best[height<=${h}][ext=webm][acodec!=none][vcodec!=none]/best[height<=${h}][acodec!=none][vcodec!=none]/bv*[height<=${h}][ext=webm]+ba[ext=webm]/bv*[height<=${h}]+ba/bv*+ba/best[acodec!=none][vcodec!=none]/bv*[height<=${h}]/bv*`,
    anyAt: (h) =>
      `best[height<=${h}][acodec!=none][vcodec!=none]/bv*[height<=${h}]+ba/bv*+ba/best[acodec!=none][vcodec!=none]/bv*[height<=${h}]/bv*`,
  };

  const matrix = [];
  for (const q of ["best", "1080", "720", "480", "360", "", "2160"]) {
    const h = ["1080", "720", "480"].includes(q) ? q : null;
    matrix.push([q, "mp4", h ? S.mp4At(h) : S.mp4Best]);
    matrix.push([q, "webm", h ? S.webmAt(h) : S.webmBest]);
    for (const f of ["mkv", "mov", "avi", "whatever"]) matrix.push([q, f, h ? S.anyAt(h) : S.anyBest]);
  }
  for (const [q, f, want] of matrix) {
    it(`quality=${JSON.stringify(q)} format=${f}`, () => assert.equal(buildVideoSelector(q, f), want));
  }

  it("never ends a chain on a term that could pick audio only", () => {
    for (const [q, f] of matrix) {
      for (const term of buildVideoSelector(q, f).split("/")) {
        assert.ok(term.startsWith("bv*") || term.includes("[vcodec!=none]"), `${q}/${f}: ${term}`);
      }
    }
  });
});

describe("buildYtdlpArgs (Rust build_ytdlp_args)", () => {
  const sel = (q, f) => buildVideoSelector(q, f);
  const cases = [
    [
      "video mp4 best, defaults",
      opts(),
      [...BASE(), "--no-playlist", "--embed-thumbnail", "-f", sel("best", "mp4"), "--merge-output-format", "mp4"],
    ],
    [
      "video webm 720 + noPlaylist",
      opts({ format: "webm", quality: "720", noPlaylist: true }),
      [...BASE(), "--no-playlist", "--embed-thumbnail", "-f", sel("720", "webm"), "--merge-output-format", "webm"],
    ],
    [
      "video mkv 1080 + dedupe",
      opts({ format: "mkv", quality: "1080", dedupeNames: true }),
      [...BASE("%(title)s-%(id)s.%(ext)s"), "--no-playlist", "--embed-thumbnail", "-f", sel("1080", "mkv"), "--merge-output-format", "mkv"],
    ],
    [
      "audio mp3 + cookies + pinned item",
      opts({ format: "mp3", cookiesPath: "/data/jobs/j1/cookies.txt", playlistItems: "2" }),
      [
        ...BASE(),
        "--cookies",
        "/data/jobs/j1/cookies.txt",
        "--playlist-items",
        "2",
        "--embed-thumbnail",
        "-f",
        "bestaudio/best",
        "-x",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "0",
      ],
    ],
    ...["m4a", "wav", "flac", "ogg", "opus", "aac"].map((f) => [
      `audio ${f}`,
      opts({ format: f }),
      [...BASE(), "--no-playlist", "--embed-thumbnail", "-f", "bestaudio/best", "-x", "--audio-format", f, "--audio-quality", "0"],
    ]),
    [
      "image post: -f best, no thumbnail embed",
      opts({ format: "image", quality: "1080" }),
      [...BASE(), "--no-playlist", "-f", "best"],
    ],
    [
      "pinned playlist item wins over noPlaylist",
      opts({ format: "image", playlistItems: "1,3", noPlaylist: true }),
      [...BASE(), "--playlist-items", "1,3", "-f", "best"],
    ],
    [
      "blank cookies/items are ignored (Rust trims for the check, not the value)",
      opts({ cookiesPath: "   ", playlistItems: "  " }),
      [...BASE(), "--no-playlist", "--embed-thumbnail", "-f", sel("best", "mp4"), "--merge-output-format", "mp4"],
    ],
    [
      "unknown format falls back to mp4 at the requested quality",
      opts({ format: "gif", quality: "480" }),
      [...BASE(), "--no-playlist", "--embed-thumbnail", "-f", sel("480", "mp4"), "--merge-output-format", "mp4"],
    ],
    [
      "mov/avi merge into their own container",
      opts({ format: "avi", quality: "480" }),
      [...BASE(), "--no-playlist", "--embed-thumbnail", "-f", sel("480", "avi"), "--merge-output-format", "avi"],
    ],
  ];
  for (const [name, o, want] of cases) {
    it(name, () => assert.deepEqual(buildYtdlpArgs(o, OUT, TMP, FF), want));
  }
});

describe("server additions", () => {
  const PROXY = "http://convertx:egress-token-0123456789@egress:8899";
  const cfg = { ffmpegDir: FF, maxFilesizeBytes: 2147483648, egressProxyUrl: PROXY };
  const TAIL = [
    "--max-filesize",
    "2147483648",
    "--match-filters",
    "!is_live",
    "--downloader-args",
    "ffmpeg_i:-protocol_whitelist crypto,data,http,https,tcp,tls,httpproxy " +
      "-format_whitelist hls,dash,mpegts,mov,matroska,flv,aac,mp3,ac3,eac3,webvtt,ogg,wav,flac",
    "--proxy",
    PROXY,
  ];

  it("appends js runtime (YouTube only), size cap, live filter, ffmpeg whitelist and proxy; caps the title in bytes", () => {
    const yt = buildServerYtdlpArgs(opts(), OUT, TMP, cfg);
    const ported = buildYtdlpArgs(opts(), OUT, TMP, FF);
    assert.equal(yt[2], "%(title).180B.%(ext)s");
    assert.deepEqual(yt.slice(3, ported.length), ported.slice(3));
    assert.deepEqual(yt.slice(ported.length), ["--js-runtimes", "node", ...TAIL]);

    const other = buildServerYtdlpArgs(opts({ url: "https://vimeo.com/1", dedupeNames: true }), OUT, TMP, cfg);
    assert.equal(other[2], "%(title).180B-%(id)s.%(ext)s");
    assert.ok(!other.includes("--js-runtimes"));
    assert.deepEqual(other.slice(-TAIL.length), TAIL);
  });

  it("the ffmpeg input args parse the way yt-dlp's --downloader-args does", () => {
    // yt-dlp options.py: allowed keys r'ffmpeg_[io]\d*|<downloaders>', value
    // run through shlex.split; FFmpegFD asks for ('ffmpeg_i1', 'ffmpeg_i')
    // right before each '-i'.
    assert.match(FFMPEG_INPUT_ARGS, /^(?<key>ffmpeg_[io]\d*):(?<val>.*)$/s);
    const [key, val] = [FFMPEG_INPUT_ARGS.slice(0, FFMPEG_INPUT_ARGS.indexOf(":")), FFMPEG_INPUT_ARGS.slice(FFMPEG_INPUT_ARGS.indexOf(":") + 1)];
    assert.equal(key, "ffmpeg_i");
    assert.ok(!/["'\\]/.test(val), "no quoting, so shlex.split == whitespace split");
    const words = val.split(/\s+/);
    assert.deepEqual(words, ["-protocol_whitelist", FFMPEG_INPUT_PROTOCOLS, "-format_whitelist", FFMPEG_INPUT_FORMATS]);
    const list = FFMPEG_INPUT_PROTOCOLS.split(",");
    for (const needed of ["http", "https", "tcp", "tls", "httpproxy", "crypto", "data"]) assert.ok(list.includes(needed), needed);
    for (const banned of ["rtsp", "rtmp", "rtmps", "mms", "mmsh", "mmst", "udp", "rtp", "srt", "ftp", "file", "pipe", "unix", "gopher", "concat", "subfile"]) {
      assert.ok(!list.includes(banned), banned);
    }
    // RTSP/RTP/SAP/SDP are demuxers that open raw tcp/udp themselves.
    const formats = FFMPEG_INPUT_FORMATS.split(",");
    for (const needed of ["hls", "dash", "mpegts", "mov", "matroska", "aac", "webvtt"]) assert.ok(formats.includes(needed), needed);
    for (const banned of ["rtsp", "rtp", "sap", "sdp", "concat", "image2", "lavfi", "tee", "data"]) assert.ok(!formats.includes(banned), banned);
  });

  it("probe argv = the desktop probe argv + runtime/proxy before the URL", () => {
    const rustPrefix = ["--dump-single-json", "--no-warnings", "--skip-download", "--socket-timeout", "15", "--playlist-end", "50"];
    assert.deepEqual(buildProbeArgs("https://vimeo.com/1", { proxyUrl: "http://127.0.0.1:8899" }), [
      ...rustPrefix,
      "--proxy",
      "http://127.0.0.1:8899",
      "https://vimeo.com/1",
    ]);
    assert.deepEqual(buildProbeArgs(U, { cookiesPath: "/c.txt", proxyUrl: PROXY }), [
      ...rustPrefix,
      "--cookies",
      "/c.txt",
      "--js-runtimes",
      "node",
      "--proxy",
      PROXY,
      U,
    ]);
  });

  it("the lost-formats probe retry drops --cookies and its path (Rust filter + dedup)", () => {
    const args = buildProbeArgs(U, { cookiesPath: "/c.txt", proxyUrl: PROXY });
    const retry = stripCookieArgs(args, "/c.txt");
    assert.ok(!retry.includes("--cookies") && !retry.includes("/c.txt"));
    assert.equal(retry.at(-1), U);
    assert.equal(retry.length, args.length - 2);
  });
});

describe("parseYtdlpProgress (Rust parse_ytdlp_progress)", () => {
  const table = [
    ["[download]  45.3% of ~  10.00MiB at    1.00MiB/s ETA 00:05", [45.3, "downloading"]],
    ["[download] 100% of   10.00MiB in 00:00:05 at 2.0MiB/s", [100, "downloading"]],
    ["[download] 100.0% of 3.5MiB", [100, "downloading"]],
    ["   [download]   0.5% of 1GiB", [0.5, "downloading"]],
    ["[download]\t33.3% of x", [33.3, "downloading"]],
    ["[download] 150% of x", [100, "downloading"]],
    ["[download] 1e1% of x", [10, "downloading"]],
    ["[download] NaN% of x", [100, "downloading"]],
    ["[download]  50%", [50, "downloading"]],
    ["[download] Destination: /data/jobs/x/out/50% off.mp4", null],
    ["[download] Unknown% of x", null],
    ["[download] Downloading item 1 of 3", null],
    ["[download] /out/a.mp4 has already been downloaded", null],
    ["[Merger] Merging formats into \"/out/a.mp4\"", [99, "merging"]],
    ["[ExtractAudio] Destination: /out/a.mp3", [99, "merging"]],
    ["[info] jNQXAC9IVRw: Downloading 1 format(s): 399+251", [1, "fetching"]],
    ["[youtube] jNQXAC9IVRw: Downloading webpage", [1, "fetching"]],
    ["[generic] x: Requesting header", [1, "fetching"]],
    ["[twitter] 1: Downloading guest token", [1, "fetching"]],
    ["[Instagram] C0: Setting up session", [1, "fetching"]],
    ["[TikTok] 7: Downloading webpage", [1, "fetching"]],
    ["[vimeo] 76979871: Downloading webpage", null],
    ["[EmbedThumbnail] ffmpeg: Adding thumbnail", null],
    ["", null],
  ];
  for (const [line, want] of table) {
    it(JSON.stringify(line), () => assert.deepEqual(parseYtdlpProgress(line), want));
  }
});

describe("friendlyError (Rust friendly_error)", () => {
  const table = [
    ["ERROR: rate/request limit reached", /Spotify's free API quota/],
    ["Instagram: rate-limit reached or login required", /Instagram blocked the request/],
    ["login required instagram", /Instagram blocked the request/],
    ["ERROR: [youtube] x: Video unavailable", /This video is unavailable/],
    ["ERROR: Sign in to confirm your age", /requires sign-in or age verification/],
    ["This video is age-restricted", /requires sign-in/],
    ["ERROR: Unsupported URL: https://example.com", /This URL isn't supported/],
    ["ERROR: HTTP Error 403: Forbidden", /Access denied \(403\)/],
    ["ERROR: HTTP Error 404: Not Found", /URL not found \(404\)/],
    ["ERROR: Unable to extract uploader id", /Couldn't extract video info/],
    ["spotipy exploded", /Couldn't reach Spotify metadata/],
  ];
  for (const [detail, want] of table) {
    it(detail, () => assert.match(friendlyError(detail, 1), want));
  }
  it("falls back to the code + raw detail", () => {
    assert.equal(friendlyError("boom", 2), "Download failed (code 2): boom");
  });
  it("the server names egress-policy blocks before the generic 403 copy", () => {
    const tail =
      "ERROR: [generic] Unable to download webpage: ('Unable to connect to proxy', OSError('Tunnel connection failed: 403 Blocked by Convert-X egress policy'))";
    assert.match(serverFriendlyError(tail, 1), /private or local network address/);
    assert.equal(serverFriendlyError("ERROR: HTTP Error 403: Forbidden", 1), friendlyError("ERROR: HTTP Error 403: Forbidden", 1));
  });

  it("names non-http streams, a token mismatch and a missing egress proxy", () => {
    // ffmpeg names the refusal a few lines above the 3-line tail, so the
    // runner passes the whole stderr along. These are the real lines of the
    // smoke run (yt-dlp 2026.08.19 + ffmpeg, rtsp:// via the format whitelist).
    const ffTail =
      "Error opening input file rtsp://127.0.0.1:57250/stream. · Error opening input files: Invalid argument · ERROR: ffmpeg exited with code 4294967274";
    const ffStderr = [
      `[in#0 @ 000001ee39503b00] Format not on whitelist '${FFMPEG_INPUT_FORMATS}'`,
      "[in#0 @ 000001ee395031c0] Error opening input: Invalid argument",
      ...ffTail.split(" · "),
    ].join("\n");
    assert.match(serverFriendlyError(ffTail, 1, ffStderr), /protocol the web downloader doesn't fetch/);
    assert.match(serverFriendlyError(ffTail, 1), /^Download failed \(code 1\)/, "the tail alone doesn't say why");
    for (const tail of [
      "[rtmp @ 00000196b1f83d40] Protocol 'rtmp' not on whitelist 'crypto,data,http,https,tcp,tls,httpproxy'!",
      'ERROR: [generic] Unable to download webpage: Unsupported url scheme: "rtsp" (caused by UnsupportedRequest)',
      'ERROR: RTMP download detected but "rtmpdump" could not be run. Please install',
    ]) {
      assert.match(serverFriendlyError(tail, 1), /protocol the web downloader doesn't fetch/, tail);
    }
    // Real yt-dlp lines (smoke run): a wrong EGRESS_TOKEN, then a dead proxy.
    assert.match(
      serverFriendlyError(
        "ERROR: [youtube] jNQXAC9IVRw: Unable to download API page: ('Unable to connect to proxy', OSError('Tunnel connection failed: 407 Proxy Authentication Required')) (caused by ProxyError(\"('Unable to connect to proxy', OSError('Tunnel connection failed: 407 Proxy Authentication Required'))\"))",
        1,
      ),
      /EGRESS_TOKEN/,
    );
    assert.match(
      serverFriendlyError(
        "ERROR: [youtube] jNQXAC9IVRw: Unable to download API page: ('Unable to connect to proxy', NewConnectionError(\"HTTPSConnection(host='127.0.0.1', port=1): Failed to establish a new connection: [WinError 10061] No connection could be made\"))",
        1,
      ),
      /can't reach its egress proxy/,
    );
  });

  it("recognises yt-dlp's line for a live stream the match filter skipped", () => {
    assert.ok(LIVE_SKIPPED_RE.test("[download] Lofi Radio 24/7 does not pass filter (!is_live), skipping .."));
    assert.ok(!LIVE_SKIPPED_RE.test("[download] Clip does not pass filter (duration < 60), skipping .."));
  });
});

describe("staging outputs (Rust move_staging_outputs / collect_staging_files)", () => {
  it("skips yt-dlp temp artifacts and directories", () => {
    const dir = tmpDir();
    for (const f of ["a.mp4", "a.mp4.part", "b.YTDL", "c.tmp", "d.f137.mp4.part-Frag3", "e.webm"]) {
      fs.writeFileSync(path.join(dir, f), "x");
    }
    fs.mkdirSync(path.join(dir, "sub"));
    const names = collectStagingFiles(dir).map((p) => path.basename(p)).sort();
    assert.deepEqual(names, ["a.mp4", "e.webm"]);
    assert.deepEqual(collectStagingFiles(path.join(dir, "missing")), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("picks the largest file with an expected extension, else the largest overall", () => {
    const f = (p, size) => ({ path: `/o/${p}`, size });
    assert.equal(pickPrimaryOutput([f("a.mp4", 100), f("a.jpg", 900)], "mp4").path, "/o/a.mp4");
    assert.equal(pickPrimaryOutput([f("a.mp4", 100), f("a.jpg", 900)], "image").path, "/o/a.jpg");
    assert.equal(pickPrimaryOutput([f("a.MKV", 5), f("b.mp4", 4)], "mp4").path, "/o/a.MKV");
    assert.equal(pickPrimaryOutput([f("a.webm", 5), f("a.mp3", 4)], "mp3").path, "/o/a.mp3");
    assert.equal(pickPrimaryOutput([f("a.txt", 10), f("b.json", 20)], "mp4").path, "/o/b.json");
    // Unknown format expects video extensions (Rust expected_exts fallback).
    assert.equal(pickPrimaryOutput([f("a.mp3", 10), f("a.mp4", 1)], "gif").path, "/o/a.mp4");
    // max_by_key keeps the LAST maximum.
    assert.equal(pickPrimaryOutput([f("x.mp4", 5), f("y.mp4", 5)], "mp4").path, "/o/y.mp4");
    // A dotfile has no extension in Rust's Path::extension, so it never matches.
    assert.equal(pickPrimaryOutput([f(".mp4", 50), f("a.mp4", 1)], "mp4").path, "/o/a.mp4");
    assert.equal(pickPrimaryOutput([], "mp4"), null);
  });

  it("expectedExts mirrors the Rust lists", () => {
    assert.deepEqual(expectedExts("mp3"), ["mp3", "m4a", "wav", "flac", "ogg", "opus", "aac"]);
    assert.deepEqual(expectedExts("webm"), ["mp4", "mkv", "webm", "avi", "mov"]);
    assert.deepEqual(expectedExts("image"), ["jpg", "jpeg", "png", "webp", "gif", "heic"]);
    assert.deepEqual(expectedExts("zzz"), ["mp4", "mkv", "webm", "avi", "mov"]);
  });

  it("titleFromPath = file stem", () => {
    assert.equal(titleFromPath("/o/Me at the zoo.mp4"), "Me at the zoo");
    assert.equal(titleFromPath("/o/archive.tar.gz"), "archive.tar");
    assert.equal(titleFromPath("/o/.hidden"), ".hidden");
    assert.equal(titleFromPath("/o/noext"), "noext");
  });
});

describe("small predicates", () => {
  it("youtube / spotify / lost formats", () => {
    assert.equal(isYoutubeUrl("https://youtu.be/x"), true);
    assert.equal(isYoutubeUrl("https://m.YOUTUBE.com/watch?v=x"), true);
    assert.equal(isYoutubeUrl("https://vimeo.com/x"), false);
    assert.equal(isSpotifyUrl(" https://open.spotify.com/track/x"), true);
    assert.equal(isSpotifyUrl("spotify:track:x"), true);
    assert.equal(ytdlpLostFormats("ERROR: [youtube] x: Requested format is not available. Use --list-formats"), true);
    assert.equal(ytdlpLostFormats("ERROR: No video formats found!"), true);
    assert.equal(ytdlpLostFormats("ERROR: Video unavailable"), false);
  });

  it("pushTailLine keeps the last three non-empty lines", () => {
    const t = [];
    for (const l of ["a", "  ", "b", "c", " d "]) pushTailLine(t, l);
    assert.deepEqual(t, ["b", "c", "d"]);
  });

  it("formatElapsed is MM:SS", () => {
    assert.equal(formatElapsed(0), "00:00");
    assert.equal(formatElapsed(65_400), "01:05");
    assert.equal(formatElapsed(3600_000 * 2), "120:00");
  });
});

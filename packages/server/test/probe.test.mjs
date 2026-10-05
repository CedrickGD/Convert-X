// parseProbeJson on real yt-dlp 2026.08.19 output (trimmed to the fields the
// parser reads — see test/fixtures/probe-*.json), checked against what the
// desktop's parse_probe_json / classify_entry produce for the same JSON.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyEntry, parseProbeJson } from "../src/ytdlp.mjs";
import { fixture } from "./helpers.mjs";

const load = (name) => JSON.parse(fixture(name));

describe("parseProbeJson — real yt-dlp output", () => {
  it("YouTube single video", () => {
    const j = load("probe-youtube.json");
    assert.deepEqual(parseProbeJson(j), {
      kind: "single",
      title: "Me at the zoo",
      uploader: "jawed",
      thumbnail: j.thumbnail,
      entries: [
        {
          index: 1,
          title: "Me at the zoo",
          thumbnail: j.thumbnail,
          duration: 19,
          kind: "video",
          url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
          webpage_url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        },
      ],
    });
  });

  it("YouTube playlist → multi, thumbnail from the last thumbnails[] entry", () => {
    const j = load("probe-youtube-playlist.json");
    const r = parseProbeJson(j);
    assert.equal(r.kind, "multi");
    assert.equal(r.title, "AI Plays Flappy Bird - NEAT Python");
    assert.equal(r.uploader, "Tech With Tim");
    assert.equal(r.thumbnail, j.thumbnails.at(-1).url);
    assert.equal(r.entries.length, 3);
    assert.deepEqual(r.entries[1], {
      index: 2,
      title: "Python Flappy Bird AI Tutorial (with NEAT) - Moving Birds",
      thumbnail: j.entries[1].thumbnail,
      duration: 1106,
      kind: "video",
      // No `url` on a merged-format entry → webpage_url.
      url: "https://www.youtube.com/watch?v=ps55secj7iU",
      webpage_url: "https://www.youtube.com/watch?v=ps55secj7iU",
    });
    assert.deepEqual(
      r.entries.map((e) => e.index),
      [1, 2, 3],
    );
  });

  it("Vimeo: null acodec / null uploader_id are 'missing', not strings", () => {
    const r = parseProbeJson(load("probe-vimeo.json"));
    assert.equal(r.kind, "single");
    assert.equal(r.uploader, "Vimeo");
    assert.equal(r.entries[0].kind, "video");
    assert.equal(r.entries[0].duration, 62);
    assert.equal(r.entries[0].url, "https://player.vimeo.com/video/76979871");
  });

  it("SoundCloud: vcodec none + acodec → audio; url prefers webpage_url", () => {
    const r = parseProbeJson(load("probe-soundcloud.json"));
    assert.equal(r.entries[0].kind, "audio");
    assert.equal(r.entries[0].duration, 213.886);
    assert.equal(r.entries[0].url, "https://soundcloud.com/forss/flickermood");
    assert.equal(r.uploader, "Forss");
  });

  it("Imgur gifv: mp4 without codecs is video; page URL wins over media URL", () => {
    const r = parseProbeJson(load("probe-imgur-gifv.json"));
    assert.equal(r.entries[0].kind, "video");
    assert.equal(r.entries[0].url, "https://i.imgur.com/A61SaA1.gif");
    assert.equal(r.uploader, null);
    assert.equal(r.entries[0].duration, null);
  });

  it("generic direct link: unknown_video, no uploader, no thumbnail", () => {
    const r = parseProbeJson(load("probe-generic-direct.json"));
    assert.deepEqual(r, {
      kind: "single",
      title: "png",
      uploader: null,
      thumbnail: null,
      entries: [
        {
          index: 1,
          title: "png",
          thumbnail: null,
          duration: null,
          kind: "video",
          url: "https://httpbin.org/image/png",
          webpage_url: "https://httpbin.org/image/png",
        },
      ],
    });
  });

  it("carousel: images, a video, a codec-less still and a null entry", () => {
    const r = parseProbeJson(load("probe-synthetic-carousel.json"));
    assert.equal(r.kind, "multi");
    assert.equal(r.uploader, "someone"); // uploader/channel null → uploader_id
    assert.deepEqual(
      r.entries.map((e) => [e.index, e.title, e.kind, e.url, e.webpage_url, e.thumbnail]),
      [
        [1, "Video 1", "image", "https://scontent.cdninstagram.com/v/t51/1.jpg?stp=x", null, "https://scontent.cdninstagram.com/v/t51/1_big.jpg"],
        [
          2,
          "3100000000000000002",
          "video",
          "https://scontent.cdninstagram.com/v/t50/2.mp4?efg=x",
          "https://www.instagram.com/p/C0ffeeCarousel/?img_index=2",
          "https://scontent.cdninstagram.com/v/t51/2_cover.jpg",
        ],
        [3, "Item 3", "image", null, null, null],
        [4, "Item 4", "video", null, null, null],
      ],
    );
  });
});

describe("parseProbeJson — envelope edge cases", () => {
  it("a playlist with exactly one entry is presented as single, keeping the entry", () => {
    const r = parseProbeJson({ _type: "playlist", title: "P", entries: [{ title: "only", ext: "mp4", duration: 3 }] });
    assert.equal(r.kind, "single");
    assert.equal(r.title, "P");
    assert.equal(r.entries[0].title, "only");
  });

  it("a playlist without entries falls back to the top-level single", () => {
    const r = parseProbeJson({ _type: "playlist", title: "P", webpage_url: "https://x/p", entries: [] });
    assert.equal(r.kind, "single");
    assert.equal(r.entries[0].title, "P");
    assert.equal(r.entries[0].url, "https://x/p");
  });

  it("entries[] alone makes it a playlist; _type is case-insensitive", () => {
    assert.equal(parseProbeJson({ entries: [{}, {}] }).kind, "multi");
    assert.equal(parseProbeJson({ _type: "MULTI_VIDEO", entries: [{}, {}] }).kind, "multi");
  });

  it("missing title → Untitled; single url falls back to url, webpage_url to original_url", () => {
    const r = parseProbeJson({ url: "https://cdn/x.mp4", original_url: "https://site/x" });
    assert.equal(r.title, "Untitled");
    assert.equal(r.entries[0].url, "https://cdn/x.mp4");
    assert.equal(r.entries[0].webpage_url, "https://site/x");
  });

  it("non-string / non-number fields are ignored like serde's as_str/as_f64", () => {
    const r = parseProbeJson({ title: 5, uploader: ["x"], duration: "12", thumbnail: null, thumbnails: [{ url: 7 }, { nourl: 1 }] });
    assert.equal(r.title, "Untitled");
    assert.equal(r.uploader, null);
    assert.equal(r.thumbnail, null);
    assert.equal(r.entries[0].duration, null);
  });
});

describe("classifyEntry (Rust classify_entry)", () => {
  const table = [
    [{ vcodec: "none", acodec: "opus" }, "audio"],
    [{ vcodec: "NONE", acodec: "mp4a" }, "audio"],
    [{ vcodec: "none", acodec: "none", ext: "m4a" }, "video"],
    [{ vcodec: "none", acodec: "" }, "video"],
    [{ ext: "JPG" }, "image"],
    [{ ext: "png", duration: 0 }, "image"],
    [{ ext: "gif", duration: 2.5 }, "video"], // animated → has duration
    [{ ext: "heic", vcodec: "none" }, "image"],
    [{ ext: "webp", vcodec: "vp8", duration: 0 }, "image"],
    [{ ext: "mp4" }, "video"],
    [{}, "video"],
    [null, "video"],
  ];
  for (const [v, want] of table) {
    it(`${JSON.stringify(v)} → ${want}`, () => assert.equal(classifyEntry(v), want));
  }
});

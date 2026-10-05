// node:test suite for the dependency-free APNG encoder in
// src/lib/lottieRender.js (the half of the Lottie pipeline that needs no DOM).
//
// It decodes the encoder's output independently — chunk walk, CRC check via
// node:zlib, inflate + PNG un-filtering — and asserts the pixels round-trip
// exactly, the APNG control chunks are well-formed (sequence numbers, frame
// count, delays), and the core's sniffer recognises the file as APNG.
//
// Run: node --test "packages/shared/test/*.test.mjs"

import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { createApngEncoder, encodeApng } from "../src/lib/lottieRender.js";
import { sniffMedia } from "../src/core/discordMedia.js";

function readChunks(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks = [];
  let off = 8;
  while (off < png.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(...png.subarray(off + 4, off + 8));
    const data = png.subarray(off + 8, off + 8 + len);
    const crc = view.getUint32(off + 8 + len);
    assert.equal(crc, zlib.crc32(png.subarray(off + 4, off + 8 + len)), `CRC of ${type}`);
    chunks.push({ type, data });
    off += 12 + len;
  }
  assert.equal(off, png.length, "no trailing bytes");
  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilter(raw, w, h) {
  const stride = w * 4;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const ft = raw[y * (stride + 1)];
    assert.ok([0, 1, 2, 3, 4].includes(ft), "valid filter type");
    for (let x = 0; x < stride; x += 1) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= 4 ? out[y * stride + x - 4] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = y > 0 && x >= 4 ? out[(y - 1) * stride + x - 4] : 0;
      let pred = 0;
      if (ft === 1) pred = a;
      else if (ft === 2) pred = b;
      else if (ft === 3) pred = (a + b) >> 1;
      else if (ft === 4) pred = paeth(a, b, c);
      out[y * stride + x] = (v + pred) & 0xff;
    }
  }
  return out;
}

function frame(w, h, seed) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    px[i * 4] = (i * 37 + seed * 11) & 0xff;
    px[i * 4 + 1] = (i * 13 + seed * 71) & 0xff;
    px[i * 4 + 2] = (seed * 97) & 0xff;
    px[i * 4 + 3] = i % 5 === 0 ? 0 : (200 + seed) & 0xff; // some fully transparent pixels
  }
  return px;
}

test("encodeApng round-trips pixels and writes well-formed APNG control chunks", async () => {
  const w = 7;
  const h = 5;
  const frames = [frame(w, h, 1), frame(w, h, 2), frame(w, h, 3)];
  const png = await encodeApng(frames, { width: w, height: h, fps: 30 });

  const sn = sniffMedia(png);
  assert.deepEqual(sn, { format: "apng", animated: true, width: w, height: h });

  const chunks = readChunks(png);
  assert.deepEqual(
    chunks.map((c) => c.type),
    ["IHDR", "acTL", "fcTL", "IDAT", "fcTL", "fdAT", "fcTL", "fdAT", "IEND"]
  );

  const ihdr = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset, 13);
  assert.equal(ihdr.getUint32(0), w);
  assert.equal(ihdr.getUint32(4), h);
  assert.deepEqual([...chunks[0].data.subarray(8)], [8, 6, 0, 0, 0]);

  const actl = new DataView(chunks[1].data.buffer, chunks[1].data.byteOffset, 8);
  assert.equal(actl.getUint32(0), 3, "num_frames");
  assert.equal(actl.getUint32(4), 0, "num_plays = loop forever");

  // Sequence numbers run 0.. across fcTL and fdAT; IDAT has none.
  const seqs = [];
  let fi = 0;
  for (const c of chunks) {
    const v = new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength);
    if (c.type === "fcTL") {
      seqs.push(v.getUint32(0));
      assert.equal(v.getUint32(4), w);
      assert.equal(v.getUint32(8), h);
      assert.equal(v.getUint32(12), 0);
      assert.equal(v.getUint32(16), 0);
      assert.equal(v.getUint16(20), 1, "delay_num");
      assert.equal(v.getUint16(22), 30, "delay_den");
      assert.equal(c.data[24], 0, "dispose none");
      assert.equal(c.data[25], 0, "blend source");
    } else if (c.type === "IDAT" || c.type === "fdAT") {
      let z = c.data;
      if (c.type === "fdAT") {
        seqs.push(v.getUint32(0));
        z = c.data.subarray(4);
      }
      const raw = zlib.inflateSync(z);
      assert.deepEqual(unfilter(raw, w, h), new Uint8Array(frames[fi].buffer), `frame ${fi} pixels`);
      fi += 1;
    }
  }
  assert.deepEqual(seqs, [0, 1, 2, 3, 4]);
  assert.equal(fi, 3);
});

test("a single-frame APNG is still a valid animation of one frame", async () => {
  const png = await encodeApng([frame(3, 3, 9)], { width: 3, height: 3, fps: 24 });
  const chunks = readChunks(png);
  assert.deepEqual(chunks.map((c) => c.type), ["IHDR", "acTL", "fcTL", "IDAT", "IEND"]);
  const fctl = new DataView(chunks[2].data.buffer, chunks[2].data.byteOffset, 26);
  assert.equal(fctl.getUint16(22), 24);
});

test("non-integer fps falls back to a millisecond delay", async () => {
  const png = await encodeApng([frame(2, 2, 1), frame(2, 2, 2)], { width: 2, height: 2, fps: 29.97 });
  const fctl = readChunks(png).find((c) => c.type === "fcTL");
  const v = new DataView(fctl.data.buffer, fctl.data.byteOffset, 26);
  assert.equal(v.getUint16(20), 33);
  assert.equal(v.getUint16(22), 1000);
});

test("encoder rejects wrong frame sizes and an incomplete animation", async () => {
  const enc = createApngEncoder({ width: 4, height: 4, fps: 30, numFrames: 2 });
  await assert.rejects(enc.addFrame(new Uint8ClampedArray(4 * 4 * 4 - 1)), /wrong size/);
  await enc.addFrame(frame(4, 4, 1));
  assert.equal(enc.framesWritten, 1);
  assert.throws(() => enc.finish(), /declared 2 frames but got 1/);
  await enc.addFrame(frame(4, 4, 2));
  await assert.rejects(enc.addFrame(frame(4, 4, 3)), /already has every declared frame/);
  assert.ok(enc.finish().length > 0);
  assert.throws(() => createApngEncoder({ width: 0, height: 4, numFrames: 1 }), /positive/);
  assert.throws(() => createApngEncoder({ width: 4, height: 4, numFrames: 0 }), /at least one frame/);
});

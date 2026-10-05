/**
 * Lottie → APNG / PNG rendering for the Discord sticker stealer.
 *
 * FFmpeg cannot read Lottie JSON, so Lottie stickers are rasterised here
 * first: lottie-web (lazy-loaded, canvas renderer, light build — no
 * expression `eval`) draws each output frame onto a detached canvas and a
 * small dependency-free APNG encoder packs the RGBA frames. The resulting
 * APNG then goes through the normal ffmpeg attempt ladder as if the source
 * had been an animated PNG (`-f apng`).
 *
 * Runs in any modern browser engine (web build, Tauri's WebView2). Needs
 * `document` + canvas for rendering; the encoder half (`encodeApng`) only
 * needs CompressionStream, so it also runs under Node 22 for tests.
 */

let lottiePromise = null;

/** Lazy-load the canvas-only light build of lottie-web (one shared copy). */
function loadLottie() {
  if (!lottiePromise) {
    lottiePromise = import("lottie-web/build/player/esm/lottie_light_canvas.min.js")
      .then((m) => m.default || m)
      .catch((e) => {
        // Let a later call retry (e.g. a transient chunk-load failure).
        lottiePromise = null;
        throw e;
      });
  }
  return lottiePromise;
}

// ---------------------------------------------------------------------------
// PNG / APNG encoding
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(view, off, value) {
  view.setUint32(off, value >>> 0, false);
}

/** One PNG chunk: length + type + data + CRC(type + data). */
function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  u32(view, 0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  u32(view, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** zlib (RFC 1950) — exactly what IDAT/fdAT carry. */
async function zlibDeflate(bytes) {
  if (typeof CompressionStream !== "function") {
    throw new Error("This browser can't encode animated PNGs (no CompressionStream).");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Apply PNG scanline filters to straight-alpha RGBA8 pixels. Each row picks
 * the filter (None/Sub/Up/Paeth) with the smallest sum of absolute signed
 * residuals — the standard libpng heuristic, a big win for zlib on flat
 * vector art like stickers.
 */
function filterRgba(rgba, width, height) {
  const stride = width * 4;
  const out = new Uint8Array(height * (stride + 1));
  const cand = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    const prev = y > 0 ? row - stride : -1;
    const scores = [0, 0, 0, 0];
    for (let x = 0; x < stride; x += 1) {
      const cur = rgba[row + x];
      const left = x >= 4 ? rgba[row + x - 4] : 0;
      const up = prev >= 0 ? rgba[prev + x] : 0;
      const upLeft = prev >= 0 && x >= 4 ? rgba[prev + x - 4] : 0;
      const v0 = cur;
      const v1 = (cur - left) & 0xff;
      const v2 = (cur - up) & 0xff;
      const v3 = (cur - paeth(left, up, upLeft)) & 0xff;
      cand[0][x] = v0;
      cand[1][x] = v1;
      cand[2][x] = v2;
      cand[3][x] = v3;
      scores[0] += v0 < 128 ? v0 : 256 - v0;
      scores[1] += v1 < 128 ? v1 : 256 - v1;
      scores[2] += v2 < 128 ? v2 : 256 - v2;
      scores[3] += v3 < 128 ? v3 : 256 - v3;
    }
    let best = 0;
    for (let f = 1; f < 4; f += 1) if (scores[f] < scores[best]) best = f;
    const at = y * (stride + 1);
    out[at] = best === 3 ? 4 : best; // PNG filter ids: 0 None, 1 Sub, 2 Up, 4 Paeth
    out.set(cand[best], at + 1);
  }
  return out;
}

function ihdr(width, height) {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  u32(view, 0, width);
  u32(view, 4, height);
  data[8] = 8; // bit depth
  data[9] = 6; // colour type: RGBA
  data[10] = 0; // deflate
  data[11] = 0; // adaptive filtering
  data[12] = 0; // no interlace
  return pngChunk("IHDR", data);
}

/** Frame delay as an exact-ish fraction of a second (fcTL delay_num/den). */
function frameDelay(fps) {
  const f = Number(fps) > 0 ? Number(fps) : 30;
  if (Number.isInteger(f) && f <= 0xffff) return [1, f];
  return [Math.max(1, Math.round(1000 / f)), 1000];
}

/**
 * Incremental APNG writer. `addFrame` takes straight-alpha RGBA8 pixels of
 * exactly width×height; frames are filtered and deflated one at a time so a
 * long animation never holds every raw frame in memory. Every frame covers
 * the full canvas with blend_op SOURCE, so dispose_op NONE is exact.
 */
export function createApngEncoder({ width, height, fps = 30, numFrames, numPlays = 0 }) {
  if (!(width > 0 && height > 0)) throw new Error("APNG size must be positive.");
  if (!(numFrames > 0)) throw new Error("APNG needs at least one frame.");
  const [delayNum, delayDen] = frameDelay(fps);
  const parts = [PNG_SIGNATURE, ihdr(width, height)];
  const actl = new Uint8Array(8);
  const actlView = new DataView(actl.buffer);
  u32(actlView, 0, numFrames);
  u32(actlView, 4, numPlays);
  parts.push(pngChunk("acTL", actl));

  let seq = 0;
  let written = 0;

  return {
    async addFrame(rgba) {
      if (written >= numFrames) throw new Error("APNG already has every declared frame.");
      if (!rgba || rgba.length !== width * height * 4) {
        throw new Error("APNG frame has the wrong size.");
      }
      const fctl = new Uint8Array(26);
      const fv = new DataView(fctl.buffer);
      u32(fv, 0, seq);
      seq += 1;
      u32(fv, 4, width);
      u32(fv, 8, height);
      u32(fv, 12, 0);
      u32(fv, 16, 0);
      fv.setUint16(20, delayNum, false);
      fv.setUint16(22, delayDen, false);
      fctl[24] = 0; // dispose_op: none
      fctl[25] = 0; // blend_op: source
      parts.push(pngChunk("fcTL", fctl));

      const z = await zlibDeflate(filterRgba(rgba, width, height));
      if (written === 0) {
        parts.push(pngChunk("IDAT", z));
      } else {
        const fdat = new Uint8Array(4 + z.length);
        u32(new DataView(fdat.buffer), 0, seq);
        seq += 1;
        fdat.set(z, 4);
        parts.push(pngChunk("fdAT", fdat));
      }
      written += 1;
    },
    get framesWritten() {
      return written;
    },
    finish() {
      if (written !== numFrames) {
        throw new Error(`APNG declared ${numFrames} frames but got ${written}.`);
      }
      parts.push(pngChunk("IEND", new Uint8Array(0)));
      let total = 0;
      for (const p of parts) total += p.length;
      const out = new Uint8Array(total);
      let off = 0;
      for (const p of parts) {
        out.set(p, off);
        off += p.length;
      }
      return out;
    },
  };
}

/** Encode an array of RGBA frames into one APNG (convenience wrapper). */
export async function encodeApng(frames, { width, height, fps = 30, numPlays = 0 }) {
  const enc = createApngEncoder({ width, height, fps, numFrames: frames.length, numPlays });
  for (const f of frames) await enc.addFrame(f);
  return enc.finish();
}

// ---------------------------------------------------------------------------
// Lottie rendering
// ---------------------------------------------------------------------------

function parseLottie(jsonText) {
  let data;
  try {
    data = typeof jsonText === "string" ? JSON.parse(jsonText) : JSON.parse(JSON.stringify(jsonText));
  } catch {
    throw new Error("That Lottie sticker file is damaged.");
  }
  const fr = Number(data?.fr);
  const ip = Number(data?.ip);
  const op = Number(data?.op);
  if (!data || !Array.isArray(data.layers) || !(fr > 0) || !Number.isFinite(ip) || !(op > ip)) {
    throw new Error("That Lottie sticker file is damaged.");
  }
  return { data, fr, ip, op };
}

function abortError() {
  const e = new Error("Cancelled");
  e.name = "AbortError";
  e.cancelled = true;
  return e;
}

/**
 * Mount a Lottie animation on a detached size×size canvas and resolve once
 * lottie-web has finished its own setup. The caller must `destroy()` it.
 */
async function mountAnimation(data, size) {
  if (typeof document === "undefined") {
    throw new Error("Lottie stickers can only be rendered in the app.");
  }
  const lottie = await loadLottie();
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Couldn't create a drawing surface for the Lottie sticker.");

  const anim = lottie.loadAnimation({
    renderer: "canvas",
    loop: false,
    autoplay: false,
    animationData: data,
    rendererSettings: {
      context: ctx,
      clearCanvas: true,
      preserveAspectRatio: "xMidYMid meet",
    },
  });

  if (!anim.isLoaded) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The Lottie sticker took too long to load.")), 15000);
      anim.addEventListener("DOMLoaded", () => {
        clearTimeout(timer);
        resolve();
      });
      anim.addEventListener("data_failed", () => {
        clearTimeout(timer);
        reject(new Error("That Lottie sticker file is damaged."));
      });
    });
  }
  return { anim, canvas, ctx };
}

function snapshot(ctx, size) {
  return ctx.getImageData(0, 0, size, size).data;
}

/**
 * Render Lottie JSON to an animated PNG (Uint8Array).
 *
 * opts: { size=320, fps=30, maxSeconds=null, signal?, onProgress?(0..1) }.
 * The output is size×size with the animation letterboxed (transparent) in
 * the middle, plays forever, and is cut at `maxSeconds` when set.
 */
export async function renderLottieToApng(jsonText, opts = {}) {
  const size = Math.max(16, Math.min(1024, Math.round(opts.size || 320)));
  const fps = opts.fps > 0 ? opts.fps : 30;
  const { data, fr, ip, op } = parseLottie(jsonText);
  if (opts.signal?.aborted) throw abortError();

  let seconds = (op - ip) / fr;
  if (opts.maxSeconds > 0) seconds = Math.min(seconds, opts.maxSeconds);
  const totalLottieFrames = op - ip;
  const numFrames = Math.max(1, Math.min(1800, Math.round(seconds * fps)));

  const { anim, ctx } = await mountAnimation(data, size);
  try {
    const enc = createApngEncoder({ width: size, height: size, fps, numFrames });
    for (let k = 0; k < numFrames; k += 1) {
      if (opts.signal?.aborted) throw abortError();
      // goToAndStop(frame, true) is relative to the first frame (ip).
      const frame = Math.min(totalLottieFrames - 0.001, (k * fr) / fps);
      anim.goToAndStop(frame, true);
      await enc.addFrame(snapshot(ctx, size));
      if (typeof opts.onProgress === "function") {
        try {
          opts.onProgress((k + 1) / numFrames);
        } catch {
          // A broken progress callback must not break the render.
        }
      }
    }
    return enc.finish();
  } finally {
    try {
      anim.destroy();
    } catch {
      // ignore
    }
  }
}

/**
 * A still PNG preview of a Lottie animation. Uses the first frame unless it
 * is fully transparent (many stickers fade in), then the middle one.
 */
export async function renderLottiePoster(jsonText, size = 256) {
  const px = Math.max(16, Math.min(1024, Math.round(size)));
  const { data, ip, op } = parseLottie(jsonText);
  const { anim, canvas, ctx } = await mountAnimation(data, px);
  try {
    anim.goToAndStop(0, true);
    const first = snapshot(ctx, px);
    let visible = false;
    for (let i = 3; i < first.length; i += 4) {
      if (first[i] !== 0) {
        visible = true;
        break;
      }
    }
    if (!visible) anim.goToAndStop((op - ip) / 2, true);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't draw the Lottie preview."))), "image/png");
    });
  } finally {
    try {
      anim.destroy();
    } catch {
      // ignore
    }
  }
}

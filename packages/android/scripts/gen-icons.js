#!/usr/bin/env node
/**
 * Regenerate every Android raster icon from the vector source of truth.
 *
 * The source SVGs live in the DESKTOP package (they're shared with the Tauri
 * icon set) and are described by `icon-manifest.json`:
 *
 *   source-cx.svg      full plate  — dark rounded plate + silver CX monogram
 *   source-cx-fg.svg   glyph only  — for the adaptive-icon FOREGROUND layer,
 *                                    with the knockout gap painted in the
 *                                    layer's background colour (transparency
 *                                    would let the C show through the x).
 *
 * Why this script exists: before it, the PNGs were produced ad-hoc. The result
 * was every `drawable-<dpi>` splashscreen_logo.png silently keeping the
 * v0.6.16 green-X art through TWO subsequent icon redesigns, and
 * `mipmap-hdpi/ic_launcher.png` landing at 49x49 instead of 72x72. Everything
 * below is derived, so a future redesign only has to touch the SVGs and
 * re-run this.
 *
 * Usage:
 *   node scripts/gen-icons.js            # write files
 *   node scripts/gen-icons.js --check    # verify only, non-zero exit on drift
 *
 * Requires `sharp` (dev-only, not a runtime dependency of the app):
 *   npm i -D sharp
 */
const fs = require('fs');
const path = require('path');

let sharp;
try {
  sharp = require('sharp');
} catch {
  // Allow an out-of-tree sharp (e.g. a scratch install) via SHARP_PATH so the
  // RN package doesn't have to carry a native dep just to redraw icons.
  try {
    sharp = require(process.env.SHARP_PATH || 'sharp');
  } catch {
    console.error('gen-icons needs sharp.  npm i -D sharp   (or set SHARP_PATH)');
    process.exit(1);
  }
}

const ROOT = path.join(__dirname, '..');
const ICONS = path.join(ROOT, '..', 'desktop', 'src-tauri', 'icons');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
const ASSETS = path.join(ROOT, 'assets');

const manifest = JSON.parse(
  fs.readFileSync(path.join(ICONS, 'icon-manifest.json'), 'utf8')
);
const PLATE_SVG = fs.readFileSync(path.join(ICONS, manifest.default), 'utf8');
const FG_SVG = fs.readFileSync(path.join(ICONS, manifest.android_fg), 'utf8');

// The splash screen sits on @color/splashscreen_background, not on the icon
// plate, so the foreground's knockout gap has to be repainted to match or it
// shows up as a lighter seam through the glyph.
const SPLASH_BG = '#0a0a0a';
const ICON_BG = manifest.bg_color; // mirrors @color/iconBackground

/**
 * The adaptive icon's background is a flat colour declared in THREE places
 * that must agree: the manifest (which tints the knockout gap baked into the
 * foreground PNGs), res/values/colors.xml (what the launcher actually paints),
 * and app.json (what `expo prebuild` would regenerate colors.xml from). If
 * they drift, the knockout stops matching the background and a visible seam
 * appears through the glyph. Fail loudly rather than emit a broken icon.
 */
function assertBackgroundInSync() {
  const norm = (c) => String(c || '').trim().toLowerCase();
  const colorsXml = fs.readFileSync(
    path.join(RES, 'values', 'colors.xml'),
    'utf8'
  );
  const m = colorsXml.match(/<color name="iconBackground">\s*([^<]+)</);
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  const declared = appJson.expo?.android?.adaptiveIcon?.backgroundColor;
  const problems = [];
  if (!m || norm(m[1]) !== norm(ICON_BG)) {
    problems.push(
      `res/values/colors.xml @iconBackground is ${m ? m[1].trim() : '(missing)'}, expected ${ICON_BG}`
    );
  }
  if (norm(declared) !== norm(ICON_BG)) {
    problems.push(
      `app.json expo.android.adaptiveIcon.backgroundColor is ${declared}, expected ${ICON_BG}`
    );
  }
  if (problems.length) {
    console.error(`Background colour out of sync with ${manifest.default}'s manifest:`);
    problems.forEach((p) => console.error('  ' + p));
    process.exit(1);
  }
}

/** Fraction of the fg SVG's 1024 canvas actually covered by the glyph. */
const GLYPH_EXTENT = 0.637;

/**
 * Adaptive-icon safe zone. The foreground layer is a 108dp canvas but the
 * launcher only guarantees the inner 66dp circle survives masking — and One UI
 * masks to an aggressive squircle. The raw SVG draws the glyph at a
 * circumscribed diameter of ~84% of the canvas, so the C's top-left corner and
 * the x's lower-right arm were being sliced flat by the mask on device.
 * `icon-manifest.json` already declared the intended `android_fg_scale` (62,
 * i.e. essentially exactly the 66/108 = 61.1% safe circle) — it just was never
 * applied to the render. Fit the glyph's CIRCUMSCRIBED circle to that, since
 * the corners are what clip, not the bounding box.
 */
const FG_SAFE_DIAMETER = (manifest.android_fg_scale || 62) / 100;

const DENSITIES = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
/** Legacy pre-API-26 launcher icon: 48dp. */
const LEGACY = [48, 72, 96, 144, 192];
/** Adaptive-icon layer: 108dp canvas (only the inner 72dp is guaranteed visible). */
const ADAPTIVE = [108, 162, 216, 324, 432];
/** Android 12+ splash icon canvas: 288dp, inner ~2/3 is the safe zone. */
const SPLASH = [288, 432, 576, 864, 1152];
/**
 * How much of the splash canvas the glyph should cover. The Android 12 splash
 * masks the drawable to a circle, so the glyph has to stay well inside — this
 * matches the visual weight of the logo it replaces.
 */
const SPLASH_COVERAGE = 0.52;

const written = [];
const drifted = [];
const CHECK = process.argv.includes('--check');

/** Rasterise an SVG string at its native size by pinning width/height. */
function render(svg, size) {
  const pinned = svg
    .replace(/\bwidth="\d+"/, `width="${size}"`)
    .replace(/\bheight="\d+"/, `height="${size}"`);
  return sharp(Buffer.from(pinned), { density: 384 })
    .resize(size, size, { fit: 'fill' })
    .png()
    .toBuffer();
}

async function emit(file, buf) {
  const rel = path.relative(ROOT, file);
  const same = fs.existsSync(file) && fs.readFileSync(file).equals(buf);
  if (same) return;
  if (CHECK) {
    drifted.push(rel);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  written.push(`${rel}  (${buf.length} B)`);
}

/** Full plate, optionally masked to a circle for ic_launcher_round. */
async function plate(size, round) {
  const base = await render(PLATE_SVG, size);
  if (!round) return base;
  const mask = Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
      `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`
  );
  return sharp(base)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

let measuredDiameter = null;
/**
 * Circumscribed diameter of the VISIBLE (silver) art, as a fraction of the
 * canvas. Measured by rendering with the knockout dropped — the knockout is
 * painted in the layer's background colour, so it is invisible on device and
 * must not drag the measurement outward.
 */
async function glyphDiameter() {
  if (measuredDiameter != null) return measuredDiameter;
  const probe = FG_SVG.split(ICON_BG).join('none');
  const buf = await render(probe, 1024);
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cx = info.width / 2;
  const cy = info.height / 2;
  let max = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + info.channels - 1] > 8) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const r = dx * dx + dy * dy;
        if (r > max) max = r;
      }
    }
  }
  measuredDiameter = (2 * Math.sqrt(max)) / info.width;
  return measuredDiameter;
}

/**
 * Glyph on transparency, knockout repainted to `bg`, padded to `size`.
 * `opts.fitDiameter` scales the glyph so its circumscribed circle hits that
 * fraction of the canvas (mask-safety); `opts.coverage` scales by bounding box.
 */
async function glyph(size, bg, opts = {}) {
  const svg = FG_SVG.split(ICON_BG).join(bg);
  const { coverage, fitDiameter } = opts;
  let scale = null;
  if (fitDiameter != null) scale = fitDiameter / (await glyphDiameter());
  else if (coverage != null) scale = coverage / GLYPH_EXTENT;
  if (scale == null) return render(svg, size);
  const inner = Math.round(size * scale);
  const buf = await render(svg, inner);
  const left = Math.floor((size - inner) / 2);
  const top = Math.floor((size - inner) / 2);
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: buf, left, top }])
    .png()
    .toBuffer();
}

(async () => {
  assertBackgroundInSync();

  for (let i = 0; i < DENSITIES.length; i++) {
    const d = DENSITIES[i];
    await emit(
      path.join(RES, `mipmap-${d}`, 'ic_launcher.png'),
      await plate(LEGACY[i], false)
    );
    await emit(
      path.join(RES, `mipmap-${d}`, 'ic_launcher_round.png'),
      await plate(LEGACY[i], true)
    );
    await emit(
      path.join(RES, `mipmap-${d}`, 'ic_launcher_foreground.png'),
      await glyph(ADAPTIVE[i], ICON_BG, { fitDiameter: FG_SAFE_DIAMETER })
    );
    await emit(
      path.join(RES, `drawable-${d}`, 'splashscreen_logo.png'),
      await glyph(SPLASH[i], SPLASH_BG, { coverage: SPLASH_COVERAGE })
    );
  }

  // Expo `prebuild` sources: these are what regenerates res/ if the native
  // project is ever re-templated, so they must carry the same art at full res.
  await emit(path.join(ASSETS, 'icon.png'), await plate(1024, false));
  await emit(
    path.join(ASSETS, 'adaptive-icon.png'),
    await glyph(1024, ICON_BG, { fitDiameter: FG_SAFE_DIAMETER })
  );
  await emit(
    path.join(ASSETS, 'splash-icon.png'),
    await glyph(1024, SPLASH_BG, { coverage: SPLASH_COVERAGE })
  );
  await emit(path.join(ASSETS, 'favicon.png'), await plate(48, false));

  if (CHECK) {
    if (drifted.length) {
      console.error('Icons out of date vs the SVG sources:');
      drifted.forEach((f) => console.error('  ' + f));
      console.error('Run: node scripts/gen-icons.js');
      process.exit(1);
    }
    console.log('Icons are up to date.');
    return;
  }
  if (!written.length) {
    console.log('Icons already up to date — nothing written.');
    return;
  }
  console.log(`Wrote ${written.length} file(s):`);
  written.forEach((f) => console.log('  ' + f));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

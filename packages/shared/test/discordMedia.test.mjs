// node:test suite for the shared Discord media core.
//
// It runs every assertion against BOTH implementations — the canonical
// packages/shared/src/core/discordMedia.js and its line-for-line TypeScript
// port packages/android/src/lib/discordMedia.ts (imported directly; Node 22
// strips the types) — and adds a parity suite asserting the two expose the
// same names and produce identical output on a battery of vectors.
//
// Run: npm test (in packages/shared)

import test from 'node:test';
import assert from 'node:assert/strict';

// The .ts port lives in a package whose package.json has no "type":"module";
// swallow the one-off MODULE_TYPELESS warning Node emits while loading it so
// the test output stays clean. Register the filter BEFORE the dynamic import.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w && (w.name === 'MODULE_TYPELESS_PACKAGE_JSON' || /TYPELESS_PACKAGE_JSON/.test(String(w.message || '')))) return;
  // eslint-disable-next-line no-console
  console.warn(w);
});

const JS = await import('../src/core/discordMedia.js');
const TS = await import('../../android/src/lib/discordMedia.ts');

const MODULES = [['js', JS], ['ts', TS]];

// ── byte-array builders (synthetic headers) ──────────────────────────────────

function flat(parts) {
  const arr = [];
  for (const p of parts) {
    if (typeof p === 'string') for (let i = 0; i < p.length; i += 1) arr.push(p.charCodeAt(i) & 0xff);
    else if (Array.isArray(p)) for (const b of p) arr.push(b & 0xff);
    else arr.push(p & 0xff);
  }
  return arr;
}
function bytes(...parts) { return Uint8Array.from(flat(parts)); }
const u32be = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16be = (n) => [(n >>> 8) & 0xff, n & 0xff];
const u32le = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u16le = (n) => [n & 0xff, (n >>> 8) & 0xff];
const u24le = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function makePng(w, h, apng) {
  const parts = [PNG_SIG, u32be(13), 'IHDR', u32be(w), u32be(h), [8, 6, 0, 0, 0], u32be(0)];
  if (apng) parts.push(u32be(8), 'acTL', u32be(2), u32be(0), u32be(0));
  parts.push(u32be(0), 'IDAT', u32be(0), u32be(0), 'IEND', u32be(0));
  return bytes(...parts);
}
function makeGif(w, h, opts) {
  const o = opts || {};
  const parts = ['GIF89a', u16le(w), u16le(h), [0x00, 0x00, 0x00]];
  if (o.netscape) parts.push([0x21, 0xff, 0x0b], 'NETSCAPE2.0', [0x03, 0x01, 0x00, 0x00], [0x00]);
  const frames = o.frames || 1;
  for (let i = 0; i < frames; i += 1) {
    parts.push([0x2c], u16le(0), u16le(0), u16le(w), u16le(h), [0x00], [0x02], [0x00]);
  }
  parts.push([0x3b]);
  return bytes(...parts);
}
function makeWebpVP8X(w, h, animated) {
  const chunk = ['VP8X', u32le(10), [animated ? 0x12 : 0x10], [0, 0, 0], u24le(w - 1), u24le(h - 1)];
  const chunkLen = flat(chunk).length;
  return bytes('RIFF', u32le(4 + chunkLen), 'WEBP', ...chunk);
}
function makeJpeg(w, h) {
  return bytes([0xff, 0xd8, 0xff, 0xc0], u16be(17), [8], u16be(h), u16be(w), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], [0xff, 0xd9]);
}
// A GIF with no NETSCAPE2.0 loop extension whose FIRST frame alone is
// `firstFrameBytes` of LZW sub-blocks — bigger than the 256 KB sniff prefix, so
// a prefix sniff cannot reach frame 2 and reports animated:null.
function makeBigGif(frames, firstFrameBytes) {
  const blocks = Math.ceil(firstFrameBytes / 255);
  const out = new Uint8Array(13 + 11 + blocks * 256 + 1 + (frames - 1) * 12 + 1);
  out.set(flat(['GIF89a', u16le(64), u16le(64), [0x00, 0x00, 0x00]]), 0);
  let o = 13;
  out.set(flat([[0x2c], u16le(0), u16le(0), u16le(64), u16le(64), [0x00], [0x02]]), o);
  o += 11;
  for (let i = 0; i < blocks; i += 1) { out[o] = 0xff; o += 256; } // 255-byte sub-blocks of zeros
  out[o] = 0x00; o += 1;
  for (let f = 1; f < frames; f += 1) {
    out.set(flat([[0x2c], u16le(0), u16le(0), u16le(64), u16le(64), [0x00], [0x02], [0x00]]), o);
    o += 12;
  }
  out[o] = 0x3b;
  return out;
}

const MP4_BYTES = bytes(u32be(0x18), 'ftyp', 'isom', u32be(0x200), 'isomiso2avc1mp41');
const WEBM_BYTES = bytes([0x1a, 0x45, 0xdf, 0xa3], [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f]);
const LOTTIE_BYTES = new TextEncoder().encode('{"v":"5.6.2","fr":30,"layers":[{"ty":4}]}');

// ── classifier ──────────────────────────────────────────────────────────────

for (const [name, D] of MODULES) {
  test(`[${name}] classifyMediaRef — emoji markup`, () => {
    assert.deepEqual(D.classifyMediaRef('<a:catjam:506956736113147909>'), {
      kind: 'emoji', key: 'emoji:506956736113147909', id: '506956736113147909', name: 'catjam', animatedHint: true, input: '<a:catjam:506956736113147909>',
    });
    assert.deepEqual(D.classifyMediaRef('<:mmLol:216154654256398347>'), {
      kind: 'emoji', key: 'emoji:216154654256398347', id: '216154654256398347', name: 'mmLol', animatedHint: false, input: '<:mmLol:216154654256398347>',
    });
    // Vencord ~N suffix tolerated
    const tilde = D.classifyMediaRef('<a:blob~1:392938283556143104>');
    assert.equal(tilde.kind, 'emoji');
    assert.equal(tilde.id, '392938283556143104');
    assert.equal(tilde.name, 'blob');
    assert.equal(tilde.animatedHint, true);
    // single-character names are valid Discord emoji names
    const one = D.classifyMediaRef('<a:x:506956736113147909>');
    assert.equal(one.kind, 'emoji');
    assert.equal(one.name, 'x');
    assert.equal(one.animatedHint, true);
    assert.deepEqual(D.extractMediaRefs('hi <:o:216154654256398347>!').map((r) => r.key), ['emoji:216154654256398347']);
  });

  test(`[${name}] classifyMediaRef — emoji CDN url`, () => {
    const a = D.classifyMediaRef('https://cdn.discordapp.com/emojis/506956736113147909.gif?size=48&name=catSlap');
    assert.equal(a.kind, 'emoji');
    assert.equal(a.id, '506956736113147909');
    assert.equal(a.name, 'catSlap');
    assert.equal(a.animatedHint, true);
    const b = D.classifyMediaRef('https://media.discordapp.net/emojis/216154654256398347.webp?size=48&animated=true');
    assert.equal(b.kind, 'emoji');
    assert.equal(b.animatedHint, true);
    const c = D.classifyMediaRef('https://cdn.discordapp.com/emojis/216154654256398347.png');
    assert.equal(c.animatedHint, null);
  });

  test(`[${name}] classifyMediaRef — sticker url + hints`, () => {
    assert.equal(D.classifyMediaRef('https://cdn.discordapp.com/stickers/796140620111544330.json').formatHint, 'lottie');
    assert.equal(D.classifyMediaRef('https://media.discordapp.net/stickers/1216467563744198836.gif').formatHint, 'gif');
    assert.equal(D.classifyMediaRef('https://media.discordapp.net/stickers/781291131828699156.png').formatHint, 'png');
    assert.equal(D.classifyMediaRef('https://media.discordapp.net/stickers/781291131828699156.webp').formatHint, 'png');
    const noext = D.classifyMediaRef('https://cdn.discordapp.com/stickers/781291131828699156');
    assert.equal(noext.kind, 'sticker');
    assert.equal(noext.formatHint, null);
    // legacy <id>/<32hex>.png
    const legacy = D.classifyMediaRef('https://media.discordapp.net/stickers/748287200700923974/50f2b05a1dbf45c8a7a2e1c0d3e4f5a6.png');
    assert.equal(legacy.kind, 'sticker');
    assert.equal(legacy.id, '748287200700923974');
    // canary host
    assert.equal(D.classifyMediaRef('https://canary.discord.com/stickers/781291131828699156.png').kind, 'sticker');
  });

  test(`[${name}] classifyMediaRef — attachment + expiry`, () => {
    const a = D.classifyMediaRef('https://cdn.discordapp.com/attachments/763509665585561610/1216965708911480923/image.png?ex=65f0a1b2&is=65de2c32&hm=deadbeef&');
    assert.equal(a.kind, 'attachment');
    assert.equal(a.channelId, '763509665585561610');
    assert.equal(a.attachmentId, '1216965708911480923');
    assert.equal(a.filename, 'image.png');
    assert.equal(a.ext, 'png');
    assert.equal(a.expiresAt, parseInt('65f0a1b2', 16) * 1000);
    assert.ok(a.url.startsWith('https://cdn.discordapp.com/attachments/'));
    assert.ok(a.url.includes('ex=65f0a1b2'));
    // media proxy variant is normalised to the cdn host
    const b = D.classifyMediaRef('https://media.discordapp.net/attachments/111111111111111111/1216965708911480923/clip.mp4');
    assert.equal(b.kind, 'attachment');
    assert.equal(b.ext, 'mp4');
    assert.equal(b.expiresAt, null);
    assert.ok(b.url.startsWith('https://cdn.discordapp.com/attachments/'));
  });

  test(`[${name}] classifyMediaRef — tenor`, () => {
    assert.deepEqual(D.classifyMediaRef('https://tenor.com/view/rickroll-roll-gif-22954713'), {
      kind: 'tenor', key: 'tenor:22954713', postId: '22954713', shortCode: null, mediaBase: null, mediaCode: null, input: 'https://tenor.com/view/rickroll-roll-gif-22954713',
    });
    assert.equal(D.classifyMediaRef('https://tenor.com/de/view/foo-22954713').postId, '22954713');
    assert.equal(D.classifyMediaRef('https://tenor.com/en-GB/view/foo-22954713').postId, '22954713');
    const short = D.classifyMediaRef('https://tenor.com/bP0Zs.gif');
    assert.equal(short.kind, 'tenor');
    assert.equal(short.shortCode, 'bP0Zs');
    const media = D.classifyMediaRef('https://media1.tenor.com/m/x8v1oNUOmg4AAAAd/rickroll-roll.gif');
    assert.equal(media.mediaBase, 'x8v1oNUOmg4');
    assert.equal(media.mediaCode, 'AAAAd');
    assert.equal(media.key, 'tenor-media:x8v1oNUOmg4');
    assert.equal(D.classifyMediaRef('https://c.tenor.com/x8v1oNUOmg4AAAAC/x.gif').mediaBase, 'x8v1oNUOmg4');
  });

  test(`[${name}] classifyMediaRef — giphy`, () => {
    assert.equal(D.classifyMediaRef('https://giphy.com/gifs/some-slug-Ju7l5y9osyymQ').id, 'Ju7l5y9osyymQ');
    assert.equal(D.classifyMediaRef('https://giphy.com/gifs/Ju7l5y9osyymQ').id, 'Ju7l5y9osyymQ');
    assert.equal(D.classifyMediaRef('https://giphy.com/embed/Ju7l5y9osyymQ').id, 'Ju7l5y9osyymQ');
    assert.equal(D.classifyMediaRef('https://i.giphy.com/Ju7l5y9osyymQ.gif').id, 'Ju7l5y9osyymQ');
    assert.equal(D.classifyMediaRef('https://media2.giphy.com/media/Ju7l5y9osyymQ/giphy.webp').id, 'Ju7l5y9osyymQ');
  });

  test(`[${name}] classifyMediaRef — klipy page vs media`, () => {
    assert.deepEqual(D.classifyMediaRef('https://klipy.com/gifs/archer-jazz-hands'), {
      kind: 'klipy', key: 'klipy:gifs:archer-jazz-hands', type: 'gifs', slug: 'archer-jazz-hands', input: 'https://klipy.com/gifs/archer-jazz-hands',
    });
    assert.equal(D.classifyMediaRef('https://klipy.com/stickers/foo-bar').type, 'stickers');
    const km = D.classifyMediaRef('https://static.klipy.com/ii/0123456789abcdef0123456789abcdef/a1/b2/randomXYZ.gif');
    assert.equal(km.kind, 'direct');
    assert.equal(km.ext, 'gif');
    assert.equal(D.classifyMediaRef('https://static2.klipy.com/ii/0123456789abcdef0123456789abcdef/a1/b2/r.mp4').ext, 'mp4');
  });

  test(`[${name}] classifyMediaRef — bare id + message link`, () => {
    assert.deepEqual(D.classifyMediaRef('216154654256398347'), {
      kind: 'snowflake', key: 'id:216154654256398347', id: '216154654256398347', input: '216154654256398347',
    });
    const msg = D.classifyMediaRef('https://discord.com/channels/123456789012345678/234567890123456789/345678901234567890');
    assert.equal(msg.kind, 'discord-message');
    assert.equal(msg.key, 'msg:345678901234567890');
    assert.equal(D.classifyMediaRef('https://ptb.discord.com/channels/@me/234567890123456789/345678901234567890').kind, 'discord-message');
  });

  test(`[${name}] classifyMediaRef — wrappers + ext proxy`, () => {
    // <...> no-embed wrapper only unwraps URLs, never emoji markup
    assert.equal(D.classifyMediaRef('<https://i.giphy.com/Ju7l5y9osyymQ.gif>').kind, 'giphy');
    assert.equal(D.classifyMediaRef('<a:xx:506956736113147909>').kind, 'emoji');
    // markdown [text](url)
    assert.equal(D.classifyMediaRef('[cat](https://i.giphy.com/Ju7l5y9osyymQ.gif)').kind, 'giphy');
    // external proxy decodes + re-classifies to the original
    const p = 'https://images-ext-1.discordapp.net/external/SIG/%3Fa%3Db/https/media.tenor.com/x8v1oNUOmg4AAAAd/t.gif?width=1';
    const r = D.classifyMediaRef(p);
    assert.equal(r.kind, 'tenor');
    assert.equal(r.mediaBase, 'x8v1oNUOmg4');
    assert.equal(r.input, p);
    // proxy wrapping a plain image → direct
    const p2 = 'https://images-ext-1.discordapp.net/external/SIG/https/example.com/pics/a.png';
    const r2 = D.classifyMediaRef(p2);
    assert.equal(r2.kind, 'direct');
    assert.equal(r2.ext, 'png');
  });

  test(`[${name}] classifyMediaRef — prose wrappers + sentence punctuation`, () => {
    const TENOR = 'https://tenor.com/view/rickroll-roll-gif-22954713';
    const GIPHY = 'https://giphy.com/gifs/x-Ju7l5y9osyymQ';
    for (const wrapped of [
      `(${TENOR})`, `${TENOR}.`, `${TENOR}!`, `${TENOR}?`, `${TENOR},`, `${TENOR};`, `${TENOR}:`,
      `"${TENOR}"`, `'${TENOR}'`, `[${TENOR}]`, `<${TENOR}>`, `(${TENOR}).`, `"${TENOR}".`, `(<${TENOR}>)`,
      `[text](${TENOR})`, `[text](${TENOR}).`, `[text](<${TENOR}>)`, `text](${TENOR})`,
      `“${TENOR}”`, `||${TENOR}||`, `**${TENOR}**`, `\`${TENOR}\``,
    ]) {
      const r = D.classifyMediaRef(wrapped);
      assert.ok(r, 'should accept: ' + wrapped);
      assert.equal(r.key, 'tenor:22954713', wrapped);
      assert.equal(r.input, TENOR, wrapped);
    }
    assert.equal(D.classifyMediaRef(`(${GIPHY})`).id, 'Ju7l5y9osyymQ');
    assert.equal(D.classifyMediaRef('https://cdn.discordapp.com/emojis/506956736113147909.gif?size=48&name=catSlap.').name, 'catSlap');
    assert.equal(D.classifyMediaRef('216154654256398347.').key, 'id:216154654256398347');
    // emoji markup keeps its own < >, only the sentence punctuation goes
    assert.equal(D.classifyMediaRef('<:ok:216154654256398347>!').key, 'emoji:216154654256398347');
    assert.equal(D.classifyMediaRef('(<a:x:506956736113147909>)').key, 'emoji:506956736113147909');
    // a ')' balanced by a '(' inside the URL itself is part of the URL
    const ATT = 'https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/cat_(1)';
    for (const v of [ATT, `(${ATT})`, `${ATT}.`, `(${ATT}).`, `[${ATT}]`]) {
      const a = D.classifyMediaRef(v);
      assert.equal(a.kind, 'attachment', v);
      assert.equal(a.filename, 'cat_(1)', v);
      assert.equal(a.input, ATT, v);
    }
    // punctuation alone, mentions and timestamps are still not media
    for (const neg of ['(', ').', '!', '"', '<@216154654256398347>', '<#216154654256398347>', '<t:1700000000:R>', '(hello)']) {
      assert.equal(D.classifyMediaRef(neg), null, 'should reject: ' + JSON.stringify(neg));
    }
  });

  test(`[${name}] classifyMediaRef — negatives`, () => {
    for (const neg of [
      '', '   ', 'hello world', 'https://example.com/foo.png', 'https://youtube.com/watch?v=x',
      'not-a-url', '123', '12345678901234567890123', '<:a:1>', 'https://cdn.discordapp.com/emojis/',
      'https://tenor.com/', 'https://giphy.com/', 'https://klipy.com/',
    ]) {
      assert.equal(D.classifyMediaRef(neg), null, 'should reject: ' + JSON.stringify(neg));
    }
    assert.equal(D.isMediaRefToken('<a:xx:506956736113147909>'), true);
    assert.equal(D.isMediaRefToken('nope'), false);
  });

  test(`[${name}] extractMediaRefs — multi-line paste, dedupe, order, cap`, () => {
    const text = [
      'look at this <a:catjam:506956736113147909> emoji',
      'and https://tenor.com/view/x-gif-22954713 , 216154654256398347',
      'dup https://tenor.com/view/y-gif-22954713',
      'https://example.com/ignored.png',
    ].join('\n');
    const refs = D.extractMediaRefs(text);
    assert.deepEqual(refs.map((r) => r.key), ['emoji:506956736113147909', 'tenor:22954713', 'id:216154654256398347']);
    assert.deepEqual(D.extractMediaRefs(''), []);
    assert.deepEqual(D.extractMediaRefs(null), []);
    // cap at 50
    const many = Array.from({ length: 60 }, (_, i) => `<:e${i}:1000000000000000${String(100 + i)}>`).join(' ');
    assert.equal(D.extractMediaRefs(many).length, 50);
  });

  test(`[${name}] extractMediaRefs — links inside prose punctuation`, () => {
    const TENOR = 'https://tenor.com/view/rickroll-roll-gif-22954713';
    assert.deepEqual(
      D.extractMediaRefs(`see (${TENOR}) and <:ok:216154654256398347>!`).map((r) => r.key),
      ['tenor:22954713', 'emoji:216154654256398347'],
    );
    for (const text of [`check this ${TENOR}.`, `wow ${TENOR}!`, `"${TENOR}"`, `[${TENOR}]`, `look: [the gif](${TENOR}).`, `[my favourite gif](${TENOR})`]) {
      const refs = D.extractMediaRefs(text);
      assert.deepEqual(refs.map((r) => r.key), ['tenor:22954713'], text);
      assert.equal(refs[0].input, TENOR, text);
    }
    const mixed = [
      'first (https://giphy.com/gifs/x-Ju7l5y9osyymQ), then',
      '"https://media1.tenor.com/m/x8v1oNUOmg4AAAAd/r.gif" and <https://klipy.com/gifs/archer-jazz-hands>.',
      'id 216154654256398347; <a:x:506956736113147909>?',
    ].join('\n');
    assert.deepEqual(D.extractMediaRefs(mixed).map((r) => r.key), [
      'giphy:Ju7l5y9osyymQ', 'tenor-media:x8v1oNUOmg4', 'klipy:gifs:archer-jazz-hands', 'id:216154654256398347', 'emoji:506956736113147909',
    ]);
  });

  // ── sniffers ──────────────────────────────────────────────────────────────

  test(`[${name}] sniffMedia — png / apng`, () => {
    assert.deepEqual(D.sniffMedia(makePng(100, 80, false)), { format: 'png', animated: false, width: 100, height: 80 });
    assert.deepEqual(D.sniffMedia(makePng(320, 320, true)), { format: 'apng', animated: true, width: 320, height: 320 });
  });

  test(`[${name}] sniffMedia — gif static / animated`, () => {
    assert.deepEqual(D.sniffMedia(makeGif(48, 48, { frames: 1 })), { format: 'gif', animated: false, width: 48, height: 48 });
    assert.deepEqual(D.sniffMedia(makeGif(48, 48, { frames: 2 })), { format: 'gif', animated: true, width: 48, height: 48 });
    assert.deepEqual(D.sniffMedia(makeGif(48, 48, { frames: 1, netscape: true })), { format: 'gif', animated: true, width: 48, height: 48 });
    // truncated single-frame with no netscape → animated null
    const g = makeGif(48, 48, { frames: 1 });
    const trunc = g.slice(0, 16);
    assert.equal(D.sniffMedia(trunc).animated, null);
  });

  test(`[${name}] sniffMedia — webp / jpeg / mp4 / webm / json / unknown`, () => {
    assert.deepEqual(D.sniffMedia(makeWebpVP8X(128, 128, true)), { format: 'webp', animated: true, width: 128, height: 128 });
    assert.deepEqual(D.sniffMedia(makeWebpVP8X(96, 96, false)), { format: 'webp', animated: false, width: 96, height: 96 });
    assert.deepEqual(D.sniffMedia(makeJpeg(200, 150)), { format: 'jpeg', animated: false, width: 200, height: 150 });
    assert.equal(D.sniffMedia(MP4_BYTES).format, 'mp4');
    assert.equal(D.sniffMedia(MP4_BYTES).animated, true);
    assert.equal(D.sniffMedia(WEBM_BYTES).format, 'webm');
    assert.equal(D.sniffMedia(LOTTIE_BYTES).format, 'json');
    assert.deepEqual(D.sniffMedia(new Uint8Array([1, 2, 3, 4])), { format: 'unknown', animated: null, width: null, height: null });
    assert.deepEqual(D.sniffMedia(new Uint8Array([])), { format: 'unknown', animated: null, width: null, height: null });
  });

  // ── url helpers ─────────────────────────────────────────────────────────────

  test(`[${name}] emojiUrl — host, size whitelist, params`, () => {
    assert.equal(D.emojiUrl('1', { ext: 'webp', animated: true, size: 16 }), 'https://media.discordapp.net/emojis/1.webp?size=16&animated=true');
    assert.equal(D.emojiUrl('1', { ext: 'webp', animated: true, size: 17 }), 'https://media.discordapp.net/emojis/1.webp?animated=true');
    assert.equal(D.emojiUrl('1', { ext: 'webp', lossless: true }), 'https://media.discordapp.net/emojis/1.webp?quality=lossless');
    assert.equal(D.emojiUrl('1', { ext: 'png' }), 'https://media.discordapp.net/emojis/1.png');
    assert.equal(D.emojiUrl('1', { ext: 'png', animated: true }), 'https://media.discordapp.net/emojis/1.png'); // animated ignored for non-webp
  });

  test(`[${name}] stickerUrls / tenorRenditionUrl / giphyRenditions`, () => {
    const u = D.stickerUrls('99');
    assert.equal(u.mediaPng, 'https://media.discordapp.net/stickers/99.png');
    assert.equal(u.mediaGif, 'https://media.discordapp.net/stickers/99.gif?size=4096');
    assert.equal(u.cdnRawGif, 'https://cdn.discordapp.com/stickers/99');
    assert.equal(u.lottieJson, 'https://cdn.discordapp.com/stickers/99.json');
    assert.equal(D.tenorRenditionUrl('x8v1oNUOmg4', D.TENOR_CODES.gif, 'gif'), 'https://media.tenor.com/x8v1oNUOmg4AAAAC/tenor.gif');
    assert.equal(D.TENOR_CODES.gif, 'AAAAC');
    assert.equal(D.TENOR_CODES.mp4, 'AAAPo');
    assert.equal(D.giphyRenditions('abc').gif, 'https://i.giphy.com/abc.gif');
    assert.equal(D.giphyRenditions('abc').mp4, 'https://media.giphy.com/media/abc/giphy.mp4');
  });

  test(`[${name}] isCorsSafeUrl`, () => {
    assert.equal(D.isCorsSafeUrl('https://media.discordapp.net/emojis/1.png'), true);
    assert.equal(D.isCorsSafeUrl('https://media.discordapp.net/stickers/1.png'), true);
    assert.equal(D.isCorsSafeUrl('https://media.discordapp.net/attachments/111111111111111111/222222222222222222/x.png'), false);
    assert.equal(D.isCorsSafeUrl('https://cdn.discordapp.com/emojis/1.png'), true);
    assert.equal(D.isCorsSafeUrl('https://cdn.discordapp.com/stickers/1'), false);
    assert.equal(D.isCorsSafeUrl('https://media.tenor.com/a/b.gif'), true);
    assert.equal(D.isCorsSafeUrl('https://c.tenor.com/a/b.gif'), true);
    assert.equal(D.isCorsSafeUrl('https://i.giphy.com/a.gif'), true);
    assert.equal(D.isCorsSafeUrl('https://static.klipy.com/ii/x.gif'), true);
    assert.equal(D.isCorsSafeUrl('https://tenor.com/view/x-1'), false);
    assert.equal(D.isCorsSafeUrl('https://example.com/x.png'), false);
  });

  test(`[${name}] isAllowedMediaHost`, () => {
    for (const ok of [
      'https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/x.png',
      'https://media.discordapp.net/stickers/1.png',
      'https://images-ext-1.discordapp.net/external/sig/https/x/y',
      'https://media.tenor.com/a/b.gif', 'https://media1.tenor.com/m/a/b.gif', 'https://c.tenor.com/a/b.gif',
      'https://tenor.com/view/x-1', 'https://tenor.com/de/view/x-1', 'https://tenor.com/bP0Zs.gif', 'https://tenor.com/oembed?url=x',
      'https://i.giphy.com/a.gif', 'https://media4.giphy.com/media/a/giphy.gif',
      'https://static.klipy.com/ii/x.gif', 'https://static2.klipy.com/ii/x.gif',
    ]) assert.equal(D.isAllowedMediaHost(ok), true, 'allow: ' + ok);
    for (const bad of [
      'http://cdn.discordapp.com/x', 'https://evil.com/x', 'https://cdn.discordapp.com:8080/x',
      'https://user@cdn.discordapp.com/x', 'https://127.0.0.1/x', 'https://[::1]/x',
      'https://tenor.com/trending', 'https://media5.giphy.com/a.gif', 'ftp://cdn.discordapp.com/x',
    ]) assert.equal(D.isAllowedMediaHost(bad), false, 'deny: ' + bad);
  });

  test(`[${name}] decodeExternalProxyUrl / attachmentExpired`, () => {
    assert.equal(
      D.decodeExternalProxyUrl('https://images-ext-1.discordapp.net/external/SIG/%3Fw%3D1/https/media.tenor.com/base/t.gif?width=2'),
      'https://media.tenor.com/base/t.gif?w=1',
    );
    assert.equal(
      D.decodeExternalProxyUrl('https://images-ext-2.discordapp.net/external/SIG/https/example.com/a.png'),
      'https://example.com/a.png',
    );
    assert.equal(D.decodeExternalProxyUrl('https://example.com/not-a-proxy'), null);
    const ref = D.classifyMediaRef('https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/x.png?ex=10&is=1&hm=1&');
    assert.equal(D.attachmentExpired(ref, 20000), true); // 0x10*1000 = 16000 <= 20000
    assert.equal(D.attachmentExpired(ref, 1000), false);
    assert.equal(D.attachmentExpired(D.classifyMediaRef('216154654256398347'), 0), false);
  });

  test(`[${name}] parseTenorPage`, () => {
    const html = [
      '<meta property="og:image" content="https://media1.tenor.com/m/x8v1oNUOmg4AAAAd/rickroll-roll.gif">',
      '<meta property="og:image:width" content="640">',
      '<meta property="og:image:height" content="480">',
      '<meta property="og:title" content="Rickroll Never Gonna Give You Up GIF - Rickroll Roll Rick - Discover &amp; Share GIFs">',
      '<link rel="canonical" href="https://tenor.com/view/rickroll-roll-gif-22954713">',
    ].join('\n');
    const p = D.parseTenorPage(html);
    assert.equal(p.base, 'x8v1oNUOmg4');
    assert.equal(p.postId, '22954713');
    assert.equal(p.width, 640);
    assert.equal(p.height, 480);
    assert.equal(p.title, 'Rickroll Never Gonna Give You Up');
    assert.equal(D.parseTenorPage('<html>nothing</html>'), null);
    assert.equal(D.parseTenorPage(''), null);
  });

  test(`[${name}] outputFileName / targetLabel`, () => {
    const media = { title: 'emoji-catjam-123' };
    assert.equal(D.outputFileName(media, 'gif', 'gif'), 'emoji-catjam-123.gif');
    assert.equal(D.outputFileName(media, 'sticker', 'png'), 'emoji-catjam-123-sticker.png');
    assert.equal(D.outputFileName(media, 'emoji', 'gif'), 'emoji-catjam-123-emoji.gif');
    assert.equal(D.outputFileName({ title: 'a b/c*d' }, 'original', 'png'), 'a_b_c_d.png');
    assert.equal(D.targetLabel('sticker'), 'Discord sticker');
    assert.equal(D.targetLabel('gif'), 'GIF');
  });
}

// ── resolver (fake net) ───────────────────────────────────────────────────────

function fakeNet(cfg) {
  const c = cfg || {};
  return {
    async getBytes(url, opts) {
      if (c.getBytes) return c.getBytes(url, opts);
      return { status: 200, contentType: null, bytes: new Uint8Array(0), finalUrl: url };
    },
    async getText(url, opts) {
      if (c.getText) return c.getText(url, opts);
      return { status: 404, contentType: null, text: '', finalUrl: null };
    },
    async head(url) {
      if (c.head) return c.head(url);
      return { status: 404, contentType: null };
    },
    async klipyResolve(type, slug) {
      if (c.klipyResolve) return c.klipyResolve(type, slug);
      return { status: 501, json: null };
    },
  };
}

for (const [name, D] of MODULES) {
  test(`[${name}] resolveMediaRef — emoji animated`, async () => {
    const net = fakeNet({
      getBytes: async () => ({ status: 200, contentType: 'image/webp', bytes: makeWebpVP8X(128, 128, true), finalUrl: null }),
      head: async () => ({ status: 200, contentType: 'image/gif' }),
    });
    const m = await D.resolveMediaRef(D.classifyMediaRef('<a:catjam:506956736113147909>'), net);
    assert.equal(m.kind, 'emoji');
    assert.equal(m.animated, true);
    assert.equal(m.sourceFormat, 'gif');
    assert.equal(m.title, 'emoji-catjam-506956736113147909');
    assert.ok(m.renditions.gif);
    assert.equal(m.convertSources.large.format, 'gif');
  });

  test(`[${name}] resolveMediaRef — emoji static + not found`, async () => {
    const okNet = fakeNet({
      getBytes: async () => ({ status: 200, contentType: 'image/webp', bytes: makeWebpVP8X(128, 128, false), finalUrl: null }),
      head: async () => ({ status: 200, contentType: 'image/png' }),
    });
    const m = await D.resolveMediaRef(D.classifyMediaRef('216154654256398347'), okNet);
    // snowflake resolves emoji-first
    assert.equal(m.kind, 'emoji');
    assert.equal(m.animated, false);
    assert.equal(m.sourceFormat, 'png');

    const badNet = fakeNet({ getBytes: async () => ({ status: 404, contentType: null, bytes: new Uint8Array(0), finalUrl: null }) });
    await assert.rejects(
      () => D.resolveMediaRef(D.classifyMediaRef('https://cdn.discordapp.com/emojis/506956736113147909.png'), badNet),
      /Emoji not found/,
    );
  });

  test(`[${name}] resolveMediaRef — sticker apng / gif / lottie / missing`, async () => {
    const apngNet = fakeNet({
      head: async (url) => (url.includes('/stickers/') ? { status: 200, contentType: 'image/png' } : { status: 404, contentType: null }),
      getBytes: async () => ({ status: 200, contentType: 'image/png', bytes: makePng(320, 320, true), finalUrl: null }),
    });
    const apng = await D.resolveMediaRef(D.classifyMediaRef('https://media.discordapp.net/stickers/781291131828699156.png'), apngNet);
    assert.equal(apng.sourceFormat, 'apng');
    assert.equal(apng.animated, true);
    assert.equal(apng.width, 320);
    assert.equal(apng.renditions.original.ext, 'png');
    assert.equal(apng.renditions.original.animated, true);

    const gifNet = fakeNet({
      head: async () => ({ status: 200, contentType: 'image/gif' }),
      getBytes: async () => ({ status: 200, contentType: 'image/gif', bytes: makeGif(160, 128, { frames: 2 }), finalUrl: null }),
    });
    const gif = await D.resolveMediaRef(D.classifyMediaRef('https://media.discordapp.net/stickers/1216467563744198836'), gifNet);
    assert.equal(gif.sourceFormat, 'gif');
    assert.equal(gif.renditions.original.corsSafe, false); // cdn raw gif
    assert.equal(gif.renditions.gif.corsSafe, true);

    const lottieNet = fakeNet({ head: async (url) => (url.endsWith('.json') ? { status: 200, contentType: 'application/json' } : { status: 404, contentType: null }) });
    const lottie = await D.resolveMediaRef(D.classifyMediaRef('https://media.discordapp.net/stickers/796140620111544330'), lottieNet);
    assert.equal(lottie.sourceFormat, 'lottie');
    assert.equal(lottie.width, 320);
    assert.equal(lottie.thumbnail, null);

    const directLottie = await D.resolveMediaRef(D.classifyMediaRef('https://cdn.discordapp.com/stickers/796140620111544330.json'), fakeNet({}));
    assert.equal(directLottie.sourceFormat, 'lottie'); // formatHint short-circuits, no network

    const missingNet = fakeNet({ head: async () => ({ status: 404, contentType: null }) });
    await assert.rejects(() => D.resolveMediaRef(D.classifyMediaRef('https://media.discordapp.net/stickers/999999999999999999'), missingNet), /could not be found/);
  });

  test(`[${name}] resolveMediaRef — snowflake falls through to sticker and to none`, async () => {
    const stickerNet = fakeNet({
      getBytes: async (url) => (url.includes('/emojis/')
        ? { status: 404, contentType: null, bytes: new Uint8Array(0), finalUrl: null }
        : { status: 200, contentType: 'image/png', bytes: makePng(160, 160, false), finalUrl: null }),
      head: async (url) => (url.includes('/stickers/') ? { status: 200, contentType: 'image/png' } : { status: 404, contentType: null }),
    });
    const m = await D.resolveMediaRef(D.classifyMediaRef('781291131828699156'), stickerNet);
    assert.equal(m.kind, 'sticker');
    assert.equal(m.sourceFormat, 'png');

    const noneNet = fakeNet({
      getBytes: async () => ({ status: 404, contentType: null, bytes: new Uint8Array(0), finalUrl: null }),
      head: async () => ({ status: 404, contentType: null }),
    });
    await assert.rejects(() => D.resolveMediaRef(D.classifyMediaRef('781291131828699156'), noneNet), /No emoji or sticker/);
  });

  test(`[${name}] resolveMediaRef — attachment png / mp4 / expired / gone`, async () => {
    const pngNet = fakeNet({ getBytes: async () => ({ status: 200, contentType: 'image/png', bytes: makePng(64, 64, false), finalUrl: null }) });
    const png = await D.resolveMediaRef(D.classifyMediaRef('https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/pic.png'), pngNet);
    assert.equal(png.kind, 'attachment');
    assert.equal(png.sourceFormat, 'png');
    assert.equal(png.animated, false);
    assert.equal(png.title, 'pic');
    assert.equal(png.renditions.original.corsSafe, false);

    const mp4 = await D.resolveMediaRef(D.classifyMediaRef('https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/clip.mp4'), fakeNet({}));
    assert.equal(mp4.sourceFormat, 'mp4');
    assert.equal(mp4.animated, true);

    await assert.rejects(
      () => D.resolveMediaRef(D.classifyMediaRef('https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/x.png?ex=10&is=1&hm=1'), fakeNet({}), { now: 999999999 }),
      /expired/,
    );
    const goneNet = fakeNet({ getBytes: async () => ({ status: 404, contentType: null, bytes: new Uint8Array(0), finalUrl: null }) });
    await assert.rejects(() => D.resolveMediaRef(D.classifyMediaRef('https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/x.png'), goneNet), /no longer available/);
  });

  test(`[${name}] resolveMediaRef — tenor page / oembed fallback / media / fail`, async () => {
    const html = [
      '<meta property="og:image" content="https://media1.tenor.com/m/x8v1oNUOmg4AAAAd/r.gif">',
      '<meta property="og:image:width" content="498">',
      '<meta property="og:image:height" content="498">',
      '<meta property="og:title" content="Rick GIF - Rick Roll - Discover &amp; Share GIFs">',
      '<link rel="canonical" href="https://tenor.com/view/r-gif-22954713">',
    ].join('');
    const pageNet = fakeNet({ getText: async (url) => (url.includes('/view/') ? { status: 200, contentType: 'text/html', text: html, finalUrl: url } : { status: 404, contentType: null, text: '', finalUrl: null }) });
    const page = await D.resolveMediaRef(D.classifyMediaRef('https://tenor.com/view/r-gif-22954713'), pageNet);
    assert.equal(page.kind, 'tenor');
    assert.equal(page.title, 'tenor-22954713');
    assert.equal(page.name, 'Rick');
    assert.equal(page.width, 498);
    assert.equal(page.renditions.gif.url, 'https://media.tenor.com/x8v1oNUOmg4AAAAC/tenor.gif');
    assert.equal(page.renditions.mp4.url, 'https://media.tenor.com/x8v1oNUOmg4AAAPo/tenor.mp4');
    assert.equal(page.convertSources.large.format, 'mp4');

    const oembedNet = fakeNet({
      getText: async (url) => (url.includes('/oembed')
        ? { status: 200, contentType: 'application/json', text: JSON.stringify({ thumbnail_url: 'https://media.tenor.com/x8v1oNUOmg4AAAAN/r.png', title: 'Rick' }), finalUrl: url }
        : { status: 200, contentType: 'text/html', text: '<html></html>', finalUrl: url }),
    });
    const oe = await D.resolveMediaRef(D.classifyMediaRef('https://tenor.com/view/r-gif-22954713'), oembedNet);
    assert.equal(oe.renditions.gif.url, 'https://media.tenor.com/x8v1oNUOmg4AAAAC/tenor.gif');

    const media = await D.resolveMediaRef(D.classifyMediaRef('https://media1.tenor.com/m/x8v1oNUOmg4AAAAd/r.gif'), fakeNet({}));
    assert.equal(media.kind, 'tenor');
    assert.equal(media.title, 'tenor-x8v1oNUOmg4');

    const failNet = fakeNet({ getText: async (url) => ({ status: 200, contentType: 'text/html', text: '<html></html>', finalUrl: url }) });
    await assert.rejects(() => D.resolveMediaRef(D.classifyMediaRef('https://tenor.com/view/r-gif-22954713'), failNet), /Tenor link could not be loaded/);
  });

  test(`[${name}] resolveMediaRef — giphy ok / missing`, async () => {
    const okNet = fakeNet({ head: async () => ({ status: 200, contentType: 'image/gif' }) });
    const g = await D.resolveMediaRef(D.classifyMediaRef('https://giphy.com/gifs/x-Ju7l5y9osyymQ'), okNet);
    assert.equal(g.kind, 'giphy');
    assert.equal(g.title, 'giphy-Ju7l5y9osyymQ');
    assert.equal(g.renditions.mp4.url, 'https://media.giphy.com/media/Ju7l5y9osyymQ/giphy.mp4');
    await assert.rejects(() => D.resolveMediaRef(D.classifyMediaRef('https://giphy.com/gifs/x-Ju7l5y9osyymQ'), fakeNet({ head: async () => ({ status: 404, contentType: null }) })), /Giphy GIF could not be found/);
  });

  test(`[${name}] resolveMediaRef — klipy ok / no key`, async () => {
    const okNet = fakeNet({
      klipyResolve: async () => ({ status: 200, json: { title: 'Archer Jazz Hands', files: { hd: { gif: { url: 'https://static.klipy.com/ii/a/b/c/x.gif', width: 320, height: 240, size: 1 }, mp4: { url: 'https://static.klipy.com/ii/a/b/c/x.mp4', width: 320, height: 240 } }, sm: { gif: { url: 'https://static.klipy.com/ii/a/b/c/s.gif', width: 120, height: 90 } } } } }),
    });
    const k = await D.resolveMediaRef(D.classifyMediaRef('https://klipy.com/gifs/archer-jazz-hands'), okNet);
    assert.equal(k.kind, 'klipy');
    assert.equal(k.title, 'klipy-archer-jazz-hands');
    assert.equal(k.name, 'Archer Jazz Hands');
    assert.equal(k.animated, true);
    assert.equal(k.width, 320);
    assert.equal(k.renditions.gif.url, 'https://static.klipy.com/ii/a/b/c/x.gif');
    assert.equal(k.convertSources.large.format, 'mp4');

    await assert.rejects(() => D.resolveMediaRef(D.classifyMediaRef('https://klipy.com/gifs/archer-jazz-hands'), fakeNet({})), /Klipy GIF links can't be looked up/);
  });

  test(`[${name}] resolveMediaRef — direct klipy media + discord message`, async () => {
    const net = fakeNet({ getBytes: async () => ({ status: 200, contentType: 'image/gif', bytes: makeGif(100, 100, { frames: 2 }), finalUrl: null }) });
    const d = await D.resolveMediaRef(D.classifyMediaRef('https://static.klipy.com/ii/0123456789abcdef0123456789abcdef/a1/b2/x.gif'), net);
    assert.equal(d.kind, 'direct');
    assert.equal(d.sourceFormat, 'gif');
    assert.equal(d.animated, true);
    assert.equal(d.renditions.original.corsSafe, true);

    await assert.rejects(() => D.resolveMediaRef(D.classifyMediaRef('https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333'), fakeNet({})), /Discord message links need a login/);
  });

  test(`[${name}] resolveMediaRef — GIF whose first frame outgrows the sniff prefix`, async () => {
    const SNIFF = 262144;
    const animatedGif = makeBigGif(2, 300000);
    const staticGif = makeBigGif(1, 300000);
    assert.equal(D.sniffMedia(animatedGif.slice(0, SNIFF)).animated, null); // the prefix alone can't tell
    assert.equal(D.sniffMedia(animatedGif).animated, true);
    // a server that honours maxBytes, recording each cap it was asked for
    const honouring = (gif, caps) => fakeNet({
      getBytes: async (url, opts) => {
        caps.push(opts && opts.maxBytes);
        return { status: 200, contentType: 'image/gif', bytes: gif.slice(0, (opts && opts.maxBytes) || gif.length), finalUrl: url };
      },
    });
    const ATT = 'https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/big.gif';
    const KLIPY = 'https://static.klipy.com/ii/0123456789abcdef0123456789abcdef/a1/b2/big.gif';
    for (const url of [ATT, KLIPY]) {
      const caps = [];
      const a = await D.resolveMediaRef(D.classifyMediaRef(url), honouring(animatedGif, caps));
      assert.equal(a.sourceFormat, 'gif', url);
      assert.equal(a.animated, true, url);
      assert.equal(a.renditions.original.animated, true, url);
      assert.deepEqual(caps, [SNIFF, 4 * 1024 * 1024], url); // re-fetched with the 4 MiB cap
      // the larger prefix proves a big single-frame GIF static — no blanket "animated"
      const s = await D.resolveMediaRef(D.classifyMediaRef(url), honouring(staticGif, []));
      assert.equal(s.animated, false, url);
      // a host that only ever serves the 256 KB prefix: still undetermined → animated, never static
      const stub = fakeNet({ getBytes: async () => ({ status: 200, contentType: 'image/gif', bytes: animatedGif.slice(0, SNIFF), finalUrl: null }) });
      assert.equal((await D.resolveMediaRef(D.classifyMediaRef(url), stub)).animated, true, url);
      // the re-fetch failing outright is not fatal either
      let n = 0;
      const flaky = fakeNet({
        getBytes: async () => {
          n += 1;
          if (n > 1) throw new Error('network down');
          return { status: 200, contentType: 'image/gif', bytes: animatedGif.slice(0, SNIFF), finalUrl: null };
        },
      });
      assert.equal((await D.resolveMediaRef(D.classifyMediaRef(url), flaky)).animated, true, url);
    }
    // a small, fully-sniffed GIF is decided by the first fetch alone
    const caps = [];
    const small = await D.resolveMediaRef(D.classifyMediaRef(ATT), honouring(makeGif(48, 48, { frames: 1 }), caps));
    assert.equal(small.animated, false);
    assert.deepEqual(caps, [SNIFF]);
  });

  test(`[${name}] resolveMediaInput — batch with mixed success + errors`, async () => {
    const net = fakeNet({
      getBytes: async (url) => (url.includes('/emojis/')
        ? { status: 200, contentType: 'image/webp', bytes: makeWebpVP8X(128, 128, true), finalUrl: null }
        : { status: 200, contentType: 'image/png', bytes: makePng(64, 64, false), finalUrl: null }),
      head: async () => ({ status: 200, contentType: 'image/gif' }),
    });
    const text = '<a:catjam:506956736113147909> https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333 https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/pic.png';
    const res = await D.resolveMediaInput(text, net);
    assert.equal(res.media.length, 2);
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0].message, /Discord message links/);
    assert.equal(res.errors[0].input, 'https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333');
  });
}

// ── planning (availableTargets / planExport / attempt strings) ────────────────

function stickerApngMedia(D) {
  const u = D.stickerUrls('781291131828699156');
  return {
    key: 'sticker:781291131828699156', kind: 'sticker', id: '781291131828699156', name: null, title: 'sticker-781291131828699156', pageUrl: '',
    sourceFormat: 'apng', animated: true, width: 320, height: 320, thumbnail: u.thumb,
    renditions: {
      original: { url: u.mediaPng, ext: 'png', corsSafe: true, animated: true },
      png: { url: u.mediaStill, ext: 'png', corsSafe: true, animated: false },
      webp: { url: u.mediaWebpStatic, ext: 'webp', corsSafe: true, animated: false },
    },
    convertSources: { large: { url: u.mediaPng, ext: 'png', format: 'apng', corsSafe: true }, small: { url: u.mediaPng, ext: 'png', format: 'apng', corsSafe: true } },
  };
}
function emojiStaticMedia(D) {
  return {
    key: 'emoji:1', kind: 'emoji', id: '1', name: 'x', title: 'emoji-x-1', pageUrl: '',
    sourceFormat: 'png', animated: false, width: null, height: null, thumbnail: D.emojiUrl('1', { ext: 'png' }),
    renditions: {
      original: { url: D.emojiUrl('1', { ext: 'png' }), ext: 'png', corsSafe: true, animated: false },
      png: { url: D.emojiUrl('1', { ext: 'png' }), ext: 'png', corsSafe: true, animated: false },
      webp: { url: D.emojiUrl('1', { ext: 'webp', lossless: true }), ext: 'webp', corsSafe: true, animated: false },
    },
    convertSources: { large: { url: D.emojiUrl('1', { ext: 'png' }), ext: 'png', format: 'png', corsSafe: true }, small: { url: D.emojiUrl('1', { ext: 'png' }), ext: 'png', format: 'png', corsSafe: true } },
  };
}
function lottieMedia(D) {
  const u = D.stickerUrls('796140620111544330');
  return {
    key: 'sticker:796140620111544330', kind: 'sticker', id: '796140620111544330', name: null, title: 'sticker-796140620111544330', pageUrl: '',
    sourceFormat: 'lottie', animated: true, width: 320, height: 320, thumbnail: null,
    renditions: { original: { url: u.lottieJson, ext: 'json', corsSafe: false, animated: true } },
    convertSources: { large: { url: u.lottieJson, ext: 'json', format: 'lottie', corsSafe: false }, small: { url: u.lottieJson, ext: 'json', format: 'lottie', corsSafe: false } },
  };
}

for (const [name, D] of MODULES) {
  test(`[${name}] availableTargets — sticker apng across caps`, () => {
    const m = stickerApngMedia(D);
    const web = Object.fromEntries(D.availableTargets(m, D.CAPS.web).map((t) => [t.key, t.enabled]));
    assert.deepEqual(web, { original: true, gif: true, png: true, apng: true, webp: true, mp4: true, sticker: true, emoji: true });
    const android = Object.fromEntries(D.availableTargets(m, D.CAPS.android).map((t) => [t.key, t.enabled]));
    // android: webp via static rendition fetch, mp4 via mediacodec convert
    assert.deepEqual(android, { original: true, gif: true, png: true, apng: true, webp: true, mp4: true, sticker: true, emoji: true });
  });

  test(`[${name}] availableTargets — static emoji disables apng + mp4`, () => {
    const m = emojiStaticMedia(D);
    const web = D.availableTargets(m, D.CAPS.web);
    const apng = web.find((t) => t.key === 'apng');
    const mp4 = web.find((t) => t.key === 'mp4');
    assert.equal(apng.enabled, false);
    assert.match(apng.reason, /still image/i);
    assert.equal(mp4.enabled, false);
    assert.match(mp4.reason, /animated/i);
  });

  test(`[${name}] availableTargets — lottie limited without caps.lottie`, () => {
    const m = lottieMedia(D);
    const android = Object.fromEntries(D.availableTargets(m, D.CAPS.android).map((t) => [t.key, t.enabled]));
    assert.equal(android.original, true);
    assert.equal(android.gif, false);
    assert.equal(android.sticker, false);
    const web = Object.fromEntries(D.availableTargets(m, D.CAPS.web).map((t) => [t.key, t.enabled]));
    assert.equal(web.gif, true);
    assert.equal(web.sticker, true);
    const plan = D.planExport(m, 'sticker', D.CAPS.web);
    assert.equal(plan.mode, 'convert');
    assert.equal(plan.source.format, 'lottie');
    assert.deepEqual(plan.attempts[0].inputArgs, ['-f', 'apng']);
  });

  test(`[${name}] planExport — original is always a fetch`, () => {
    const plan = D.planExport(stickerApngMedia(D), 'original', D.CAPS.web);
    assert.equal(plan.mode, 'fetch');
    assert.equal(plan.ext, 'png');
    assert.equal(plan.fileName, 'sticker-781291131828699156.png');
  });

  test(`[${name}] planExport — apng sticker: webp fetch on android, convert on web`, () => {
    const m = stickerApngMedia(D);
    const androidWebp = D.planExport(m, 'webp', D.CAPS.android);
    assert.equal(androidWebp.mode, 'fetch'); // static webp rendition
    const webWebp = D.planExport(m, 'webp', D.CAPS.web);
    assert.equal(webWebp.mode, 'convert'); // animated webp encode
    assert.ok(webWebp.attempts[0].outputArgs.includes('libwebp_anim'));
  });

  test(`[${name}] planExport — mp4 attempts per encoder`, () => {
    const m = stickerApngMedia(D);
    const web = D.planExport(m, 'mp4', D.CAPS.web);
    assert.equal(web.mode, 'convert');
    assert.equal(web.attempts.length, 1);
    assert.ok(web.attempts[0].outputArgs.join(' ').includes('libx264'));
    const android = D.planExport(m, 'mp4', D.CAPS.android);
    assert.equal(android.attempts.length, 2);
    assert.ok(android.attempts[0].outputArgs.join(' ').includes('h264_mediacodec'));
    assert.ok(android.attempts[1].outputArgs.join(' ').includes('mpeg4'));
  });

  test(`[${name}] planExport — sticker ladder shape + attempt strings`, () => {
    const plan = D.planExport(stickerApngMedia(D), 'sticker', D.CAPS.web);
    assert.equal(plan.mode, 'convert');
    assert.equal(plan.maxBytes, 512000);
    assert.equal(plan.fileName, 'sticker-781291131828699156-sticker');
    assert.equal(plan.attempts.length, 9);
    // first rung: full RGBA APNG, fit to 320, -plays 0 -f apng -t 5, no palette
    const a0 = plan.attempts[0];
    assert.deepEqual(a0.inputArgs, ['-f', 'apng']);
    assert.equal(a0.outExt, 'png');
    assert.deepEqual(a0.outputArgs, [
      '-vf', 'scale=320:320:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=320:320:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
      '-plays', '0', '-f', 'apng', '-t', '5',
    ]);
    // last rung: GIF 32 colours 10 fps
    const a8 = plan.attempts[8];
    assert.equal(a8.outExt, 'gif');
    assert.ok(a8.outputArgs.join(' ').includes('fps=10'));
    assert.ok(a8.outputArgs.join(' ').includes('max_colors=32'));
    assert.ok(a8.outputArgs.join(' ').includes('paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle:alpha_threshold=128'));
    assert.ok(a8.outputArgs.includes('-loop'));
    assert.ok(a8.outputArgs.includes('-t'));
  });

  test(`[${name}] planExport — emoji animated ladder (no -t, S=128)`, () => {
    const gifEmoji = {
      key: 'emoji:1', kind: 'emoji', id: '1', name: null, title: 'emoji-1', pageUrl: '',
      sourceFormat: 'gif', animated: true, width: null, height: null, thumbnail: null,
      renditions: { original: { url: 'g', ext: 'gif', corsSafe: true, animated: true }, gif: { url: 'g', ext: 'gif', corsSafe: true, animated: true } },
      convertSources: { large: { url: 'g', ext: 'gif', format: 'gif', corsSafe: true }, small: { url: 'g', ext: 'gif', format: 'gif', corsSafe: true } },
    };
    const plan = D.planExport(gifEmoji, 'emoji', D.CAPS.web);
    assert.equal(plan.attempts.length, 6);
    assert.ok(plan.attempts.every((a) => a.outExt === 'gif'));
    assert.ok(plan.attempts.every((a) => !a.outputArgs.includes('-t'))); // emoji has no 5s cap
    assert.ok(plan.attempts[0].outputArgs.join(' ').includes('scale=128:128'));
  });

  test(`[${name}] planExport — gif target fetches a matching rendition`, () => {
    const u = D.stickerUrls('9');
    const gifSticker = {
      key: 'sticker:9', kind: 'sticker', id: '9', name: null, title: 'sticker-9', pageUrl: '',
      sourceFormat: 'gif', animated: true, width: 160, height: 128, thumbnail: u.thumb,
      renditions: {
        original: { url: u.cdnRawGif, ext: 'gif', corsSafe: false, animated: true },
        gif: { url: u.mediaGif, ext: 'gif', corsSafe: true, animated: true },
        png: { url: u.mediaStill, ext: 'png', corsSafe: true, animated: false },
        webp: { url: u.mediaWebpAnimated, ext: 'webp', corsSafe: true, animated: true },
      },
      convertSources: { large: { url: u.mediaGif, ext: 'gif', format: 'gif', corsSafe: true }, small: { url: u.mediaGif, ext: 'gif', format: 'gif', corsSafe: true } },
    };
    const plan = D.planExport(gifSticker, 'gif', D.CAPS.web);
    assert.equal(plan.mode, 'fetch');
    assert.equal(plan.url, u.mediaGif);
    assert.equal(plan.corsSafe, true);
  });

  test(`[${name}] planExport — unsupported returns a reason`, () => {
    const m = emojiStaticMedia(D);
    const plan = D.planExport(m, 'mp4', D.CAPS.web);
    assert.equal(plan.mode, 'unsupported');
    assert.ok(typeof plan.reason === 'string' && plan.reason.length > 0);
  });
}

// ── parity: same names + identical output on vectors ──────────────────────────

test('parity — identical export names', () => {
  assert.deepEqual(Object.keys(JS).sort(), Object.keys(TS).sort());
});

test('parity — classify / extract / helpers identical', () => {
  const vectors = [
    '<a:catjam:506956736113147909>', '<:mmLol:216154654256398347>', '<a:blob~3:392938283556143104>',
    'https://cdn.discordapp.com/emojis/506956736113147909.gif?size=48&name=catSlap',
    'https://media.discordapp.net/emojis/1.webp?animated=true',
    'https://cdn.discordapp.com/stickers/796140620111544330.json',
    'https://media.discordapp.net/stickers/781291131828699156.png',
    'https://media.discordapp.net/stickers/748287200700923974/50f2b05a1dbf45c8a7a2e1c0d3e4f5a6.png',
    'https://cdn.discordapp.com/attachments/763509665585561610/1216965708911480923/image.png?ex=65f0a1b2&is=65de2c32&hm=deadbeef&',
    'https://tenor.com/view/x-gif-22954713', 'https://tenor.com/de/view/y-22954713', 'https://tenor.com/bP0Zs.gif',
    'https://media1.tenor.com/m/x8v1oNUOmg4AAAAd/r.gif',
    'https://giphy.com/gifs/x-Ju7l5y9osyymQ', 'https://i.giphy.com/Ju7l5y9osyymQ.gif',
    'https://klipy.com/gifs/archer-jazz-hands', 'https://static.klipy.com/ii/0123456789abcdef0123456789abcdef/a1/b2/x.gif',
    '216154654256398347', 'https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333', 'https://example.com/x.png',
    '<https://i.giphy.com/Ju7l5y9osyymQ.gif>', '[c](https://i.giphy.com/Ju7l5y9osyymQ.gif)',
    'https://images-ext-1.discordapp.net/external/SIG/%3Fa%3Db/https/media.tenor.com/x8v1oNUOmg4AAAAd/t.gif?width=1',
    '<a:x:506956736113147909>', '<:ok:216154654256398347>!', '(https://tenor.com/view/x-gif-22954713)',
    'https://tenor.com/view/x-gif-22954713.', 'https://tenor.com/view/x-gif-22954713!', '"https://giphy.com/gifs/x-Ju7l5y9osyymQ"',
    '[https://klipy.com/gifs/archer-jazz-hands]', '[text](https://tenor.com/bP0Zs.gif).', 'text](https://tenor.com/bP0Zs.gif)',
    '(https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/cat_(1)).', '||<https://i.giphy.com/Ju7l5y9osyymQ.gif>||',
    '<@216154654256398347>', '<t:1700000000:R>', '(', '!',
  ];
  for (const v of vectors) {
    assert.deepEqual(JS.classifyMediaRef(v), TS.classifyMediaRef(v), 'classify: ' + v);
    assert.equal(JS.isMediaRefToken(v), TS.isMediaRefToken(v), 'token: ' + v);
    assert.equal(JS.decodeExternalProxyUrl(v), TS.decodeExternalProxyUrl(v), 'decode: ' + v);
  }
  const multi = vectors.join('\n');
  assert.deepEqual(JS.extractMediaRefs(multi), TS.extractMediaRefs(multi));
  const prose = 'see (https://tenor.com/view/rickroll-roll-gif-22954713) and <:ok:216154654256398347>! "https://giphy.com/gifs/x-Ju7l5y9osyymQ". [my gif](https://tenor.com/bP0Zs.gif)';
  assert.deepEqual(JS.extractMediaRefs(prose), TS.extractMediaRefs(prose));
  assert.equal(JS.emojiUrl('1', { ext: 'webp', animated: true, size: 16 }), TS.emojiUrl('1', { ext: 'webp', animated: true, size: 16 }));
  assert.deepEqual(JS.stickerUrls('9'), TS.stickerUrls('9'));
  assert.deepEqual(JS.giphyRenditions('a'), TS.giphyRenditions('a'));
  assert.deepEqual(JS.TENOR_CODES, TS.TENOR_CODES);
  assert.deepEqual(JS.EMOJI_SIZES, TS.EMOJI_SIZES);
  assert.deepEqual(JS.CAPS, TS.CAPS);
  assert.deepEqual(JS.TARGETS, TS.TARGETS);
  assert.deepEqual(JS.PRESETS, TS.PRESETS);
});

test('parity — sniffers identical', () => {
  const samples = [
    makePng(100, 80, false), makePng(320, 320, true),
    makeGif(48, 48, { frames: 1 }), makeGif(48, 48, { frames: 2 }), makeGif(48, 48, { frames: 1, netscape: true }),
    makeWebpVP8X(128, 128, true), makeWebpVP8X(96, 96, false),
    makeJpeg(200, 150), MP4_BYTES, WEBM_BYTES, LOTTIE_BYTES, new Uint8Array([1, 2, 3]),
    makeBigGif(2, 300000).slice(0, 262144), makeBigGif(2, 300000),
  ];
  for (const s of samples) assert.deepEqual(JS.sniffMedia(s), TS.sniffMedia(s));
});

test('parity — planExport / availableTargets identical across caps', () => {
  const builders = [stickerApngMedia, emojiStaticMedia, lottieMedia];
  for (const build of builders) {
    const mj = build(JS);
    const mt = build(TS);
    for (const capsName of ['web', 'desktop', 'android']) {
      for (const tgt of ['original', 'gif', 'png', 'apng', 'webp', 'mp4', 'sticker', 'emoji']) {
        assert.deepEqual(JS.planExport(mj, tgt, JS.CAPS[capsName]), TS.planExport(mt, tgt, TS.CAPS[capsName]), `plan ${build.name} ${capsName} ${tgt}`);
      }
      assert.deepEqual(JS.availableTargets(mj, JS.CAPS[capsName]), TS.availableTargets(mt, TS.CAPS[capsName]), `targets ${build.name} ${capsName}`);
    }
  }
});

test('parity — resolver identical on a fake net', async () => {
  const mk = (D) => fakeNet({
    getBytes: async (url) => (url.includes('/emojis/')
      ? { status: 200, contentType: 'image/webp', bytes: makeWebpVP8X(128, 128, true), finalUrl: null }
      : { status: 200, contentType: 'image/png', bytes: makePng(320, 320, true), finalUrl: null }),
    head: async (url) => (url.includes('/stickers/') ? { status: 200, contentType: 'image/png' } : { status: 200, contentType: 'image/gif' }),
    klipyResolve: async () => ({ status: 200, json: { title: 'K', files: { hd: { gif: { url: 'https://static.klipy.com/ii/a/b/c/x.gif', width: 100, height: 100 } } } } }),
  });
  for (const input of ['<a:xx:506956736113147909>', 'https://media.discordapp.net/stickers/781291131828699156.png', 'https://klipy.com/gifs/archer-jazz-hands']) {
    const a = await JS.resolveMediaRef(JS.classifyMediaRef(input), mk(JS));
    const b = await TS.resolveMediaRef(TS.classifyMediaRef(input), mk(TS));
    assert.deepEqual(a, b, 'resolve: ' + input);
  }
  const big = makeBigGif(2, 300000);
  const capped = () => fakeNet({ getBytes: async (url, opts) => ({ status: 200, contentType: 'image/gif', bytes: big.slice(0, opts.maxBytes), finalUrl: url }) });
  for (const input of ['(https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/big.gif).', 'https://static.klipy.com/ii/0123456789abcdef0123456789abcdef/a1/b2/big.gif!']) {
    const a = await JS.resolveMediaRef(JS.classifyMediaRef(input), capped());
    const b = await TS.resolveMediaRef(TS.classifyMediaRef(input), capped());
    assert.deepEqual(a, b, 'resolve: ' + input);
    assert.equal(a.animated, true, input);
  }
});

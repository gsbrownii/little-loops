#!/usr/bin/env node
// Render the PNG app icons from icons/icon.svg with headless Chrome (tools/cdp.mjs).
//
//   node tools/make-icons.mjs                     # writes the four PNGs below into icons/
//   node tools/make-icons.mjs --preview out.png   # ...and a QA sheet: every icon, the maskable icon
//                                                 #    under circle/squircle masks + its safe zone, favicon sizes
//
//   icons/icon-192.png           192x192  purpose "any"       rounded square, transparent corners
//   icons/icon-512.png           512x512  purpose "any"       rounded square, transparent corners
//   icons/icon-maskable-512.png  512x512  purpose "maskable"  full-bleed square, art inside the central 80% safe zone
//   icons/apple-touch-icon.png   180x180  iOS home screen     full-bleed square, fully opaque (iOS rounds the corners)
//
// icons/icon.svg contract: a background <rect id="bg" fill="…"> (rounded square) followed by the artwork.
// Full-bleed variants paint the whole square in the bg colour and draw icon.svg scaled down on top, so the
// rounded corners disappear into the same colour. Screenshots are re-encoded here (opaque icons as RGB with
// no alpha channel) and checked: exact pixel size, transparent corners on "any", no transparency on opaque.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { APP_ROOT } from './serve.mjs';
import { launch } from './cdp.mjs';

const ICON_DIR = path.join(APP_ROOT, 'icons');
const SOURCE = path.join(ICON_DIR, 'icon.svg');

// scale = artwork size relative to the full icon. The art in icon.svg (cream disc + head) reaches at most
// ~202/512 from the centre, so 0.82 keeps it within the maskable safe-zone circle (radius 40%) with room.
export const VARIANTS = [
  { file: 'icon-192.png', size: 192, bleed: false, scale: 1 },
  { file: 'icon-512.png', size: 512, bleed: false, scale: 1 },
  { file: 'icon-maskable-512.png', size: 512, bleed: true, scale: 0.82 },
  { file: 'apple-touch-icon.png', size: 180, bleed: true, scale: 0.92 },
];

// ---------- minimal PNG codec (8-bit RGB/RGBA, non-interlaced) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePNG(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      colorType = data[9];
      if (depth !== 8 || (colorType !== 6 && colorType !== 2) || data[12] !== 0) {
        throw new Error(`unsupported PNG (depth ${depth}, colour type ${colorType}, interlace ${data[12]})`);
      }
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = px.subarray(y * stride, (y + 1) * stride);
    const up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = up ? up[i] : 0;
      const c = up && i >= channels ? up[i - channels] : 0;
      const pred = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c);
      row[i] = (src[i] + pred) & 0xff;
    }
  }
  return { width, height, channels, data: px };
}

export function encodePNG({ width, height, channels, data }) {
  const stride = width * channels;
  const out = Buffer.alloc((stride + 1) * height);
  const trial = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const up = y ? data.subarray((y - 1) * stride, y * stride) : null;
    let best = 0, bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const t = trial[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? row[i - channels] : 0;
        const b = up ? up[i] : 0;
        const c = up && i >= channels ? up[i - channels] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (row[i] - pred) & 0xff;
        t[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    out[y * (stride + 1)] = best;
    trial[best].copy(out, y * (stride + 1) + 1);
  }
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const alphaAt = (img, x, y) => (img.channels === 4 ? img.data[(y * img.width + x) * 4 + 3] : 255);

function dropAlpha(img) {
  if (img.channels === 3) return img; // Chrome already encoded an opaque capture as RGB
  const n = img.width * img.height;
  const rgb = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    if (img.data[i * 4 + 3] !== 255) {
      throw new Error(`pixel ${i % img.width},${Math.floor(i / img.width)} is not opaque`);
    }
    rgb[i * 3] = img.data[i * 4];
    rgb[i * 3 + 1] = img.data[i * 4 + 1];
    rgb[i * 3 + 2] = img.data[i * 4 + 2];
  }
  return { width: img.width, height: img.height, channels: 3, data: rgb };
}

// ---------- rendering ----------

function readSource() {
  const svg = fs.readFileSync(SOURCE, 'utf8');
  const bg = /<rect\b[^>]*\bid="bg"[^>]*\bfill="(#[0-9A-Fa-f]{3,8})"/.exec(svg)?.[1];
  if (!bg) throw new Error('icons/icon.svg needs a <rect id="bg" fill="#…"> background');
  return { svg, bg };
}

function pageFor({ svg, bg }, { size, bleed, scale }) {
  const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const art = Math.round(size * scale);
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden;background:${bleed ? bg : 'transparent'}}
    img{position:absolute;left:${(size - art) / 2}px;top:${(size - art) / 2}px;width:${art}px;height:${art}px}
  </style><img src="${uri}" alt="">`;
}

async function capture(b, html, size, tmpFile) {
  fs.writeFileSync(tmpFile, html);
  await b.setViewport(size, size, { touch: false, mobile: false });
  await b.goto(pathToFileURL(tmpFile).href, { wait: 150 });
  await b.waitFor(`(() => { const i = document.querySelector('img'); return !i || (i.complete && i.naturalWidth > 0); })()`);
  const { data } = await b.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
  });
  return decodePNG(Buffer.from(data, 'base64'));
}

async function main() {
  const argv = process.argv.slice(2);
  const pi = argv.indexOf('--preview');
  const preview = pi >= 0 ? path.resolve(argv[pi + 1] || path.join(os.tmpdir(), 'little-loops-icons.png')) : null;

  const src = readSource();
  const tmpFile = path.join(os.tmpdir(), `ll-icon-${process.pid}.html`);
  const b = await launch({ width: 512, height: 512, touch: false, serve: false, dpr: 1 });
  try {
    // Transparent page background so "any" icons keep transparent corners.
    await b.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    for (const v of VARIANTS) {
      let img = await capture(b, pageFor(src, v), v.size, tmpFile);
      if (img.width !== v.size || img.height !== v.size) {
        throw new Error(`${v.file}: rendered ${img.width}x${img.height}, expected ${v.size}x${v.size}`);
      }
      if (v.bleed) {
        img = dropAlpha(img); // throws if any pixel is see-through
      } else {
        const c = v.size - 1, m = v.size >> 1;
        if (alphaAt(img, 0, 0) !== 0 || alphaAt(img, c, c) !== 0) throw new Error(`${v.file}: corners should be transparent`);
        if (alphaAt(img, m, m) !== 255 || alphaAt(img, m, 2) !== 255) throw new Error(`${v.file}: icon body should be opaque`);
      }
      const png = encodePNG(img);
      fs.writeFileSync(path.join(ICON_DIR, v.file), png);
      console.log(`  icons/${v.file.padEnd(24)} ${v.size}x${v.size} ${img.channels === 4 ? 'RGBA' : 'RGB '} ${(png.length / 1024).toFixed(1)} KB`);
    }

    if (preview) {
      const uri = (f) => `data:image/png;base64,${fs.readFileSync(path.join(ICON_DIR, f)).toString('base64')}`;
      const svgUri = `data:image/svg+xml;base64,${Buffer.from(src.svg).toString('base64')}`;
      const cell = (label, inner) => `<figure>${inner}<figcaption>${label}</figcaption></figure>`;
      const html = `<!doctype html><meta charset="utf-8"><style>
        body{margin:0;padding:16px;background:#e9e9ef;font:13px sans-serif;display:flex;flex-wrap:wrap;gap:18px;align-items:flex-end;width:1150px}
        figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:6px}
        .chk{background:repeating-conic-gradient(#ccc 0 25%,#fff 0 50%) 0 0/16px 16px}
        .wrap{position:relative;width:256px;height:256px}
        .wrap img{width:256px;height:256px;display:block}
        .safe{position:absolute;inset:0;border-radius:50%;box-shadow:inset 0 0 0 2px red;transform:scale(.8)}
        .dark{background:#202124;padding:10px;display:flex;gap:10px;align-items:center}
      </style>
      ${cell('icon-512 (any)', `<img class="chk" src="${uri('icon-512.png')}" width="256" height="256">`)}
      ${cell('icon-192 (any, 1:1)', `<img class="chk" src="${uri('icon-192.png')}" width="192" height="192">`)}
      ${cell('apple-touch-icon 180 (1:1)', `<img src="${uri('apple-touch-icon.png')}" width="180" height="180">`)}
      ${cell('maskable + 80% safe zone', `<div class="wrap"><img src="${uri('icon-maskable-512.png')}"><div class="safe"></div></div>`)}
      ${cell('maskable: circle mask', `<img src="${uri('icon-maskable-512.png')}" width="200" height="200" style="border-radius:50%">`)}
      ${cell('maskable: squircle', `<img src="${uri('icon-maskable-512.png')}" width="200" height="200" style="border-radius:28%">`)}
      ${cell('maskable: tight circle (72/108)', `<div style="width:200px;height:200px;border-radius:50%;overflow:hidden"><img src="${uri('icon-maskable-512.png')}" style="width:300px;height:300px;margin:-50px"></div>`)}
      ${cell('apple, iOS-style corners 60px', `<img src="${uri('apple-touch-icon.png')}" width="120" height="120" style="border-radius:27px">`)}
      ${cell('favicon 16 / 32 / 48 (svg)', `<div class="dark"><img src="${svgUri}" width="16"><img src="${svgUri}" width="32"><img src="${svgUri}" width="48"></div><div style="display:flex;gap:10px;padding:10px;background:#fff"><img src="${svgUri}" width="16"><img src="${svgUri}" width="32"><img src="${svgUri}" width="48"></div>`)}
      `;
      fs.writeFileSync(tmpFile, html);
      await b.send('Emulation.setDefaultBackgroundColorOverride', {});
      await b.setViewport(1182, 640, { touch: false, mobile: false });
      await b.goto(pathToFileURL(tmpFile).href, { wait: 300 });
      await b.screenshot(preview);
      console.log(`  preview -> ${preview}`);
    }
    if (b.errors.length) console.warn('Browser errors:', b.errors);
  } finally {
    await b.close();
    fs.rmSync(tmpFile, { force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`make-icons: ${err.message}`);
    process.exit(1);
  });
}

#!/usr/bin/env node
// Render coloring art to PNG for visual QA (uses the real renderer: js/modules/coloring/scene.js).
//
//   node tools/render-coloring.mjs --sheet animals      --out out/animals.png   # each animal + anchor markers
//   node tools/render-coloring.mjs --sheet accessories  --out out/acc.png       # each accessory on --animal (default first)
//   node tools/render-coloring.mjs --sheet combos       --out out/combos.png    # every animal x accessory
//   node tools/render-coloring.mjs --sheet backgrounds  --out out/bgs.png       # each background + stage box + first animal ghost
//   node tools/render-coloring.mjs --sheet scene --animal cat --accessory crown --background meadow --out out/one.png
//   node tools/render-coloring.mjs --sheet print  --animal cat --accessory crown --background meadow --out out/print.png
// Options: --size <px per cell, default 260>, --fills random  (random colours on every region)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ROOT } from './serve.mjs';
import { launch } from './cdp.mjs';
import { renderScene, regionKeys, DEFAULT_PLACEMENT } from '../js/modules/coloring/scene.js';

const argv = process.argv.slice(2);
const opt = (name, d) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : d;
};
const sheet = opt('sheet', 'combos');
const out = path.resolve(opt('out', path.join(os.tmpdir(), `coloring-${sheet}.png`)));
const size = Number(opt('size', 260));
const randomFills = opt('fills', '') === 'random';

const load = (f) => JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'data/coloring', f), 'utf8'));
const animalsDoc = load('animals.json');
const animals = animalsDoc.items;
const accessories = load('accessories.json').items;
const backgrounds = load('backgrounds.json').items;
const placement = animalsDoc.placement || DEFAULT_PLACEMENT;
const pick = (list, id) => (id ? list.find((x) => x.id === id) : list[0]) || list[0];

const PALETTE = ['#FF5A5F', '#FF9F1C', '#FFD23F', '#A8E063', '#2EC4B6', '#7BDFF2', '#3A86FF', '#9B5DE5', '#FF8FAB', '#A0522D', '#FFD3B6'];
function fillsFor(parts) {
  if (!randomFills) return {};
  const f = {};
  regionKeys(parts).forEach((k, i) => { f[k] = PALETTE[(i * 7) % PALETTE.length]; });
  return f;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function anchorMarkers(animal) {
  const P = placement;
  return Object.entries(animal.anchors || {}).map(([name, a]) => {
    const x = P.x + a.x * (P.scale || 1);
    const y = P.y + a.y * (P.scale || 1);
    const col = { head: '#e11', eyes: '#11e', neck: '#0a0', hand: '#e0e' }[name] || '#000';
    return `<g><circle cx="${x}" cy="${y}" r="7" fill="none" stroke="${col}" stroke-width="3"/><line x1="${x - 12}" y1="${y}" x2="${x + 12}" y2="${y}" stroke="${col}" stroke-width="2"/><line x1="${x}" y1="${y - 12}" x2="${x}" y2="${y + 12}" stroke="${col}" stroke-width="2"/><text x="${x + 10}" y="${y - 10}" font-size="18" fill="${col}" font-family="sans-serif">${name}</text></g>`;
  }).join('');
}

function overlay(svg, extra) {
  return svg.replace(/<\/svg>$/, `${extra}</svg>`);
}

const cells = [];
let cols = 3;
if (sheet === 'animals') {
  for (const a of animals) cells.push([a.id, overlay(renderScene({ animal: a, placement, mode: 'thumb', fills: fillsFor({ animal: a }) }), anchorMarkers(a))]);
} else if (sheet === 'accessories') {
  const a = pick(animals, opt('animal'));
  for (const acc of accessories) cells.push([`${a.id} + ${acc.id} (${acc.anchor})`, renderScene({ animal: a, accessory: acc, placement, mode: 'thumb', fills: fillsFor({ animal: a, accessory: acc }) })]);
} else if (sheet === 'combos') {
  cols = accessories.length || 6;
  for (const a of animals) for (const acc of accessories) cells.push([`${a.id}+${acc.id}`, renderScene({ animal: a, accessory: acc, placement, mode: 'thumb', fills: fillsFor({ animal: a, accessory: acc }) })]);
} else if (sheet === 'backgrounds') {
  const a = pick(animals, opt('animal'));
  const acc = pick(accessories, opt('accessory'));
  const stage = `<rect x="${placement.x}" y="${placement.y}" width="${300 * (placement.scale || 1)}" height="${300 * (placement.scale || 1)}" fill="none" stroke="#e11" stroke-width="3" stroke-dasharray="12 8"/>`;
  for (const bg of backgrounds) {
    cells.push([`${bg.id} (stage box)`, overlay(renderScene({ background: bg, placement, mode: 'thumb', fills: fillsFor({ background: bg }) }), stage)]);
    cells.push([`${bg.id} + ${a.id} + ${acc.id}`, renderScene({ background: bg, animal: a, accessory: acc, placement, mode: 'thumb', fills: fillsFor({ background: bg, animal: a, accessory: acc }) })]);
  }
  cols = 4;
} else if (sheet === 'scene' || sheet === 'print') {
  const parts = { background: pick(backgrounds, opt('background')), animal: pick(animals, opt('animal')), accessory: pick(accessories, opt('accessory')) };
  cells.push([`${parts.animal.id} + ${parts.accessory.id} @ ${parts.background.id} (${sheet})`, renderScene({ ...parts, placement, mode: sheet === 'print' ? 'print' : 'thumb', fills: fillsFor(parts) })]);
  cols = 1;
} else {
  console.error(`Unknown --sheet ${sheet}`);
  process.exit(1);
}

const cell = sheet === 'scene' || sheet === 'print' ? Math.max(size, 700) : size;
cols = Math.min(cols, cells.length);
const rows = Math.ceil(cells.length / cols);
const html = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#eee;font:13px sans-serif}
  .g{display:grid;grid-template-columns:repeat(${cols},${cell}px);gap:8px;padding:8px}
  .c{background:#fff;border:1px solid #bbb}
  .c svg{width:${cell}px;height:${cell}px;display:block}
  .l{padding:3px 6px;border-top:1px solid #ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style><div class="g">${cells.map(([label, svg]) => `<div class="c">${svg}<div class="l">${esc(label)}</div></div>`).join('')}</div>`;

const tmp = path.join(os.tmpdir(), `ll-render-${process.pid}.html`);
fs.writeFileSync(tmp, html);
const width = cols * (cell + 8) + 8;
const height = rows * (cell + 30) + 16;
const b = await launch({ width, height, touch: false, serve: false });
try {
  await b.goto(pathToFileURL(tmp).href, { wait: 200 });
  await b.screenshot(out);
  console.log(`Wrote ${out} (${cells.length} cells)`);
} finally {
  await b.close();
  fs.rmSync(tmp, { force: true });
}

#!/usr/bin/env node
// Collect every line the app can speak, for the recorded voice pack.
//
//   node tools/voice-lines.mjs           write tools/voice/lines.json (input for tools/voice/make_voice.py)
//   node tools/voice-lines.mjs --check   exit 1 if any line has no recording in the voice pack
//   node tools/voice-lines.mjs --list    print the lines
//
// Sources:
//   1. content data: robot level say/hint, coloring item say, Loop Machine tier/round say/hint/explain,
//      locked-game lines from data/app.json
//   2. phrases written in the code (js/**/*.js): string literals that look like spoken sentences
//      (start with a capital letter, end with . ! or ?) — over-collecting a few is harmless
//   3. lines the code assembles: Loop Machine read-aloud parts (tokens.js choicesParts/wordsParts:
//      every choice in every position, every word both mid-list "ago," and last "ago."), finished
//      sentences, the end-of-game star counts that can happen, coloring colour names
// Anything still missed is spoken with the device voice. At runtime every line passed to say()
// without a recording is recorded in speech.unrecorded (spoken, queued or dropped by an interrupt),
// and tools/smoke-test.mjs fails if a played-through game hit one.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ROOT } from './serve.mjs';
import { speechKey } from '../js/core/speech.js';
import { choicesParts, wordsParts, isPicture } from '../js/modules/machine/tokens.js';
import { sayOf } from '../js/modules/coloring/parts.js';
import { prepareData } from '../js/modules/machine/rounds.js';

const fileFor = (key) => `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)}.mp3`;

/** Every spoken line: [{ key, text, file, sources }], sorted by key. */
export function collectLines(root = APP_ROOT) {
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8').replace(/^﻿/, ''));
const lines = new Map(); // key -> { text, sources:Set }

function add(text, source) {
  if (text == null) return;
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (!t || !/[a-z0-9]/i.test(t)) return;
  const key = speechKey(t);
  if (!lines.has(key)) lines.set(key, { text: t, sources: new Set() });
  lines.get(key).sources.add(source);
}

// ---- 1. content data -------------------------------------------------------------------------
const registry = read('data/app.json');
for (const m of registry.modules || []) {
  if (m.status !== 'ready') add(m.lockedSay || `${m.title} is coming soon!`, 'data/app.json');
}

const levels = read('data/robot/levels.json');
for (const l of levels.levels || []) { add(l.say, 'levels'); add(l.hint, 'levels'); }

for (const f of ['animals', 'accessories', 'backgrounds']) {
  // exactly what the picker says: the item's `say`, else "<name>!" (parts.js sayOf)
  for (const it of read(`data/coloring/${f}.json`).items || []) add(sayOf(it), `coloring/${f}`);
}

const machine = read('data/machine/rounds.json');
for (const t of machine.tiers || []) add(t.say, 'machine tiers');
for (const r of machine.rounds || []) {
  add(r.say, 'machine'); add(r.hint, 'machine'); add(r.explain, 'machine');
  if (r.type === 'order' && Array.isArray(r.words)) {
    add(r.words.join(' '), 'machine sentence');                 // the finished sentence, read back
    // "The words are: ..." lists the cards in their scrambled tray order (wordsParts), so ANY word
    // can be mid-list ("ago,") or last ("ago."): record every word both ways.
    const [intro, ...listed] = wordsParts(r.words); // the app's own cleaning; each ends in ',' or '.'
    add(intro, 'machine read-aloud');
    for (const p of listed) {
      const word = p.slice(0, -1);
      add(`${word},`, 'machine read-aloud');
      add(`${word}.`, 'machine read-aloud');
    }
  } else if (Array.isArray(r.choices)) {
    // "which group has more" (picture groups) is not read aloud
    if (r.choices.some((c) => Array.isArray(c) && c.every(isPicture))) continue;
    // choices are shown (and read) in a shuffled order: every choice in every position
    for (const c of r.choices) {
      for (const p of choicesParts([c, c])) add(p, 'machine read-aloud');
    }
    add('Is it', 'machine read-aloud');
  }
}
// End-of-session star counts (session.js finish(): "You earned 8 gold stars and 2 silver stars!").
// Every round of a session ends gold or silver, so golds + silvers = the session's length, which
// buildSession() makes min(sessionLength, rounds in that tier). The same prepareData() as the game
// reads rounds.json, so only totals that can really happen are recorded.
const plural = (n, w) => `${n} ${w} star${n === 1 ? '' : 's'}`;
const md = prepareData(machine, () => {});
const totals = new Set(md.tiers.map((t) => Math.min(md.sessionLength, (md.byTier[t.id] || []).length)).filter((n) => n > 0));
for (const total of totals) {
  for (let g = 0; g <= total; g++) {
    const s = total - g;
    add(g && s ? `You earned ${plural(g, 'gold')} and ${plural(s, 'silver')}!` : g ? `You earned ${plural(g, 'gold')}!` : `You earned ${plural(s, 'silver')}!`, 'machine end');
  }
}

// Coloring colour names ("Red!")
const colorsSrc = fs.readFileSync(path.join(root, 'js/modules/coloring/colors.js'), 'utf8');
for (const m of colorsSrc.matchAll(/name:\s*'([^']+)'/g)) add(`${m[1]}!`, 'coloring colors');

// ---- 2. phrases in the code ------------------------------------------------------------------
function* jsFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsFiles(p);
    else if (e.name.endsWith('.js')) yield p;
  }
}
const LITERAL = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.|\$(?!\{))*)`/g;
const SPOKEN = /^[A-Z][^<>{}=#\\/@|_]*[.!?]$/;
// Text that looks like a sentence but is only ever shown (settings notes, labels, a confirm box):
// mark its source line with a trailing `// not spoken` comment so it isn't recorded and shipped.
// Never put that marker on a line that also speaks something.
const NOT_SPOKEN = /\/\/\s*not spoken\b/;
for (const file of jsFiles(path.join(root, 'js'))) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*') || /console\.(warn|error|log)|throw new Error/.test(line)) continue;
    if (NOT_SPOKEN.test(line)) continue;
    for (const m of line.matchAll(LITERAL)) {
      const s = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(['"`\\])/g, '$1').replace(/\\u2019/g, '’');
      if (s.length < 2 || s.length > 120 || !SPOKEN.test(s) || !/[aeiouy]/i.test(s)) continue;
      add(s, rel);
    }
  }
}

return [...lines.entries()]
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([key, v]) => ({ key, text: v.text, file: fileFor(key), sources: [...v.sources].sort() }));
}

/** { name, total, missing: [line] } — lines with no recording in the voice pack named in js/config.js. */
export async function checkVoice(root = APP_ROOT) {
  const out = collectLines(root);
  const { voicePack } = (await import(new URL('../js/config.js', import.meta.url).href)).APP;
  const idxPath = path.join(root, voicePack);
  let idx = null;
  try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch { idx = null; }
  const have = new Map(Object.entries((idx && idx.lines) || {}));
  const dir = path.dirname(idxPath);
  const missing = out.filter((l) => !have.has(l.key) || !fs.existsSync(path.join(dir, have.get(l.key))));
  return { name: idx ? idx.name || idx.voice : null, pack: voicePack, total: out.length, missing };
}

// ---- CLI ---------------------------------------------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const args = isMain ? process.argv.slice(2) : [];
const out = isMain ? collectLines() : [];
if (!isMain) {
  // imported (tools/validate.mjs, tools/voice.mjs): nothing to do
} else if (args.includes('--list')) {
  for (const l of out) console.log(`${l.text}    [${l.sources.join(', ')}]`);
  console.log(`\n${out.length} lines`);
} else if (args.includes('--check')) {
  const r = await checkVoice();
  if (!r.name) { console.error(`voice: no voice pack index at ${r.pack}`); process.exit(1); }
  if (r.missing.length) {
    console.error(`voice: ${r.missing.length} of ${r.total} line(s) have no recording, e.g.:`);
    r.missing.slice(0, 15).forEach((l) => console.error(`  - ${l.text}   [${l.sources.join(', ')}]`));
    console.error('Run: npm run voice   (records the missing lines; see README "Voice")');
    process.exit(1);
  }
  console.log(`voice: all ${r.total} lines are recorded (${r.name})`);
} else {
  const dest = path.join(APP_ROOT, 'tools/voice/lines.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${JSON.stringify(out.map(({ key, text, file }) => ({ key, text, file })), null, 1)}\n`);
  const bySource = {};
  for (const l of out) for (const s of l.sources) bySource[s] = (bySource[s] || 0) + 1;
  console.log(`voice: ${out.length} lines -> tools/voice/lines.json`);
  console.log(Object.entries(bySource).sort((a, b) => b[1] - a[1]).map(([s, n]) => `  ${String(n).padStart(4)}  ${s}`).join('\n'));
}

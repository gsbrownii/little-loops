#!/usr/bin/env node
// End-to-end smoke test in headless Chrome (tools/cdp.mjs). Zero dependencies.
//
//   node tools/smoke-test.mjs            # everything (~7 min)
//   node tools/smoke-test.mjs --quick    # skip the layout sweep and the offline/sub-path checks
//   node tools/smoke-test.mjs --only voice   # only the sections whose function name contains "voice"
//
// Covers: start screen + home, parent gate -> settings, Robot Puzzles (drag, tap, repeat blocks,
// a miss + hint, success, progress), Coloring (wizard, fill, undo, print via the gate), Loop Machine
// (a full 10-round session in every tier incl. word-order rounds, wrong answers + hint), double-taps
// across screen changes, recovery from failed downloads (registry, game code, stylesheet), a layout
// sweep (no page scroll, every touch target >= 64px, an instruction on every screen) at phone and
// tablet sizes in both orientations, offline mode via the service worker (incl. Range answers and
// the voice index cached with the app), the GitHub Pages sub-path, and no console errors anywhere.
// Voice: every line said (and what the speaker button repeats) has a recording, read-aloud on,
// nothing speaks while hidden, and the speech engine under stubbed failures (interrupts during
// loading, stalled clips, refused <audio>, a suspended AudioContext, decoded-clip memory).
// Exit code 1 on any failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from './cdp.mjs';
import { APP_ROOT } from './serve.mjs';
import { speechKey } from '../js/core/speech.js';
import { collectLines } from './voice-lines.mjs';
import { wordsParts } from '../js/modules/machine/tokens.js';
import { readSW } from './precache.mjs';

const QUICK = process.argv.includes('--quick');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] || '' : null; // e.g. --only Voice
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(APP_ROOT, p), 'utf8').replace(/^﻿/, ''));
const registry = readJSON('data/app.json');
const levels = readJSON('data/robot/levels.json').levels;
const machine = readJSON('data/machine/rounds.json');
const voicePackPath = (await import(pathToFileURL(path.join(APP_ROOT, 'js/config.js')).href)).APP.voicePack;
const packLines = readJSON(voicePackPath).lines || {};
const SPEECH = "import(new URL('js/core/speech.js', document.baseURI).href).then((m) => m.speech)";
const notSpeaking = (b, timeout = 15000) => b.waitFor(`${SPEECH}.then((s) => !s.speaking)`, { timeout }).catch(() => {});

let failures = 0;
let passes = 0;
const pass = (msg) => { passes++; console.log(`  PASS  ${msg}`); };
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };
const check = (ok, msg, detail = '') => (ok ? pass(msg) : fail(detail ? `${msg} -- ${detail}` : msg));
const section = (t) => console.log(`\n${t}`);

// Console noise we accept (none expected today; keep the list explicit).
const BENIGN = [/favicon\.ico/];
/**
 * Recorded voice: no line passed to speech (spoken, queued or dropped by an interrupt) lacks a
 * recording, and clips really played. First taps the speaker button, so what replay says (the
 * screen's instruction) is covered too.
 */
async function voiceCheck(b, where, { expectClips = true, replay = true } = {}) {
  if (replay) {
    await b.waitFor(TAPS_OK, { timeout: 5000 }).catch(() => {});
    const can = await b.eval("(() => { const r = document.querySelector('.topbar-replay'); return !!r && !r.hidden && r.getBoundingClientRect().width > 0; })()");
    if (can) {
      await b.tap('.topbar-replay', { wait: 300 });
      await notSpeaking(b);
    }
  }
  await b.sleep(400);
  const v = await b.eval(`import(new URL('js/core/speech.js', document.baseURI).href).then((m) => ({
    pack: !!m.speech.packInfo(), missing: [...m.speech.missing], unrecorded: [...m.speech.unrecorded], stats: { ...m.speech.stats } }))`);
  if (!v.pack) { fail(`voice pack loaded (${where})`); return; }
  const gaps = [...new Set([...v.missing, ...v.unrecorded])];
  check(gaps.length === 0, `every spoken line has a recording (${where})`, gaps.slice(0, 4).map((t) => JSON.stringify(t)).join(', '));
  if (expectClips) check(v.stats.started > 0 && v.stats.clipErrors === 0 && v.stats.device === 0, `recorded voice plays (${where})`, JSON.stringify(v.stats));
}

function checkErrors(b, where) {
  const errs = b.errors.filter((e) => !BENIGN.some((re) => re.test(e)));
  check(errs.length === 0, `no console errors (${where})`, errs.slice(0, 5).join(' | '));
  b.errors.length = 0;
}

// After every screen change the app ignores taps for a moment (js/core/tapguard.js: a double-tap
// must not act on the next screen). A test tap that follows a route change waits for it to end.
const TAPS_OK = '!document.body.dataset.tapGuard';
const tapsOk = (b) => b.waitFor(TAPS_OK, { timeout: 5000 });

async function start(b, where = '') {
  await b.goto(where);
  await b.tap('.splash-play');
  await b.waitFor("document.body.dataset.screen === 'home' || (location.hash.length > 2 && !!document.body.dataset.screen)");
  await tapsOk(b);
}

async function go(b, hash, screen) {
  await b.eval(`location.hash = ${JSON.stringify(hash)}`);
  await b.waitFor(`document.body.dataset.screen === ${JSON.stringify(screen)} && !!document.querySelector('.screen-root')`);
  await b.sleep(500);
  await tapsOk(b);
}

const storage = (b) => b.eval("JSON.parse(localStorage.getItem('littleloops:v1') || '{}')");

// Pretend the app went to the background / came back (speech.js only reads document.hidden).
const HIDE_PAGE = `(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
  return true;
})()`;
const SHOW_PAGE = `(() => {
  delete document.hidden;
  delete document.visibilityState;
  document.dispatchEvent(new Event('visibilitychange'));
  return true;
})()`;

// A puzzle stays locked until the one before it is solved, also when opened by URL. Tests that
// jump straight to a later level turn on the grown-up setting "Unlock all puzzle levels" first.
const unlockAllPuzzles = (b) => b.eval("import('./js/core/storage.js').then((m) => { m.storage.set('robot.unlockAll', true); return true; })");

/** Page-side audit: page scroll, touch-target sizes, instruction caption. */
const AUDIT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden]'); };
  const sel = 'button, [role="button"], .rb-pal, .rb-slot, .mc-ans, .mc-word, .swatch, .wiz-tile, .tile';
  const small = [...document.querySelectorAll('#app ' + sel.split(', ').join(', #app '))]
    .filter((el) => vis(el) && !el.closest('.settings') && !el.closest('.rb-block-body'))
    .map((el) => { const r = el.getBoundingClientRect(); return { el, w: r.width, h: r.height }; })
    .filter((x) => x.w < 63.5 || x.h < 63.5)
    .map((x) => (x.el.className.baseVal ?? x.el.className) + ' ' + Math.round(x.w) + 'x' + Math.round(x.h));
  const se = document.scrollingElement;
  const root = document.querySelector('.screen-root');
  return {
    pageScroll: se.scrollHeight - innerHeight,
    pageScrollX: se.scrollWidth - innerWidth,
    small: [...new Set(small)].slice(0, 6),
    caption: (document.querySelector('.topbar-caption') || {}).textContent || '',
    oops: !!document.querySelector('.oops'),
  };
})()`;

// ---------------------------------------------------------------------------------------------
async function testCore() {
  section('Start screen, home, parent gate, settings');
  const b = await launch({ width: 390, height: 844, touch: true });
  try {
    await b.goto();
    check(await b.eval("!!document.querySelector('.splash-play') && document.body.classList.contains('is-splash')"), 'start screen shows the play button');
    await b.tap('.splash-play');
    await b.waitFor("document.body.dataset.screen === 'home'");
    await tapsOk(b);
    const tiles = await b.eval("[...document.querySelectorAll('.tile')].map(t => t.dataset.id + ':' + t.dataset.status)");
    check(tiles.length === registry.modules.length, `home shows ${registry.modules.length} tiles`, tiles.join(','));
    const art404 = await b.eval("[...document.querySelectorAll('.tile img')].filter(i => !i.complete || !i.naturalWidth).length");
    check(art404 === 0, 'all home tile art loads');
    check((await b.eval(AUDIT)).caption.length > 0, 'home speaks an instruction (caption set)');
    // locked tile: stays home
    await b.tap('.tile[data-status="locked"]');
    check(await b.eval("document.body.dataset.screen") === 'home', 'locked tile stays on home');
    // parent gate: cancel, then a short hold, then a full hold
    await b.tap('.btn-gear');
    check(await b.eval("!!document.querySelector('.gate')"), 'gear opens the parent gate');
    await b.hold('.gate-hold', 1200);
    check(await b.eval("!!document.querySelector('.gate') && document.body.dataset.screen === 'home'"), 'a 1.2 s hold does not open settings');
    await b.hold('.gate-hold', 3400);
    await b.sleep(500);
    check(await b.eval("document.body.dataset.screen") === 'settings', '3 s hold opens settings (and the release does not click through)');
    const st = await storage(b);
    check(!st.settings, 'gate release did not flip any setting', JSON.stringify(st));
    // The page appears at once; each game's section arrives with its code (in any order).
    await b.waitFor("(() => { const s = document.querySelector('.settings'); return !!s && /Unlock all puzzle levels/i.test(s.innerText) && /Read word answers aloud/i.test(s.innerText); })()", { timeout: 10000 }).catch(() => {});
    const sectionsText = await b.eval("(document.querySelector('.settings') || {}).innerText || ''");
    check(/Unlock all puzzle levels/i.test(sectionsText), 'robot setting listed');
    check(/Read word answers aloud/i.test(sectionsText), 'Loop Machine setting listed');
    // direct #/settings without the gate is refused
    await b.eval("location.hash = '#/'"); await b.waitFor("document.body.dataset.screen === 'home'");
    await b.eval("location.hash = '#/settings'"); await b.sleep(600);
    check(await b.eval("document.body.dataset.screen") === 'home', 'typing #/settings without the gate goes home');
    await voiceCheck(b, 'core');
    checkErrors(b, 'core');
  } finally { await b.close(); }
}

// ---------------------------------------------------------------------------------------------
async function buildProgram(b, program) {
  for (const step of program) {
    if (typeof step === 'string') {
      await b.tap(`.rb-pal[data-card="${step}"]`, { wait: 220 });
    } else {
      await b.tap(`.rb-pal[data-card="repeat${step.repeat}"]`, { wait: 220 });
      for (const d of step.do) await b.tap(`.rb-pal[data-card="${d}"]`, { wait: 220 });
    }
  }
}

async function testRobot() {
  section('Robot Puzzles');
  const b = await launch({ width: 1024, height: 768, touch: true });
  try {
    await start(b);
    await go(b, '#/robot', 'robot');
    check(await b.eval("document.querySelectorAll('.rb-lvl-num').length") === levels.length, `level select shows ${levels.length} levels`);
    // Level 1 by DRAGGING the card into the strip
    await go(b, '#/robot/1', 'robot');
    const card = levels[0].solution[0];
    await b.drag(`.rb-pal[data-card="${card}"]`, '.rb-strip', { steps: 14, wait: 400 });
    const placed = await b.eval("document.querySelectorAll('.rb-strip [data-card]').length");
    check(placed === 1, 'drag a card into the strip');
    await b.tap('.rb-play');
    await b.waitFor("!!document.querySelector('.rb-win')", { timeout: 15000 }).then(() => pass('level 1 solved by dragging'), () => fail('level 1 solved by dragging'));
    check((await storage(b)).robot?.done?.[levels[0].id] === true, 'level 1 progress saved');
    // The speaker button after a win repeats "<praise> Tap the green arrow for the next puzzle!"
    // as its two recordings (never one joined line for the device voice).
    await notSpeaking(b);
    const winCaption = await b.eval("document.querySelector('.topbar-caption').textContent");
    const before = await b.eval(`${SPEECH}.then((s) => ({ ...s.stats }))`);
    await tapsOk(b);
    await b.tap('.topbar-replay', { wait: 300 });
    await notSpeaking(b);
    const after = await b.eval(`${SPEECH}.then((s) => ({ stats: { ...s.stats }, unrecorded: [...s.unrecorded] }))`);
    check(/Tap the green arrow/.test(winCaption) && after.stats.started >= before.started + 2 && after.stats.device === before.device
      && !after.unrecorded.some((k) => /green arrow/.test(k)), 'replay after a win plays the recorded praise + next-puzzle lines', `${winCaption} ${JSON.stringify({ before, after })}`);
    // Nothing talks while the app is hidden: lines a game timer asks for then are dropped, and
    // the instruction is said again on return.
    await go(b, '#/robot', 'robot');
    await go(b, '#/robot/1', 'robot');
    await b.tap(`.rb-pal[data-card="${card}"]`, { wait: 250 });
    check(!(await b.eval("!!document.querySelector('.rb-win')")), 'level 1 opens fresh (no win card yet)');
    await b.tap('.rb-play', { wait: 0 });
    await b.eval(HIDE_PAGE);
    const hidden0 = await b.eval(`${SPEECH}.then((s) => ({ ...s.stats }))`);
    const won = await b.waitFor("!!document.querySelector('.rb-win')", { timeout: 15000 }).then(() => true, () => false);
    await b.sleep(3000); // the win line (after ~0.75 s) and the queued next-puzzle line
    const hidden1 = await b.eval(`${SPEECH}.then((s) => ({ ...s.stats }))`);
    check(won && hidden1.started === hidden0.started && hidden1.device === hidden0.device && hidden1.hidden >= hidden0.hidden + 2,
      'nothing speaks while the app is hidden (the win lines are dropped)', JSON.stringify({ won, hidden0, hidden1 }));
    await b.eval(SHOW_PAGE);
    await b.sleep(800);
    const shown = await b.eval(`${SPEECH}.then((s) => ({ ...s.stats }))`);
    check(shown.started > hidden1.started, 'back from hidden: the instruction is said again', JSON.stringify({ hidden1, shown }));
    await notSpeaking(b);
    // A wrong program twice -> robot stays put, then the hint appears (level 2)
    await go(b, '#/robot/2', 'robot');
    const wrongCard = ['up', 'down', 'left', 'right'].find((c) => levels[1].cards.includes(c) && c !== levels[1].solution[0]) || levels[1].cards[0];
    for (let i = 0; i < 2; i++) {
      await b.eval("(() => { const c = [...document.querySelectorAll('#topbar button')].find(x => /clear/i.test(x.getAttribute('aria-label') || '')); if (c) c.click(); })()");
      await b.sleep(250);
      await b.tap(`.rb-pal[data-card="${wrongCard}"]`, { wait: 250 });
      await b.tap('.rb-play');
      await b.waitFor("!document.querySelector('.rb-play.is-running')", { timeout: 12000 });
      await b.sleep(900);
    }
    check(!(await b.eval("!!document.querySelector('.rb-win')")), 'a wrong program does not win');
    const hintDots = await b.eval("(() => { const l = document.querySelector('.rb-hint-layer'); return l ? l.querySelectorAll('*').length : 0; })()");
    check(hintDots > 0, 'hint path appears after 2 misses');
    // Loop levels by TAPPING their reference solution (first loop level, first 2-arrow-body level, finale)
    await unlockAllPuzzles(b);
    const loopIdx = levels.findIndex((l) => l.cards.some((c) => c.startsWith('repeat')));
    const twoBodyIdx = levels.findIndex((l) => (l.solution || []).some((s) => typeof s === 'object' && s.do.length >= 2));
    for (const idx of [...new Set([loopIdx, twoBodyIdx, levels.length - 1])].filter((i) => i >= 0)) {
      await go(b, `#/robot/${idx + 1}`, 'robot');
      await buildProgram(b, levels[idx].solution);
      await b.tap('.rb-play');
      const ok = await b.waitFor("!!document.querySelector('.rb-win')", { timeout: 25000 }).then(() => true, () => false);
      check(ok, `level ${idx + 1} (${levels[idx].id}) solved with its reference program`);
    }
    await voiceCheck(b, 'robot');
    checkErrors(b, 'robot');
  } finally { await b.close(); }
}

// ---------------------------------------------------------------------------------------------
async function testColoring() {
  section('Coloring');
  const b = await launch({ width: 390, height: 844, touch: true });
  try {
    await start(b);
    await go(b, '#/coloring', 'coloring');
    for (let step = 1; step <= 3; step++) {
      await b.waitFor("document.querySelectorAll('.wiz-tile').length > 0");
      await b.sleep(400);
      await b.tap(`.wiz-tile:nth-of-type(${step + 1})`, { wait: 1200 });
    }
    const onPaint = await b.waitFor("!!document.querySelector('.paint-stage [data-region]')", { timeout: 8000 }).then(() => true, () => false);
    check(onPaint, 'wizard (animal -> accessory -> place) leads to the paint screen');
    await tapsOk(b);
    await b.tap('.swatch[data-color]:first-child');
    const target = await b.eval(`(() => {
      const regs = [...document.querySelectorAll('.paint-stage [data-region]')].map(el => ({ el, r: el.getBoundingClientRect() }))
        .filter(x => x.r.width > 40 && x.r.height > 40).sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
      const x = regs[Math.min(3, regs.length - 1)]; if (!x) return null;
      // a point that really hits this region
      for (let i = 1; i < 10; i++) for (let j = 1; j < 10; j++) {
        const px = x.r.left + x.r.width * i / 10, py = x.r.top + x.r.height * j / 10;
        if (document.elementFromPoint(px, py) === x.el) return { id: x.el.dataset.region, x: px, y: py, before: x.el.getAttribute('fill') };
      }
      return null;
    })()`);
    if (!target) { fail('found a tappable region'); } else {
      await b.tap({ x: target.x, y: target.y }, { wait: 400 });
      const after = await b.eval(`document.querySelector('[data-region="${target.id}"]').getAttribute('fill')`);
      check(after.toUpperCase() !== target.before.toUpperCase(), 'tapping a region fills it', `${target.before} -> ${after}`);
      await b.tap('.paint-undo', { wait: 400 });
      const undone = await b.eval(`document.querySelector('[data-region="${target.id}"]').getAttribute('fill')`);
      check(undone.toUpperCase() === target.before.toUpperCase(), 'undo restores the colour');
      await b.tap({ x: target.x, y: target.y }, { wait: 600 });
    }
    // Print behind the parent gate (window.print stubbed)
    await b.eval("window.print = () => { window.__printed = (window.__printed || 0) + 1; window.__printSVG = document.querySelector('#print-root svg') ? document.querySelector('#print-root svg').outerHTML : ''; }");
    await b.tap('.col-print');
    check(await b.eval("!!document.querySelector('.gate')"), 'print asks for the parent gate');
    await b.hold('.gate-hold', 3400);
    await b.sleep(900);
    check(await b.eval('window.__printed') === 1, 'print runs after the gate');
    const printOk = await b.eval(`(() => { const s = window.__printSVG || ''; const fills = [...s.matchAll(/class="region"[^>]*fill="([^"]+)"|fill="([^"]+)"[^>]*data-region/g)];
      return s.length > 1000 && !/data-region/.test(s) ? 'clean' : (s.length ? 'has-data-region' : 'empty'); })()`);
    check(printOk === 'clean', 'print output is a clean outline svg', printOk);
    // Fills survive a reload
    await b.reload();
    await b.tap('.splash-play');
    await b.waitFor("!!document.body.dataset.screen");
    await go(b, '#/coloring/paint', 'coloring');
    if (target) {
      const kept = await b.eval(`(() => { const el = document.querySelector('[data-region="${target.id}"]'); return el && el.getAttribute('fill'); })()`);
      check(kept && kept.toUpperCase() !== target.before.toUpperCase(), 'colours are saved across a reload', String(kept));
    }
    await voiceCheck(b, 'coloring');
    checkErrors(b, 'coloring');
  } finally { await b.close(); }
}

// ---------------------------------------------------------------------------------------------
async function answerRound(b, { wrongFirst = false } = {}) {
  await b.waitFor("(() => { const p = document.querySelector('.mc-play'); return p && (p.dataset.state === 'ready' || p.dataset.state === 'done'); })()", { timeout: 20000 });
  await tapsOk(b);
  const st = await b.eval("(() => { const p = document.querySelector('.mc-play'); return { id: p.dataset.roundId, state: p.dataset.state }; })()");
  if (st.state === 'done') return { done: true };
  const round = machine.rounds.find((r) => r.id === st.id);
  if (!round) return { error: `unknown round id ${st.id}` };
  let hinted = null;
  if (round.type === 'order') {
    for (const w of round.words) {
      const ok = await b.eval(`(() => { const el = [...document.querySelectorAll('.mc-tray .mc-word')].find(e => e.dataset.word === ${JSON.stringify(w)}); if (!el) return false; el.id = '__w'; return true; })()`);
      if (!ok) return { error: `word card not found: ${w} (${round.id})` };
      await b.tap('#__w', { wait: 260 });
      await b.eval("(() => { const e = document.getElementById('__w'); if (e) e.removeAttribute('id'); })()");
    }
  } else {
    const key = JSON.stringify(round.answer);
    if (wrongFirst) {
      const before = await b.eval("[...document.querySelectorAll('.mc-ans')].filter(a => !a.disabled).length");
      for (let i = 0; i < 2; i++) {
        const wrong = await b.eval(`(() => { const el = [...document.querySelectorAll('.mc-ans')].find(a => !a.disabled && a.dataset.choice !== ${JSON.stringify(key)}); if (!el) return false; el.id = '__x'; return true; })()`);
        if (!wrong) break;
        await b.tap('#__x', { wait: 900 });
        await b.eval("(() => { const e = document.getElementById('__x'); if (e) e.removeAttribute('id'); })()");
        await b.waitFor("document.querySelector('.mc-play').dataset.state === 'ready'", { timeout: 8000 }).catch(() => {});
      }
      const after = await b.eval("[...document.querySelectorAll('.mc-ans')].filter(a => !a.disabled).length");
      hinted = { before, after };
    }
    const found = await b.eval(`(() => { const el = [...document.querySelectorAll('.mc-ans')].find(a => a.dataset.choice === ${JSON.stringify(key)}); if (!el) return false; el.id = '__a'; return true; })()`);
    if (!found) return { error: `answer button not found for ${round.id}` };
    await b.tap('#__a', { wait: 200 });
  }
  await b.waitFor(`(() => { const p = document.querySelector('.mc-play'); return !p || p.dataset.roundId !== ${JSON.stringify(st.id)} || p.dataset.state === 'done'; })()`, { timeout: 20000 });
  return { id: st.id, type: round.type, hinted };
}

async function testMachine() {
  section('Loop Machine');
  const b = await launch({ width: 390, height: 844, touch: true });
  try {
    await start(b);
    // "Read word answers aloud" on: the read-aloud lines (answer choices, and word-order cards in
    // their scrambled order) are said too, so the voice check covers them.
    await b.eval("import('./js/core/storage.js').then((m) => { m.storage.set('machine.readAloud', true); return true; })");
    const tiers = machine.tiers.map((t) => t.id);
    for (let i = 0; i < tiers.length; i++) {
      await go(b, '#/machine', 'machine');
      check(await b.eval("document.querySelectorAll('.mc-tier').length") === tiers.length, `tier picker shows ${tiers.length} machines`);
      await b.tap(`.mc-tier:nth-of-type(${i + 1})`, { wait: 600 });
      const types = new Set();
      let rounds = 0;
      let error = null;
      let hintInfo = null;
      for (let k = 0; k < machine.sessionLength + 2; k++) {
        // Two wrong taps on the first answer-button round from round 2 on (word-order rounds have
        // no answer buttons, so a session that opens with one tries the next round instead).
        const r = await answerRound(b, { wrongFirst: k >= 1 && !hintInfo });
        if (r.done) break;
        if (r.error) { error = r.error; break; }
        rounds++;
        types.add(r.type);
        if (r.hinted) hintInfo = r.hinted;
      }
      const done = await b.waitFor("document.querySelector('.mc-play') && document.querySelector('.mc-play').dataset.state === 'done'", { timeout: 15000 }).then(() => true, () => false);
      check(!error && done && rounds === machine.sessionLength, `${tiers[i]} machine: full ${machine.sessionLength}-round session completes`, error || `rounds=${rounds} done=${done}`);
      // The wrong answers tapped (2, or the only one in a 2-choice round) grey out and stay visible.
      check(!!hintInfo && hintInfo.before - hintInfo.after >= Math.min(2, hintInfo.before - 1), `${tiers[i]}: 2 wrong answers grey out`, hintInfo ? JSON.stringify(hintInfo) : 'no answer-button round after round 1');
      console.log(`        round types played: ${[...types].join(', ')}`);
      const best = (await storage(b)).machine?.best?.[tiers[i]];
      check(best != null, `${tiers[i]}: best score saved`, String(best));
    }
    await voiceCheck(b, 'machine');
    checkErrors(b, 'machine');
  } finally { await b.close(); }
}

// ---------------------------------------------------------------------------------------------
async function testLayouts() {
  section('Layout sweep (no page scroll, touch targets >= 64px, an instruction on every screen)');
  const screens = [
    ['#/', 'home'], ['#/robot', 'robot'], ['#/robot/1', 'robot'], [`#/robot/${levels.length}`, 'robot'],
    ['#/coloring', 'coloring'], ['#/coloring/paint', 'coloring'], ['#/machine', 'machine'], ['#/machine/super', 'machine'],
  ];
  const viewports = [[360, 640], [640, 360], [390, 844], [844, 390], [768, 1024], [1024, 768], [1366, 1024]];
  const b = await launch({ width: 360, height: 640, touch: true });
  try {
    await start(b);
    await unlockAllPuzzles(b);
    for (const [w, h] of viewports) {
      await b.setViewport(w, h);
      const problems = [];
      for (const [hash, screen] of screens) {
        await go(b, hash, screen);
        if (hash === `#/robot/${levels.length}`) await buildProgram(b, levels[levels.length - 1].solution);
        if (hash === '#/machine/super') {
          // Measure the answers at rest: wait until the round's intro is over (belt tokens slide in
          // one by one, ~2 s for a long loop) and the answers' entrance pop (scale 0.5 -> 1) has
          // finished. A fixed sleep can land mid-pop, where a 100x118 button measures 50x59.
          await b.waitFor("(() => { const p = document.querySelector('.mc-play'); return !!p && p.dataset.state === 'ready'; })()", { timeout: 15000 });
          await b.waitFor("!document.getAnimations().some((a) => a.playState === 'running' && a.effect && a.effect.target && a.effect.target.closest && !!a.effect.target.closest('.mc-panel') && Number.isFinite(a.effect.getComputedTiming().endTime))", { timeout: 5000 });
        }
        const a = await b.eval(AUDIT);
        if (a.oops) problems.push(`${hash}: error screen`);
        if (a.pageScroll > 1 || a.pageScrollX > 1) problems.push(`${hash}: page scrolls ${a.pageScrollX}x${a.pageScroll}`);
        if (a.small.length) problems.push(`${hash}: small targets ${a.small.join('; ')}`);
        if (!a.caption.trim()) problems.push(`${hash}: no instruction`);
      }
      check(problems.length === 0, `${w}x${h}`, problems.join(' || '));
    }
    checkErrors(b, 'layout sweep');
  } finally { await b.close(); }
}

// ---------------------------------------------------------------------------------------------
async function testOffline() {
  section('Offline (service worker) and GitHub Pages sub-path');
  for (const base of ['/', '/little-loops/']) {
    const b = await launch({ width: 1024, height: 768, touch: true, base });
    try {
      await b.goto();
      const ready = await b.eval("navigator.serviceWorker.ready.then(() => true)");
      await b.reload();
      await b.waitFor('!!navigator.serviceWorker.controller', { timeout: 15000 });
      check(ready, `service worker installs (${base})`);
      await b.offline(true);
      await b.reload();
      await b.tap('.splash-play');
      await b.waitFor("document.body.dataset.screen === 'home'");
      const bad = [];
      for (const [hash, screen] of [['#/robot/1', 'robot'], ['#/coloring/paint', 'coloring'], ['#/machine/little', 'machine']]) {
        await go(b, hash, screen);
        await b.sleep(400);
        const a = await b.eval(AUDIT);
        if (a.oops) bad.push(hash);
      }
      check(bad.length === 0, `all games open offline (${base})`, bad.join(','));
      await voiceCheck(b, `offline ${base}`); // clips must play from the offline cache (range requests)
      // The voice pack's index and the unlock clip are cached with the app (core, no ?v=), and
      // the worker answers lookups exactly (a ?query on a core file still finds it).
      const sample = Object.values(packLines)[0];
      const errorsBefore = b.errors.length;
      const sw = await b.eval(`(async () => {
        const names = (await caches.keys()).filter((n) => n.startsWith('little-loops-'));
        const keys = names.length ? (await (await caches.open(names[0])).keys()).map((r) => r.url) : [];
        const abs = (p) => new URL(p, document.baseURI).href;
        const q = await fetch(abs('data/app.json?x=1')).then((r) => r.status, () => 0);
        const clip = abs(${JSON.stringify(`${path.posix.dirname(voicePackPath)}/${sample}`)});
        const size = (await (await fetch(clip)).arrayBuffer()).byteLength;
        const range = {};
        for (const h of ['bytes=0-', 'Bytes=0-1', 'bytes=-100', 'bytes=0-1,5-6', 'items=0-1', 'bytes=100-50', 'bytes=' + size + '-', 'bytes=-0']) {
          const r = await fetch(clip, { headers: { Range: h } });
          range[h] = r.status + ':' + (await r.arrayBuffer()).byteLength;
        }
        return { index: keys.includes(abs(${JSON.stringify(voicePackPath)})), silence: keys.includes(abs('audio/silence.mp3')), q, size, range };
      })()`);
      check(sw.index && sw.silence, `voice index + silence.mp3 are cached with the app (${base})`, JSON.stringify(sw));
      check(sw.q === 200, `a core file with a ?query is served offline (${base})`, String(sw.q));
      const want = { 'bytes=0-': `206:${sw.size}`, 'Bytes=0-1': '206:2', 'bytes=-100': '206:100', 'bytes=0-1,5-6': `200:${sw.size}`, 'items=0-1': `200:${sw.size}`, 'bytes=100-50': `200:${sw.size}`, [`bytes=${sw.size}-`]: '416:0', 'bytes=-0': '416:0' };
      const wrong = Object.entries(want).filter(([h, v]) => sw.range[h] !== v).map(([h, v]) => `${h} -> ${sw.range[h]} (want ${v})`);
      check(wrong.length === 0, `offline Range requests answered like the web server (${base})`, wrong.join('; '));
      // The two 416 answers above are logged by Chrome as failed loads; they were asked for.
      await b.sleep(300);
      for (let i = b.errors.length - 1; i >= errorsBefore; i--) if (/status of 416/.test(b.errors[i])) b.errors.splice(i, 1);
      await b.offline(false);
      checkErrors(b, `offline ${base}`);
    } finally { await b.close(); }
  }
}

// ---------------------------------------------------------------------------------------------
async function testRobustness() {
  section('Robustness: double-taps across screen changes, recovering from failed downloads');
  const where = (b) => b.eval("({ hash: location.hash, screen: document.body.dataset.screen || '' })");
  // Two quick taps on the same spot (a child's double-tap): the second must not act on the new screen.
  const dbl = async (b, sel, gap = 100) => {
    const { x, y } = await b.point(sel);
    for (let i = 0; i < 2; i++) {
      if (i) await b.sleep(gap);
      await b.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await b.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await b.sleep(1000);
  };
  let w;
  let b = await launch({ width: 390, height: 844, touch: true });
  try {
    await b.goto();
    await dbl(b, '.splash-play');
    w = await where(b);
    check(w.screen === 'home', 'double-tap on Start stays on home', JSON.stringify(w));
    await tapsOk(b);
    await dbl(b, '.tile[data-id="machine"]');
    w = await where(b);
    check(w.hash === '#/machine' && await b.eval("document.querySelectorAll('.mc-tier').length > 0"), 'double-tap on a home tile opens only that game', JSON.stringify(w));
    await go(b, '#/robot/1', 'robot');
    await dbl(b, '.topbar-back');
    w = await where(b);
    check(w.hash === '#/robot', 'double-tap on Back goes back one screen only', JSON.stringify(w));
    await tapsOk(b);
    await b.tap('.topbar-back', { wait: 800 });
    check((await where(b)).screen === 'home', 'a single tap once the screen has settled still works');
    await voiceCheck(b, 'double-taps');
    checkErrors(b, 'double-taps');
  } finally { await b.close(); }

  // Failed downloads on a first visit (before the service worker has cached anything).
  b = await launch({ width: 1024, height: 768, touch: true });
  const block = (urls) => b.send('Network.setBlockedURLs', { urls });
  const EXPECTED = [/ERR_BLOCKED_BY_CLIENT|ERR_INTERNET_DISCONNECTED|Failed to fetch|failed\b|Could not load|robot\.js|machine\.css|app\.json/i];
  try {
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source: 'delete Navigator.prototype.serviceWorker;' });
    // Registry (data/app.json) blocked during boot: a retry button, then the games once it loads.
    await block(['*data/app.json']);
    await b.goto();
    await b.tap('.splash-play');
    await b.waitFor("document.body.dataset.screen === 'home'");
    const retry = await b.eval("!!document.querySelector('.home-retry .btn-go') && document.querySelectorAll('.tile').length === 0 && /try again/i.test(document.querySelector('.topbar-caption').textContent)");
    check(retry, 'home without data/app.json shows a spoken retry button (no empty grid)');
    await block([]);
    await tapsOk(b);
    await b.tap('.home-retry .btn-go');
    await b.waitFor("document.querySelectorAll('.tile').length > 0", { timeout: 8000 }).then(() => pass('retry loads the games'), () => fail('retry loads the games'));
    // A game's code blocked: Oops (with no stale game buttons), then a reload once it is back.
    await block(['*robot/robot.js']);
    await tapsOk(b);
    await b.tap('.tile[data-id="robot"]');
    await b.waitFor("!!document.querySelector('.oops')", { timeout: 8000 }).catch(() => {});
    check(await b.eval("!!document.querySelector('.oops') && document.querySelectorAll('.topbar-actions > *').length === 0"), 'a game that fails to download shows Oops, without its top-bar buttons');
    await b.offline(true);
    await tapsOk(b);
    await b.tap('.oops .btn-go', { wait: 1500 });
    w = await where(b);
    check(w.screen === 'home' && /^https?:/.test(await b.eval('location.href')), 'Oops while still offline goes home (no reload into an error page)', JSON.stringify(w));
    await b.offline(false);
    await block([]);
    await tapsOk(b);
    await b.tap('.tile[data-id="robot"]');
    await b.waitFor("!!document.querySelector('.oops')", { timeout: 8000 }).catch(() => {});
    await tapsOk(b);
    await b.tap('.oops .btn-go');
    await b.waitFor("document.body.classList.contains('is-splash') && !!document.querySelector('.splash-play')", { timeout: 15000 }).catch(() => {});
    await b.sleep(300);
    await b.tap('.splash-play');
    await b.waitFor("document.body.dataset.screen === 'home'", { timeout: 8000 }).catch(() => {});
    await tapsOk(b);
    await b.tap('.tile[data-id="robot"]');
    const recovered = await b.waitFor("document.querySelectorAll('.rb-lvl-num').length > 0", { timeout: 8000 }).then(() => true, () => false);
    check(recovered, 'once the network is back, Oops reloads the app and the game opens');
    // A game's stylesheet blocked: Oops (never an unstyled game), then styled on the next try.
    await go(b, '#/', 'home');
    await block(['*machine/machine.css']);
    await b.tap('.tile[data-id="machine"]');
    await b.waitFor("!!document.querySelector('.oops')", { timeout: 8000 }).then(() => pass('a missing stylesheet shows Oops'), () => fail('a missing stylesheet shows Oops'));
    await block([]);
    await tapsOk(b);
    await b.tap('.oops .btn-go');
    await b.waitFor("document.body.dataset.screen === 'home'");
    await tapsOk(b);
    await b.tap('.tile[data-id="machine"]');
    const styled = await b.waitFor("(() => { const l = [...document.querySelectorAll('link[rel=stylesheet]')].find((x) => /machine\\.css/.test(x.href)); try { return !!l && l.sheet.cssRules.length > 0 && document.querySelectorAll('.mc-tier').length > 0; } catch { return false; } })()", { timeout: 8000 }).then(() => true, () => false);
    check(styled, 'the stylesheet loads on the next try');
    const errs = b.errors.filter((e) => !BENIGN.some((re) => re.test(e)) && !EXPECTED.some((re) => re.test(e)));
    check(errs.length === 0, 'no unexpected console errors (failed downloads)', errs.slice(0, 5).join(' | '));
    b.errors.length = 0;
  } finally { await b.close(); }
}

// ---------------------------------------------------------------------------------------------
async function testVoiceStatic() {
  section('Voice coverage (static)');
  // Word-order read-aloud lists the cards in scrambled order: every word mid-list and last.
  const gaps = [];
  for (const r of machine.rounds) {
    if (r.type !== 'order' || !Array.isArray(r.words)) continue;
    const [intro, ...listed] = wordsParts(r.words);
    for (const t of [intro, ...listed.flatMap((p) => [`${p.slice(0, -1)},`, `${p.slice(0, -1)}.`])]) {
      if (!packLines[speechKey(t)]) gaps.push(`${r.id}: ${t}`);
    }
  }
  check(gaps.length === 0, 'every word-order card is recorded mid-list and last', gaps.slice(0, 6).join(', '));
  // A coloring item without `say` is spoken as "<name>!" (parts.js sayOf): the collector must agree.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'll-voice-'));
  try {
    fs.cpSync(path.join(APP_ROOT, 'data'), path.join(tmp, 'data'), { recursive: true });
    fs.cpSync(path.join(APP_ROOT, 'js'), path.join(tmp, 'js'), { recursive: true });
    const f = path.join(tmp, 'data/coloring/animals.json');
    const doc = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
    delete doc.items[0].say;
    fs.writeFileSync(f, JSON.stringify(doc));
    const keys = new Set(collectLines(tmp).map((l) => l.key));
    const want = speechKey(`${doc.items[0].name}!`);
    check(keys.has(want), 'a coloring item without "say" is collected as "<name>!"', want);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // The service worker caches the pack index and the unlock clip with the app (all-or-nothing).
  const listed = readSW(fs.readFileSync(path.join(APP_ROOT, 'sw.js'), 'utf8')).urls;
  check(listed.includes(voicePackPath) && listed.includes('audio/silence.mp3'), 'sw.js precaches the voice index and silence.mp3 as core files', voicePackPath);
}

// Page-side probes for the voice engine: which clip each Web Audio source / <audio> play() was
// for, when the fallback fetched a clip, decoded buffers (weakly), and an optional refusal of
// <audio> play() (the iOS NotAllowedError case) via window.__blockPlay.
const VOICE_HOOK = `(() => {
  if (window.__vt) return true;
  const T = window.__vt = { starts: [], plays: [], fetches: [], decodes: 0, refs: [], els: new Set() };
  const tag = new WeakMap();
  const file = (u) => String(u || '').split('?')[0].split('/').pop();
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    if (!/\\.mp3/.test(url)) return origFetch.call(this, input, init);
    T.fetches.push(file(url));
    if (window.__onClipFetch) window.__onClipFetch(file(url));
    const res = await origFetch.call(this, input, init);
    const buf = await res.arrayBuffer();
    tag.set(buf, file(url));
    return { ok: res.ok, status: res.status, arrayBuffer: () => Promise.resolve(buf) };
  };
  const BAC = window.BaseAudioContext || window.AudioContext;
  const origDecode = BAC.prototype.decodeAudioData;
  BAC.prototype.decodeAudioData = function (buf, ok, bad) {
    const f = tag.get(buf);
    return origDecode.call(this, buf, (ab) => { if (f) tag.set(ab, f); T.decodes++; T.refs.push(new WeakRef(ab)); if (ok) ok(ab); }, bad);
  };
  const origStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...a) {
    T.starts.push({ file: (this.buffer && tag.get(this.buffer)) || '', t: performance.now() });
    return origStart.apply(this, a);
  };
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    T.els.add(this);
    T.plays.push({ file: file(this.src), t: performance.now() });
    if (window.__blockPlay && !/silence/.test(this.src)) return Promise.reject(new DOMException('refused', 'NotAllowedError'));
    return origPlay.call(this);
  };
  T.audible = () => [...T.els].filter((el) => !el.paused && !el.ended).map((el) => file(el.src));
  return true;
})()`;

async function testVoiceEngine() {
  section('Voice engine: interrupts, stalls and fallbacks (stubbed, deterministic)');
  // Distinct recorded lines nobody else says during this test (Loop Machine round questions).
  const seen = new Set();
  const spare = [];
  for (const r of machine.rounds) {
    const k = r.say && speechKey(r.say);
    if (!k || seen.has(k) || !packLines[k]) continue;
    seen.add(k);
    spare.push({ text: r.say, file: packLines[k] });
  }
  const take = (n) => spare.splice(0, n);
  if (spare.length < 45) { fail(`enough spare recorded lines for the voice engine test (${spare.length})`); return; }
  const J = JSON.stringify;
  const b = await launch({ width: 1024, height: 768, touch: true });
  // Clip requests can be held back (a stalled network) with the DevTools Fetch domain.
  const paused = [];
  b.on('Fetch.requestPaused', (p) => paused.push(p.requestId));
  const hold = (files) => b.send('Fetch.enable', { patterns: files.map((f) => ({ urlPattern: `*${f}*`, requestStage: 'Request' })) });
  const release = async () => {
    for (const id of paused.splice(0)) await b.send('Fetch.continueRequest', { requestId: id }).catch(() => {});
    await b.send('Fetch.disable').catch(() => {});
  };
  try {
    // No service worker and no HTTP cache: every clip load really goes to the (holdable) network.
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source: 'delete Navigator.prototype.serviceWorker;' });
    await b.send('Network.setCacheDisabled', { cacheDisabled: true });
    await start(b);
    await b.eval(VOICE_HOOK);
    await b.waitFor(`${SPEECH}.then((s) => !!s.packInfo())`, { timeout: 10000 });
    await notSpeaking(b);

    // 1. Web Audio fallback (<audio> refused): a line interrupted while its clip is being fetched
    //    and decoded never starts afterwards, and the new line starts at once.
    for (const mode of ['say', 'stop']) {
      const [A, B] = take(2);
      const r = await b.eval(`(async () => {
        const sp = await ${SPEECH}; const T = window.__vt; T.starts.length = 0;
        window.__blockPlay = true;
        let tInt = 0;
        window.__onClipFetch = (f) => {
          if (f !== ${J(A.file)} || tInt) return;
          setTimeout(() => { tInt = performance.now(); ${mode === 'say' ? `sp.say(${J(B.text)})` : 'sp.stop()'}; }, 0);
        };
        await sp.say(${J(A.text)});
        await new Promise((r) => setTimeout(r, 2500));
        window.__onClipFetch = null;
        window.__blockPlay = false;
        const startA = T.starts.find((s) => s.file === ${J(A.file)});
        const startB = T.starts.find((s) => s.file === ${J(B.file)});
        const res = { interrupted: tInt > 0, aStartedAfter: startA ? Math.round(startA.t - tInt) : null, bAfter: startB ? Math.round(startB.t - tInt) : null, speaking: sp.speaking };
        sp.stop();
        return res;
      })()`);
      if (mode === 'say') check(r.interrupted && r.aStartedAfter === null && r.bAfter !== null && r.bAfter < 500, 'Web Audio fallback: an interrupted line never starts later; the new line starts at once', J(r));
      else check(r.interrupted && r.aStartedAfter === null, 'Web Audio fallback: stop() during fetch/decode keeps the line silent', J(r));
    }

    // 2. <audio> clip that never loads: stop() + the next screen's line starts at once (not after
    //    the 4 s load timeout) and the speaker glows while it plays.
    {
      const [A, B] = take(2);
      await hold([A.file]);
      const r = await b.eval(`(async () => {
        const sp = await ${SPEECH}; const T = window.__vt; T.plays.length = 0;
        sp.say(${J(A.text)});
        await new Promise((r) => setTimeout(r, 300));
        const t0 = performance.now();
        sp.stop();
        const pB = sp.say(${J(B.text)});
        await new Promise((r) => setTimeout(r, 250));
        const speaking = sp.speaking;
        const glow = !!document.querySelector('.topbar-replay.is-speaking');
        const end = performance.now() + 6000;
        while (!T.plays.some((p) => p.file === ${J(B.file)}) && performance.now() < end) await new Promise((r) => setTimeout(r, 20));
        const playB = T.plays.find((p) => p.file === ${J(B.file)});
        await pB;
        return { bAfter: playB ? Math.round(playB.t - t0) : null, speaking, glow };
      })()`);
      await release();
      check(r.bAfter !== null && r.bAfter < 500 && r.speaking && r.glow, 'a clip stuck loading does not hold up the next line (stop + say)', J(r));
    }

    // 3. <audio> clip whose data never comes: after the time limits the device voice says the
    //    line, and when the data does arrive later the clip stays silent (no double speech), and
    //    stop() + the next line leave exactly one clip playing.
    {
      const [A, B] = take(2);
      await hold([A.file]);
      const before = await b.eval(`${SPEECH}.then((s) => s.stats.clipErrors)`);
      await b.eval(`${SPEECH}.then((s) => { s.say(${J(A.text)}); return true; })`);
      const gaveUp = await b.waitFor(`${SPEECH}.then((s) => s.stats.clipErrors > ${before})`, { timeout: 12000 }).then(() => true, () => false);
      await release();
      await b.sleep(1500);
      const late = await b.eval('window.__vt.audible()');
      await b.eval(`${SPEECH}.then((s) => { s.stop(); s.say(${J(B.text)}); return true; })`);
      await b.sleep(500);
      const next = await b.eval('window.__vt.audible()');
      check(gaveUp && !late.includes(A.file), 'a clip that loads too late never plays over the fallback', J({ gaveUp, late }));
      check(next.length === 1 && next[0] === B.file, 'stop() + the next line: only that line plays', J(next));
      await b.eval(`${SPEECH}.then((s) => { s.stop(); return true; })`);
    }

    // 4. Web Audio fallback on a context that can't run (iOS 'interrupted' after a call, or a
    //    refused resume): no line hangs, queued lines still get their turn, the glow goes off.
    {
      const [A, B] = take(2);
      const r = await b.eval(`(async () => {
        const sp = await ${SPEECH}; const T = window.__vt; T.starts.length = 0;
        const ac = (await import(new URL('js/core/sound.js', document.baseURI).href)).audioContext();
        const proto = Object.getPrototypeOf(ac);
        const resume = proto.resume;
        proto.resume = function () { return new Promise(() => {}); };
        window.__blockPlay = true;
        try {
          await ac.suspend();
          const before = { ...sp.stats };
          const t0 = performance.now();
          const all = Promise.all([sp.say(${J(A.text)}), sp.say(${J(B.text)}, { interrupt: false })]);
          const settled = await Promise.race([all.then(() => true), new Promise((r) => setTimeout(() => r(false), 25000))]);
          await new Promise((r) => setTimeout(r, 100));
          return { settled, ms: Math.round(performance.now() - t0), speaking: sp.speaking, glow: !!document.querySelector('.topbar-replay.is-speaking'),
            clipErrors: sp.stats.clipErrors - before.clipErrors, sourcesStarted: T.starts.filter((s) => s.file === ${J(A.file)} || s.file === ${J(B.file)}).length };
        } finally {
          proto.resume = resume;
          window.__blockPlay = false;
          await ac.resume().catch(() => {});
          sp.stop();
        }
      })()`);
      check(r.settled && !r.speaking && !r.glow && r.clipErrors >= 1 && r.sourcesStarted === 0, 'Web Audio fallback on a suspended context: lines finish (device voice), nothing hangs', J(r));
    }

    // 5. Web Audio fallback memory: only a few decoded clips are kept, and a replay of the last
    //    one is instant (no new download).
    {
      const lines = take(30);
      const n = await b.eval(`(async () => {
        const sp = await ${SPEECH}; const T = window.__vt; T.refs.length = 0;
        window.__blockPlay = true;
        for (const t of ${J(lines.map((l) => l.text))}) {
          const d0 = T.decodes;
          sp.say(t);
          const end = performance.now() + 5000;
          while (T.decodes === d0 && performance.now() < end) await new Promise((r) => setTimeout(r, 15));
        }
        sp.stop();
        return T.refs.length;
      })()`);
      await b.sleep(300);
      await b.send('HeapProfiler.collectGarbage').catch(() => {});
      await b.sleep(200);
      await b.send('HeapProfiler.collectGarbage').catch(() => {});
      const last = lines[lines.length - 1];
      const r = await b.eval(`(async () => {
        const sp = await ${SPEECH}; const T = window.__vt;
        const alive = T.refs.filter((w) => !!w.deref()).length;
        const fetched = T.fetches.filter((f) => f === ${J(last.file)}).length;
        T.starts.length = 0;
        const p = sp.say(${J(last.text)});
        const end = performance.now() + 3000;
        while (!T.starts.some((s) => s.file === ${J(last.file)}) && performance.now() < end) await new Promise((r) => setTimeout(r, 15));
        const replayed = T.starts.some((s) => s.file === ${J(last.file)});
        const refetched = T.fetches.filter((f) => f === ${J(last.file)}).length - fetched;
        sp.stop();
        window.__blockPlay = false;
        await p;
        return { alive, replayed, refetched };
      })()`);
      check(n === lines.length && r.alive <= 18, 'Web Audio fallback keeps at most ~16 decoded clips', J({ decoded: n, ...r }));
      check(r.replayed && r.refetched === 0, 'Web Audio fallback replays a recent clip without downloading it again', J(r));
    }
    const errs = b.errors.filter((e) => !BENIGN.some((re) => re.test(e)) && !/ERR_|net::|Failed to load resource/.test(e));
    check(errs.length === 0, 'no console errors (voice engine)', errs.slice(0, 5).join(' | '));
    b.errors.length = 0;
  } finally {
    await release().catch(() => {});
    await b.close();
  }
}

// ---------------------------------------------------------------------------------------------
const t0 = Date.now();
console.log('Little Loops smoke test');
const ALL = [testVoiceStatic, testCore, testRobot, testColoring, testMachine, testRobustness, testVoiceEngine, ...(QUICK ? [] : [testLayouts, testOffline])];
for (const t of ONLY != null ? ALL.filter((x) => x.name.toLowerCase().includes(ONLY.toLowerCase())) : ALL) {
  try { await t(); } catch (err) { fail(`${t.name} crashed: ${err.message}`); }
}
console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${passes} passed, ${failures} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(failures ? 1 : 0);

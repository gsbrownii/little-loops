// Paint screen (#/coloring/paint): the composed scene (renderScene mode 'color', inserted once),
// a 12-colour palette + undo, and top-bar "New picture" and "Print" (behind the parent gate).
// A tap on a region sets that element's fill attribute directly — the SVG is never re-rendered.
// Small regions get a little help from tapassist.js so fingertips can hit them.
import { h, icon, prefersReducedMotion } from '../../core/dom.js';
import { renderScene, regionKeys } from './scene.js';
import { PALETTE, WHITE } from './colors.js';
import { paintLayout } from './layout.js';
import { watchSize } from './fit.js';
import { readSaved, writeSaved, resolvePicture, sceneParts } from './parts.js';
import { createPrinter } from './printing.js';
import { createPrintFlow } from './printflow.js';
import { pickRegion } from './tapassist.js';
import { colIcon } from './icons.js';

const INSTRUCTION = 'Pick a color, then tap the picture to paint it!';
const SAVE_DELAY = 400;
const MAX_UNDO = 300;
const DONE_SHARE = 0.75; // celebrate once this share of the picture is coloured
const KEY_COLOR = 'color';

export function mountPaint(root, ctx, parts, note = {}) {
  // ---- state ----
  const saved = readSaved(ctx.store, parts);
  const pic = saved ? saved.pic : resolvePicture(parts, {});
  const scene = sceneParts(parts, pic);
  const keys = regionKeys(scene);
  const fills = saved ? { ...saved.fills } : {};
  let done = saved ? saved.done : false;
  const history = []; // [{ el, key, prev }]
  let colorIdx = Math.max(0, PALETTE.findIndex((c) => c.hex === ctx.store.get(KEY_COLOR, '')));
  let saveTimer = 0;
  let dirty = false;
  const reduced = prefersReducedMotion();

  // ---- DOM ----
  const stage = h('div', { class: 'paint-stage' });
  const swatches = PALETTE.map((c, i) => {
    const b = h('button', {
      class: `swatch${c.eraser ? ' is-white' : ''}`,
      type: 'button',
      'aria-label': c.name,
      'aria-pressed': 'false',
      dataset: { color: c.id, hex: c.hex },
      style: { '--c': c.hex },
    });
    b.addEventListener('click', () => selectColor(i, true));
    return b;
  });
  const swatchGrid = h('div', { class: 'paint-swatches' }, swatches);
  const undoBtn = h('button', { class: 'btn-round paint-undo', type: 'button', 'aria-label': 'Undo' }, icon('undo'));
  undoBtn.addEventListener('click', undo);
  const tools = h('div', { class: 'paint-tools' }, swatchGrid, undoBtn);
  const wrap = h('div', { class: 'paint' }, stage, tools);
  root.append(wrap);

  // ---- top bar ----
  const newBtn = h('button', { class: 'btn-round col-new', type: 'button', 'aria-label': 'New picture' }, colIcon('newPicture'));
  newBtn.addEventListener('click', () => {
    ctx.sound.play('tap');
    saveNow();
    ctx.navigate('#/coloring');
  });
  const printBtn = h('button', { class: 'btn-round col-print', type: 'button', 'aria-label': 'Print (grown-ups)' }, icon('print'));
  printBtn.addEventListener('click', () => {
    saveNow();
    printFlow.start();
  });
  ctx.chrome.setActions([newBtn, printBtn]);

  // ---- layout ----
  let svg = null;
  let picSize = 0;
  const offSize = watchSize(wrap, (w, hgt) => {
    const L = paintLayout(w, hgt, { n: PALETTE.length });
    wrap.dataset.mode = L.mode;
    wrap.dataset.undo = L.undo;
    const set = (k, v) => wrap.style.setProperty(k, v);
    set('--pic', `${L.pic}px`);
    set('--sw', `${L.s}px`);
    set('--cols', String(L.cols));
    set('--gap', `${L.gap}px`);
    set('--gapu', `${L.gapU}px`);
    set('--sep', `${L.sep}px`);
    set('--padx', `${L.padX}px`);
    set('--padt', `${L.padTop}px`);
    set('--padb', `${L.padBottom}px`);
    set('--sel', String(L.ring.k));
    set('--ring-p', `${L.ring.p}px`);
    set('--ring-q', `${L.ring.q}px`);
    picSize = L.pic;
    if (!svg) insertScene();
  });
  ctx.onCleanup(offSize);

  // The scene is inserted exactly once; later taps only change fill attributes.
  function insertScene() {
    const strokeWidth = Math.min(7, Math.max(5, 1700 / Math.max(picSize, 1))); // bolder lines on small screens
    stage.innerHTML = renderScene({ ...scene, fills, mode: 'color', strokeWidth, className: 'paint-art' });
    svg = stage.querySelector('svg');
  }
  if (!svg) insertScene(); // (watchSize normally already did this)

  // ---- colours ----
  function selectColor(i, speak) {
    colorIdx = i;
    swatches.forEach((b, k) => {
      b.classList.toggle('is-on', k === i);
      b.setAttribute('aria-pressed', k === i ? 'true' : 'false');
    });
    if (speak) {
      ctx.sound.play('pick');
      ctx.say(`${PALETTE[i].name}!`); // voice: enumerated (colour names)
      try { ctx.store.set(KEY_COLOR, PALETTE[i].hex); } catch { /* storage is best-effort */ }
    }
  }
  selectColor(colorIdx, false);

  // ---- painting ----
  const regionOf = (node) => {
    const el = node && node.closest ? node.closest('[data-region]') : null;
    return el && svg && svg.contains(el) ? el : null;
  };
  const hitAt = (x, y) => regionOf(document.elementFromPoint(x, y));
  // The region a fingertip at (x, y) most likely meant (small shapes get a margin; tapassist.js).
  function aim(x, y) {
    if (!svg) return null;
    const regions = [...svg.querySelectorAll('[data-region]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { el, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
    return pickRegion(x, y, { hitAt, regions });
  }

  // Any press anywhere on the page (also the parent gate's hold button) counts as pointer
  // activity, so the click fallback below never paints from a stray click after a long press.
  let lastPointerAt = 0;
  const notePointer = () => { lastPointerAt = performance.now(); };
  for (const t of ['pointerdown', 'pointerup', 'pointercancel']) window.addEventListener(t, notePointer, true);
  ctx.onCleanup(() => {
    for (const t of ['pointerdown', 'pointerup', 'pointercancel']) window.removeEventListener(t, notePointer, true);
  });

  let down = null;
  stage.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    down = { id: e.pointerId, x: e.clientX, y: e.clientY, region: regionOf(e.target) };
  });
  stage.addEventListener('pointerup', (e) => {
    if (!down || e.pointerId !== down.id) return;
    const d = down;
    down = null;
    const tolerance = Math.max(20, picSize * 0.05); // little fingers wobble
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    let el = null;
    if (moved <= tolerance) el = aim(d.x, d.y) || aim(e.clientX, e.clientY);
    else if (d.region && hitAt(e.clientX, e.clientY) === d.region) el = d.region; // scribbled inside one shape
    if (el) paintRegion(el, d.x, d.y);
  });
  stage.addEventListener('pointercancel', () => { down = null; });
  // Clicks with no pointer events before them (assistive tech, keyboard emulation).
  stage.addEventListener('click', (e) => {
    if (down || performance.now() - lastPointerAt < 1500) return;
    const el = regionOf(e.target);
    if (el) paintRegion(el, e.clientX, e.clientY);
  });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  function paintRegion(el, x, y) {
    const key = el.getAttribute('data-region');
    const color = PALETTE[colorIdx].hex;
    const prev = (el.getAttribute('fill') || WHITE).toUpperCase();
    ctx.sound.play('fill');
    pop(el);
    splash(x, y, color);
    if (prev === color) return;
    el.setAttribute('fill', color);
    history.push({ el, key, prev });
    if (history.length > MAX_UNDO) history.shift();
    record(key, color);
    checkDone();
  }

  function record(key, color) {
    if (color === WHITE) delete fills[key];
    else fills[key] = color;
    undoBtn.classList.toggle('is-empty', history.length === 0);
    scheduleSave();
  }

  function undo() {
    const last = history.pop();
    if (!last) {
      ctx.sound.play('locked'); // gentle "nothing to undo"
      wobble(undoBtn);
      undoBtn.classList.add('is-empty');
      return;
    }
    last.el.setAttribute('fill', last.prev);
    ctx.sound.play('remove');
    pop(last.el);
    record(last.key, last.prev);
  }
  undoBtn.classList.add('is-empty');

  function checkDone() {
    if (done || !keys.length) return;
    const colored = keys.filter((k) => fills[k] && fills[k] !== WHITE).length;
    if (colored / keys.length < DONE_SHARE) return;
    done = true;
    scheduleSave();
    ctx.celebrate();
    ctx.say(ctx.praise());
    ctx.say('What a beautiful picture!', { interrupt: false });
  }

  // ---- little animations ----
  function pop(el) {
    if (reduced || typeof el.animate !== 'function') return;
    try {
      el.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.06)', offset: 0.4 }, { transform: 'scale(1)' }],
        { duration: 260, easing: 'ease-out' }
      );
    } catch { /* decorative */ }
  }

  function splash(x, y, color) {
    if (reduced) return;
    const r = stage.getBoundingClientRect();
    const dot = h('span', {
      class: `paint-splash${color === WHITE ? ' is-white' : ''}`,
      style: { left: `${x - r.left - stage.clientLeft}px`, top: `${y - r.top - stage.clientTop}px`, '--c': color },
    });
    stage.append(dot);
    const a = dot.animate(
      [{ transform: 'scale(0.2)', opacity: 1 }, { transform: 'scale(1)', opacity: 0 }],
      { duration: 420, easing: 'ease-out' }
    );
    a.onfinish = () => dot.remove();
    a.oncancel = () => dot.remove();
  }

  function wobble(el) {
    el.classList.remove('wobble');
    void el.offsetWidth;
    el.classList.add('wobble');
  }

  // ---- saving ----
  function scheduleSave() {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DELAY);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!dirty) return;
    dirty = false;
    writeSaved(ctx.store, pic, fills, done);
  }
  const onHide = () => { if (document.visibilityState === 'hidden') saveNow(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', saveNow);
  ctx.onCleanup(() => {
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', saveNow);
    saveNow();
  });
  if (!saved) {
    // First visit with nothing saved: remember the default picture so "keep painting" works.
    dirty = true;
    saveNow();
  }

  // ---- printing (grown-ups): parent gate, then print inside the finger lift (printflow.js) ----
  const printer = createPrinter(() => scene);
  const printFlow = createPrintFlow({
    ctx,
    print: () => printer.print(scene),
    // The "tap to print" card (rarely needed) changes the replay line; put the painting one back.
    onDone: () => {
      if (ctx.isActive() && ctx.chrome.instruction !== INSTRUCTION) ctx.instruct(INSTRUCTION, { speak: false });
    },
  });
  ctx.onCleanup(() => {
    printFlow.destroy();
    printer.destroy();
  });

  // ---- instruction ----
  if (note.surprise) {
    // "Surprise!", then the instruction queued behind it (a swatch tap cancels both).
    ctx.instruct(INSTRUCTION, { speak: false });
    ctx.say('Surprise!');
    ctx.say(INSTRUCTION, { interrupt: false });
  } else {
    ctx.instruct(INSTRUCTION);
  }
}

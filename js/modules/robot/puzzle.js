// Robot Puzzles — the puzzle screen (#/robot/<n>).
// Board + command strip + card palette + Play (Clear lives in the top bar). All movement
// rules come from logic.js (simulate / solutionPath); the strip model lives in program.js.
// Spoken level text (say / hint) comes only from the level JSON; the lines below are
// generic game feedback that is the same for every level.
import { h, icon, flash, fromMarkup, prefersReducedMotion } from '../../core/dom.js';
import { draggable } from '../../core/drag.js';
import { simulate, solutionPath, isArrow, isRepeatCard, DELTA } from './logic.js';
import * as P from './program.js';
import {
  CARD_COLORS, CARD_SAY, CARD_LABEL, cardSVG, starSVG, obstacleSVG, padSVG, bonkSVG, touchSVG, hintSVG,
} from './art.js';
import { isDone, markDone } from './levels.js';

const STEP_MS = 520; // one robot move
const IDLE_MS = 7000; // nothing happened for this long -> show a gentle nudge
const MAX_DEMOS = 3;
const TAP_GUARD_MS = 350; // a second tap this soon after a removal is part of a double-tap
const CARD_SIZES = [64, 72, 80, 88, 96]; // card sizes the layout may pick (all >= 64px)

const SAY = {
  empty: 'Put some arrows in the strip first!',
  emptyRepeat: 'Put an arrow inside the repeat card!',
  bump: 'Oops, bump! Can you fix the arrows?',
  // A run that ends without reaching the star (outcome 'short'); finish() picks the line.
  short: 'So close! The robot needs more arrows to reach the star.', // adding cards can still do it
  swap: 'So close! Try changing an arrow.', // one step from the star, but adding cards can't fix it
  retry: 'Hmm, the robot didn’t reach the star yet. Try different arrows!', // otherwise
  hint: 'Here’s a hint! Follow the sparkly dots.',
  full: 'The strip is full!',
  next: 'Tap the green arrow for the next puzzle!',
  allDone: 'You solved every puzzle!',
  lastDone: 'You solved the last puzzle!',
};

export function mountPuzzle(root, ctx, data, n) {
  const levels = data.levels;
  const level = levels[n - 1];
  const isLast = n === levels.length;
  const { cols, rows } = level.grid;
  const store = ctx.store;
  const reduced = prefersReducedMotion();

  // ---------- lifecycle ----------
  let alive = true;
  const timers = new Set();
  const cleanups = [];
  const ok = () => alive && ctx.isActive();
  const later = (ms) => new Promise((resolve) => {
    const t = setTimeout(() => { timers.delete(t); resolve(); }, ms);
    timers.add(t);
  });
  const after = (ms, fn) => {
    const t = setTimeout(() => { timers.delete(t); if (ok()) fn(); }, ms);
    timers.add(t);
    return t;
  };
  const cancel = (t) => { clearTimeout(t); timers.delete(t); };

  // ---------- state ----------
  const strip = P.createStrip(level.maxCards, level.repeatCapacity);
  let running = false;
  let runSeq = 0;
  let solved = false;
  let misses = 0;
  let hintOn = false;
  let robotAt = level.start.slice();
  let dragging = null; // src of the drag in progress
  let ghostEl = null;
  let topEls = [];
  let stripOffs = [];
  const paletteOffs = [];
  let marks = [];
  let active = [];
  let glowing = [];
  let idleTimer = 0;
  let demos = 0;
  let winEl = null;
  let layoutRaf = 0;
  let lastRemove = { t: -Infinity, x: 0, y: 0 }; // last strip-card removal by tap
  const flights = new Set(); // cards flying from the palette into the strip
  let newGlow = false; // repeat cards glow until the first one is placed
  const editable = () => !running && !solved;

  // ---------- top bar ----------
  // Clear sits in the top bar so the strip can use the full width of the screen.
  const clearBtn = h('button', { class: 'btn-round rb-clear', type: 'button', 'aria-label': 'Clear the strip' }, icon('trash'));
  ctx.chrome.setBack({ icon: 'back', to: '#/robot', label: 'All puzzles' });
  ctx.chrome.setActions([clearBtn, h('div', { class: 'rb-lvl-badge', role: 'img', 'aria-label': `Puzzle ${n}` }, String(n))]);

  // ---------- board ----------
  const piece = (cls, [c, r], markup) => {
    const el = h('div', { class: `rb-piece ${cls}`, style: { left: `${(c * 100) / cols}%`, top: `${(r * 100) / rows}%` } });
    if (markup) el.append(fromMarkup(markup));
    return el;
  };
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) cells.push(h('div', { class: `rb-cell${(c + r) % 2 ? ' is-alt' : ''}` }));
  }
  const pad = piece('rb-pad', level.start, padSVG());
  const star = piece('rb-star', level.goal, starSVG());
  const obstacles = level.obstacles.map((o) => piece(`rb-obstacle rb-${o.kind}`, o.at, obstacleSVG(o.kind)));
  const hintLayer = h('div', { class: 'rb-hint-layer' });
  const robotBody = h('div', { class: 'rb-robot-body' },
    h('img', { class: 'rb-robot-img', src: ctx.asset('art/robot.svg'), alt: '', draggable: 'false' }));
  const robot = h('div', { class: 'rb-robot' }, robotBody);
  const boardFx = h('div', { class: 'rb-board-fx' });
  const board = h('div', {
    class: 'rb-board',
    role: 'img',
    'aria-label': 'Puzzle board: help the robot reach the star',
    style: { '--cols': String(cols), '--rows': String(rows) },
  },
    h('div', { class: 'rb-cells' }, cells),
    h('div', { class: 'rb-layer' }, pad, ...obstacles, hintLayer, star, robot, boardFx)
  );
  const boardWrap = h('div', { class: 'rb-board-wrap' }, board);

  // ---------- controls ----------
  const stripEl = h('div', { class: 'rb-strip', 'aria-label': 'Command strip' });
  const paletteEl = h('div', { class: 'rb-palette', 'aria-label': 'Cards' });
  const playBtn = h('button', { class: 'rb-play', type: 'button', 'aria-label': 'Play' }, icon('play'));
  // A grid: the command strip on top, the card palette below. Play sits at the end of the
  // palette row, at the end of the strip row or on its own row: layout() picks whichever
  // leaves the biggest board (classes is-play-strip / is-play-below).
  const controls = h('div', { class: 'rb-controls' }, stripEl, playBtn, paletteEl);
  const puzzle = h('div', { class: 'rb-puzzle' }, boardWrap, controls);
  const fx = h('div', { class: 'rb-fx', 'aria-hidden': 'true' });
  root.append(puzzle, fx);

  function cardEl(card, extra = '') {
    const el = h('button', {
      class: `rb-card ${extra}`.trim(),
      type: 'button',
      dataset: { card },
      'aria-label': CARD_LABEL[card] || card,
      style: { '--rb-c': CARD_COLORS[card] || '#FFFFFF' },
    });
    el.append(fromMarkup(cardSVG(card)));
    return el;
  }

  const srcCard = (src) => (src.card != null ? src.card : P.itemAt(strip, P.locate(strip, src.uid))?.card);

  /** Make a card draggable; `onTap` runs on a tap. Pushes the off() into `list`. */
  function bindDrag(el, src, onTap, list) {
    const off = draggable(el, {
      ghost: () => { ghostEl = el.cloneNode(true); ghostEl.classList.remove('is-active', 'rb-glow', 'is-pressed', 'rb-landing'); return ghostEl; },
      onTap: (ev) => {
        poke();
        if (editable()) onTap(ev);
      },
      onStart: () => {
        poke();
        dragging = src;
        ctx.sound.play('pick');
        el.closest('.rb-block')?.classList.toggle('is-lifted', el.classList.contains('rb-badge'));
      },
      onMove: ({ x, y, over }) => showTarget(targetAt(over, x, y, srcCard(src))),
      onDrop: ({ x, y, over }) => {
        const t = targetAt(over, x, y, srcCard(src));
        endDrag();
        if (editable()) dropped(src, t, x, y, el);
        else renderStrip();
      },
      onCancel: () => { endDrag(); renderStrip(); },
    });
    const key = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (editable() && el.getAttribute('aria-disabled') !== 'true') onTap();
    };
    el.addEventListener('keydown', key);
    list.push(() => { off(); el.removeEventListener('keydown', key); });
  }

  function endDrag() {
    clearMarks();
    dragging = null;
    ghostEl = null;
  }

  // ---------- palette ----------
  const paletteCards = level.cards.map((card) => {
    const el = cardEl(card, 'rb-pal');
    bindDrag(el, { card }, () => tapPalette(card, el), paletteOffs);
    return el;
  });
  paletteEl.append(...paletteCards);

  // ---------- strip rendering ----------
  /** Build strip DOM for `items`. With bind=false it is only used for measuring. */
  function buildStrip(items, bind) {
    const tops = [];
    const kids = items.map((it, i) => {
      if (P.isBlock(it)) {
        const badge = cardEl(it.card, 'rb-badge');
        badge.dataset.uid = String(it.uid);
        badge.append(h('span', { class: 'rb-count', 'aria-hidden': 'true' }));
        if (bind) bindDrag(badge, { uid: it.uid }, (ev) => tapRemove(it.uid, ev), stripOffs);
        const slots = [];
        for (let j = 0; j < strip.cap; j++) {
          const a = it.body[j];
          if (a) {
            const c = cardEl(a.card, 'rb-inner');
            Object.assign(c.dataset, { uid: String(a.uid), block: String(it.uid), inner: String(j) });
            if (bind) bindDrag(c, { uid: a.uid }, (ev) => tapRemove(a.uid, ev), stripOffs);
            slots.push(c);
          } else {
            slots.push(h('div', { class: 'rb-slot rb-inner-slot', dataset: { block: String(it.uid), inner: String(j) } }));
          }
        }
        const blockEl = h('div', { class: 'rb-block', dataset: { top: String(i), blockUid: String(it.uid), card: it.card } },
          badge, h('div', { class: 'rb-block-body' }, slots));
        tops.push(blockEl);
        return blockEl;
      }
      const c = cardEl(it.card, 'rb-top');
      Object.assign(c.dataset, { top: String(i), uid: String(it.uid) });
      if (bind) bindDrag(c, { uid: it.uid }, (ev) => tapRemove(it.uid, ev), stripOffs);
      tops.push(c);
      return c;
    });
    for (let k = items.length; k < strip.max; k++) kids.push(h('div', { class: 'rb-slot', dataset: { empty: String(k) } }));
    return { kids, tops };
  }

  function renderStrip() {
    if (!alive) return;
    flights.forEach((land) => land()); // cards still flying in snap into place
    stripOffs.forEach((off) => off());
    stripOffs = [];
    active = [];
    glowing = [];
    const { kids, tops } = buildStrip(strip.items, true);
    topEls = tops;
    stripEl.replaceChildren(...kids);
    stripEl.classList.toggle('is-empty', strip.items.length === 0);
    syncDisabled();
    scheduleLayout(false);
  }

  /** The level's reference solution as strip items: the layout reserves room for it from the start. */
  function solutionItems() {
    const sol = [];
    for (const step of level.solution.slice(0, strip.max)) {
      if (isArrow(step)) sol.push({ uid: -1, card: step });
      else if (step && Array.isArray(step.do)) {
        const card = step.repeat === 3 && level.cards.includes('repeat3') ? 'repeat3' : level.cards.includes('repeat2') ? 'repeat2' : 'repeat3';
        sol.push({ uid: -1, card, times: step.repeat, body: step.do.slice(0, strip.cap).map((d) => ({ uid: -1, card: d })) });
      }
    }
    return sol;
  }

  const elForUid = (uid) => stripEl.querySelector(`[data-uid="${uid}"]`);
  const blockElFor = (uid) => stripEl.querySelector(`.rb-block[data-block-uid="${uid}"]`);

  function syncDisabled() {
    const dis = !editable();
    for (const el of [...paletteCards, ...stripEl.querySelectorAll('.rb-card')]) {
      if (dis) el.setAttribute('aria-disabled', 'true');
      else el.removeAttribute('aria-disabled');
    }
    clearBtn.classList.toggle('is-off', dis || strip.items.length === 0);
    root.classList.toggle('rb-is-running', running);
  }

  // ---------- drop targets ----------
  function targetAt(over, x, y, card) {
    const inStrip = !!over && stripEl.contains(over);
    if (!inStrip) {
      const r = stripEl.getBoundingClientRect();
      const m = 16; // forgiving edge for little fingers
      if (x < r.left - m || x > r.right + m || y < r.top - m || y > r.bottom + m) return { type: 'out' };
      return { type: 'top', index: strip.items.length };
    }
    const arrow = isArrow(card);
    const innerEl = over.closest('[data-inner]');
    if (innerEl && arrow) {
      return { type: 'inner', blockUid: Number(innerEl.dataset.block), index: Number(innerEl.dataset.inner), el: innerEl };
    }
    const blockEl = over.closest('.rb-block');
    const badgeEl = over.closest('.rb-badge');
    if (blockEl && badgeEl && arrow) {
      // Left half of a repeat badge = "put it before the repeat".
      const r = badgeEl.getBoundingClientRect();
      if (x < r.left + r.width / 2) return { type: 'top', index: Number(blockEl.dataset.top) };
    }
    if (blockEl && arrow) {
      const blk = strip.items[Number(blockEl.dataset.top)];
      if (P.isBlock(blk) && blk.body.length < strip.cap) {
        return { type: 'inner', blockUid: blk.uid, index: blk.body.length, el: blockEl.querySelector(`[data-inner="${blk.body.length}"]`) };
      }
    }
    const topEl = over.closest('[data-top]');
    if (topEl) {
      const i = Number(topEl.dataset.top);
      const r = topEl.getBoundingClientRect();
      return { type: 'top', index: i + (x > r.left + r.width / 2 ? 1 : 0) };
    }
    return { type: 'top', index: strip.items.length };
  }

  function mark(el, cls) {
    if (!el) return;
    el.classList.add(cls);
    marks.push([el, cls]);
  }
  function clearMarks() {
    marks.forEach(([el, cls]) => el.classList.remove(cls));
    marks = [];
    ghostEl?.classList.remove('rb-ghost-out');
  }

  function showTarget(t) {
    clearMarks();
    if (!dragging || !editable()) return;
    const fromStrip = dragging.uid != null;
    if (t.type === 'out') {
      if (fromStrip) ghostEl?.classList.add('rb-ghost-out');
      return;
    }
    if (t.type === 'inner') {
      mark(t.el, 'rb-drop-here');
      return;
    }
    const loc = fromStrip ? P.locate(strip, dragging.uid) : null;
    const fromTop = !!loc && loc.inner == null;
    if (!fromTop && strip.items.length >= strip.max) {
      mark(stripEl, 'rb-full');
      return;
    }
    if (t.index < strip.items.length) mark(topEls[t.index], 'rb-drop-before');
    else {
      const slot = stripEl.querySelector('.rb-slot[data-empty]');
      if (slot) mark(slot, 'rb-drop-here');
      else mark(topEls[topEls.length - 1], 'rb-drop-after');
    }
  }

  // ---------- editing ----------
  function speakCard(card) {
    if (CARD_SAY[card]) ctx.say(CARD_SAY[card]);
  }

  function edited() {
    clearGlow();
    poke();
  }

  /** The first repeat card placed ends the "new card" glow for good. */
  function placed(card) {
    if (!isRepeatCard(card) || !newGlow) return;
    newGlow = false;
    store.set('seen.repeat', true);
    paletteCards.forEach((el) => el.classList.remove('is-new'));
  }

  function tapPalette(card, el) {
    const from = el.getBoundingClientRect();
    const res = P.tapAdd(strip, card);
    if (res.action === 'full') {
      stripFull(el, null);
      return;
    }
    if (res.action !== 'add') return;
    ctx.sound.play('drop');
    speakCard(card);
    placed(card);
    edited();
    renderStrip();
    flyIn(res.item.uid, from);
  }

  function dropped(src, t, x, y, el) {
    if (t.type === 'out') {
      if (src.uid != null) removeCard(src.uid, { x, y });
      else ctx.sound.play('tap'); // a palette card dropped off the strip just goes home
      renderStrip();
      return;
    }
    const res = P.applyDrop(strip, src, t);
    if (res.action === 'full') {
      renderStrip();
      stripFull(el, { x, y });
      return;
    }
    if (res.action === 'none') {
      renderStrip();
      return;
    }
    ctx.sound.play('drop');
    speakCard(res.item.card);
    placed(res.item.card);
    edited();
    renderStrip();
    popIn(res.item.uid);
  }

  /** Tap on a strip card removes it. The next card slides into the same spot, so a quick
   *  second tap there (a double-tap) is ignored instead of removing that card too. Quick taps
   *  on other cards still work. */
  function tapRemove(uid, ev) {
    const now = performance.now();
    const x = ev?.clientX ?? 0;
    const y = ev?.clientY ?? 0;
    if (now - lastRemove.t < TAP_GUARD_MS && Math.hypot(x - lastRemove.x, y - lastRemove.y) < 32) return;
    if (!removeCard(uid)) return;
    lastRemove = { t: now, x, y };
  }

  function removeCard(uid, pt) {
    if (!editable()) return false;
    const el = elForUid(uid);
    const target = el?.classList.contains('rb-badge') ? blockElFor(uid) : el;
    const item = P.removeUid(strip, uid);
    if (!item) return false;
    poof(target, pt);
    ctx.sound.play('remove');
    edited();
    renderStrip();
    return true;
  }

  function clearStrip() {
    poke();
    if (!editable()) return;
    if (!strip.items.length) {
      ctx.sound.play('tap');
      flash(clearBtn, 'wobble', 520);
      return;
    }
    topEls.forEach((el) => poof(el));
    P.clear(strip);
    ctx.sound.play('remove');
    edited();
    renderStrip();
    hideBlocked();
    moveRobot(level.start, { fast: true });
  }

  function stripFull(el, pt) {
    ctx.sound.play('locked');
    flash(stripEl, 'rb-shake', 520);
    if (pt && el && el.isConnected) bounceBack(el, pt);
    else if (el) flash(el, 'wobble', 520);
    ctx.say(SAY.full);
  }

  // ---------- effects ----------
  function rectOf(el) {
    return el && el.isConnected ? el.getBoundingClientRect() : null;
  }

  function fxBox(r) {
    return h('div', { class: 'rb-fx-box', style: { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` } });
  }

  function poof(el, pt) {
    const r = rectOf(el);
    if (!r && !pt) return;
    const w = r ? r.width : 64;
    const hh = r ? r.height : 64;
    const size = Math.min(w, hh);
    const box = pt
      ? { left: pt.x - w / 2, top: pt.y - hh / 2, width: w, height: hh }
      : { left: r.left, top: r.top, width: w, height: hh };
    const wrap = fxBox(box);
    if (el) {
      const clone = el.cloneNode(true);
      clone.classList.remove('is-active', 'rb-glow', 'is-pressed', 'is-drag-source', 'rb-drop-before', 'rb-drop-after', 'rb-landing');
      clone.classList.add('rb-fx-clone', 'rb-poofing');
      wrap.append(clone);
    }
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const d = size * 0.75;
      const puff = h('span', { class: 'rb-puff', style: { '--dx': `${Math.cos(a) * d}px`, '--dy': `${Math.sin(a) * d}px` } });
      wrap.append(puff);
    }
    fx.append(wrap);
    after(reduced ? 50 : 560, () => wrap.remove());
  }

  function bounceBack(el, pt) {
    const r = rectOf(el);
    if (!r || reduced) {
      if (el) flash(el, 'wobble', 520);
      return;
    }
    const wrap = fxBox({ left: pt.x - r.width / 2, top: pt.y - r.height / 2, width: r.width, height: r.height });
    const clone = el.cloneNode(true);
    clone.classList.remove('is-pressed', 'is-drag-source');
    clone.classList.add('rb-fx-clone');
    wrap.append(clone);
    fx.append(wrap);
    const dx = r.left - (pt.x - r.width / 2);
    const dy = r.top - (pt.y - r.height / 2);
    wrap.animate([
      { transform: 'translate(0, 0) scale(1.1)' },
      { transform: `translate(${dx * 0.15}px, ${dy * 0.15 - 30}px) scale(1.05)`, offset: 0.3 },
      { transform: `translate(${dx}px, ${dy}px) scale(1)` },
    ], { duration: 520, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'forwards' });
    after(560, () => wrap.remove());
    after(520, () => flash(el, 'wobble', 520));
  }

  /** A tapped card flies from the palette into its place. The flying copy lives in the
   *  (untouchable) effects layer, so it never catches the child's next tap on the palette;
   *  the real card waits invisibly in place and can be tapped or dragged straight away. */
  function flyIn(uid, from) {
    if (reduced) return;
    const el = elForUid(uid);
    const target = el?.classList.contains('rb-badge') ? blockElFor(uid) : el;
    const r = rectOf(target);
    if (!target || !r || !from) return;
    const wrap = fxBox(r);
    const clone = target.cloneNode(true);
    clone.classList.remove('is-pressed', 'is-drag-source');
    clone.classList.add('rb-fx-clone');
    wrap.append(clone);
    fx.append(wrap);
    target.classList.add('rb-landing');
    const dx = from.left + from.width / 2 - (r.left + r.width / 2);
    const dy = from.top + from.height / 2 - (r.top + r.height / 2);
    const anim = wrap.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(1.05)` },
      { transform: 'translate(0, 0) scale(1)' },
    ], { duration: 300, easing: 'cubic-bezier(.3,.8,.4,1)' });
    let landed = false;
    const land = () => {
      if (landed) return;
      landed = true;
      flights.delete(land);
      anim.cancel();
      wrap.remove();
      target.classList.remove('rb-landing');
    };
    flights.add(land);
    anim.onfinish = land;
  }

  function popIn(uid) {
    if (reduced) return;
    const el = elForUid(uid);
    const target = el?.classList.contains('rb-badge') ? blockElFor(uid) : el;
    target?.animate([
      { transform: 'scale(0.7)' }, { transform: 'scale(1.1)', offset: 0.6 }, { transform: 'scale(1)' },
    ], { duration: 260, easing: 'ease-out' });
  }

  // ---------- robot ----------
  function moveRobot(pos, { instant = false, fast = false } = {}) {
    robotAt = pos.slice();
    robot.style.transitionDuration = instant ? '0s' : fast ? '0.3s' : '';
    robot.style.transform = `translate(${pos[0] * 100}%, ${pos[1] * 100}%)`;
    if (!instant && !reduced) {
      robotBody.animate([
        { transform: 'translateY(0)' }, { transform: 'translateY(-14%)', offset: 0.45 }, { transform: 'translateY(0)' },
      ], { duration: fast ? 300 : 420, easing: 'ease-out' });
    }
  }

  function bump(dir) {
    const [dx, dy] = DELTA[dir] || [0, 0];
    if (!reduced) {
      robotBody.animate([
        { transform: 'translate(0, 0)' },
        { transform: `translate(${dx * 26}%, ${dy * 26}%) scale(0.94)`, offset: 0.3 },
        { transform: `translate(${-dx * 6}%, ${-dy * 6}%) rotate(-7deg)`, offset: 0.55 },
        { transform: 'translate(0, 0) rotate(5deg)', offset: 0.78 },
        { transform: 'translate(0, 0)' },
      ], { duration: 600, easing: 'ease-out' });
    }
    hideBlocked();
    const bonk = piece('rb-bonk', [robotAt[0] + dx * 0.5, robotAt[1] + dy * 0.5], bonkSVG());
    boardFx.append(bonk);
  }

  function hideBlocked() {
    boardFx.replaceChildren();
  }

  function dance() {
    if (reduced) return;
    robotBody.animate([
      { transform: 'translateY(0) rotate(0)' },
      { transform: 'translateY(-24%) rotate(-12deg)', offset: 0.2 },
      { transform: 'translateY(0) rotate(0)', offset: 0.4 },
      { transform: 'translateY(-24%) rotate(12deg)', offset: 0.6 },
      { transform: 'translateY(0) rotate(0) scale(1.08)', offset: 0.8 },
      { transform: 'translateY(0) rotate(0) scale(1)' },
    ], { duration: 900, easing: 'ease-in-out' });
  }

  // ---------- run ----------
  function clearActive() {
    active.forEach((el) => el.classList.remove('is-active'));
    active = [];
    stripEl.querySelectorAll('.rb-count.is-on').forEach((c) => { c.classList.remove('is-on'); c.textContent = ''; });
  }

  function setActive(step) {
    clearActive();
    const el = topEls[step.top];
    if (!el) return;
    el.classList.add('is-active');
    active.push(el);
    if (stripEl.classList.contains('is-scroll')) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (step.inner != null) {
      const inner = el.querySelector(`[data-inner="${step.inner}"]`);
      if (inner) { inner.classList.add('is-active'); active.push(inner); }
      const count = el.querySelector('.rb-count');
      if (count) {
        if (count.textContent !== String(step.iteration)) {
          count.textContent = String(step.iteration);
          if (!reduced) count.animate([{ transform: 'scale(1.6)' }, { transform: 'scale(1)' }], { duration: 250 });
        }
        count.classList.add('is-on');
      }
    }
  }

  function clearGlow() {
    glowing.forEach((el) => el.classList.remove('rb-glow'));
    glowing = [];
  }

  function glowStep(step) {
    clearGlow();
    const el = topEls[step.top];
    if (!el) return;
    const target = step.inner != null ? el.querySelector(`[data-inner="${step.inner}"]`) : el;
    if (target) { target.classList.add('rb-glow'); glowing.push(target); }
  }

  // While the robot runs, Play stays a (dimmed) Play button and extra taps are ignored: a
  // double-tap or an impatient second tap must never stop the robot. Back still leaves.
  function setRunning(on) {
    running = on;
    playBtn.classList.toggle('is-running', on);
    if (on) playBtn.setAttribute('aria-disabled', 'true');
    else playBtn.removeAttribute('aria-disabled');
    syncDisabled();
  }

  async function play() {
    poke();
    if (solved || running) return;
    clearGlow();
    hideBlocked();
    if (!strip.items.length) {
      ctx.sound.play('tap');
      flash(stripEl, 'rb-shake', 520);
      if (paletteCards[0]) flash(paletteCards[0], 'wobble', 520);
      ctx.say(SAY.empty);
      return;
    }
    const result = simulate(level, P.toProgram(strip.items));
    if (result.outcome === 'empty') {
      ctx.sound.play('tap');
      stripEl.querySelectorAll('.rb-inner-slot').forEach((s) => flash(s, 'rb-shake', 520));
      ctx.say(SAY.emptyRepeat);
      return;
    }
    const token = ++runSeq;
    const live = () => ok() && token === runSeq;
    setRunning(true);
    if (robotAt[0] !== level.start[0] || robotAt[1] !== level.start[1]) {
      ctx.sound.play('whoosh');
      moveRobot(level.start, { fast: true });
      await later(380);
      if (!live()) return;
    }
    for (const step of result.steps) {
      setActive(step);
      if (step.blocked) {
        ctx.sound.play('bump');
        bump(step.dir);
        await later(650);
        if (!live()) return;
        break;
      }
      ctx.sound.play('step');
      moveRobot(step.to);
      await later(STEP_MS);
      if (!live()) return;
    }
    finish(result);
  }

  function finish(result) {
    if (result.outcome === 'goal') {
      win();
      return;
    }
    setRunning(false);
    clearActive();
    ctx.sound.play('tryAgain');
    if (result.outcome === 'edge' || result.outcome === 'obstacle') {
      if (result.failStep) glowStep(result.failStep);
      miss(SAY.bump);
    } else {
      miss(shortLine(result.final));
    }
  }

  /** The robot stopped short of the star at `end`. "Needs more arrows" only when filling the
   *  strip's empty places can still get there; a full strip or a wrong turn asks for changes. */
  function shortLine(end) {
    if (P.canFinishByFilling(level, strip)) return SAY.short;
    const away = Math.abs(end[0] - level.goal[0]) + Math.abs(end[1] - level.goal[1]);
    return away === 1 ? SAY.swap : SAY.retry;
  }

  function miss(line) {
    misses++;
    ctx.say(line);
    if (misses >= 2 && !hintOn) {
      showHint();
      // Queued behind the kind words; anything new (a tap, leaving) cancels it.
      ctx.say(level.hint || SAY.hint, { interrupt: false });
    }
  }

  function showHint() {
    hintOn = true;
    const path = solutionPath(level);
    if (path.length > 1) hintLayer.replaceChildren(fromMarkup(hintSVG(path, cols, rows)));
    hintLayer.classList.add('is-on');
    star.classList.add('is-hinted');
  }

  function hideHint() {
    hintOn = false;
    hintLayer.classList.remove('is-on');
    hintLayer.replaceChildren();
    star.classList.remove('is-hinted');
  }

  // ---------- success ----------
  async function win() {
    solved = true;
    clearActive();
    hideHint();
    setRunning(false);
    playBtn.classList.remove('rb-nudge');
    markDone(store, level);
    star.classList.add('is-collected');
    dance();
    robotBody.classList.add('is-happy');
    await later(reduced ? 150 : 750);
    if (!ok()) return;
    const allDone = levels.every((lv) => isDone(store, lv));
    const line = isLast ? (allDone ? SAY.allDone : SAY.lastDone) : ctx.praise();
    showWin(allDone);
    ctx.celebrate({ big: isLast });
    // As parts, so the caption reads as one line and the replay button plays both recordings.
    ctx.instruct(isLast ? line : [line, SAY.next], { speak: false });
    ctx.say(line);
    if (!isLast) ctx.say(SAY.next, { interrupt: false });
  }

  function showWin(allDone) {
    const levelsBtn = h('button', { class: 'btn-round rb-win-btn rb-win-levels', type: 'button', 'aria-label': 'All puzzles' }, icon('grid'));
    const againBtn = h('button', { class: 'btn-round rb-win-btn rb-win-again', type: 'button', 'aria-label': 'Play again' }, icon('retry'));
    const nextBtn = isLast ? null : h('button', { class: 'rb-win-next', type: 'button', 'aria-label': 'Next puzzle' }, icon('next'));
    levelsBtn.addEventListener('click', () => { ctx.sound.play('tap'); ctx.navigate('#/robot'); });
    againBtn.addEventListener('click', () => { ctx.sound.play('tap'); again(); });
    nextBtn?.addEventListener('click', () => { ctx.sound.play('tap'); ctx.navigate(`#/robot/${n + 1}`); });
    const starEl = () => h('span', { class: 'rb-win-star' }, fromMarkup(starSVG()));
    const stars = h('div', { class: 'rb-win-stars' }, isLast
      ? [starEl(), h('img', { class: 'rb-win-robot', src: ctx.asset('art/robot.svg'), alt: '', draggable: 'false' }), starEl()]
      : [starEl()]);
    const base = `rb-win-card${isLast ? ' is-final' : ''}${allDone ? ' is-all' : ''}`;
    const card = h('div', { class: base, dataset: { base }, role: 'dialog', 'aria-label': 'Puzzle solved' },
      stars, h('div', { class: 'rb-win-btns' }, levelsBtn, againBtn, nextBtn));
    winEl = h('div', { class: 'rb-win' }, card);
    root.append(winEl);
    placeWin();
  }

  // Success card shapes, roomiest first: stars over a row of buttons; stars beside the buttons
  // (short, for little room under the board); buttons in a column (narrow, for landscape);
  // then the same with smaller stars/buttons (buttons stay >= 64px).
  const WIN_SHAPES = ['', 'is-side', 'is-stack', 'is-small', 'is-side is-small', 'is-stack is-small'];

  /** Put the success card over the controls so the board (robot on the star) stays visible. */
  function placeWin() {
    if (!winEl) return;
    const card = winEl.firstElementChild;
    const base = card.dataset.base;
    const rr = root.getBoundingClientRect();
    const br = board.getBoundingClientRect();
    const land = puzzle.classList.contains('is-landscape');
    const m = 8;
    const split = land ? br.right - rr.left : br.bottom - rr.top;
    // The free area beside (landscape) or under (portrait) the board.
    const area = land
      ? { x: split + m, y: m, w: rr.width - split - 2 * m, h: rr.height - 2 * m }
      : { x: m, y: split + m, w: rr.width - 2 * m, h: rr.height - split - 2 * m };
    let best = null;
    for (const shape of WIN_SHAPES) {
      card.className = `${base} ${shape}`.trim();
      const cw = card.offsetWidth;
      const ch = card.offsetHeight;
      const over = Math.max(0, cw - area.w) + Math.max(0, ch - area.h);
      if (!best || over < best.over - 0.5) best = { shape, cw, ch, over };
      if (over <= 0.5) break;
    }
    card.className = `${base} ${best.shape}`.trim();
    const { cw, ch } = best;
    let x;
    let y;
    if (best.over <= 0.5) {
      x = area.x + (area.w - cw) / 2;
      y = area.y + (area.h - ch) / 2;
    } else {
      // No room beside the board: overlap the board, on the side away from the robot.
      const rb = robot.getBoundingClientRect();
      const rx = rb.left + rb.width / 2 - rr.left;
      const ry = rb.top + rb.height / 2 - rr.top;
      if (land) {
        x = rr.width - cw - m;
        y = ry < rr.height / 2 ? rr.height - ch - m : m;
      } else {
        y = rr.height - ch - m;
        x = rx < rr.width / 2 ? rr.width - cw - m : m;
      }
    }
    x = Math.max(m, Math.min(x, rr.width - cw - m));
    y = Math.max(m, Math.min(y, rr.height - ch - m));
    card.style.left = `${Math.round(x)}px`;
    card.style.top = `${Math.round(y)}px`;
    winEl.style.setProperty('--rb-split', `${Math.round(split)}px`);
    winEl.classList.toggle('is-land', land);
  }

  function again() {
    winEl?.remove();
    winEl = null;
    solved = false;
    misses = 0;
    hideHint();
    clearGlow();
    hideBlocked();
    star.classList.remove('is-collected');
    robotBody.classList.remove('is-happy');
    P.clear(strip);
    moveRobot(level.start, { fast: true });
    renderStrip();
    ctx.instruct(level.say);
    poke();
  }

  // ---------- idle nudges ----------
  function poke() {
    cancel(idleTimer);
    playBtn.classList.remove('rb-nudge');
    if (!solved) idleTimer = after(IDLE_MS, onIdle);
  }

  function onIdle() {
    if (running || solved || dragging) { idleTimer = after(IDLE_MS, onIdle); return; }
    if (!strip.items.length) {
      if (demos < MAX_DEMOS) { demos++; demoDrag(); }
    } else if (!glowing.length) {
      playBtn.classList.add('rb-nudge');
    }
    idleTimer = after(IDLE_MS + 3000, onIdle);
  }

  /** Show a ghost card gliding from the palette into the strip ("drag me there!"). */
  function demoDrag() {
    if (reduced) { if (paletteCards[0]) flash(paletteCards[0], 'wobble', 520); return; }
    const from = paletteCards[0];
    const to = stripEl.querySelector('.rb-slot[data-empty]');
    const a = rectOf(from);
    const b = rectOf(to);
    if (!a || !b) return;
    const wrap = fxBox(a);
    const clone = from.cloneNode(true);
    clone.classList.add('rb-fx-clone');
    wrap.append(clone, h('div', { class: 'rb-demo-finger' }, fromMarkup(touchSVG())));
    wrap.classList.add('rb-demo');
    fx.append(wrap);
    const dx = b.left + b.width / 2 - (a.left + a.width / 2);
    const dy = b.top + b.height / 2 - (a.top + a.height / 2);
    wrap.animate([
      { transform: 'translate(0, 0) scale(1)', opacity: 0 },
      { transform: 'translate(0, 0) scale(1.08)', opacity: 1, offset: 0.15 },
      { transform: `translate(${dx}px, ${dy}px) scale(1.08)`, opacity: 1, offset: 0.75 },
      { transform: `translate(${dx}px, ${dy}px) scale(1)`, opacity: 0 },
    ], { duration: 2000, easing: 'ease-in-out', fill: 'forwards' });
    after(2050, () => wrap.remove());
  }

  // ---------- layout ----------
  // The board is as big as possible; cards are >= 64px (bigger when there is room). The strip
  // reserves the height of the level's reference solution from the start (an inline
  // min-height), so the board, palette and Play stay put while the child builds it. Only a
  // program that needs more room than the plan triggers a new plan.
  let cardPx = 64;
  let cellLimit = Infinity;
  let layoutFull = true;
  let reserved = 0; // planned strip height in px (0 = not planned yet)
  let planKey = ''; // puzzle size + orientation the plan was made for

  function scheduleLayout(full = true) {
    layoutFull = layoutFull || full;
    if (!layoutRaf) layoutRaf = requestAnimationFrame(() => { layoutRaf = 0; layout(); });
  }

  function layout() {
    if (!ok()) return;
    const cs = getComputedStyle(puzzle);
    const W = puzzle.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const H = puzzle.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (W <= 0 || H <= 0) return;
    const key = `${W}x${H}`;
    let full = layoutFull || !reserved || key !== planKey;
    layoutFull = false;
    const gap = parseFloat(cs.columnGap) || 12;
    const landscape = W > H * 1.15;
    puzzle.classList.toggle('is-landscape', landscape);
    // Undo the extreme-content fallbacks (re-applied below if still needed).
    controls.classList.remove('is-tight');
    controls.style.maxHeight = '';
    stripEl.style.maxHeight = '';
    stripEl.classList.remove('is-scroll');

    const lines = (el) => new Set([...el.children].map((k) => k.offsetTop)).size;
    // A repeat block whose inner slots wrap no longer reads as a sequence: avoid it.
    const wraps = () => [...stripEl.querySelectorAll('.rb-block-body')].some((b) => lines(b) > 1);
    // Smallest board we accept before the controls start scrolling (extreme content only).
    const minBoard = landscape ? Math.min(H, Math.max(150, W * 0.3)) : Math.max(132, Math.min(W, H * 0.25));
    const maxCH = landscape ? H : H - gap - minBoard;

    if (!full) {
      // An edit: keep the plan unless the new program outgrew the reserved strip height.
      stripEl.style.minHeight = `${reserved}px`;
      if (stripEl.offsetHeight > reserved + 0.5 || wraps()) full = true;
    }

    if (full) {
      planKey = key;
      const setCard = (px) => root.style.setProperty('--card', `${px}px`);
      const setArr = (a) => {
        controls.classList.toggle('is-play-strip', a === 1);
        controls.classList.toggle('is-play-below', a === 2);
      };
      const fits = (w) => { controls.style.width = `${w}px`; return controls.scrollHeight <= H + 0.5; };
      const maxCW = Math.max(150, W - gap - minBoard);
      const roomyCW = Math.min(maxCW, Math.max(0, W - gap - H * (cols / rows)), 640);
      // Landscape: narrowest controls column whose content fits the height (null = never fits).
      const fitWidth = () => {
        if (!fits(maxCW)) return null;
        let lo = Math.max(150, roomyCW);
        let hi = maxCW;
        if (fits(lo)) return lo;
        while (hi - lo > 4) {
          const mid = Math.round((lo + hi) / 2);
          if (fits(mid)) hi = mid; else lo = mid;
        }
        return hi;
      };
      // Size the controls for what is in the strip now; return the board cell size.
      const place = () => {
        if (!landscape) {
          controls.style.width = '';
          const cell = Math.min(W / cols, (H - gap - controls.offsetHeight) / rows);
          return { cell, fit: cell * Math.max(cols, rows) >= minBoard - 0.5 };
        }
        // Usually the controls fit beside a full-height board: one reflow, no search.
        const fw = roomyCW >= 150 && fits(roomyCW) ? roomyCW : fitWidth();
        const cw = Math.max(fw ?? maxCW, roomyCW);
        controls.style.width = `${cw}px`;
        return { cell: Math.min(H / rows, (W - gap - cw) / cols), fit: fw != null };
      };
      // Try every Play position (end of the palette row / end of the strip row / its own row
      // under the palette) and every card size with `items` in the strip: biggest board first,
      // then the chunkiest cards, then the most compact controls.
      const ARRS = [0, 1, 2];
      const evalAt = (arr, px) => {
        setArr(arr);
        setCard(px);
        return { arr, px, ...place(), wrap: wraps(), h: controls.offsetHeight };
      };
      const best = (list) => list.slice().sort((a, b) => Math.floor(b.cell) - Math.floor(a.cell) || a.h - b.h)[0];
      const search = (items) => {
        stripEl.replaceChildren(...buildStrip(items, false).kids);
        stripEl.style.minHeight = '';
        // The smallest cards leave the biggest board: that sets the bar.
        const base = ARRS.map((a) => evalAt(a, CARD_SIZES[0]));
        let pool = base.filter((c) => c.fit && !c.wrap);
        if (!pool.length) pool = base.filter((c) => c.fit);
        const fitAll = pool.length > 0;
        if (!fitAll) pool = base;
        const top = Math.max(...pool.map((c) => c.cell));
        // Big tablets may trade a little board for chunkier cards; phones keep every pixel.
        const tol = top * Math.max(cols, rows) >= 600 ? 0.93 : 0.985;
        // Then the biggest cards first; stop at the first size that keeps the board.
        let pick = null;
        for (const px of fitAll ? CARD_SIZES.slice(1).reverse() : []) {
          const good = ARRS.map((a) => evalAt(a, px)).filter((c) => c.fit && !c.wrap && c.cell >= top * tol);
          if (good.length) { pick = best(good); break; }
        }
        if (!pick) pick = best(pool);
        setArr(pick.arr);
        setCard(pick.px);
        const placed = place();
        return { ...pick, cell: placed.cell, fitAll, stripH: stripEl.offsetHeight };
      };

      const real = [...stripEl.childNodes];
      let pick;
      // The controls' size never depends on the board, so hide the board while trying
      // layouts: each trial then re-lays out only the controls (much cheaper on slow tablets).
      boardWrap.style.display = 'none';
      try {
        pick = search(solutionItems());
        // The child's program needs more room than the solution (or the solution can't fit
        // at all): plan for the program in the strip instead.
        stripEl.replaceChildren(...real);
        if (stripEl.offsetHeight > pick.stripH + 0.5 || wraps() || !pick.fitAll) {
          const alt = search(strip.items);
          if (alt.fitAll || !pick.fitAll) pick = alt;
          else { pick = search(solutionItems()); }
        }
      } finally {
        stripEl.replaceChildren(...real);
        boardWrap.style.display = '';
      }
      // Restore the picked plan with the real cards and reserve its strip height.
      setArr(pick.arr);
      setCard(pick.px);
      cardPx = pick.px;
      reserved = Math.max(pick.stripH, stripEl.offsetHeight);
      stripEl.style.minHeight = `${reserved}px`;
      cellLimit = pick.cell > 0 ? Math.floor(Math.max(pick.cell, minBoard / Math.max(cols, rows))) : Infinity;
    }

    // Safety nets for extreme content (tiny phone + many repeat blocks): first let the strip
    // scroll inside itself (palette + Play stay visible), then the controls; never the page.
    const over = controls.scrollHeight - maxCH;
    if (over > 0.5) {
      stripEl.style.minHeight = '';
      const target = Math.max(Math.ceil(cardPx + 34), Math.floor(stripEl.offsetHeight - over));
      stripEl.style.maxHeight = `${target}px`;
      stripEl.classList.add('is-scroll');
    }
    if (controls.scrollHeight > maxCH + 0.5) {
      if (!landscape) controls.style.maxHeight = `${Math.max(0, Math.floor(maxCH))}px`;
      controls.classList.add('is-tight');
    }
    sizeBoard();
  }

  function sizeBoard() {
    if (!ok()) return;
    const w = boardWrap.clientWidth;
    const hh = boardWrap.clientHeight;
    const cell = Math.max(8, Math.floor(Math.min(w / cols, hh / rows, cellLimit)));
    board.style.width = `${cell * cols}px`;
    board.style.height = `${cell * rows}px`;
    placeWin();
  }

  // layout() itself notices a new size (planKey) and re-plans.
  const roPuzzle = new ResizeObserver(() => scheduleLayout(false));
  roPuzzle.observe(puzzle);
  const roBoard = new ResizeObserver(() => sizeBoard());
  roBoard.observe(boardWrap);

  // ---------- wire up ----------
  playBtn.addEventListener('click', () => play());
  clearBtn.addEventListener('click', () => clearStrip());

  moveRobot(level.start, { instant: true });
  renderStrip();
  layout();
  poke();

  // The level's own spoken intro (levels.json "say"). New repeat cards also glow until the
  // child first puts one in the strip (purely visual; the words live in the level JSON).
  if (level.hasRepeat && !store.get('seen.repeat', false)) {
    newGlow = true;
    paletteCards.filter((el) => isRepeatCard(el.dataset.card)).forEach((el) => el.classList.add('is-new'));
  }
  ctx.instruct(level.say);

  cleanups.push(() => {
    alive = false;
    runSeq++;
    timers.forEach((t) => clearTimeout(t));
    timers.clear();
    if (layoutRaf) cancelAnimationFrame(layoutRaf);
    roPuzzle.disconnect();
    roBoard.disconnect();
    stripOffs.forEach((off) => off());
    paletteOffs.forEach((off) => off());
    fx.replaceChildren();
  });
  return () => cleanups.forEach((fn) => fn());
}

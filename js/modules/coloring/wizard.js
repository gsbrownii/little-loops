// "Make a picture" wizard (#/coloring): pick an animal -> something to wear -> a place.
// Each step is a grid of big picture tiles (one per part, any count). Tap a tile: it speaks,
// lights up and the wizard moves on ~600 ms later. After the last step the choice is saved
// and the paint screen opens. Top bar: "keep painting" (if a picture is saved) + "surprise me" dice.
// The brush comes first so it sits exactly where the paint screen's "New picture" button was: a
// double tap on "New picture" lands on the harmless brush, not on the dice.
// Starting a new picture (dice or the last step here) never throws away the painting being left:
// parts.js keeps the last coloured picture and the brush brings it back (choosePicture /
// resumePicture).
import { h, icon, flash, wait } from '../../core/dom.js';
import { releaseTaps } from '../../core/tapguard.js';
import { renderScene, ANIMAL_BOX } from './scene.js';
import { pickedLayout, PICK_SCALE, PICK_PEAK } from './layout.js';
import { watchSize } from './fit.js';
import { sceneParts, choosePicture, resumePicture, hasSaved, hasPrevious, readSaved, randomPicture, sayOf } from './parts.js';

const STEPS = {
  animal: { say: 'Pick an animal!', list: 'animals' },
  accessory: { say: 'Pick something to wear!', list: 'accessories' },
  background: { say: 'Pick a place!', list: 'backgrounds' },
};
const TILE_BG = ['#FFE3EC', '#DDF3FF', '#FFF3C4', '#DDF7E3', '#ECE2FF', '#FFE6D2'];
const ADVANCE_MS = 600;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function mountWizard(root, ctx, parts, { onSurprise } = {}) {
  const steps = ['animal', 'accessory', 'background']
    .filter((kind) => parts[STEPS[kind].list].length)
    .map((kind) => ({ kind, say: STEPS[kind].say, list: parts[STEPS[kind].list] }));

  const draft = { animal: null, accessory: null, background: null };
  let index = 0;
  let busy = false; // a tile was just picked; ignore taps until the next step shows
  let timer = 0;
  let token = 0; // bumps whenever pending work must be abandoned
  let size = { w: 0, h: 0 };
  let layout = null;

  const dotEls = steps.map(() => h('span', { class: 'wiz-dot' }));
  const dots = h('div', { class: 'wiz-dots', 'aria-hidden': 'true' }, dotEls);
  const grid = h('div', { class: 'wiz-grid' });
  grid.style.setProperty('--pick-scale', String(PICK_SCALE));
  grid.style.setProperty('--pick-peak', String(PICK_PEAK));
  const stage = h('div', { class: 'wiz-stage' }, dots, grid);
  const wiz = h('div', { class: 'wiz' }, stage);
  root.append(wiz);

  // ---- top bar: (keep painting +) surprise me ----
  const dice = h('button', { class: 'btn-round col-surprise', type: 'button', 'aria-label': 'Surprise me' }, icon('dice'));
  dice.addEventListener('click', surprise);
  const actions = [dice];
  if (hasSaved(ctx.store) || hasPrevious(ctx.store)) {
    const resume = h('button', { class: 'btn-round col-resume', type: 'button', 'aria-label': 'Keep painting my picture' }, icon('brush'));
    resume.addEventListener('click', () => {
      cancelPending();
      ctx.sound.play('tap');
      resumePicture(ctx.store); // a blank new pick gives way to the last coloured picture
      ctx.navigate('#/coloring/paint');
    });
    actions.unshift(resume); // first: under the paint screen's "New picture" button
  }
  ctx.chrome.setActions(actions);

  function cancelPending() {
    token++;
    clearTimeout(timer);
    timer = 0;
    busy = false;
  }

  function surprise() {
    cancelPending();
    busy = true;
    ctx.sound.play('whoosh');
    const saved = readSaved(ctx.store, parts);
    choosePicture(ctx.store, randomPicture(parts, saved ? saved.pic : null));
    if (onSurprise) onSurprise();
    ctx.navigate('#/coloring/paint');
  }

  // ---- layout ----
  // The step dots sit above the grid, or beside it on short landscape screens (more tile height).
  // .wiz clips (overflow hidden); the stage itself does not, so the picked tile's zoom + ring may
  // spill into the .wiz side/bottom padding. pickedLayout keeps that much room around the grid.
  const DOTS = 30;
  const DOTS_GAP = 6;
  function applyLayout() {
    if (!size.w || !steps.length) return;
    const n = steps[index].list.length;
    const side = size.h < 380 && size.w > size.h;
    stage.dataset.dots = side ? 'side' : 'top';
    const gap = size.w < 500 || size.h < 420 ? 12 : 18;
    const cs = getComputedStyle(wiz);
    const padX = parseFloat(cs.paddingLeft) || 0;
    const padB = parseFloat(cs.paddingBottom) || 0;
    // Clip-free box the grid (plus its picked-tile room) may use. Content is centred, so the
    // bottom padding only counts once both ends have it: with dots on top the dots row is the
    // top spill area; with dots beside, the top bar edge is the limit.
    const W = size.w - (side ? DOTS + DOTS_GAP : 0) + 2 * padX;
    const H = side ? size.h : size.h - (DOTS + DOTS_GAP) + 2 * padB;
    layout = pickedLayout(W, H, n, { gap });
    // The grid's own box must still fit inside the stage (only the picked ring may spill out).
    const innerW = size.w - (side ? DOTS + DOTS_GAP : 0);
    const gridW = layout.cols * layout.size + (layout.cols - 1) * gap;
    if (gridW > innerW) layout = pickedLayout(W - (gridW - innerW), H, n, { gap });
    grid.style.setProperty('--cols', String(layout.cols));
    grid.style.setProperty('--tile', `${layout.size}px`);
    grid.style.setProperty('--gap', `${layout.gap}px`);
    const tooMany = layout.rows * layout.size + (layout.rows - 1) * gap > H - 2 * layout.room;
    stage.classList.toggle('scroll', tooMany);
    stage.classList.toggle('is-overflow', tooMany);
  }
  const offSize = watchSize(stage, (w, hgt) => {
    size = { w, h: hgt };
    applyLayout();
  });
  ctx.onCleanup(offSize);

  // ---- thumbnails (all drawn by scene.js) ----
  function strokeFor(viewSide) {
    const art = (layout ? layout.size : 160) * 0.86;
    return clamp((2.4 * viewSide) / art, 3, 14); // ~2.4 px lines whatever the tile size
  }

  function thumbMarkup(kind, item) {
    if (kind === 'background') {
      const scene = sceneParts(parts, { animal: draft.animal, accessory: draft.accessory, background: item });
      return renderScene({ ...scene, mode: 'thumb', strokeWidth: strokeFor(600) });
    }
    const pic = kind === 'animal' ? { animal: item } : { animal: draft.animal, accessory: item };
    const approxSide = ANIMAL_BOX.width * parts.placement.scale * 1.1;
    return renderScene({ ...sceneParts(parts, pic), mode: 'thumb', strokeWidth: strokeFor(approxSide) });
  }

  // Animal (+ accessory) thumbnails are framed around what is actually drawn, so the art fills
  // the tile whatever its size inside the 300x300 animal box.
  function artBox(svg) {
    const P = parts.placement;
    const box = ANIMAL_BOX.width * P.scale;
    const paper = svg.firstElementChild;
    if (paper && paper.tagName.toLowerCase() === 'rect') paper.remove(); // let the tile colour show
    try {
      const b = svg.getBBox();
      if (b && b.width > 1 && b.height > 1) return { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height };
    } catch { /* not rendered: use the animal box */ }
    return { x0: P.x, y0: P.y, x1: P.x + box, y1: P.y + box };
  }

  function frame(svg, b) {
    const sw = Number(svg.querySelector('g')?.getAttribute('stroke-width')) || 5;
    const side = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 1.06 + sw * 2;
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const r = (v) => Math.round(v * 10) / 10;
    svg.setAttribute('viewBox', `${r(cx - side / 2)} ${r(cy - side / 2)} ${r(side)} ${r(side)}`);
  }

  // Each tile is framed on its own drawing: small accessories (a bow tie) get as much room as
  // tall ones (a balloon), which matters more on small tiles than an identical animal size.
  function frameThumbs() {
    grid.querySelectorAll('.wiz-art svg').forEach((svg) => frame(svg, artBox(svg)));
  }

  // ---- steps ----
  function show(i, { queued = false } = {}) {
    cancelPending();
    index = i;
    const step = steps[i];
    ctx.chrome.setBack(i === 0
      ? { icon: 'home', to: '#/' }
      : { icon: 'back', label: 'Back', to: () => show(i - 1) });
    dotEls.forEach((d, k) => {
      d.classList.toggle('is-done', k < i);
      d.classList.toggle('is-current', k === i);
    });
    applyLayout();

    grid.classList.remove('is-picking');
    const tiles = step.list.map((item, k) => {
      const art = h('span', { class: `wiz-art${step.kind === 'background' ? ' is-scene' : ''}`, html: thumbMarkup(step.kind, item) });
      const tile = h('button', {
        class: 'wiz-tile',
        type: 'button',
        'aria-label': item.name,
        dataset: { id: item.id, kind: step.kind },
        style: { '--tile-bg': TILE_BG[k % TILE_BG.length] },
      }, art, h('span', { class: 'wiz-check' }, icon('check')));
      if (draft[step.kind] === item) tile.classList.add('is-current');
      tile.addEventListener('click', () => pick(item, tile));
      return tile;
    });
    grid.replaceChildren(...tiles);
    releaseTaps(); // a new step replaced the screen: ignore the rest of a double tap
    if (step.kind !== 'background') frameThumbs();
    flash(grid, 'wiz-enter', 450);

    if (queued) {
      // Let the picked item's name finish, then say the next instruction.
      ctx.instruct(step.say, { speak: false });
      ctx.say(step.say, { interrupt: false });
    } else {
      ctx.instruct(step.say);
    }
  }

  function pick(item, tile) {
    if (busy) return;
    busy = true;
    const step = steps[index];
    ctx.sound.play('select');
    grid.querySelectorAll('.wiz-tile.is-current').forEach((t) => t.classList.remove('is-current'));
    tile.classList.add('is-picked');
    grid.classList.add('is-picking');
    draft[step.kind] = item;
    const said = ctx.say(sayOf(item));
    const my = token;
    timer = setTimeout(async () => {
      timer = 0;
      if (!ctx.isActive() || my !== token) return;
      if (index < steps.length - 1) {
        show(index + 1, { queued: true });
        return;
      }
      choosePicture(ctx.store, { ...draft });
      dotEls.forEach((d) => { d.classList.add('is-done'); d.classList.remove('is-current'); });
      // Let "A sunny meadow!" finish before the paint screen speaks (navigation stops speech).
      await Promise.race([said, wait(1400)]);
      if (!ctx.isActive() || my !== token) return;
      ctx.navigate('#/coloring/paint');
    }, ADVANCE_MS);
  }

  ctx.onCleanup(() => {
    token++;
    clearTimeout(timer);
  });

  show(0);
}

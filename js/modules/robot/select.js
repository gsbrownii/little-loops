// Robot Puzzles — level select screen (#/robot).
// Big numbered buttons; a star when solved, a lock when not yet playable; the next
// puzzle to play pulses and has the robot sitting on it.
import { h, icon, flash, fromMarkup } from '../../core/dom.js';
import { isDone, isUnlocked, nextIndex } from './levels.js';
import { loopSVG } from './art.js';

export function mountLevelSelect(root, ctx, data) {
  const { levels } = data;
  const store = ctx.store;
  const cleanups = [];

  ctx.chrome.setBack({ icon: 'home', to: '#/', label: 'Home' });
  ctx.chrome.setActions([]);
  ctx.instruct('Pick a puzzle!');

  const next = nextIndex(store, levels);
  const buttons = levels.map((lv, i) => {
    const done = isDone(store, lv);
    const open = isUnlocked(store, levels, i);
    const state = done ? 'done' : open ? 'open' : 'locked';
    const btn = h('button', {
      class: `rb-lvl${i === next ? ' is-next' : ''}`,
      type: 'button',
      dataset: { n: String(i + 1), state, kind: lv.hasRepeat ? 'loop' : 'seq' },
      'aria-label': `Puzzle ${i + 1}${done ? ', solved' : ''}${open ? '' : ', locked'}`,
    },
      h('span', { class: 'rb-lvl-num' }, String(i + 1)),
      lv.hasRepeat && open ? h('span', { class: 'rb-lvl-loop' }, fromMarkup(loopSVG(null))) : null,
      done ? h('span', { class: 'rb-lvl-star' }, icon('star')) : null,
      open ? null : h('span', { class: 'rb-lvl-lock' }, icon('lock')),
      i === next ? h('img', { class: 'rb-lvl-robot', src: ctx.asset('art/robot.svg'), alt: '', draggable: 'false' }) : null
    );
    btn.addEventListener('click', () => {
      if (!open) {
        ctx.sound.play('locked');
        flash(btn, 'wobble');
        ctx.say('Finish the puzzle before this one first!');
        return;
      }
      ctx.sound.play('tap');
      ctx.navigate(`#/robot/${i + 1}`);
    });
    return btn;
  });

  const grid = h('div', { class: 'rb-levels' }, buttons);
  const wrap = h('div', { class: 'rb-select scroll' }, grid);
  root.append(wrap);

  // Fit the buttons to the screen: choose the column count that gives the biggest buttons.
  const fit = () => {
    if (!ctx.isActive()) return;
    const cs = getComputedStyle(wrap);
    const W = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const H = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const n = buttons.length;
    const gap = Math.round(Math.max(12, Math.min(24, Math.min(W, H) * 0.03)));
    let best = { size: 0, cols: Math.min(n, 3) };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const size = Math.floor(Math.min((W - (cols - 1) * gap) / cols, (H - (rows - 1) * gap) / rows));
      if (size > best.size) best = { size, cols };
    }
    let { size, cols } = best;
    size = Math.min(size, 180);
    if (size < 64) {
      // Too many levels to fit even with 64px buttons: keep them at 64 and let the list scroll.
      size = 64;
      cols = Math.max(1, Math.floor((W + gap) / (size + gap)));
    }
    grid.style.setProperty('--s', `${size}px`);
    grid.style.setProperty('--gap', `${gap}px`);
    grid.style.gridTemplateColumns = `repeat(${cols}, ${size}px)`;
  };
  const ro = new ResizeObserver(() => fit());
  ro.observe(wrap);
  cleanups.push(() => ro.disconnect());
  fit();

  return () => cleanups.forEach((fn) => fn());
}

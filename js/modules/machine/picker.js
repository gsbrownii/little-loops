// Loop Machine — tier picker (#/machine). Three big buttons: a small / medium / large robot,
// 1 / 2 / 3 stars, the best gold-star score (trophy) and the age range for grown-ups.
import { h, fromMarkup, flash } from '../../core/dom.js';
import { starSVG, trophySVG } from './art.js';

const ROBOT_SCALE = [0.5, 0.7, 0.9]; // share of the art box (height and width)

export function mountPicker(root, ctx, data) {
  const timers = new Set();
  let leaving = false;

  ctx.chrome.setBack({ icon: 'home', to: '#/', label: 'Home' });
  ctx.chrome.setActions([]);
  ctx.instruct('Pick your machine! One star is easy. Three stars is tricky!');

  const cards = data.tiers.map((tier, i) => {
    const count = (data.byTier[tier.id] || []).length;
    const bestRaw = Number(ctx.store.get(`best.${tier.id}`, 0));
    const best = Number.isFinite(bestRaw) && bestRaw > 0 ? Math.floor(bestRaw) : 0;
    const stars = h('span', { class: 'mc-tier-stars' },
      Array.from({ length: tier.stars }, () => h('span', { class: 'mc-tier-star' }, fromMarkup(starSVG('gold')))));
    // Scale by the art box's height AND width (whichever is smaller wins), so the three robots
    // stay small / medium / large in every orientation; CSS stands the drawing on the floor.
    const pct = `${Math.round((ROBOT_SCALE[i] ?? 1) * 100)}%`;
    const robot = h('img', {
      class: 'mc-tier-robot',
      src: ctx.asset('art/robot.svg'),
      alt: '',
      draggable: 'false',
      style: { height: pct, maxWidth: pct },
    });
    const btn = h('button', {
      class: 'mc-tier',
      type: 'button',
      dataset: count ? { tier: tier.id, index: String(i) } : { tier: tier.id, index: String(i), empty: 'true' },
      'aria-label': `${tier.name} machine, ages ${tier.ages}${best ? `, best ${best} gold stars` : ''}`,
    },
      h('span', { class: 'mc-tier-art', style: { '--rs': String(ROBOT_SCALE[i] ?? 1) } }, h('span', { class: 'mc-tier-floor' }), robot),
      h('span', { class: 'mc-tier-info' },
        stars,
        h('span', { class: 'mc-tier-name' }, tier.name),
        h('span', { class: 'mc-tier-ages' }, `Ages ${tier.ages}`)),
      best ? h('span', { class: 'mc-tier-best', 'aria-hidden': 'true' },
        h('span', { class: 'mc-tier-trophy' }, fromMarkup(trophySVG())),
        h('span', { class: 'mc-tier-best-n' }, String(best))) : null
    );
    btn.addEventListener('click', () => {
      if (leaving) return;
      if (!count) {
        ctx.sound.play('locked');
        flash(btn, 'wobble');
        ctx.say('This machine is resting. Try another one!');
        return;
      }
      leaving = true;
      ctx.sound.play('select');
      btn.classList.add('is-chosen');
      const t = setTimeout(() => {
        timers.delete(t);
        if (ctx.isActive()) ctx.navigate(`#/machine/${encodeURIComponent(tier.id)}`);
      }, 260);
      timers.add(t);
    });
    return btn;
  });

  root.append(h('div', { class: 'mc-picker scroll', dataset: { count: String(cards.length) } }, cards));

  return () => {
    timers.forEach((t) => clearTimeout(t));
    timers.clear();
  };
}

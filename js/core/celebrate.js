// Short success celebration: confetti stars + sound. Never blocks taps (pointer-events: none).
// await celebrate();              // small burst + 'success' sound (~1.4s)
// await celebrate({ big: true }); // bigger burst, giant star, 'fanfare' sound (~2.4s)
import { h, prefersReducedMotion } from './dom.js';
import { sound } from './sound.js';

const COLORS = ['#FF6B6B', '#FFD166', '#06D6A0', '#4CC9F0', '#9B5DE5', '#FF8FAB', '#FF9F1C'];
const STAR = 'M12 1 L15 8.6 L23 9.3 L17 14.6 L18.9 22.6 L12 18.3 L5.1 22.6 L7 14.6 L1 9.3 L9 8.6 Z';

const PRAISE = ['You did it!', 'Great job!', 'Awesome!', 'Super thinking!', 'Woo-hoo!', 'Fantastic!', 'Hooray!'];
let lastPraise = -1;

/** A random cheerful phrase (never the same twice in a row). */
export function praise() {
  let i;
  do { i = Math.floor(Math.random() * PRAISE.length); } while (i === lastPraise && PRAISE.length > 1);
  lastPraise = i;
  return PRAISE[i];
}

export function celebrate({ big = false, sound: withSound = true } = {}) {
  if (withSound) sound.play(big ? 'fanfare' : 'success');
  const reduced = prefersReducedMotion();
  const layer = h('div', { class: 'celebrate', 'aria-hidden': 'true' });
  document.body.append(layer);
  const count = reduced ? 0 : big ? 46 : 26;
  const anims = [];
  const vmin = Math.min(window.innerWidth, window.innerHeight);

  for (let i = 0; i < count; i++) {
    const color = COLORS[i % COLORS.length];
    const isStar = i % 3 !== 0;
    const size = 16 + Math.random() * (big ? 26 : 18);
    const bit = h('div', {
      class: 'celebrate-bit',
      html: isStar
        ? `<svg viewBox="0 0 24 24"><path d="${STAR}" fill="${color}" stroke="#2B2D42" stroke-width="1.2" stroke-linejoin="round"/></svg>`
        : `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="${color}" stroke="#2B2D42" stroke-width="1.2"/></svg>`,
    });
    bit.style.width = bit.style.height = `${size}px`;
    layer.append(bit);
    const angle = Math.random() * Math.PI * 2;
    const dist = vmin * (0.25 + Math.random() * (big ? 0.5 : 0.35));
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    const spin = (Math.random() - 0.5) * 720;
    anims.push(
      bit.animate(
        [
          { transform: 'translate(-50%, -50%) scale(0.2) rotate(0deg)', opacity: 1 },
          { transform: `translate(calc(-50% + ${dx * 0.8}px), calc(-50% + ${dy * 0.8}px)) scale(1) rotate(${spin * 0.7}deg)`, opacity: 1, offset: 0.6 },
          { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + vmin * 0.15}px)) scale(0.8) rotate(${spin}deg)`, opacity: 0 },
        ],
        { duration: (big ? 1900 : 1200) + Math.random() * 400, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' }
      )
    );
  }

  const star = h('div', {
    class: 'celebrate-star',
    html: `<svg viewBox="0 0 24 24"><path d="${STAR}" fill="#FFD166" stroke="#2B2D42" stroke-width="1" stroke-linejoin="round"/></svg>`,
  });
  layer.append(star);
  const starSize = big ? 0.55 : 0.32;
  star.style.width = star.style.height = `${Math.round(vmin * starSize)}px`;
  anims.push(
    star.animate(
      reduced
        ? [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }]
        : [
            { transform: 'translate(-50%, -50%) scale(0) rotate(-40deg)', opacity: 1 },
            { transform: 'translate(-50%, -50%) scale(1.15) rotate(8deg)', opacity: 1, offset: 0.3 },
            { transform: 'translate(-50%, -50%) scale(1) rotate(0deg)', opacity: 1, offset: 0.75 },
            { transform: 'translate(-50%, -50%) scale(1.3) rotate(0deg)', opacity: 0 },
          ],
      { duration: big ? 2200 : 1300, easing: 'ease-out', fill: 'forwards' }
    )
  );

  const total = big ? 2400 : 1500;
  return new Promise((resolve) => {
    setTimeout(() => {
      anims.forEach((a) => a.cancel());
      layer.remove();
      resolve();
    }, total);
  });
}

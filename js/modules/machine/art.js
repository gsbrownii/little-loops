// Loop Machine — original SVG art (strings). Chunky #2B2D42 outlines, bright fills.
// Everything here is fixed markup: content (words/numbers) is never interpolated into it.
import { INK } from './tokens.js';

const G = `stroke="${INK}" stroke-linecap="round" stroke-linejoin="round"`;

export const STAR_POINTS = '50,6 62.6,36.4 95.4,38.9 70.4,60.2 78.2,92.1 50,74.8 21.8,92.1 29.6,60.2 4.6,38.9 37.4,36.4';

/** A star; kind = 'gold' | 'silver' | 'empty'. */
export function starSVG(kind = 'gold') {
  if (kind === 'empty') {
    return `<svg viewBox="0 0 100 100" aria-hidden="true"><polygon points="${STAR_POINTS}" fill="rgba(43,45,66,0.08)" stroke="rgba(43,45,66,0.28)" stroke-width="7" stroke-linejoin="round"/></svg>`;
  }
  const fill = kind === 'silver' ? '#DCE2EE' : '#FFD166';
  const shine = kind === 'silver' ? '#FFFFFF' : '#FFF1C2';
  return `<svg viewBox="0 0 100 100" aria-hidden="true"><g ${G}><polygon points="${STAR_POINTS}" fill="${fill}" stroke-width="7"/>`
    + `<path d="M36 42 L44 40" fill="none" stroke="${shine}" stroke-width="7"/></g></svg>`;
}

export function trophySVG() {
  return `<svg viewBox="0 0 100 100" aria-hidden="true"><g ${G} stroke-width="6">`
    + '<path d="M28 18 Q8 18 12 36 Q16 52 34 52" fill="none"/>'
    + '<path d="M72 18 Q92 18 88 36 Q84 52 66 52" fill="none"/>'
    + '<path d="M26 12 H74 V36 Q74 64 50 66 Q26 64 26 36 Z" fill="#FFD166"/>'
    + '<path d="M44 66 H56 V78 H44 Z" fill="#E0A92E"/>'
    + '<rect x="30" y="78" width="40" height="12" rx="4" fill="#FF9F1C"/>'
    + '<path d="M38 22 V38" fill="none" stroke="#FFF1C2" stroke-width="6"/>'
    + '</g></svg>';
}

/** The pulsing mystery box's question mark (white with an ink outline). */
export function qmarkSVG() {
  const d = 'M34 38 Q34 20 50 20 Q67 20 67 36 Q67 47 56 52 Q50 55 50 62 V65';
  return `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke-linecap="round" stroke-linejoin="round" fill="none">`
    + `<path d="${d}" stroke="${INK}" stroke-width="22"/><path d="${d}" stroke="#FFFFFF" stroke-width="11"/>`
    + `<circle cx="50" cy="82" r="10" fill="#FFFFFF" stroke="${INK}" stroke-width="5.5"/></g></svg>`;
}

/** Belt separators: '→' '+' '='. */
export function symbolSVG(sym) {
  const s = `fill="none" stroke="${INK}" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"`;
  let body = '';
  if (sym === '→') body = `<path d="M14 50 H80 M60 29 L82 50 L60 71" ${s}/>`;
  else if (sym === '+') body = `<path d="M50 20 V80 M20 50 H80" ${s}/>`;
  else if (sym === '=') body = `<path d="M20 38 H80 M20 64 H80" ${s}/>`;
  return `<svg viewBox="0 0 100 100" aria-hidden="true">${body}</svg>`;
}

export function funnelSVG() {
  return `<svg viewBox="0 0 64 64" aria-hidden="true"><g ${G} stroke-width="4">`
    + '<path d="M8 12 H56 L40 38 V56 H24 V38 Z" fill="#FF9F1C"/>'
    + '<rect x="4" y="6" width="56" height="10" rx="5" fill="#FFD166"/>'
    + '<path d="M17 24 H47" fill="none" stroke="#FFFFFF" stroke-width="4" opacity="0.75"/>'
    + '<path d="M24 46 H40" fill="none" stroke-width="3.5"/>'
    + '</g></svg>';
}

export function dialSVG() {
  const ticks = [-60, -30, 0, 30, 60]
    .map((a) => `<path d="M32 9 V15" transform="rotate(${a} 32 34)" fill="none" stroke-width="3.5"/>`).join('');
  return `<svg viewBox="0 0 64 64" aria-hidden="true"><g ${G}>`
    + '<circle cx="32" cy="34" r="25" fill="#FFFFFF" stroke-width="4.5"/>'
    + '<path d="M14 40 A19 19 0 0 1 22 18" fill="none" stroke="#3DDC97" stroke-width="5" opacity="0.9"/>'
    + '<path d="M42 18 A19 19 0 0 1 50 40" fill="none" stroke="#FF6B6B" stroke-width="5" opacity="0.9"/>'
    + ticks
    + '<g class="mc-needle"><path d="M32 34 L32 15" fill="none" stroke="#FF6B6B" stroke-width="5"/></g>'
    + '<circle cx="32" cy="34" r="5" fill="#2B2D42" stroke="none"/>'
    + '</g></svg>';
}

export function gearSVG() {
  const teeth = [0, 45, 90, 135, 180, 225, 270, 315]
    .map((a) => `<rect x="27" y="3" width="10" height="13" rx="3" transform="rotate(${a} 32 32)"/>`).join('');
  return `<svg viewBox="0 0 64 64" aria-hidden="true"><g class="mc-gear-spin"><g ${G} stroke-width="4" fill="#FFD166">${teeth}`
    + '<circle cx="32" cy="32" r="19"/></g><circle cx="32" cy="32" r="7" fill="#FFF6E5" stroke="#2B2D42" stroke-width="4"/></g></svg>';
}

/** Little LCD faces for the machine's display. mood: idle | think | happy | hint */
export function faceSVG(mood = 'idle') {
  const c = '#8CFFC1';
  const s = `fill="none" stroke="${c}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"`;
  let body;
  if (mood === 'happy') {
    body = `<path d="M24 38 Q32 28 40 38" ${s}/><path d="M60 38 Q68 28 76 38" ${s}/>`
      + `<path d="M30 52 Q50 74 70 52 Z" fill="${c}" stroke="${c}" stroke-width="5" stroke-linejoin="round"/>`;
  } else if (mood === 'think') {
    body = `<circle cx="34" cy="32" r="6" fill="${c}"/><circle cx="66" cy="32" r="6" fill="${c}"/>`
      + `<path d="M36 60 Q43 54 50 60 Q57 66 64 60" ${s}/>`;
  } else if (mood === 'hint') {
    body = `<path d="M50 14 C34 14 28 28 33 38 C36 44 40 46 40 54 H60 C60 46 64 44 67 38 C72 28 66 14 50 14 Z" fill="none" stroke="${c}" stroke-width="6" stroke-linejoin="round"/>`
      + `<path d="M42 64 H58 M44 72 H56" ${s}/>`;
  } else {
    body = `<circle cx="34" cy="34" r="7" fill="${c}"/><circle cx="66" cy="34" r="7" fill="${c}"/>`
      + `<path d="M34 56 Q50 70 66 56" ${s}/>`;
  }
  return `<svg viewBox="0 0 100 84" aria-hidden="true">${body}</svg>`;
}

/** A row of n small gold stars (the tier badge in the top bar). */
export function miniStarsSVG(n) {
  const w = 34 * n + 6;
  const stars = Array.from({ length: n }, (_, i) =>
    `<polygon points="${STAR_POINTS}" transform="translate(${3 + i * 34} 4) scale(0.34)" fill="#FFD166" stroke="${INK}" stroke-width="12" stroke-linejoin="round"/>`).join('');
  return `<svg viewBox="0 0 ${w} 42" width="${w}" height="42" aria-hidden="true">${stars}</svg>`;
}

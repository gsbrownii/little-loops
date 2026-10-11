// Robot Puzzles — original inline SVG art (cards, star, obstacles, hint path, effects).
// Everything is outlined in the app ink colour (#2B2D42) to match art/robot.svg.
// Markup is built only from constants and numbers (never from level content).

export const INK = '#2B2D42';

/** Card ids in palette order. */
export const CARD_IDS = ['up', 'down', 'left', 'right', 'repeat2', 'repeat3'];

/** One bright colour per card (arrow direction or repeat count). */
export const CARD_COLORS = {
  up: '#3DDC97',
  down: '#FF8FAB',
  left: '#B58CF5',
  right: '#4CC9F0',
  repeat2: '#FFD166',
  repeat3: '#FFAA45',
};

/** Spoken when a card is placed or tapped. */
export const CARD_SAY = {
  up: 'Up!',
  down: 'Down!',
  left: 'Left!',
  right: 'Right!',
  repeat2: 'Repeat two times!',
  repeat3: 'Repeat three times!',
};

/** Accessible names (screen readers / grown-ups). */
export const CARD_LABEL = {
  up: 'Up arrow',
  down: 'Down arrow',
  left: 'Left arrow',
  right: 'Right arrow',
  repeat2: 'Repeat two times',
  repeat3: 'Repeat three times',
};

const ROTATE = { up: 0, right: 90, down: 180, left: 270 };

/** Big chunky arrow (white, ink outline) for an arrow card. */
export function arrowSVG(dir) {
  const rot = ROTATE[dir] ?? 0;
  return `<svg class="rb-glyph" viewBox="0 0 48 48" aria-hidden="true" focusable="false">`
    + `<g transform="rotate(${rot} 24 24)">`
    + `<path d="M24 4 L44 24 H32.5 V44 H15.5 V24 H4 Z" fill="#FFFFFF" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>`
    + `</g></svg>`;
}

// Loop arrow geometry: a circle with a gap at the top and an arrowhead that points back
// toward the start, i.e. "go round again".
const LOOP = (() => {
  const cx = 24;
  const cy = 24;
  const r = 15.5;
  const a0 = (-62 * Math.PI) / 180; // start (top right)
  const a1 = (232 * Math.PI) / 180; // end (top left), drawn clockwise
  const p = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [sx, sy] = p(a0);
  const [ex, ey] = p(a1);
  const t = [-Math.sin(a1), Math.cos(a1)]; // direction of travel at the end
  const nrm = [Math.cos(a1), Math.sin(a1)];
  const tip = [ex + t[0] * 7.5, ey + t[1] * 7.5];
  const base = [ex - t[0] * 1.5, ey - t[1] * 1.5];
  const b1 = [base[0] + nrm[0] * 7, base[1] + nrm[1] * 7];
  const b2 = [base[0] - nrm[0] * 7, base[1] - nrm[1] * 7];
  const f = (n) => n.toFixed(2);
  return {
    arc: `M${f(sx)} ${f(sy)} A${r} ${r} 0 1 1 ${f(ex)} ${f(ey)}`,
    head: `M${f(tip[0])} ${f(tip[1])} L${f(b1[0])} ${f(b1[1])} L${f(b2[0])} ${f(b2[1])} Z`,
  };
})();

/** Loop icon with the repeat count ("×2" / "×3") in the middle (no count when `times` is null). */
export function loopSVG(times) {
  const n = times == null ? 0 : Math.max(1, Math.min(9, Number(times) | 0));
  return `<svg class="rb-glyph rb-loop" viewBox="0 0 48 48" aria-hidden="true" focusable="false">`
    + `<path d="${LOOP.arc}" fill="none" stroke="${INK}" stroke-width="9.5" stroke-linecap="round"/>`
    + `<path d="${LOOP.head}" fill="${INK}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>`
    + `<path d="${LOOP.arc}" fill="none" stroke="#FFFFFF" stroke-width="4" stroke-linecap="round"/>`
    + `<path d="${LOOP.head}" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="0.5" stroke-linejoin="round"/>`
    + (n ? `<text x="24" y="30" text-anchor="middle" font-size="16" font-weight="900" fill="${INK}" `
      + `font-family="ui-rounded, 'Arial Rounded MT Bold', system-ui, sans-serif">×${n}</text>` : '')
    + `</svg>`;
}

/** Face markup for a palette/strip card. */
export function cardSVG(card) {
  if (card === 'repeat2') return loopSVG(2);
  if (card === 'repeat3') return loopSVG(3);
  return arrowSVG(card);
}

// ---------- Board pieces (viewBox 0 0 100 100, drawn inside one cell) ----------

export function starSVG() {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = (-90 + i * 36) * (Math.PI / 180);
    const r = i % 2 === 0 ? 43 : 20;
    pts.push(`${(50 + r * Math.cos(a)).toFixed(1)},${(53 + r * Math.sin(a)).toFixed(1)}`);
  }
  return `<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">`
    + `<polygon points="${pts.join(' ')}" fill="#FFD166" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>`
    + `<path d="M40 32 Q44 26 50 25" fill="none" stroke="#FFFFFF" stroke-width="4" stroke-linecap="round" opacity="0.9"/>`
    + `<circle cx="42.5" cy="51" r="3.6" fill="${INK}"/><circle cx="57.5" cy="51" r="3.6" fill="${INK}"/>`
    + `<path d="M43.5 59.5 Q50 65.5 56.5 59.5" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>`
    + `<circle cx="37" cy="58" r="3" fill="#FF8FAB"/><circle cx="63" cy="58" r="3" fill="#FF8FAB"/>`
    + `</svg>`;
}

const OBSTACLES = {
  rock: `<path d="M14 78 C9 63 17 46 31 41 C35 27 55 20 67 31 C80 33 91 49 88 64 C90 72 86 78 80 80 L20 80 C17 80 15 79 14 78 Z" fill="#B8BDD0" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>`
    + `<path d="M31 41 C38 44 41 51 40 58" fill="none" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/>`
    + `<path d="M67 31 C64 40 66 48 72 52" fill="none" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/>`
    + `<ellipse cx="54" cy="66" rx="12" ry="6" fill="#9CA1B8"/>`
    + `<path d="M44 33 Q50 29 57 30" fill="none" stroke="#FFFFFF" stroke-width="4" stroke-linecap="round" opacity="0.85"/>`,
  bush: `<g stroke="${INK}" stroke-width="10">`
    + `<circle cx="30" cy="60" r="20"/><circle cx="50" cy="44" r="23"/><circle cx="70" cy="60" r="20"/><rect x="24" y="58" width="52" height="22" rx="10"/></g>`
    + `<g fill="#3DDC97"><circle cx="30" cy="60" r="20"/><circle cx="50" cy="44" r="23"/><circle cx="70" cy="60" r="20"/><rect x="24" y="58" width="52" height="22" rx="10"/></g>`
    + `<g fill="none" stroke="#1FA56B" stroke-width="3.5" stroke-linecap="round"><path d="M38 40 Q44 36 48 40"/><path d="M58 52 Q64 48 68 52"/><path d="M24 62 Q29 58 34 62"/></g>`
    + `<circle cx="44" cy="64" r="4.5" fill="#FF6B6B" stroke="${INK}" stroke-width="2.5"/><circle cx="62" cy="38" r="4.5" fill="#FF6B6B" stroke="${INK}" stroke-width="2.5"/><circle cx="74" cy="68" r="4.5" fill="#FF6B6B" stroke="${INK}" stroke-width="2.5"/>`,
  puddle: `<path d="M12 64 C10 50 26 44 40 47 C50 37 72 39 80 49 C92 51 94 66 84 73 C76 81 58 80 48 78 C34 82 14 78 12 64 Z" fill="#4CC9F0" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>`
    + `<ellipse cx="50" cy="62" rx="22" ry="7" fill="none" stroke="#A9E9FA" stroke-width="4"/>`
    + `<ellipse cx="50" cy="62" rx="9" ry="3" fill="none" stroke="#FFFFFF" stroke-width="3"/>`
    + `<path d="M24 56 Q28 52 34 52" fill="none" stroke="#FFFFFF" stroke-width="4" stroke-linecap="round"/>`,
};

export function obstacleSVG(kind) {
  const body = OBSTACLES[kind] || OBSTACLES.rock;
  return `<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** The robot's starting pad (drawn under the robot). */
export function padSVG() {
  return `<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">`
    + `<rect x="11" y="11" width="78" height="78" rx="20" fill="#CFEFFF" stroke="#2A9BC0" stroke-width="4" stroke-dasharray="10 8" stroke-linecap="round"/>`
    + `</svg>`;
}

/** Little "bonk" burst shown where the robot bumped. */
export function bonkSVG() {
  return `<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">`
    + `<g stroke="${INK}" stroke-width="5" stroke-linecap="round">`
    + `<path d="M50 10 V28"/><path d="M50 72 V90"/><path d="M10 50 H28"/><path d="M72 50 H90"/>`
    + `<path d="M22 22 L33 33"/><path d="M78 22 L67 33"/><path d="M22 78 L33 67"/><path d="M78 78 L67 67"/></g>`
    + `<circle cx="50" cy="50" r="13" fill="#FFD166" stroke="${INK}" stroke-width="4"/>`
    + `</svg>`;
}

/** A finger-touch marker used by the "how to drag" demo. */
export function touchSVG() {
  return `<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">`
    + `<circle cx="50" cy="50" r="40" fill="rgba(255,255,255,0.55)" stroke="${INK}" stroke-width="5"/>`
    + `<circle cx="50" cy="50" r="17" fill="#FFFFFF" stroke="${INK}" stroke-width="5"/>`
    + `</svg>`;
}

/**
 * Hint path: dotted line + sparkles through the reference solution's cells.
 * `cells` = [[c, r], ...]; viewBox is in cell units so it scales with the board.
 */
export function hintSVG(cells, cols, rows) {
  const pts = cells.map(([c, r]) => [c + 0.5, r + 0.5]);
  const line = pts.map(([x, y]) => `${x},${y}`).join(' ');
  const dots = pts.slice(1).map(([x, y], i) =>
    `<g class="rb-hint-dot" style="animation-delay:${(i * 0.18).toFixed(2)}s">`
    + `<circle cx="${x}" cy="${y}" r="0.15" fill="#FFD166" stroke="#FF9F1C" stroke-width="0.045"/>`
    + `<circle cx="${x - 0.04}" cy="${y - 0.04}" r="0.045" fill="#FFFFFF"/></g>`).join('');
  return `<svg class="rb-hint" viewBox="0 0 ${cols} ${rows}" aria-hidden="true" focusable="false">`
    + `<polyline points="${line}" fill="none" stroke="#FFFFFF" stroke-width="0.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`
    + `<polyline class="rb-hint-line" points="${line}" fill="none" stroke="#9B5DE5" stroke-width="0.075" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="0.001 0.16"/>`
    + dots
    + `</svg>`;
}

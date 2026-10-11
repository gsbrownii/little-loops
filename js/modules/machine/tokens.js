// Loop Machine picture tokens — PURE (no DOM). Shared by the game (machine.js) and the
// content validator (tools/validate-machine.mjs).
//
// A "token" is one thing shown on the belt or on an answer button:
//   number          4, 12, 144                 -> drawn as a number chip
//   word / letter   "cat", "c", "sunflower"     -> drawn as a word chip
//   symbol          "→" "+" "=" "?"             -> separators; "?" marks the mystery box
//   picture         "circle-red", "star-blue"  (shape-colour)  or  "apple", "fish" (object)
// Picture tokens are drawn by tokenSVG() in a 100x100 box with the app's chunky outline style.

export const INK = '#2B2D42';
export const SHAPES = ['circle', 'square', 'triangle', 'star', 'heart', 'diamond'];
export const COLORS = {
  red: '#FF4D4D',
  blue: '#3A7BFF',
  yellow: '#FFD23F',
  green: '#2DBE60',
  purple: '#9B5DE5',
  orange: '#FF9F1C',
};
export const SYMBOLS = ['→', '+', '=', '?'];

const SHAPE_GEOM = {
  circle: '<circle cx="50" cy="50" r="38"/>',
  square: '<rect x="14" y="14" width="72" height="72" rx="10"/>',
  triangle: '<path d="M50 12 L90 84 L10 84 Z"/>',
  star: '<polygon points="50,10 60.6,37.4 90,39 67.1,57.6 74.7,86 50,70 25.3,86 32.9,57.6 10,39 39.4,37.4"/>',
  heart: '<path d="M50 86 C20 66 8 48 14 32 C20 16 42 14 50 30 C58 14 80 16 86 32 C92 48 80 66 50 86 Z"/>',
  diamond: '<path d="M50 10 L86 50 L50 90 L14 50 Z"/>',
};

export const OBJECTS = {
  apple: {
    name: 'apple',
    svg: '<path d="M50 30 C30 18 10 32 14 56 C18 80 36 92 50 84 C64 92 82 80 86 56 C90 32 70 18 50 30 Z" fill="#FF4D4D"/>'
      + '<path d="M50 30 Q52 18 58 11" fill="none"/>'
      + '<path d="M55 22 Q68 9 80 17 Q67 29 55 22 Z" fill="#2DBE60" stroke-width="4"/>'
      + '<path d="M30 46 Q32 38 38 35" fill="none" stroke="#FFFFFF" stroke-width="5"/>',
  },
  fish: {
    name: 'fish',
    svg: '<path d="M70 50 L93 31 L93 69 Z" fill="#FF9F1C"/>'
      + '<ellipse cx="45" cy="50" rx="32" ry="22" fill="#FF9F1C"/>'
      + '<path d="M44 30 Q52 40 44 50" fill="none" stroke-width="4"/>'
      + '<circle cx="28" cy="45" r="5" fill="#2B2D42" stroke="none"/>'
      + '<path d="M20 58 Q26 62 32 58" fill="none" stroke-width="4"/>',
  },
  flower: {
    name: 'flower',
    svg: '<path d="M50 58 L50 94" fill="none" stroke="#1E8E46" stroke-width="7"/>'
      + '<path d="M50 80 Q64 66 76 72 Q64 86 50 80 Z" fill="#2DBE60" stroke-width="4"/>'
      + '<circle cx="50" cy="22" r="14" fill="#FF8FC8"/><circle cx="68" cy="35" r="14" fill="#FF8FC8"/>'
      + '<circle cx="61" cy="56" r="14" fill="#FF8FC8"/><circle cx="39" cy="56" r="14" fill="#FF8FC8"/>'
      + '<circle cx="32" cy="35" r="14" fill="#FF8FC8"/><circle cx="50" cy="40" r="11" fill="#FFD23F"/>',
  },
  balloon: {
    name: 'balloon',
    svg: '<path d="M50 76 Q40 86 52 96" fill="none" stroke-width="4"/>'
      + '<path d="M45 76 L55 76 L50 69 Z" fill="#3A7BFF" stroke-width="4"/>'
      + '<ellipse cx="50" cy="40" rx="27" ry="31" fill="#3A7BFF"/>'
      + '<path d="M36 28 Q40 20 47 18" fill="none" stroke="#FFFFFF" stroke-width="5"/>',
  },
  cupcake: {
    name: 'cupcake',
    svg: '<path d="M24 54 L76 54 L68 91 L32 91 Z" fill="#7FD8FF"/>'
      + '<path d="M40 56 L43 89 M50 56 L50 89 M60 56 L57 89" fill="none" stroke-width="3.5"/>'
      + '<path d="M19 57 C12 42 28 31 39 35 C41 21 61 20 63 33 C75 28 90 41 81 57 Z" fill="#FF8FC8"/>'
      + '<circle cx="52" cy="22" r="8" fill="#FF4D4D"/>',
  },
  moon: {
    name: 'moon',
    svg: '<path d="M69 17.1 A38 38 0 1 0 69 82.9 A34 34 0 0 1 69 17.1 Z" fill="#FFD23F"/>'
      + '<circle cx="38" cy="40" r="5" fill="none" stroke-width="3.5"/><circle cx="34" cy="64" r="4" fill="none" stroke-width="3.5"/>',
  },
  cloud: {
    name: 'cloud',
    svg: '<path d="M28 74 C11 74 9 51 26 50 C23 31 46 25 54 38 C60 25 83 29 80 48 C95 50 93 74 76 74 Z" fill="#A9DCFF"/>',
  },
  ladybug: {
    name: 'ladybug',
    svg: '<path d="M42 22 Q36 10 28 12 M58 22 Q64 10 72 12" fill="none" stroke-width="4"/>'
      + '<circle cx="50" cy="30" r="13" fill="#2B2D42"/>'
      + '<circle cx="50" cy="58" r="31" fill="#FF4D4D"/>'
      + '<path d="M50 28 L50 89" fill="none" stroke-width="4"/>'
      + '<circle cx="37" cy="48" r="6" fill="#2B2D42" stroke="none"/><circle cx="63" cy="48" r="6" fill="#2B2D42" stroke="none"/>'
      + '<circle cx="35" cy="70" r="6" fill="#2B2D42" stroke="none"/><circle cx="65" cy="70" r="6" fill="#2B2D42" stroke="none"/>',
  },
};

/** All valid picture token ids: every shape-colour combo + every object. */
export const PICTURE_TOKENS = [
  ...SHAPES.flatMap((s) => Object.keys(COLORS).map((c) => `${s}-${c}`)),
  ...Object.keys(OBJECTS),
];

// Own-property lookup: a word token such as "constructor" or "__proto__" must never match
// something inherited from Object.prototype.
const own = (table, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);
export const isObjectToken = (t) => own(OBJECTS, t);

export const isNumberToken = (t) => typeof t === 'number' && Number.isFinite(t);
export const isSymbol = (t) => typeof t === 'string' && SYMBOLS.includes(t);
export const isPicture = (t) => typeof t === 'string' && PICTURE_TOKENS.includes(t);
export const isWordToken = (t) => typeof t === 'string' && t.length > 0 && t.length <= 24 && !isPicture(t) && !isSymbol(t);

/** 'number' | 'picture' | 'symbol' | 'word' | null */
export function tokenKind(t) {
  if (isNumberToken(t)) return 'number';
  if (isPicture(t)) return 'picture';
  if (isSymbol(t)) return 'symbol';
  if (isWordToken(t)) return 'word';
  return null;
}

/** SVG markup (100x100) for a picture token, or null for anything else. */
export function tokenSVG(t) {
  if (!isPicture(t)) return null;
  let body;
  if (isObjectToken(t)) {
    body = OBJECTS[t].svg;
  } else {
    const [shape, color] = t.split('-');
    body = SHAPE_GEOM[shape].replace(/\/>$/, ` fill="${COLORS[color]}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" aria-hidden="true"><g stroke="${INK}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round">${body}</g></svg>`;
}

/** Spoken name: 'red circle', 'apple', '12', 'cat'. */
export function tokenName(t) {
  if (isNumberToken(t)) return t < 0 ? `minus ${-t}` : String(t);
  if (isPicture(t)) {
    if (isObjectToken(t)) return OBJECTS[t].name;
    const [shape, color] = t.split('-');
    return `${color} ${shape}`;
  }
  if (t === '→') return 'goes with';
  if (t === '+') return 'plus';
  if (t === '=') return 'makes';
  if (t === '?') return 'what';
  return String(t);
}

/** Deep equality for answers (tokens or arrays of tokens). */
export function sameAnswer(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameAnswer(x, b[i]));
  }
  return a === b;
}

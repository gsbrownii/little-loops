// Pure layout maths for the coloring screens (no DOM), so it can be checked in Node.
//
// tileLayout   — wizard picker grid: the column/row split that makes the (square) tiles biggest.
// pickedLayout — tileLayout that also leaves room around the grid for the picked tile's
//                zoom + ring, so it is never clipped at the stage edge.
// paintLayout  — paint screen: picture as large as possible + a palette grid (12 swatches) and
//                an undo button, either stacked under the picture (portrait) or beside it
//                (landscape). Every swatch is at least `min` px (64 = the app's touch minimum).
//                It also sizes the selected swatch's zoom + ring so they always fit the free
//                space around a swatch (never clipped, never covering a neighbour).

/**
 * Best grid for `n` square tiles inside a W x H box.
 * A single row/column only wins when it is clearly bigger (6 tiles -> 3x2 or 2x3).
 * @returns {{cols:number, rows:number, size:number, gap:number}}
 */
export function tileLayout(W, H, n, { gap = 16, max = 440, min = 72 } = {}) {
  const count = Math.max(1, n | 0);
  let best = null;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    if ((cols - 1) * rows >= count) continue; // a whole empty column: never useful
    const size = Math.floor(Math.min((W - (cols - 1) * gap) / cols, (H - (rows - 1) * gap) / rows, max));
    const strip = count > 3 && (cols === 1 || rows === 1);
    const score = size * (strip ? 0.88 : 1) + (W >= H ? cols : rows) * 0.01; // ties follow the screen's shape
    if (!best || score > best.score) best = { cols, rows, size, gap, score };
  }
  if (best.size < min) {
    // Too many items to fit: keep tiles tappable, fill the width, and let the stage scroll (see CSS).
    const cols = Math.max(1, Math.min(count, Math.floor((W + gap) / (min + gap))));
    best = { cols, rows: Math.ceil(count / cols), size: min, gap, score: 0 };
  }
  return best;
}

// The picked wizard tile grows to PICK_PEAK during its bounce (then settles at PICK_SCALE) and wears
// a PICK_RING px ring (5 yellow + 3 ink); the check badge sits inside that ring. wizard.js passes
// these to coloring.css as --pick-scale / --pick-peak so the numbers live in one place.
export const PICK_SCALE = 1.04;
export const PICK_PEAK = 1.07;
export const PICK_RING = 8;

/** Room needed on every side of a tile of `size` px for the picked state (zoom + ring). */
export const pickedRoom = (size) => Math.ceil((size * (PICK_PEAK - 1)) / 2 + PICK_RING * PICK_PEAK + 1);

/**
 * tileLayout for a W x H box, keeping `pickedRoom(tile)` free on every side of the grid
 * (W x H may include clip-free space outside the grid's own box, see wizard.js).
 * Returns the tileLayout result plus `room`.
 */
export function pickedLayout(W, H, n, opts = {}) {
  let room = pickedRoom(0);
  let L = tileLayout(W - 2 * room, H - 2 * room, n, opts);
  for (let i = 0; i < 3; i++) {
    const need = pickedRoom(L.size);
    if (need <= room) break;
    room = need;
    L = tileLayout(W - 2 * room, H - 2 * room, n, opts);
  }
  return { ...L, room };
}

// Selected-swatch looks, best first: zoom k, white band p and ink ring q (px, outside the swatch).
// The first one whose reach fits the free room around the swatches wins.
const RINGS = [
  { k: 1.12, p: 4, q: 4 },
  { k: 1.1, p: 4, q: 4 },
  { k: 1.08, p: 3, q: 4 },
  { k: 1.06, p: 3, q: 3.5 },
  { k: 1.05, p: 2.5, q: 3 },
  { k: 1.04, p: 2, q: 3 },
  { k: 1.03, p: 2, q: 2.5 },
  { k: 1.02, p: 1.5, q: 2.5 },
  { k: 1, p: 1.5, q: 2 },
];
/** How far the selected look reaches past the swatch's own box (px). */
export const ringReach = (s, { k, p, q }) => (s * (k - 1)) / 2 + (p + q) * k;
/** The biggest selected look that fits `room` px around an `s` px swatch. */
export function ringFor(s, room) {
  return RINGS.find((r) => ringReach(s, r) <= room + 0.25) || RINGS[RINGS.length - 1];
}

const GAPS = [14, 12, 10, 8, 6];

/**
 * Paint screen layout for a W x H area (the module root under the top bar).
 * Returns sizes in CSS px:
 *   mode  'stack' (picture on top, palette below) | 'side' (picture left, palette right)
 *   undo  'right' (extra column next to the swatch grid) | 'below' (own row under the grid)
 *   cols/rows of the swatch grid, s = swatch size, gap, gapU (gap before undo),
 *   sep (picture <-> palette), pic = picture side, padX/padTop/padBottom = outer padding,
 *   room = free space around every swatch (gaps and edges), ring = { k, p, q } selected look.
 */
export function paintLayout(W, H, { n = 12, min = 64, max = 100 } = {}) {
  const padX = W < 700 ? 8 : 16;
  const padTop = 2;
  const padBottom = 12; // room for the buttons' drop shadows
  const SHADOW = 6; // the picture frame's drop shadow (below it)
  const Wi = W - 2 * padX;
  const Hi = H - padTop - padBottom;
  let best = null;

  for (const mode of ['stack', 'side']) {
    const sep0 = mode === 'stack' ? 16 : 18;
    for (const undo of ['right', 'below']) {
      for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        if ((cols - 1) * rows >= n) continue;
        for (const gap of GAPS) {
          for (const gapU of [gap + 8, gap]) {
            for (let s = min; s <= max; s += 2) {
              const pw = undo === 'right' ? (cols + 1) * s + (cols - 1) * gap + gapU : cols * s + (cols - 1) * gap;
              const ph = undo === 'right' ? rows * s + (rows - 1) * gap : (rows + 1) * s + (rows - 1) * gap + gapU;
              let pic;
              let sep = sep0;
              let edge; // free space between the outer swatches and the screen / picture
              if (mode === 'stack') {
                if (pw > Wi) break;
                pic = Math.floor(Math.min(Wi, Hi - sep - ph));
                // Spare height (picture limited by the width) first widens the picture/palette gap a little.
                sep += Math.max(0, Math.min(8, Math.floor((Hi - pic - sep - ph) / 2)));
                const slackY = Math.max(0, (Hi - pic - sep - ph) / 2);
                edge = Math.min(padX + (Wi - pw) / 2, sep - SHADOW, padBottom + slackY);
              } else {
                if (ph > Hi) break;
                pic = Math.floor(Math.min(Hi, Wi - sep - pw));
                const slackX = Math.max(0, (Wi - pic - sep - pw) / 2);
                const slackY = (Hi - ph) / 2;
                edge = Math.min(sep, padX + slackX, padTop + slackY, padBottom + slackY);
              }
              if (pic < 120) break;
              if (s > min && s > pic * 0.27) break; // the picture stays the hero, not the paint pots
              const room = Math.min(gap, gapU, edge);
              // Spec column counts: portrait 4-6 per row; landscape a 2-3 column palette.
              const pref = mode === 'stack' ? cols >= 4 && cols <= 6 : cols >= 2 && cols <= 3;
              const natural = (mode === 'stack') === (undo === 'right');
              // Weighted: the picture matters most; then free room around the swatches up to 8px
              // (the selected swatch's ring must fit), the spec's column counts (worth more than
              // bigger swatches, so a landscape phone gets 3 columns rather than 6 when the
              // picture is the same size), bigger swatches, the natural undo spot, a compact grid.
              const score = pic
                + 4 * Math.min(room, 8) + 0.4 * Math.min(Math.max(room - 8, 0), 6)
                + 0.3 * Math.min(gapU, 24)
                + 0.5 * (s - min)
                + (pref ? (mode === 'side' ? 24 : 8) : 0) + (natural ? 4 : 0) - 0.5 * rows;
              if (!best || score > best.score) {
                best = { mode, undo, cols, rows, s, gap, gapU, sep, pic, padX, padTop, padBottom, pw, ph, room, score };
              }
            }
          }
        }
      }
    }
  }

  if (!best) {
    // Smaller than any supported screen: keep the swatches tappable and let the picture shrink.
    const mode = W >= H ? 'side' : 'stack';
    const cols = mode === 'side' ? 3 : 4;
    const rows = Math.ceil(n / cols);
    const s = min;
    const gap = 6;
    const sep = 10;
    const pw = (cols + 1) * s + (cols - 1) * gap + gap;
    const ph = rows * s + (rows - 1) * gap;
    const pic = Math.max(80, Math.floor(mode === 'stack' ? Math.min(Wi, Hi - sep - ph) : Math.min(Hi, Wi - sep - pw)));
    best = { mode, undo: 'right', cols, rows, s, gap, gapU: gap, sep, pic, padX, padTop, padBottom, pw, ph, room: gap, score: 0 };
  }
  best.ring = ringFor(best.s, best.room);
  return best;
}

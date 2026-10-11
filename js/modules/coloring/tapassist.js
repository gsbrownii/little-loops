// Tap assist: which region did a small finger mean?
//
// On a phone many colourable regions are only 9-15 CSS px across (a cherry, a crown gem, a bubble),
// much smaller than a child's fingertip, so a tap "on" them usually lands on the big region around
// them. Small regions therefore get an invisible margin that grows their hit area towards
// TARGET px; bigger regions are only ever hit directly. A direct hit on a small region always wins.
// It is deliberately modest: mid-size parts (flower petals, a belly, a tree top) must stay easy to
// paint, so only really small parts get help, and never more than REACH px.
//
// Size = sqrt(width x height) of the on-screen box, so a long thin stripe (easy to hit along its
// length) gets little help. Distances are measured to the real shape (not its box, which for a
// diagonal arm can cover half the body) by hit-testing rings of points around the tap, so a shape
// hidden under another one is never picked either. Rings are only sampled when a small region's
// box is close enough.
//
// Pure apart from the injected `hitAt`, so it can be checked in Node:
//   pickRegion(x, y, { hitAt(x, y) -> region | null, regions: [{ el, left, top, right, bottom }] })

export const TARGET = 30; // effective size (px) small regions are grown towards
export const REACH = 11; // never reach further than this from a region's edge
export const NEAR = 8; // a tap in a gap between shapes takes the nearest region this close
const STEP = 2.5; // ring spacing (px)
const ARC = 5; // max distance between samples on a ring (px)

const boxDist = (x, y, r) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
const sizeOf = (r) => Math.sqrt(Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top));

/** Margin (px) a region of this rect gets around it (0 for regions at least TARGET px in size). */
export function allowance(r, { target = TARGET, reach = REACH } = {}) {
  return Math.max(0, Math.min(reach, (target - sizeOf(r)) / 2));
}

function* ring(x, y, rad) {
  const n = Math.max(8, Math.ceil((2 * Math.PI * rad) / ARC));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    yield [x + Math.cos(a) * rad, y + Math.sin(a) * rad];
  }
}

/**
 * @param {number} x
 * @param {number} y  tap point (viewport px)
 * @param {{hitAt:(x:number,y:number)=>any, regions:{el:any,left:number,top:number,right:number,bottom:number}[],
 *          target?:number, reach?:number, near?:number}} o
 * @returns the region element to paint, or null
 */
export function pickRegion(x, y, { hitAt, regions, target = TARGET, reach = REACH, near = NEAR }) {
  const direct = hitAt(x, y);
  const own = direct ? regions.find((r) => r.el === direct) : null;
  if (direct && own && sizeOf(own) < target) return direct; // tapped a small region itself

  // Small regions whose box is within their margin of the tap.
  const cands = new Map();
  let far = 0;
  for (const r of regions) {
    if (r.el === direct) continue;
    const allow = allowance(r, { target, reach });
    if (allow > 0 && boxDist(x, y, r) <= allow) {
      cands.set(r.el, allow);
      far = Math.max(far, allow);
    }
  }
  if (cands.size) {
    // Nearest real hit, ranked relative to each region's margin (tinier shapes reach further).
    let best = null;
    for (let rad = Math.min(STEP, far); rad <= far + 1e-6; rad += STEP) {
      if (best && rad / far >= best.rank) break; // nothing further out can rank better
      for (const [px, py] of ring(x, y, rad)) {
        const el = hitAt(px, py);
        const allow = el ? cands.get(el) : 0;
        if (!allow || rad > allow) continue;
        const rank = rad / allow;
        if (!best || rank < best.rank) best = { el, rank };
      }
    }
    if (best) return best.el;
  }
  if (direct) return direct;

  // Tapped an outline or a gap between shapes: the nearest region within `near` px.
  for (let rad = STEP; rad <= near + 1e-6; rad += STEP) {
    for (const [px, py] of ring(x, y, rad)) {
      const el = hitAt(px, py);
      if (el) return el;
    }
  }
  return null;
}

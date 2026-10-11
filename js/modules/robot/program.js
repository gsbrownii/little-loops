// Robot Puzzles — the command strip model (PURE, no DOM).
// The strip is a list of items; each item has a stable uid so the UI can drag it around.
//   arrow item:  { uid, card: 'up' | 'down' | 'left' | 'right' }
//   repeat item: { uid, card: 'repeat2' | 'repeat3', times, body: [arrow item, ...] }
// toProgram() turns it into the logic.js Program format for simulate(). canFinishByFilling()
// tells the game whether a short run can still be fixed just by adding cards.
import { isArrow, isRepeatCard, REPEAT_CARDS, simulate, solve } from './logic.js';

let uidSeq = 0;

export const isBlock = (it) => !!it && Array.isArray(it.body);

export function makeItem(card) {
  if (isRepeatCard(card)) return { uid: ++uidSeq, card, times: REPEAT_CARDS[card], body: [] };
  if (isArrow(card)) return { uid: ++uidSeq, card };
  return null;
}

export function createStrip(max, cap) {
  return { items: [], max, cap };
}

export function toProgram(items) {
  return items.map((it) => (isBlock(it) ? { repeat: it.times, do: it.body.map((b) => b.card) } : it.card));
}

/** Where is the item with this uid? -> { top, inner } (inner = null for top-level items) */
export function locate(s, uid) {
  for (let i = 0; i < s.items.length; i++) {
    const it = s.items[i];
    if (it.uid === uid) return { top: i, inner: null };
    if (isBlock(it)) {
      const j = it.body.findIndex((b) => b.uid === uid);
      if (j >= 0) return { top: i, inner: j };
    }
  }
  return null;
}

export function itemAt(s, loc) {
  if (!loc) return null;
  const it = s.items[loc.top];
  return loc.inner == null ? it : it?.body?.[loc.inner] || null;
}

function removeAt(s, loc) {
  if (loc.inner == null) return s.items.splice(loc.top, 1)[0];
  return s.items[loc.top].body.splice(loc.inner, 1)[0];
}

export function removeUid(s, uid) {
  const loc = locate(s, uid);
  return loc ? removeAt(s, loc) : null;
}

export function clear(s) {
  s.items.length = 0;
}

/** Number of top-level cards + arrows inside repeat blocks. */
export function count(s) {
  return s.items.reduce((n, it) => n + 1 + (isBlock(it) ? it.body.length : 0), 0);
}

/** `body` (arrow ids) as it is, plus every way to fill its empty inner slots (up to `cap`). */
function filledBodies(body, cap, arrows) {
  const out = [body];
  const grow = (seq) => {
    if (seq.length > body.length) out.push(seq);
    if (seq.length < cap) arrows.forEach((a) => grow([...seq, a]));
  };
  grow(body);
  return out;
}

/**
 * After a run that stopped short of the star: could the child still reach it just by filling
 * the strip's EMPTY places (the dashed slots a child sees: inner slots of repeat blocks and the
 * free slots after the last card), keeping every placed card as it is? That is when "the robot
 * needs more arrows" is true. Uses the game's own rules (simulate / solve from logic.js).
 */
export function canFinishByFilling(level, s) {
  const arrows = (level.cards || []).filter(isArrow);
  let cells = [level.start]; // where the robot can be after the cards so far
  for (const it of s.items) {
    const steps = isBlock(it)
      ? filledBodies(it.body.map((b) => b.card), s.cap, arrows).map((body) => ({ repeat: it.times, do: body }))
      : [it.card];
    const next = new Map();
    for (const pos of cells) {
      for (const step of steps) {
        const r = simulate({ ...level, start: pos }, [step]);
        if (r.outcome === 'goal') return true;
        if (r.outcome === 'short' || r.outcome === 'empty') next.set(`${r.final}`, r.final);
      }
    }
    cells = [...next.values()];
    if (!cells.length) return false;
  }
  const free = s.max - s.items.length;
  return free > 0 && cells.some((pos) => !!solve({ ...level, start: pos }, { maxCards: free }));
}

/**
 * Tap on a palette card: append it. An arrow goes inside a trailing repeat block that
 * still has room. Returns { action: 'add', item, block? } or { action: 'full' }.
 */
export function tapAdd(s, card) {
  if (isArrow(card)) {
    const last = s.items[s.items.length - 1];
    if (isBlock(last) && last.body.length < s.cap) {
      const item = makeItem(card);
      last.body.push(item);
      return { action: 'add', item, block: last };
    }
  }
  if (s.items.length >= s.max) return { action: 'full' };
  const item = makeItem(card);
  if (!item) return { action: 'none' };
  s.items.push(item);
  return { action: 'add', item };
}

/**
 * Apply a drag & drop.
 *   src:    { card } (new card from the palette) or { uid } (a card already in the strip)
 *   target: { type: 'top', index }              insert at top-level position `index`
 *           { type: 'inner', blockUid, index }  put an arrow into a repeat block's slot
 *           { type: 'out' }                     dropped outside the strip
 * Returns { action: 'add' | 'move' | 'remove' | 'full' | 'none', item, replaced? }.
 * Nothing changes when the action is 'full' or 'none'.
 */
export function applyDrop(s, src, target) {
  const loc = src.uid != null ? locate(s, src.uid) : null;
  if (src.uid != null && !loc) return { action: 'none' };
  const item = loc ? itemAt(s, loc) : makeItem(src.card);
  if (!item) return { action: 'none' };

  if (!target || target.type === 'out') {
    if (!loc) return { action: 'none', item };
    removeAt(s, loc);
    return { action: 'remove', item };
  }

  if (target.type === 'inner') {
    const bi = s.items.findIndex((x) => x.uid === target.blockUid);
    const block = s.items[bi];
    if (!isBlock(block)) return { action: 'none', item };
    if (isBlock(item)) {
      // Repeat blocks can't nest: treat as a top-level drop on that block.
      return applyDrop(s, src, { type: 'top', index: bi });
    }
    const body = block.body;
    let idx = Math.max(0, Math.min(s.cap - 1, target.index | 0));
    if (loc && loc.inner != null && s.items[loc.top] === block) {
      // Moving inside the same block.
      if (idx >= body.length) idx = body.length - 1;
      if (idx === loc.inner) return { action: 'none', item };
      body.splice(loc.inner, 1);
      body.splice(idx, 0, item);
      return { action: 'move', item };
    }
    if (body.length < s.cap) {
      if (loc) removeAt(s, loc);
      body.splice(Math.min(idx, body.length), 0, item);
      return { action: loc ? 'move' : 'add', item };
    }
    // Block is full: the new arrow replaces the one in that slot.
    if (loc) removeAt(s, loc);
    const replaced = body[idx];
    body[idx] = item;
    return { action: loc ? 'move' : 'add', item, replaced };
  }

  // Top-level insert.
  let index = Math.max(0, Math.min(s.items.length, target.index | 0));
  if (loc && loc.inner == null) {
    const from = loc.top;
    if (index > from) index -= 1;
    if (index === from) return { action: 'none', item };
    s.items.splice(from, 1);
    s.items.splice(index, 0, item);
    return { action: 'move', item };
  }
  if (s.items.length >= s.max) return { action: 'full', item };
  if (loc) removeAt(s, loc); // inner -> top level (doesn't shift top-level indexes)
  s.items.splice(index, 0, item);
  return { action: loc ? 'move' : 'add', item };
}

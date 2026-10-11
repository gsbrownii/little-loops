// Robot Puzzles — level loading, sanitizing and progress helpers.
// Levels are content (data/robot/levels.json, possibly AI-generated later), so every
// field is coerced/clamped here and the UI never trusts raw values.
import { DEFAULT_GRID, DEFAULT_REPEAT_CAPACITY, isArrow, isRepeat, isRepeatCard } from './logic.js';
import { CARD_IDS } from './art.js';

export const LEVELS_PATH = 'data/robot/levels.json';
const KINDS = ['rock', 'bush', 'puddle'];
const MAX_GRID = 8;

const int = (v, d) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const text = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function cleanGrid(g) {
  const cols = clamp(int(g?.cols, DEFAULT_GRID.cols), 1, MAX_GRID);
  const rows = clamp(int(g?.rows, DEFAULT_GRID.rows), 1, MAX_GRID);
  return { cols, rows };
}

function cleanCell(v, grid) {
  if (!Array.isArray(v) || v.length < 2) return null;
  const c = int(v[0], NaN);
  const r = int(v[1], NaN);
  if (!Number.isFinite(c) || !Number.isFinite(r)) return null;
  return [clamp(c, 0, grid.cols - 1), clamp(r, 0, grid.rows - 1)];
}

function cleanSolution(sol, cap) {
  if (!Array.isArray(sol)) return [];
  const out = [];
  for (const s of sol.slice(0, 16)) {
    if (isArrow(s)) out.push(s);
    else if (isRepeat(s)) {
      const body = s.do.filter(isArrow).slice(0, Math.max(cap, 3));
      out.push({ repeat: clamp(int(s.repeat, 2), 1, 9), do: body });
    }
  }
  return out;
}

/** Turn one raw level into a safe, fully-populated level object. */
export function cleanLevel(raw, index, fileGrid) {
  const lv = raw && typeof raw === 'object' ? raw : {};
  const grid = cleanGrid(lv.grid || fileGrid);
  const start = cleanCell(lv.start, grid) || [0, grid.rows - 1];
  let goal = cleanCell(lv.goal, grid) || [grid.cols - 1, 0];
  if (goal[0] === start[0] && goal[1] === start[1]) goal = [(start[0] + 1) % grid.cols, start[1]];

  const taken = new Set([`${start}`, `${goal}`]);
  const obstacles = [];
  for (const o of Array.isArray(lv.obstacles) ? lv.obstacles : []) {
    const at = cleanCell(o?.at, grid);
    if (!at || taken.has(`${at}`)) continue;
    taken.add(`${at}`);
    obstacles.push({ at, kind: KINDS.includes(o.kind) ? o.kind : 'rock' });
  }

  let cards = [...new Set((Array.isArray(lv.cards) ? lv.cards : []).filter((c) => CARD_IDS.includes(c)))];
  if (!cards.length) cards = ['up', 'down', 'left', 'right'];
  if (!cards.some(isArrow)) cards = ['up', 'down', 'left', 'right', ...cards];

  const repeatCapacity = clamp(int(lv.repeatCapacity, DEFAULT_REPEAT_CAPACITY), 1, 3);
  const maxCards = clamp(int(lv.maxCards, 4), 1, 8);
  const rawId = text(lv.id, 40).replace(/[^A-Za-z0-9_-]/g, '_');

  return {
    id: rawId || `L${index + 1}`,
    key: rawId || `L${index + 1}`, // storage key part (no dots)
    number: index + 1,
    grid,
    start,
    goal,
    obstacles,
    cards,
    maxCards,
    repeatCapacity,
    say: text(lv.say) || 'Help the robot reach the star!',
    hint: text(lv.hint),
    solution: cleanSolution(lv.solution, repeatCapacity),
    hasRepeat: cards.some(isRepeatCard),
    hasObstacles: obstacles.length > 0,
  };
}

/** Sanitize a whole levels file. Throws if there is nothing playable. */
export function cleanLevels(raw) {
  const fileGrid = cleanGrid(raw?.grid);
  const list = Array.isArray(raw?.levels) ? raw.levels.slice(0, 99) : [];
  const levels = list.map((lv, i) => cleanLevel(lv, i, lv?.grid || fileGrid));
  if (!levels.length) throw new Error('No robot levels found');
  // Make keys unique even if ids repeat.
  const seen = new Set();
  for (const lv of levels) {
    let k = lv.key;
    let n = 2;
    while (seen.has(k)) k = `${lv.key}_${n++}`;
    lv.key = k;
    seen.add(k);
  }
  return { grid: fileGrid, levels };
}

export async function loadLevels(ctx) {
  return cleanLevels(await ctx.loadJSON(LEVELS_PATH));
}

// ---------- Progress (stored through ctx.store, i.e. "robot.done.<id>") ----------

export const isDone = (store, lv) => store.get(`done.${lv.key}`, false) === true;
export const markDone = (store, lv) => store.set(`done.${lv.key}`, true);
export const unlockAll = (store) => store.get('unlockAll', false) === true;

/** Level i (0-based) is playable if it is the first, the previous one is done, or all are
 *  unlocked. A level the child already solved stays playable (it can be solved out of order
 *  while "Unlock all" is on; turning the setting off later must not show it star + lock). */
export function isUnlocked(store, levels, i) {
  return i <= 0 || unlockAll(store) || isDone(store, levels[i - 1]) || (!!levels[i] && isDone(store, levels[i]));
}

/** Index of the next level to play: first unsolved, unlocked level (or -1 if all done). */
export function nextIndex(store, levels) {
  return levels.findIndex((lv, i) => !isDone(store, lv) && isUnlocked(store, levels, i));
}

// Robot Puzzles rules — PURE functions, no DOM.
// Shared by the game (robot.js) and the content validator (tools/validate-levels.mjs),
// so the game and the validator can never disagree about what a level does.
//
// Coordinates: [col, row], [0, 0] is the TOP-LEFT cell. Arrows are absolute screen
// directions ("up" = toward row 0); the robot does not turn.
//
// Program format (used for the kid's command strip AND for level.solution):
//   Program = Step[]
//   Step    = 'up' | 'down' | 'left' | 'right'
//           | { repeat: 2 | 3, do: Arrow[] }      // no nesting; body = 1..repeatCapacity arrows
//
// Palette card ids (level.cards): 'up' 'down' 'left' 'right' 'repeat2' 'repeat3'
//
// Rules:
//  - Moves run in order; a repeat runs its body `repeat` times.
//  - A move off the grid or into an obstacle is BLOCKED: the robot stays put, the run stops
//    there (outcome 'edge' / 'obstacle'), and that step is the one to debug.
//  - The moment the robot ENTERS the goal cell the run succeeds (outcome 'goal'), even if
//    cards remain.
//  - If cards run out first, outcome is 'short' (robot stays where it stopped).
//  - An empty program (or only empty repeats) gives outcome 'empty'.

export const ARROWS = ['up', 'down', 'left', 'right'];
export const DELTA = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
export const REPEAT_CARDS = { repeat2: 2, repeat3: 3 };
export const DEFAULT_GRID = { cols: 4, rows: 4 };
export const DEFAULT_REPEAT_CAPACITY = 2;

export const isArrow = (s) => typeof s === 'string' && Object.prototype.hasOwnProperty.call(DELTA, s);
export const isRepeat = (s) =>
  !!s && typeof s === 'object' && Number.isInteger(s.repeat) && s.repeat >= 1 && Array.isArray(s.do);
export const isRepeatCard = (c) => Object.prototype.hasOwnProperty.call(REPEAT_CARDS, c);

const key = (c, r) => `${c},${r}`;

/**
 * Flatten a program into single moves, remembering where each came from:
 * { dir, top: index in program, inner: index inside repeat body | null,
 *   iteration: 1..times | null, times: repeat count | null }
 */
export function expand(program) {
  const out = [];
  (program || []).forEach((step, top) => {
    if (isArrow(step)) {
      out.push({ dir: step, top, inner: null, iteration: null, times: null });
    } else if (isRepeat(step)) {
      for (let k = 1; k <= step.repeat; k++) {
        step.do.forEach((d, inner) => {
          if (isArrow(d)) out.push({ dir: d, top, inner, iteration: k, times: step.repeat });
        });
      }
    }
  });
  return out;
}

/**
 * Run a program on a level.
 * Returns {
 *   outcome: 'goal' | 'edge' | 'obstacle' | 'short' | 'empty',
 *   steps:   [{ ...expandedMove, from: [c,r], to: [c,r], blocked: null | 'edge' | 'obstacle' }],
 *   final:   [c, r]   // where the robot ends up (blocked moves leave it in place)
 *   failStep: the blocked step (or null)
 * }
 */
export function simulate(level, program, grid = DEFAULT_GRID) {
  const g = level.grid || grid || DEFAULT_GRID;
  const blocked = new Set((level.obstacles || []).map((o) => key(o.at[0], o.at[1])));
  let [c, r] = level.start;
  const [gc, gr] = level.goal;
  const moves = expand(program);
  const steps = [];
  if (!moves.length) return { outcome: 'empty', steps, final: [c, r], failStep: null };

  for (const m of moves) {
    const [dc, dr] = DELTA[m.dir];
    const nc = c + dc;
    const nr = r + dr;
    let why = null;
    if (nc < 0 || nr < 0 || nc >= g.cols || nr >= g.rows) why = 'edge';
    else if (blocked.has(key(nc, nr))) why = 'obstacle';
    if (why) {
      const step = { ...m, from: [c, r], to: [c, r], blocked: why };
      steps.push(step);
      return { outcome: why, steps, final: [c, r], failStep: step };
    }
    steps.push({ ...m, from: [c, r], to: [nc, nr], blocked: null });
    c = nc;
    r = nr;
    if (c === gc && r === gr) return { outcome: 'goal', steps, final: [c, r], failStep: null };
  }
  return { outcome: 'short', steps, final: [c, r], failStep: null };
}

/** Every top-level card a child could place on this level (arrows + every possible repeat). */
export function possibleSteps(level, { allowRepeat = true } = {}) {
  const cards = level.cards || [];
  const arrows = cards.filter(isArrow);
  const steps = [...arrows];
  if (!allowRepeat) return steps;
  const cap = level.repeatCapacity ?? DEFAULT_REPEAT_CAPACITY;
  const bodies = [];
  const grow = (prefix) => {
    if (prefix.length) bodies.push(prefix);
    if (prefix.length < cap) arrows.forEach((a) => grow([...prefix, a]));
  };
  grow([]);
  for (const rc of cards.filter(isRepeatCard)) {
    for (const body of bodies) steps.push({ repeat: REPEAT_CARDS[rc], do: body });
  }
  return steps;
}

/**
 * Shortest program (fewest top-level cards) that reaches the goal, or null.
 * BFS over robot positions — each card is a deterministic macro-move.
 */
export function solve(level, { allowRepeat = true, maxCards = level.maxCards ?? 8, grid } = {}) {
  const options = possibleSteps(level, { allowRepeat });
  const start = level.start;
  const seen = new Set([key(start[0], start[1])]);
  let frontier = [{ pos: start, prog: [] }];
  for (let depth = 0; depth < maxCards && frontier.length; depth++) {
    const next = [];
    for (const { pos, prog } of frontier) {
      for (const step of options) {
        const r = simulate({ ...level, start: pos }, [step], grid);
        if (r.outcome === 'goal') return [...prog, step];
        if (r.outcome !== 'short') continue;
        const k = key(r.final[0], r.final[1]);
        if (seen.has(k)) continue;
        seen.add(k);
        next.push({ pos: r.final, prog: [...prog, step] });
      }
    }
    frontier = next;
  }
  return null;
}

/** Cells visited by the level's reference solution — used to draw the hint path. */
export function solutionPath(level, grid) {
  const res = simulate(level, level.solution || [], grid);
  return [level.start, ...res.steps.filter((s) => !s.blocked).map((s) => s.to)];
}

#!/usr/bin/env node
// Validate Robot Puzzles level packs (format "robot-levels/1", schema: schemas/robot-levels.schema.json).
// Uses the game's own rules (js/modules/robot/logic.js), so the validator and the game can never disagree.
//
//   node tools/validate-levels.mjs                       # data/robot/levels.json (the 15-level curriculum)
//   node tools/validate-levels.mjs path/to/pack.json     # any pack (paths are relative to the current dir)
//   options:  --maps           ASCII map + reference path of every level (S start, * goal, # obstacle)
//             --no-curriculum  skip the curriculum rules (15 levels r01..r15, sequencing 1-9, loops 10-15)
//                              e.g. for AI-generated packs
//             --json           print { errors, warnings, rows } as JSON instead of the table
//
// Exit code 1 if there is any ERROR (warnings never fail). Reusable from other tools:
//   import { validateLevels } from './validate-levels.mjs';
//   const { errors, warnings, rows } = validateLevels(doc, { curriculum: false });
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  simulate, solve, possibleSteps, expand, isArrow, isRepeat, isRepeatCard,
  REPEAT_CARDS, DEFAULT_REPEAT_CAPACITY,
} from '../js/modules/robot/logic.js';

export const FORMAT = 'robot-levels/1';
export const ARROW_IDS = ['up', 'down', 'left', 'right'];
export const CARD_IDS = [...ARROW_IDS, ...Object.keys(REPEAT_CARDS)];
export const OBSTACLE_KINDS = ['rock', 'bush', 'puddle'];
export const LIMITS = {
  gridSize: 4, // schema: grid.cols / grid.rows const 4
  levelsMax: 99,
  idPattern: /^[a-z][a-z0-9-]{1,23}$/,
  cardsMax: 6,
  maxCardsMin: 1,
  maxCardsMax: 8,
  repeatCapacityMin: 1,
  repeatCapacityMax: 3,
  repeatBodyMax: 3,
  solutionMax: 8,
  obstaclesMax: 8,
  textMaxChars: 110, // say / hint (schema maxLength)
  textMaxWords: 15, // speech guideline (warning only)
  looseSlack: 2, // warn when maxCards > optimal + 2
  maxMoveDrop: 2, // warn when reference moves drop by more than 2 vs the previous level
  maxSpareCards: 2, // warn when more than 2 palette cards are unused by the reference solution
  waysBudget: 200000, // simulate() calls allowed when counting winning programs
  // Command-strip width in "card widths" (estimate computed by stripWidth() below: an arrow = 1, a
  // repeat block = 1.4 + repeatCapacity whatever is inside it). Measured 2026-10 (Clear in the top bar,
  // strip full width): a full 3-block strip (7.2) fits the nominal 360x640 / 640x360 / 375x667
  // viewports but scrolls inside its box on real 360x640 phones once system bars take height
  // (360x568, 592x360, 592x336); 4 capacity-1 blocks (9.6) hide 2-4 cards there; 2 capacity-3 blocks
  // (8.8) fit everywhere except 592x336. The number of repeat blocks matters more than the total
  // width: two blocks share one row at 360 px. So keep both limits at 7.
  stripRefMax: 7, // warn when the reference solution is wider (the hint program must fit on phones)
  stripWorstMax: 7, // warn when the widest strip a child can build (every slot a full repeat block) is wider
};
export const CURRICULUM = { count: 15, sequencing: [1, 9], loops: [10, 15] };

const TOP_KEYS = new Set(['$schema', 'schema', 'grid', 'levels']);
const LEVEL_KEYS = new Set(['id', 'start', 'goal', 'obstacles', 'cards', 'maxCards', 'repeatCapacity', 'repeatOptional', 'say', 'hint', 'solution']);
const REQUIRED_LEVEL_KEYS = ['id', 'start', 'goal', 'obstacles', 'cards', 'maxCards', 'say', 'solution'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const cellStr = (c) => `[${c[0]},${c[1]}]`;
const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
const SHORT = { up: 'U', down: 'D', left: 'L', right: 'R', repeat2: 'x2', repeat3: 'x3' };
const round1 = (x) => Math.round(x * 10) / 10;

/** Estimated command-strip width in card widths (see LIMITS.stripRefMax). */
export function stripWidth(program, repeatCapacity = DEFAULT_REPEAT_CAPACITY) {
  return round1((program || []).reduce((u, s) => u + (isRepeat(s) ? 1.4 + repeatCapacity : 1), 0));
}

/** Compact program text: ["up", {repeat:3, do:["right","up"]}] -> "U x3[R U]" */
export function formatProgram(program) {
  return (program || [])
    .map((s) => (isArrow(s) ? SHORT[s] : isRepeat(s) ? `x${s.repeat}[${s.do.map((d) => SHORT[d] || '?').join(' ')}]` : '?'))
    .join(' ');
}

/** Count programs (<= maxCards top-level cards) whose LAST card reaches the goal. */
export function countWinningPrograms(level, grid, budget = LIMITS.waysBudget) {
  const options = possibleSteps(level);
  let count = 0;
  let calls = 0;
  let capped = false;
  const rec = (pos, depth) => {
    for (const step of options) {
      if (++calls > budget) { capped = true; return; }
      const r = simulate({ ...level, start: pos }, [step], grid);
      if (r.outcome === 'goal') count++;
      else if (r.outcome === 'short' && depth + 1 < level.maxCards) rec(r.final, depth + 1);
      if (capped) return;
    }
  };
  rec(level.start, 0);
  return { count, capped };
}

/** ASCII map rows: '.' empty, 'S' start, '*' goal, '#' obstacle. With program: arrows show the path taken. */
export function renderLevelMap(level, grid, program = null) {
  const g = grid || { cols: LIMITS.gridSize, rows: LIMITS.gridSize };
  const cells = Array.from({ length: g.rows }, () => Array(g.cols).fill('.'));
  const put = (c, ch) => { if (cells[c[1]] && c[0] >= 0 && c[0] < g.cols) cells[c[1]][c[0]] = ch; };
  for (const o of level.obstacles || []) put(o.at, '#');
  if (program) {
    const glyph = { up: '^', down: 'v', left: '<', right: '>' };
    for (const s of simulate(level, program, g).steps) put(s.from, s.blocked ? '!' : glyph[s.dir]);
  }
  if (!program) put(level.start, 'S');
  put(level.goal, '*');
  return cells.map((row) => row.join(' '));
}

// ---------------------------------------------------------------------------------------------
// Structure checks (mirror schemas/robot-levels.schema.json by hand)

function checkCell(v, g, where, err) {
  if (!Array.isArray(v) || v.length !== 2 || !isInt(v[0]) || !isInt(v[1])) {
    err(`${where} must be [col, row] (two integers), got ${JSON.stringify(v)}`);
    return false;
  }
  if (v[0] < 0 || v[1] < 0 || v[0] >= g.cols || v[1] >= g.rows) {
    err(`${where} ${cellStr(v)} is outside the ${g.cols}x${g.rows} grid (cols 0..${g.cols - 1}, rows 0..${g.rows - 1})`);
    return false;
  }
  return true;
}

function checkText(level, key, required, err, warn) {
  const v = level[key];
  if (v === undefined) {
    if (required) err(`"${key}" is required (a short spoken sentence)`);
    return;
  }
  if (typeof v !== 'string' || !v.trim()) return err(`"${key}" must be a non-empty string`);
  if (v.length > LIMITS.textMaxChars) err(`"${key}" is ${v.length} chars; max ${LIMITS.textMaxChars} (speech gets cut off)`);
  if (words(v) > LIMITS.textMaxWords) warn(`"${key}" has ${words(v)} words; keep spoken lines to <= ${LIMITS.textMaxWords} simple words`);
}

/** Returns true if the program is well-formed (so it is safe to simulate). */
function checkProgram(prog, where, err) {
  if (!Array.isArray(prog) || prog.length < 1 || prog.length > LIMITS.solutionMax) {
    err(`${where} must be an array of 1..${LIMITS.solutionMax} steps`);
    return false;
  }
  let ok = true;
  prog.forEach((s, i) => {
    const at = `${where}[${i}]`;
    if (typeof s === 'string') {
      if (!isArrow(s)) { err(`${at} "${s}" is not an arrow (${ARROW_IDS.join(' | ')})`); ok = false; }
      return;
    }
    if (!isObj(s)) { err(`${at} must be an arrow string or a {repeat, do} object`); ok = false; return; }
    const extra = Object.keys(s).filter((k) => k !== 'repeat' && k !== 'do');
    if (extra.length) { err(`${at} has unknown key(s) ${extra.join(', ')} (only "repeat" and "do")`); ok = false; }
    if (!Object.values(REPEAT_CARDS).includes(s.repeat)) {
      err(`${at}.repeat must be ${Object.values(REPEAT_CARDS).join(' or ')}, got ${JSON.stringify(s.repeat)}`);
      ok = false;
    }
    if (!Array.isArray(s.do) || s.do.length < 1 || s.do.length > LIMITS.repeatBodyMax) {
      err(`${at}.do must be an array of 1..${LIMITS.repeatBodyMax} arrows`);
      ok = false;
      return;
    }
    s.do.forEach((d, j) => {
      if (isObj(d) || Array.isArray(d)) { err(`${at}.do[${j}]: repeat blocks cannot be nested; the body holds arrows only`); ok = false; }
      else if (!isArrow(d)) { err(`${at}.do[${j}] "${d}" is not an arrow`); ok = false; }
    });
  });
  return ok;
}

// ---------------------------------------------------------------------------------------------

/**
 * Validate a parsed level pack.
 * @param {object} doc parsed JSON
 * @param {{curriculum?: boolean}} opts curriculum=true enforces the 15-level main curriculum rules
 * @returns {{ errors: string[], warnings: string[], rows: object[] }}
 */
export function validateLevels(doc, { curriculum = true } = {}) {
  const errors = [];
  const warnings = [];
  const rows = [];
  const fail = (msg) => errors.push(msg);

  if (!isObj(doc)) {
    fail('file must contain a JSON object { "schema", "grid", "levels" }');
    return { errors, warnings, rows };
  }
  for (const k of Object.keys(doc)) if (!TOP_KEYS.has(k)) fail(`unknown top-level key "${k}" (allowed: ${[...TOP_KEYS].join(', ')})`);
  if (doc.schema !== FORMAT) fail(`"schema" must be "${FORMAT}", got ${JSON.stringify(doc.schema)}`);
  if (doc.$schema !== undefined && typeof doc.$schema !== 'string') fail('"$schema" must be a string');

  let grid = { cols: LIMITS.gridSize, rows: LIMITS.gridSize };
  if (!isObj(doc.grid)) fail('"grid" must be { "cols": 4, "rows": 4 }');
  else {
    for (const k of Object.keys(doc.grid)) if (k !== 'cols' && k !== 'rows') fail(`grid: unknown key "${k}"`);
    if (doc.grid.cols !== LIMITS.gridSize || doc.grid.rows !== LIMITS.gridSize) {
      fail(`grid must be ${LIMITS.gridSize}x${LIMITS.gridSize} (the board is designed for 4x4), got ${JSON.stringify(doc.grid)}`);
    }
    if (isInt(doc.grid.cols) && isInt(doc.grid.rows) && doc.grid.cols > 0 && doc.grid.rows > 0) grid = { cols: doc.grid.cols, rows: doc.grid.rows };
  }

  if (!Array.isArray(doc.levels) || doc.levels.length < 1 || doc.levels.length > LIMITS.levelsMax) {
    fail(`"levels" must be an array of 1..${LIMITS.levelsMax} levels`);
    return { errors, warnings, rows };
  }

  const seenIds = new Map();
  let prevMoves = null;

  doc.levels.forEach((level, i) => {
    const n = i + 1;
    const label = isObj(level) && typeof level.id === 'string' ? level.id : `levels[${i}]`;
    const err = (msg) => errors.push(`${label}: ${msg}`);
    const warn = (msg) => warnings.push(`${label}: ${msg}`);
    const row = { n, id: label, cards: '', maxCards: null, optimal: null, optimalNoRepeat: null, moves: null, obstacles: null, ways: null, spare: null, strip: '', ok: false };
    rows.push(row);

    if (!isObj(level)) { err('level must be an object'); prevMoves = null; return; }

    // --- structure -------------------------------------------------------------------------
    let structOk = true;
    const bad = (msg) => { err(msg); structOk = false; };
    for (const k of Object.keys(level)) if (!LEVEL_KEYS.has(k)) bad(`unknown key "${k}" (allowed: ${[...LEVEL_KEYS].join(', ')})`);
    for (const k of REQUIRED_LEVEL_KEYS) if (level[k] === undefined) bad(`missing required key "${k}"`);

    if (level.id !== undefined) {
      if (typeof level.id !== 'string' || !LIMITS.idPattern.test(level.id)) bad(`id ${JSON.stringify(level.id)} must match ${LIMITS.idPattern} (lowercase, e.g. "r01")`);
      else if (seenIds.has(level.id)) bad(`duplicate id "${level.id}" (also level ${seenIds.get(level.id)})`);
      else seenIds.set(level.id, n);
    }

    const startOk = level.start !== undefined && checkCell(level.start, grid, 'start', bad);
    const goalOk = level.goal !== undefined && checkCell(level.goal, grid, 'goal', bad);
    if (startOk && goalOk && same(level.start, level.goal)) bad(`start and goal are the same cell ${cellStr(level.start)}`);

    if (level.obstacles !== undefined) {
      if (!Array.isArray(level.obstacles)) bad('"obstacles" must be an array (use [] for none)');
      else {
        if (level.obstacles.length > LIMITS.obstaclesMax) bad(`too many obstacles (${level.obstacles.length}); max ${LIMITS.obstaclesMax}`);
        const taken = new Set();
        level.obstacles.forEach((o, j) => {
          const at = `obstacles[${j}]`;
          if (!isObj(o)) return bad(`${at} must be { "at": [col,row], "kind": "rock" | "bush" | "puddle" }`);
          const extra = Object.keys(o).filter((k) => k !== 'at' && k !== 'kind');
          if (extra.length) bad(`${at} has unknown key(s) ${extra.join(', ')}`);
          if (!OBSTACLE_KINDS.includes(o.kind)) bad(`${at}.kind must be one of ${OBSTACLE_KINDS.join(' | ')}, got ${JSON.stringify(o.kind)}`);
          if (!checkCell(o.at, grid, `${at}.at`, bad)) return;
          const k = cellStr(o.at);
          if (taken.has(k)) bad(`${at} duplicates another obstacle at ${k}`);
          taken.add(k);
          if (startOk && same(o.at, level.start)) bad(`${at} is on the start cell ${k}`);
          if (goalOk && same(o.at, level.goal)) bad(`${at} is on the goal cell ${k}`);
        });
      }
    }

    if (level.cards !== undefined) {
      if (!Array.isArray(level.cards) || level.cards.length < 1 || level.cards.length > LIMITS.cardsMax) {
        bad(`"cards" must be an array of 1..${LIMITS.cardsMax} card ids`);
      } else {
        const seen = new Set();
        for (const c of level.cards) {
          if (!CARD_IDS.includes(c)) bad(`unknown card ${JSON.stringify(c)} (allowed: ${CARD_IDS.join(', ')})`);
          else if (seen.has(c)) bad(`card "${c}" is listed twice`);
          seen.add(c);
        }
        if (!level.cards.some(isArrow)) bad('"cards" needs at least one arrow card');
        const order = level.cards.map((c) => CARD_IDS.indexOf(c));
        if (!order.includes(-1) && order.some((v, j) => j > 0 && v < order[j - 1])) {
          warn(`palette order ${level.cards.join(', ')} differs from the usual ${CARD_IDS.join(', ')}; keep cards in the same place on every level`);
        }
      }
    }

    if (level.maxCards !== undefined && (!isInt(level.maxCards) || level.maxCards < LIMITS.maxCardsMin || level.maxCards > LIMITS.maxCardsMax)) {
      bad(`maxCards must be an integer ${LIMITS.maxCardsMin}..${LIMITS.maxCardsMax}, got ${JSON.stringify(level.maxCards)}`);
    }
    if (level.repeatCapacity !== undefined && (!isInt(level.repeatCapacity) || level.repeatCapacity < LIMITS.repeatCapacityMin || level.repeatCapacity > LIMITS.repeatCapacityMax)) {
      bad(`repeatCapacity must be an integer ${LIMITS.repeatCapacityMin}..${LIMITS.repeatCapacityMax}, got ${JSON.stringify(level.repeatCapacity)}`);
    }
    if (level.repeatOptional !== undefined && typeof level.repeatOptional !== 'boolean') bad('repeatOptional must be true or false');

    const textErr = (msg) => bad(msg);
    checkText(level, 'say', true, textErr, warn);
    checkText(level, 'hint', false, textErr, warn);

    const progOk = level.solution !== undefined && checkProgram(level.solution, 'solution', bad);

    if (Array.isArray(level.cards)) row.cards = level.cards.map((c) => SHORT[c] || '?').join(' ');
    if (isInt(level.maxCards)) row.maxCards = level.maxCards;
    if (Array.isArray(level.obstacles)) row.obstacles = level.obstacles.length;

    if (!structOk || !progOk) { prevMoves = null; return; }

    // --- rules -----------------------------------------------------------------------------
    const cards = new Set(level.cards);
    const cap = level.repeatCapacity ?? DEFAULT_REPEAT_CAPACITY;
    const hasRepeatCard = level.cards.some(isRepeatCard);
    const sol = level.solution;
    let rulesOk = true;
    const rule = (msg) => { err(msg); rulesOk = false; };

    if (sol.length > level.maxCards) rule(`solution uses ${sol.length} top-level cards but maxCards is ${level.maxCards}`);
    const used = new Set();
    sol.forEach((s, j) => {
      if (isArrow(s)) {
        used.add(s);
        if (!cards.has(s)) rule(`solution[${j}] uses "${s}" which is not in the palette`);
        return;
      }
      const card = `repeat${s.repeat}`;
      used.add(card);
      if (!cards.has(card)) rule(`solution[${j}] is a repeat ${s.repeat} block but "${card}" is not in the palette`);
      if (s.do.length > cap) rule(`solution[${j}] has ${s.do.length} arrows inside the repeat but repeatCapacity is ${cap}`);
      s.do.forEach((d) => {
        used.add(d);
        if (!cards.has(d)) rule(`solution[${j}] uses "${d}" inside the repeat but it is not in the palette`);
      });
    });

    const run = simulate(level, sol, grid);
    const total = expand(sol).length;
    row.moves = run.steps.length;
    if (run.outcome !== 'goal') {
      const at = run.failStep ? ` (move ${run.steps.length}: "${run.failStep.dir}" from ${cellStr(run.failStep.from)} is blocked)` : ` (robot stops at ${cellStr(run.final)})`;
      rule(`solution does not reach the goal: outcome "${run.outcome}"${at}`);
    } else if (run.steps.length !== total) {
      rule(`solution reaches the goal on move ${run.steps.length} of ${total}; the LAST move must be the one that enters the goal (remove or shorten the trailing cards)`);
    }

    const best = solve(level, { grid });
    row.optimal = best ? best.length : null;
    if (!best) rule(`no program of <= ${level.maxCards} cards can reach the goal (solve() found nothing)`);
    const bestNoRepeat = solve(level, { allowRepeat: false, maxCards: grid.cols * grid.rows, grid });
    row.optimalNoRepeat = bestNoRepeat ? bestNoRepeat.length : null;
    row.best = best ? formatProgram(best) : '';

    if (hasRepeatCard) {
      const arrowsOnly = solve(level, { allowRepeat: false, grid });
      if (arrowsOnly && level.repeatOptional !== true) {
        rule(`the palette has a repeat card but the level is solvable with arrows only in ${arrowsOnly.length} card(s) (${formatProgram(arrowsOnly)}); lower maxCards below ${arrowsOnly.length} or set "repeatOptional": true`);
      }
    } else {
      if (level.repeatOptional !== undefined) warn('"repeatOptional" has no effect without a repeat card in the palette');
      if (level.repeatCapacity !== undefined) warn('"repeatCapacity" has no effect without a repeat card in the palette');
    }

    if (best && level.maxCards > best.length + LIMITS.looseSlack) {
      warn(`maxCards ${level.maxCards} is loose: optimal is ${best.length} card(s); use ${best.length}..${best.length + 1}`);
    }
    if (prevMoves !== null && run.outcome === 'goal' && prevMoves - row.moves > LIMITS.maxMoveDrop) {
      warn(`reference solution has ${row.moves} moves, ${prevMoves - row.moves} fewer than the previous level (${prevMoves}); difficulty should not drop sharply`);
    }
    const spare = level.cards.filter((c) => !used.has(c));
    row.spare = spare.length;
    if (spare.length > LIMITS.maxSpareCards) warn(`palette has ${spare.length} cards the reference solution does not use (${spare.join(', ')}); keep distractors to one or two`);

    const refW = stripWidth(sol, cap);
    const worstW = round1(level.maxCards * (hasRepeatCard ? 1.4 + cap : 1));
    row.strip = `${refW}/${worstW}`;
    // Only repeat blocks make the strip too wide: plain arrows wrap compactly (8 arrows, the
    // maxCards limit, fit 360x640, 375x667 and 640x360 with nothing hidden).
    if (hasRepeatCard && refW > LIMITS.stripRefMax) {
      warn(`reference solution is ${refW} card widths wide in the command strip (arrow = 1, repeat block = 1.4 + repeatCapacity); above ${LIMITS.stripRefMax} it scrolls on phones and hides part of the hint program; use fewer repeat blocks (e.g. two-arrow bodies) or fewer slots`);
    }
    if (hasRepeatCard && worstW > LIMITS.stripWorstMax) {
      warn(`a full strip (${level.maxCards} slots, each a repeat block with ${cap} inner slot${cap === 1 ? "" : "s"}) is ${worstW} card widths wide; above ${LIMITS.stripWorstMax} it can scroll inside its box on small phones (360 px wide, or landscape, once system bars take some height); use at most 2 slots, or accept it only when the level truly needs ${level.maxCards} cards`);
    }

    if (best) {
      const ways = countWinningPrograms(level, grid);
      row.ways = ways.capped ? `>${ways.count}` : ways.count;
    }
    row.ok = rulesOk;
    prevMoves = run.outcome === 'goal' ? row.moves : null;
  });

  // --- curriculum (main data/robot/levels.json) -----------------------------------------------
  if (curriculum) {
    const L = doc.levels;
    if (L.length !== CURRICULUM.count) fail(`curriculum: expected exactly ${CURRICULUM.count} levels, found ${L.length}`);
    L.forEach((level, i) => {
      if (!isObj(level)) return;
      const n = i + 1;
      const want = `r${String(n).padStart(2, '0')}`;
      const label = typeof level.id === 'string' ? level.id : `levels[${i}]`;
      if (level.id !== want) fail(`curriculum: level ${n} must have id "${want}", got ${JSON.stringify(level.id)}`);
      const obstacles = Array.isArray(level.obstacles) ? level.obstacles.length : 0;
      const repeats = Array.isArray(level.cards) ? level.cards.filter(isRepeatCard).length : 0;
      if (n >= CURRICULUM.sequencing[0] && n <= CURRICULUM.sequencing[1]) {
        if (obstacles) fail(`curriculum: ${label} is a sequencing level (1-9) and must have no obstacles`);
        if (repeats) fail(`curriculum: ${label} is a sequencing level (1-9) and must have no repeat cards`);
      } else if (n >= CURRICULUM.loops[0] && n <= CURRICULUM.loops[1]) {
        if (!obstacles) fail(`curriculum: ${label} is a loop level (10-15) and needs at least one obstacle`);
        if (!repeats) fail(`curriculum: ${label} is a loop level (10-15) and needs a repeat card (repeat2 and/or repeat3)`);
      }
    });
  }

  return { errors, warnings, rows };
}

// ---------------------------------------------------------------------------------------------
// CLI

function table(rows) {
  const head = ['#', 'id', 'palette', 'max', 'opt', 'noLoop', 'moves', 'obst', 'ways', 'spare', 'strip', 'best program'];
  const body = rows.map((r) => [
    r.n, r.id, r.cards, r.maxCards ?? '?', r.optimal ?? '-', r.optimalNoRepeat ?? '-', r.moves ?? '?', r.obstacles ?? '?', r.ways ?? '-', r.spare ?? '-', r.strip || '-', r.best || '',
  ].map(String));
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cols) => cols.map((c, i) => (i <= 2 || i === cols.length - 1 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ').trimEnd();
  return [line(head), line(w.map((x) => '-'.repeat(x))), ...body.map(line)].join('\n');
}

function maps(doc) {
  const grid = isObj(doc.grid) && isInt(doc.grid.cols) && isInt(doc.grid.rows) ? doc.grid : undefined;
  const out = [];
  for (const level of doc.levels || []) {
    try {
      const a = renderLevelMap(level, grid);
      const b = renderLevelMap(level, grid, level.solution);
      const kinds = (level.obstacles || []).map((o) => `${o.kind}${cellStr(o.at)}`).join(' ');
      out.push(`${level.id}   map${' '.repeat(Math.max(1, a[0].length - 1))}reference path${kinds ? `   obstacles: ${kinds}` : ''}`);
      a.forEach((r, i) => out.push(`      ${r}    ${b[i]}`));
      out.push(`      solution: ${formatProgram(level.solution)}   say: "${level.say}"${level.hint ? `   hint: "${level.hint}"` : ''}`);
      out.push('');
    } catch (e) {
      out.push(`${level && level.id}: cannot draw map (${e.message})`, '');
    }
  }
  return out.join('\n');
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const unknown = [...flags].filter((f) => !['--maps', '--no-curriculum', '--json'].includes(f));
  if (unknown.length) {
    console.error(`unknown option(s): ${unknown.join(' ')}\nusage: node tools/validate-levels.mjs [file] [--maps] [--no-curriculum] [--json]`);
    return 2;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fileArg = argv.find((a) => !a.startsWith('--'));
  const file = fileArg ? path.resolve(fileArg) : path.join(here, '..', 'data', 'robot', 'levels.json');

  let doc;
  let bom = false;
  try {
    let text = fs.readFileSync(file, 'utf8');
    // Windows editors / PowerShell 5.1 often save a UTF-8 byte-order mark; the browser's
    // fetch().json() ignores it, so tolerate it here too (with a warning, like tools/validate.mjs).
    if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); bom = true; }
    doc = JSON.parse(text);
  } catch (e) {
    console.error(`ERROR ${file}: ${e.code === 'ENOENT' ? 'file not found' : `invalid JSON: ${e.message}`}`);
    return 1;
  }
  const result = validateLevels(doc, { curriculum: !flags.has('--no-curriculum') });
  if (bom) result.warnings.unshift('file starts with a UTF-8 byte-order mark (BOM); save it as UTF-8 without BOM');
  if (flags.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return result.errors.length ? 1 : 0;
  }

  const rel = path.relative(process.cwd(), file);
  console.log(`Robot levels: ${rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file}`);
  console.log(table(result.rows));
  console.log('palette: U D L R arrows, x2 x3 repeat cards | max = maxCards | opt = fewest cards (solve) | noLoop = fewest cards with arrows only');
  console.log('moves = moves in the reference solution | ways = winning programs within maxCards | spare = palette cards the reference does not use');
  console.log(`strip = command-strip width in card widths: reference solution / fullest strip a child can build (loop levels warn above ${LIMITS.stripRefMax} / ${LIMITS.stripWorstMax})\n`);
  if (flags.has('--maps')) console.log(maps(doc));
  for (const w of result.warnings) console.log(`WARNING ${w}`);
  for (const e of result.errors) console.log(`ERROR   ${e}`);
  console.log(`\n${result.rows.length} level(s), ${result.errors.length} error(s), ${result.warnings.length} warning(s)`);
  return result.errors.length ? 1 : 0;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  try { return norm(process.argv[1]) === norm(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (invokedDirectly) process.exitCode = main(process.argv.slice(2));

// Loop Machine — round data helpers. PURE (no DOM): data clean-up, a light validity guard,
// the session builder and small puzzle helpers. The strict content checks live in
// tools/validate-machine.mjs; this guard only keeps a broken round from breaking the game.
import { tokenKind, isPicture, isSymbol, isNumberToken, isWordToken, sameAnswer } from './tokens.js';

export const TYPES = ['pattern', 'count', 'sequence', 'word', 'set', 'order'];
export const RECENT_MAX = 30;

export const DEFAULT_TIERS = [
  { id: 'little', name: 'Little', ages: '4-6', stars: 1, say: 'Little machine! Easy puzzles.' },
  { id: 'big', name: 'Big', ages: '7-9', stars: 2, say: 'Big machine! Number and word puzzles.' },
  { id: 'super', name: 'Super', ages: '10-12', stars: 3, say: 'Super machine! Tricky puzzles.' },
];

const isToken = (t) => tokenKind(t) !== null;
const isAnswerToken = (t) => isToken(t) && !isSymbol(t);
const text = (v) => typeof v === 'string' && v.trim().length > 0;

/** Returns null when the round is usable, otherwise a short reason. */
export function roundProblem(r, tierIds) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not an object';
  if (!text(r.id)) return 'missing id';
  if (!tierIds.includes(r.tier)) return `unknown tier "${r.tier}"`;
  if (![1, 2, 3].includes(r.level)) return 'level must be 1, 2 or 3';
  if (!TYPES.includes(r.type)) return `unknown type "${r.type}"`;
  if (!text(r.say)) return 'missing say';
  for (const k of ['hint', 'explain', 'ruleLabel']) {
    if (r[k] != null && typeof r[k] !== 'string') return `${k} must be text`;
  }
  if (r.type === 'order') {
    if (!Array.isArray(r.words) || r.words.length < 2 || r.words.length > 12) return 'order needs 2-12 words';
    if (!r.words.every(isWordToken)) return 'order words must be words';
    return null;
  }
  if (!Array.isArray(r.choices) || r.choices.length < 2 || r.choices.length > 4) return 'needs 2-4 choices';
  if (r.type === 'set') {
    const okSet = (c) => Array.isArray(c) && c.length >= 1 && c.length <= 8 && c.every(isAnswerToken);
    if (!r.choices.every(okSet)) return 'each set choice must be a list of 1-8 tokens';
  } else if (!r.choices.every(isAnswerToken)) {
    return 'bad choice token';
  }
  for (let i = 0; i < r.choices.length; i++) {
    for (let j = i + 1; j < r.choices.length; j++) {
      if (sameAnswer(r.choices[i], r.choices[j])) return 'duplicate choices';
    }
  }
  if (!r.choices.some((c) => sameAnswer(c, r.answer))) return 'answer is not one of the choices';

  if (r.type === 'set') {
    if (r.show != null && !(Array.isArray(r.show) && r.show.length <= 12 && r.show.every(isToken))) return 'bad show';
    return null;
  }
  if (!Array.isArray(r.show) || r.show.length < 1 || r.show.length > 16 || !r.show.every(isToken)) return 'bad show';
  const marks = r.show.filter((t) => t === '?').length;
  if (r.type === 'count') {
    if (!isPicture(r.target)) return 'count needs a picture target';
    if (!isNumberToken(r.answer)) return 'count answer must be a number';
    const n = r.show.filter((t) => t === r.target).length;
    if (n !== r.answer) return `count answer ${r.answer} but ${n} ${r.target} shown`;
    return null;
  }
  if (marks !== 1) return 'show needs exactly one ?';
  return null;
}

export const isValidRound = (r, tierIds) => roundProblem(r, tierIds) === null;

// Tier ids end up in routes (#/machine/<id>) and storage paths (best.<id>, recent.<id>):
// plain lowercase ids only (no dots, no "__proto__").
const TIER_ID = /^[a-z0-9-]{1,24}$/;

function cleanTier(t, i) {
  const base = DEFAULT_TIERS[i] || DEFAULT_TIERS[DEFAULT_TIERS.length - 1];
  if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !TIER_ID.test(t.id)) return null;
  const stars = Number(t.stars);
  return {
    id: t.id,
    name: text(t.name) ? t.name : base.name,
    ages: text(t.ages) ? t.ages : base.ages,
    stars: Number.isInteger(stars) && stars >= 1 && stars <= 5 ? stars : i + 1,
    say: text(t.say) ? t.say : base.say,
    index: i,
  };
}

/**
 * Normalise data/machine/rounds.json. Malformed rounds are skipped with console.warn.
 * -> { sessionLength, tiers: [{id,name,ages,stars,say,index}], byTier: { id: [round] } }
 */
export function prepareData(json, warn = (...a) => console.warn(...a)) {
  const src = json && typeof json === 'object' ? json : {};
  let tiers = Array.isArray(src.tiers) ? src.tiers.map(cleanTier).filter(Boolean) : [];
  const seenTier = new Set();
  tiers = tiers.filter((t) => (seenTier.has(t.id) ? false : seenTier.add(t.id)));
  if (!tiers.length) tiers = DEFAULT_TIERS.map((t, i) => ({ ...t, index: i }));
  tiers = tiers.slice(0, 3).map((t, i) => ({ ...t, index: i }));
  const tierIds = tiers.map((t) => t.id);

  const len = Number(src.sessionLength);
  const sessionLength = Number.isInteger(len) && len >= 1 && len <= 30 ? len : 10;

  const byTier = Object.fromEntries(tierIds.map((id) => [id, []]));
  const ids = new Set();
  for (const r of Array.isArray(src.rounds) ? src.rounds : []) {
    const why = roundProblem(r, tierIds);
    if (why) { warn(`Loop Machine: skipping round ${r && r.id ? `"${r.id}"` : '(no id)'}: ${why}`); continue; }
    if (ids.has(r.id)) { warn(`Loop Machine: skipping duplicate round id "${r.id}"`); continue; }
    ids.add(r.id);
    byTier[r.tier].push(r);
  }
  return { sessionLength, tiers, byTier };
}

/** Target difficulty for slot i of n: ramps 1 -> 3 across the session. */
export function levelFor(i, n) {
  if (n <= 1) return 1;
  return Math.min(3, 1 + Math.floor((i * 3) / n));
}

/**
 * Pick min(length, pool.length) rounds: ramp level 1 -> 3, avoid recently played ids,
 * mix types (never the same type 3 times in a row when there is any alternative).
 */
export function buildSession(pool, length, recent = [], rand = Math.random) {
  const n = Math.max(0, Math.min(length, pool.length));
  const left = pool.slice();
  const recentSet = new Set(Array.isArray(recent) ? recent : []);
  const out = [];
  for (let i = 0; i < n; i++) {
    const want = levelFor(i, n);
    const k = out.length;
    let best = null;
    let bestScore = Infinity;
    for (const r of left) {
      let s = Math.abs(r.level - want) * 10;
      if (recentSet.has(r.id)) s += 15;
      if (k >= 2 && out[k - 1].type === r.type && out[k - 2].type === r.type) s += 100;
      else if (k >= 1 && out[k - 1].type === r.type) s += 3;
      s += rand() * 2.5;
      if (s < bestScore) { bestScore = s; best = r; }
    }
    out.push(best);
    left.splice(left.indexOf(best), 1);
  }
  return out;
}

/** Remember played ids (newest last), keeping at most RECENT_MAX. */
export function pushRecent(list, id) {
  const arr = (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x !== id);
  arr.push(id);
  return arr.slice(-RECENT_MAX);
}

export function shuffle(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Indices of `words` in a shuffled order that never reads the same as the real sentence. */
export function scrambleOrder(words, rand = Math.random) {
  const idx = words.map((_, i) => i);
  if (new Set(words).size < 2) return idx; // every word the same: nothing to scramble
  for (let tries = 0; tries < 40; tries++) {
    const s = shuffle(idx, rand);
    if (s.some((w, i) => words[w] !== words[i])) return s;
  }
  // Fall back to a rotation, which always differs when two words differ.
  return idx.map((_, i) => (i + 1) % idx.length);
}

/**
 * Smallest repeating unit of a picture loop (the ? replaced by the answer), or 0 when no unit
 * repeats at least once and a bit. Used to bracket "one repeat" for the hint.
 */
export function loopPeriod(seq) {
  for (let p = 1; p <= seq.length - 2; p++) {
    let ok = true;
    for (let i = p; i < seq.length && ok; i++) ok = sameAnswer(seq[i], seq[i - p]);
    if (ok) return p;
  }
  return 0;
}

/** Differences between neighbouring numbers ("hops"); null where either side is unknown. */
export function hops(seq) {
  const out = [];
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1];
    const b = seq[i];
    out.push(isNumberToken(a) && isNumberToken(b) ? b - a : null);
  }
  return out;
}

export function hopLabel(d) {
  if (d == null || !Number.isFinite(d)) return '';
  if (!Number.isInteger(d)) return '';
  if (d === 0) return '+0';
  return d > 0 ? `+${d}` : `−${Math.abs(d)}`;
}

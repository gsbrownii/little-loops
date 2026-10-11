#!/usr/bin/env node
// Validate Loop Machine puzzle banks (format "machine-rounds/1", schema: schemas/machine-rounds.schema.json).
// Token rules come from the game's own js/modules/machine/tokens.js, so the validator and the
// game can never disagree about what a token is. Zero dependencies.
//
//   node tools/validate-machine.mjs                    # data/machine/rounds.json
//   node tools/validate-machine.mjs path/to/bank.json  # any bank (path relative to the current dir)
//   options:  --list   one line per round (say | show | choices | answer) for proofreading
//             --json   print { errors, warnings, rows, counts } as JSON instead of the report
//
// Exit code 1 if there is any ERROR (warnings never fail). Reusable from other tools:
//   import { validateMachine } from './validate-machine.mjs';
//   const { errors, warnings, rows } = validateMachine(doc);
//
// Besides the structure (mirrors the JSON Schema), it proves what a schema cannot:
//   pattern   the belt with the answer filled in is a loop whose unit repeats at least twice in view
//             (or, for shape-color tokens, the shape loop and the color loop each repeat twice; or a
//             verified "growing" pattern), and NO other choice also completes a loop
//   count     the answer really is the number of `target` pictures on the belt (levels 2-3 should
//             mix in other pictures: warning)
//   sequence  the numbers obey the declared `rule`, and no wrong choice fits another simple rule
//             (constant jump, constant ratio, growing jumps, Fibonacci-like, alternating jumps,
//             squares, cubes, triangular numbers, primes); the hint does not name the answer
//             (digits or number words)
//   little    number distractors test counting, not reading: no digit swaps (14 / 41), nothing
//             beyond 20 (warnings)
//   set       more / fewer rounds: the answer group is strictly the biggest / smallest
//   word      compound words add up, word families share their ending, missing letters are letters
//             and the question names the word, rhyme distractors do not share the rhyme sound
//             (heuristic warning)
//   order     sentences are 3..9 word cards, capitalized and punctuated, no duplicate cards; warnings
//             for likely second orders (two different lowercase determiners such as "the" + "a",
//             "and"/"or" pairs) and for an `explain` that repeats the sentence (the game reads the
//             finished sentence aloud just before the explain)
//   speech    say / hint / explain are short and TTS-friendly (no symbols such as arrows, plus, equals,
//             and no math written with symbols between digits: "3 x 4", "9 - 3"); a hint never asks
//             the child to touch / tap the belt pictures (they do not react); every word token is
//             spoken exactly as it is written
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  tokenKind, tokenName, sameAnswer, isPicture, isNumberToken, isWordToken, isObjectToken,
} from '../js/modules/machine/tokens.js';

export const FORMAT = 'machine-rounds/1';
export const TIER_IDS = ['little', 'big', 'super'];
export const ROUND_TYPES = ['pattern', 'count', 'sequence', 'word', 'set', 'order'];
export const TYPE_CODES = { pattern: 'pat', count: 'cnt', sequence: 'seq', word: 'wrd', set: 'set', order: 'ord' };
export const SET_COUNT_SKILLS = { more: 'max', fewer: 'min' };
export const NAMED_SEQUENCE_RULES = ['squares', 'cubes', 'triangular', 'fibonacci', 'primes'];
export const LIMITS = {
  sessionLength: [3, 20],
  idPattern: /^[a-z0-9-]+$/,
  idMax: 32,
  levels: [1, 3],
  textMaxChars: 110, // say / hint / explain / tier say
  textMaxWords: 15, // speech guideline (warning)
  ruleLabelMax: 24,
  skillPattern: /^[a-z][a-z0-9-]*$/,
  choices: [2, 4],
  setGroup: [1, 6],
  orderWords: [3, 9],
  showMax: 12, // hard limit
  showComfort: 9, // the belt is laid out for up to 9 items (warning above)
  countAnswer: [1, 20],
  minSequenceShow: 4, // at least 3 numbers + the "?"
  minTierRounds: 30, // warning
  minLevelRounds: 8, // warning
};

const TOP_KEYS = new Set(['$schema', 'schema', 'sessionLength', 'tiers', 'rounds']);
const TIER_KEYS = ['id', 'name', 'ages', 'stars', 'say'];
const COMMON_KEYS = ['id', 'tier', 'level', 'type', 'say', 'hint', 'explain', 'skill'];
const TYPE_FIELDS = {
  pattern: { required: ['show', 'choices', 'answer'], optional: ['rule', 'ruleLabel'] },
  count: { required: ['target', 'show', 'choices', 'answer'], optional: ['ruleLabel'] },
  sequence: { required: ['show', 'choices', 'answer'], optional: ['rule', 'ruleLabel'] },
  word: { required: ['show', 'choices', 'answer'], optional: ['ruleLabel'] },
  set: { required: ['choices', 'answer'], optional: ['show', 'target', 'ruleLabel'] },
  order: { required: ['words'], optional: [] },
};
const ALL_ROUND_KEYS = new Set([...COMMON_KEYS, 'show', 'choices', 'answer', 'target', 'rule', 'ruleLabel', 'words']);

// Spoken text: these characters are read out wrongly (or not at all) by speech synthesis.
// (arrows U+2190-21FF and the heavy arrows U+2794 / U+27A1, math operators, markup-ish characters)
const SYMBOL_CHARS = /[←-⇿➔➡+=×÷*/\\<>^~|{}[\]#@%&_]/u;
const SPEAKABLE = /^[A-Za-z0-9 .,!?'’"“”:;()\-–—]*$/u;
// Math written with a letter or dash between digits ("3 x 4", "9 - 3", "4-6"): speech reads these
// unpredictably ("three ex four", "nine dash three"), so spell the operation out.
const SYMBOL_MATH = /\d\s*[xX×*]\s*\d|\d\s*[-–—−]\s*\d/u;
// Lowercase determiners: two DIFFERENT ones in one sentence can almost always swap ("At the beach, we
// built a sandcastle." / "At a beach, we built the sandcastle."), which gives a second grammatical order.
export const ORDER_DETERMINERS = ['a', 'an', 'the', 'my', 'our', 'your', 'their', 'this', 'these', 'those', 'some'];

const NUM_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const NUM_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
/** English words for a whole number 0..999 ("twenty-five", "one hundred"), or null. */
export function numberWords(n) {
  if (!Number.isInteger(n) || n < 0 || n > 999) return null;
  if (n < 20) return NUM_ONES[n];
  if (n < 100) return NUM_TENS[Math.floor(n / 10)] + (n % 10 ? `-${NUM_ONES[n % 10]}` : '');
  const r = n % 100;
  return `${NUM_ONES[Math.floor(n / 100)]} hundred${r ? ` ${numberWords(r)}` : ''}`;
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
const show = (v) => JSON.stringify(v);
const EPS = 1e-9;
const near = (a, b) => Math.abs(a - b) < EPS * Math.max(1, Math.abs(a), Math.abs(b));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isShapeColor = (t) => isPicture(t) && !isObjectToken(t);
const isLetter = (t) => typeof t === 'string' && /^[a-z]$/i.test(t);

/** Canonical string for duplicate detection (order-insensitive choices). */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  return JSON.stringify(v);
}

// =============================================================================================
// Pattern helpers (pure, exported for tests and future generators)

/** Smallest period p >= 1 such that seq[i] === seq[i-p] for all i and the unit repeats at least twice (2p <= n). */
export function minPeriod(seq, eq = sameAnswer) {
  const n = seq.length;
  for (let p = 1; p * 2 <= n; p++) {
    let ok = true;
    for (let i = p; i < n && ok; i++) ok = eq(seq[i], seq[i - p]);
    if (ok) return p;
  }
  return null;
}

/**
 * Parse a "growing" pattern: H T^k H T^(k+1) H T^(k+2) ... (the last block may be cut short).
 * Returns { head, tail, start, blocks } or null.
 */
export function growingFit(seq) {
  if (seq.length < 5) return null;
  const head = seq[0];
  const blocks = [];
  let i = 0;
  while (i < seq.length) {
    if (!sameAnswer(seq[i], head)) return null;
    let j = i + 1;
    while (j < seq.length && !sameAnswer(seq[j], head)) j++;
    blocks.push(seq.slice(i + 1, j));
    i = j;
  }
  if (blocks.length < 3 || !blocks[0].length) return null;
  const tail = blocks[0][0];
  if (!blocks.every((b) => b.every((t) => sameAnswer(t, tail)))) return null;
  const lens = blocks.map((b) => b.length);
  for (let b = 1; b < lens.length; b++) {
    const want = lens[0] + b;
    if (b < lens.length - 1 ? lens[b] !== want : lens[b] > want) return null;
  }
  return { head, tail, start: lens[0], blocks: lens.length };
}

/**
 * How a filled-in picture belt forms a loop:
 *   { kind: 'repeat', period }                         whole pictures repeat
 *   { kind: 'attributes', shapePeriod, colorPeriod }   shape loop and color loop repeat separately
 *   { kind: 'growing', ... }                           only when allowGrowing
 *   null                                               no loop
 */
export function patternFit(seq, { allowGrowing = false } = {}) {
  const p = minPeriod(seq);
  if (p && p >= 2) return { kind: 'repeat', period: p };
  if (p === 1) return null; // every picture the same: not a loop
  if (seq.every(isShapeColor)) {
    const shapes = seq.map((t) => t.split('-')[0]);
    const colors = seq.map((t) => t.split('-')[1]);
    const sp = minPeriod(shapes);
    const cp = minPeriod(colors);
    if (sp && cp && (sp > 1 || cp > 1)) return { kind: 'attributes', shapePeriod: sp, colorPeriod: cp };
  }
  if (allowGrowing) {
    const g = growingFit(seq);
    if (g) return { kind: 'growing', ...g };
  }
  return null;
}

/** "aab" style signature of one loop unit (first-seen order), e.g. [fish, fish, bug] -> "aab". */
export function unitSignature(unit) {
  const seen = [];
  return unit.map((t) => {
    let k = seen.findIndex((x) => sameAnswer(x, t));
    if (k < 0) { seen.push(t); k = seen.length - 1; }
    return String.fromCharCode(97 + k);
  }).join('');
}

// =============================================================================================
// Sequence helpers

function parseStep(s) {
  const m = /^([+\-*/x×])(\d+(?:\.\d+)?)$/.exec(String(s).trim());
  if (!m) return null;
  const op = m[1] === 'x' || m[1] === '×' ? '*' : m[1];
  const k = Number(m[2]);
  if (!(k > 0)) return null;
  return { op, k };
}
const applyStep = (v, st) => (st.op === '+' ? v + st.k : st.op === '-' ? v - st.k : st.op === '*' ? v * st.k : v / st.k);

function isPrime(n) {
  if (!isInt(n) || n < 2) return false;
  for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
  return true;
}
function nextPrime(n) {
  let m = Math.max(2, Math.floor(n) + 1);
  while (!isPrime(m)) m++;
  return m;
}
const tri = (n) => (n * (n + 1)) / 2;
function rootOf(v, f, max = 2000) {
  for (let n = 0; n <= max; n++) {
    const x = f(n);
    if (near(x, v)) return n;
    if (x > v) return null;
  }
  return null;
}

/** Names of the machine-checkable sequence rules (for messages and the schema). */
export const SEQUENCE_RULE_HELP = '"+k", "-k", "*k" (or "xk"), "/k", "squares", "cubes", "triangular", "fibonacci", "primes", "alt:<step>,<step>[,...]" (e.g. "alt:+3,-1", "alt:*2,+1")';

/**
 * Check a full number sequence against a rule.
 * @returns {{ known: boolean, ok: boolean, why?: string }}
 */
export function checkSequenceRule(rule, seq) {
  const bad = (why) => ({ known: true, ok: false, why });
  if (typeof rule !== 'string') return { known: false, ok: false };
  const r = rule.trim();
  const step = parseStep(r);
  if (step) {
    for (let i = 1; i < seq.length; i++) {
      if (!near(seq[i], applyStep(seq[i - 1], step))) return bad(`${seq[i - 1]} ${step.op} ${step.k} is ${applyStep(seq[i - 1], step)}, not ${seq[i]}`);
    }
    return { known: true, ok: true };
  }
  if (r.startsWith('alt:')) {
    const steps = r.slice(4).split(',').map(parseStep);
    if (steps.length < 2 || steps.some((s) => !s)) return { known: false, ok: false };
    for (let i = 1; i < seq.length; i++) {
      const st = steps[(i - 1) % steps.length];
      if (!near(seq[i], applyStep(seq[i - 1], st))) return bad(`step ${i} should be ${st.op}${st.k}: ${seq[i - 1]} ${st.op} ${st.k} is ${applyStep(seq[i - 1], st)}, not ${seq[i]}`);
    }
    if (seq.length - 1 < steps.length * 2) return bad(`only ${seq.length - 1} jumps: each of the ${steps.length} alternating steps must be visible at least twice (show at least ${steps.length * 2 + 1} numbers including the answer)`);
    return { known: true, ok: true };
  }
  const named = { squares: (n) => n * n, cubes: (n) => n * n * n, triangular: tri };
  if (named[r]) {
    const n0 = rootOf(seq[0], named[r]);
    if (n0 === null) return bad(`${seq[0]} is not a ${r === 'triangular' ? 'triangular number' : r.slice(0, -1)}`);
    for (let i = 1; i < seq.length; i++) {
      if (!near(seq[i], named[r](n0 + i))) return bad(`after ${seq[i - 1]} the next ${r} number is ${named[r](n0 + i)}, not ${seq[i]}`);
    }
    return { known: true, ok: true };
  }
  if (r === 'fibonacci') {
    if (seq.length < 4) return bad('needs at least 4 numbers');
    for (let i = 2; i < seq.length; i++) {
      if (!near(seq[i], seq[i - 1] + seq[i - 2])) return bad(`${seq[i - 2]} + ${seq[i - 1]} is ${seq[i - 2] + seq[i - 1]}, not ${seq[i]}`);
    }
    return { known: true, ok: true };
  }
  if (r === 'primes') {
    if (!isPrime(seq[0])) return bad(`${seq[0]} is not prime`);
    for (let i = 1; i < seq.length; i++) {
      if (seq[i] !== nextPrime(seq[i - 1])) return bad(`the prime after ${seq[i - 1]} is ${nextPrime(seq[i - 1])}, not ${seq[i]}`);
    }
    return { known: true, ok: true };
  }
  return { known: false, ok: false };
}

/**
 * Every "simple" rule a number sequence fits. Used to prove that no WRONG choice also makes a
 * sensible sequence (which would give the round two defensible answers).
 * @returns {{ rule: string, hard: boolean }[]}  hard=false means a weaker (warning-level) reading
 */
export function simpleRulesFitting(seq) {
  const n = seq.length;
  const out = [];
  if (n < 3 || !seq.every((v) => typeof v === 'number' && Number.isFinite(v))) return out;
  const d = seq.slice(1).map((v, i) => v - seq[i]);
  const dd = d.slice(1).map((v, i) => v - d[i]);
  if (d.every((x) => near(x, d[0])) && !near(d[0], 0)) out.push({ rule: d[0] > 0 ? `+${d[0]}` : `-${-d[0]}`, hard: true });
  if (seq.every((v) => !near(v, 0))) {
    const r = seq[1] / seq[0];
    if (seq.slice(1).every((v, i) => near(v / seq[i], r)) && !near(r, 1)) out.push({ rule: r >= 1 ? `*${+r.toFixed(4)}` : `/${+(1 / r).toFixed(4)}`, hard: true });
  }
  if (n >= 4 && dd.every((x) => near(x, dd[0])) && !near(dd[0], 0)) out.push({ rule: `jumps grow by ${dd[0]}`, hard: true });
  if (n >= 5 && seq.slice(2).every((v, i) => near(v, seq[i] + seq[i + 1]))) out.push({ rule: 'add the two before', hard: true });
  if (n >= 5 && d.slice(2).every((x, i) => near(x, d[i])) && !near(d[0], d[1])) out.push({ rule: `alternating jumps ${d[0]}, ${d[1]}`, hard: true });
  for (const name of NAMED_SEQUENCE_RULES.filter((x) => x !== 'fibonacci')) {
    if (checkSequenceRule(name, seq).ok) out.push({ rule: name, hard: true });
  }
  if (n >= 5) {
    // two alternating steps, each either "add k" or "multiply by k" (e.g. x2, +1)
    const cls = [0, 1].map((par) => {
      const pairs = [];
      for (let i = par; i + 1 < n; i += 2) pairs.push([seq[i], seq[i + 1]]);
      const adds = pairs.map(([a, b]) => b - a);
      const mults = pairs.every(([a]) => !near(a, 0)) ? pairs.map(([a, b]) => b / a) : null;
      if (adds.every((x) => near(x, adds[0]))) return `+${adds[0]}`;
      // only kid-sensible multipliers: x2, x3, ... or half, a third, ...
      const m = mults && mults.every((x) => near(x, mults[0])) ? mults[0] : null;
      if (m && m >= 2 && near(m, Math.round(m))) return `x${Math.round(m)}`;
      if (m && m > 0 && m <= 0.5 && near(1 / m, Math.round(1 / m))) return `/${Math.round(1 / m)}`;
      return null;
    });
    if (cls[0] && cls[1] && cls[0] !== cls[1] && !out.length) out.push({ rule: `alternating ${cls[0]}, ${cls[1]}`, hard: false });
  }
  return out;
}

// =============================================================================================
// Word helpers

/** Rough rhyme sound: from the last vowel group to the end ("cake" -> "ake", "star" -> "ar"). */
export function rime(w) {
  const m = String(w).toLowerCase().replace(/[^a-z]/g, '').match(/[aeiouy]+[^aeiouy]*e?$/);
  return m ? m[0] : String(w).toLowerCase();
}

function commonEnding(list) {
  if (!list.length) return '';
  let end = list[0].toLowerCase();
  for (const w of list.slice(1)) {
    const lw = w.toLowerCase();
    while (end && !lw.endsWith(end)) end = end.slice(1);
  }
  return end;
}

/** Does spoken/hint text mention this answer token? (whole word / whole number) */
function mentions(text, token) {
  if (typeof text !== 'string') return false;
  if (typeof token === 'number') {
    if (new RegExp(`(^|[^0-9.])${escRe(String(token))}(?![0-9])`).test(text)) return true;
    const w = numberWords(token);
    if (!w || token < 2) return false; // "one" / "zero" are too common in ordinary hints
    return new RegExp(`(^|[^a-z-])${w.split(/[- ]/).map(escRe).join('[- ]')}(?![a-z-])`, 'i').test(text);
  }
  if (typeof token === 'string' && token.length > 1 && isWordToken(token)) {
    return new RegExp(`(^|[^A-Za-z'’])${escRe(token)}(?![A-Za-z'’])`, 'i').test(text);
  }
  return false;
}

// =============================================================================================

function checkSpoken(v, key, required, err, warn) {
  if (v === undefined) {
    if (required) err(`"${key}" is required (a short spoken sentence)`);
    return;
  }
  if (typeof v !== 'string' || !v.trim()) { err(`"${key}" must be a non-empty string`); return; }
  if (v.length > LIMITS.textMaxChars) err(`"${key}" is ${v.length} characters; max ${LIMITS.textMaxChars} (speech gets cut off)`);
  const sym = v.match(SYMBOL_CHARS);
  if (sym) err(`"${key}" contains the symbol "${sym[0]}"; spoken text must be TTS-friendly (write "plus", "minus", "times", "equals", "goes with")`);
  const math = v.match(SYMBOL_MATH);
  if (math) err(`"${key}" writes math with symbols ("${math[0]}"); speech reads that unpredictably, so write it in words ("three times four", "nine minus three", "four to six")`);
  else if (!SPEAKABLE.test(v)) warn(`"${key}" contains unusual characters (${[...new Set(v.replace(/[A-Za-z0-9 .,!?'’"“”:;()\-–—]/gu, ''))].join(' ')}); keep spoken text to plain words and punctuation`);
  if (/\d[A-Za-z]/.test(v)) warn(`"${key}" glues digits to letters ("${v.match(/\S*\d[A-Za-z]\S*/)[0]}"); write numbers as words ("fives") so speech reads them right`);
  if (words(v) > LIMITS.textMaxWords) warn(`"${key}" has ${words(v)} words; keep spoken lines to <= ${LIMITS.textMaxWords} simple words`);
}

/** Validate a token list. Returns true if every token is valid. */
function checkTokenList(list, where, { little, err, warn, allowQ = true, noSymbols = false, wordsAsPictureWarn = false }) {
  let ok = true;
  list.forEach((t, i) => {
    const at = `${where}[${i}]`;
    const kind = tokenKind(t);
    if (kind === null) { err(`${at} ${show(t)} is not a valid token (a number, a picture id, one of the symbols → + = ?, or a word/letter of 1-24 characters)`); ok = false; return; }
    // The game speaks words with tokenName(); it must say exactly what the chip shows.
    if (kind === 'word' && tokenName(t) !== t) { err(`${at} "${t}" would be spoken as "${tokenName(t)}"; pick a different word`); ok = false; }
    if (t === '?' && !allowQ) { err(`${at} "?" is not allowed here`); ok = false; }
    if (noSymbols && kind === 'symbol' && t !== '?') { err(`${at} "${t}" is a symbol; answers must be numbers, pictures or words`); ok = false; }
    if (little && kind === 'word') { err(`${at} "${t}" is a word token, but the little tier (ages 4-6) must not need reading: use pictures, numbers and symbols only`); ok = false; }
    if (wordsAsPictureWarn && kind === 'picture') warn(`${at} "${t}" is a picture id, so it will be DRAWN as a picture (${tokenName(t)}), not written as a word; rephrase if that is not intended`);
  });
  return ok;
}

function checkChoices(round, err, warn, little, { set = false, kinds = null, wordsAsPictureWarn = false } = {}) {
  const { choices, answer } = round;
  if (!Array.isArray(choices) || choices.length < LIMITS.choices[0] || choices.length > LIMITS.choices[1]) {
    err(`"choices" must be an array of ${LIMITS.choices[0]}..${LIMITS.choices[1]} answers`);
    return false;
  }
  let ok = true;
  choices.forEach((c, i) => {
    if (set) {
      if (!Array.isArray(c) || c.length < LIMITS.setGroup[0] || c.length > LIMITS.setGroup[1]) {
        err(`choices[${i}] must be a group (array) of ${LIMITS.setGroup[0]}..${LIMITS.setGroup[1]} tokens`);
        ok = false;
        return;
      }
      if (!checkTokenList(c, `choices[${i}]`, { little, err, warn, allowQ: false, noSymbols: true, wordsAsPictureWarn })) ok = false;
      return;
    }
    if (Array.isArray(c)) { err(`choices[${i}] is a group; only "set" rounds have group choices`); ok = false; return; }
    if (!checkTokenList([c], `choices[${i}]`, { little, err, warn, allowQ: false, noSymbols: true, wordsAsPictureWarn })) { ok = false; return; }
    if (kinds && !kinds.includes(tokenKind(c))) { err(`choices[${i}] ${show(c)} must be a ${kinds.join(' or ')} token for a ${round.type} round`); ok = false; }
  });
  for (let i = 0; i < choices.length; i++) {
    for (let j = i + 1; j < choices.length; j++) {
      if (sameAnswer(choices[i], choices[j])) { err(`choices[${i}] and choices[${j}] are the same (${show(choices[i])})`); ok = false; }
    }
  }
  if (answer === undefined) return false;
  const hits = choices.filter((c) => sameAnswer(c, answer)).length;
  if (hits !== 1) { err(`"answer" ${show(answer)} must be exactly one of the choices`); ok = false; }
  return ok;
}

/** 41 for 14; null for 1-digit numbers, palindromes (11) and reversals with a leading zero (10). */
export function digitReversal(n) {
  if (!isInt(n) || n < 10) return null;
  const r = String(n).split('').reverse().join('');
  if (r[0] === '0') return null;
  const v = Number(r);
  return v === n ? null : v;
}

/**
 * Little tier (ages 4-6, no reading): number distractors must test counting, not reading digits.
 * Warns on a wrong choice that is another number with its digits swapped (14 / 41) and on wrong
 * choices beyond 20 (one past the biggest number in the finished row is a fair overshoot).
 */
function checkLittleNumbers(round, warn) {
  if (!Array.isArray(round.choices) || !isNumberToken(round.answer)) return;
  const shown = Array.isArray(round.show) ? round.show.filter(isNumberToken) : [];
  const known = [round.answer, ...shown];
  const top = Math.max(...known);
  for (const c of round.choices) {
    if (!isNumberToken(c) || sameAnswer(c, round.answer)) continue;
    const src = known.find((n) => digitReversal(n) === c);
    if (src !== undefined) warn(`choice ${c} is ${src} with its digits swapped; little-tier distractors should test counting, not reading digit order (use a near miss such as one more or one less)`);
    else if (c > 20 && c > top + 1) warn(`choice ${c} is above 20; the little tier works with numbers up to 20`);
  }
}

/** Index of the single "?" in show, or -1 (after reporting). */
function questionIndex(round, err) {
  const marks = round.show.reduce((n, t) => n + (t === '?' ? 1 : 0), 0);
  if (marks !== 1) { err(`"show" must contain exactly one "?" (the mystery box), found ${marks}`); return -1; }
  return round.show.indexOf('?');
}

// =============================================================================================

/**
 * Validate a parsed Loop Machine bank.
 * @param {object} doc parsed JSON
 * @returns {{ errors: string[], warnings: string[], rows: object[], counts: object }}
 */
export function validateMachine(doc) {
  const errors = [];
  const warnings = [];
  const rows = [];
  const counts = {}; // tier -> level -> type -> n
  const fail = (m) => errors.push(m);
  const note = (m) => warnings.push(m);

  if (!isObj(doc)) {
    fail('file must contain a JSON object { "schema", "sessionLength", "tiers", "rounds" }');
    return { errors, warnings, rows, counts };
  }
  for (const k of Object.keys(doc)) if (!TOP_KEYS.has(k)) fail(`unknown top-level key "${k}" (allowed: ${[...TOP_KEYS].join(', ')})`);
  if (doc.schema !== FORMAT) fail(`"schema" must be "${FORMAT}", got ${show(doc.schema)}`);
  if (doc.$schema !== undefined && typeof doc.$schema !== 'string') fail('"$schema" must be a string');
  if (!isInt(doc.sessionLength) || doc.sessionLength < LIMITS.sessionLength[0] || doc.sessionLength > LIMITS.sessionLength[1]) {
    fail(`"sessionLength" must be an integer ${LIMITS.sessionLength[0]}..${LIMITS.sessionLength[1]}, got ${show(doc.sessionLength)}`);
  }

  // --- tiers -------------------------------------------------------------------------------
  const tierIds = new Set();
  if (!Array.isArray(doc.tiers) || doc.tiers.length !== TIER_IDS.length) {
    fail(`"tiers" must be an array of exactly ${TIER_IDS.length} tiers: ${TIER_IDS.join(', ')}`);
  }
  (Array.isArray(doc.tiers) ? doc.tiers : []).forEach((t, i) => {
    const label = isObj(t) && typeof t.id === 'string' ? `tier "${t.id}"` : `tiers[${i}]`;
    const err = (m) => fail(`${label}: ${m}`);
    const warn = (m) => note(`${label}: ${m}`);
    if (!isObj(t)) { err('must be an object { id, name, ages, stars, say }'); return; }
    for (const k of Object.keys(t)) if (!TIER_KEYS.includes(k)) err(`unknown key "${k}" (allowed: ${TIER_KEYS.join(', ')})`);
    for (const k of TIER_KEYS) if (t[k] === undefined) err(`missing "${k}"`);
    if (t.id !== TIER_IDS[i]) err(`tier ${i + 1} must have id "${TIER_IDS[i]}" (tiers are exactly ${TIER_IDS.join(', ')}, in that order), got ${show(t.id)}`);
    if (typeof t.id === 'string') {
      if (tierIds.has(t.id)) err('duplicate tier id');
      tierIds.add(t.id);
    }
    if (t.name !== undefined && (typeof t.name !== 'string' || !t.name.trim() || t.name.length > 24)) err('"name" must be a non-empty string of at most 24 characters');
    if (t.ages !== undefined && (typeof t.ages !== 'string' || !/^\d{1,2}-\d{1,2}$/.test(t.ages))) err(`"ages" must look like "4-6", got ${show(t.ages)}`);
    if (t.stars !== undefined && t.stars !== i + 1) err(`"stars" must be ${i + 1} (1 = little, 2 = big, 3 = super), got ${show(t.stars)}`);
    checkSpoken(t.say, 'say', true, err, warn);
  });

  // --- rounds ------------------------------------------------------------------------------
  if (!Array.isArray(doc.rounds) || !doc.rounds.length) {
    fail('"rounds" must be a non-empty array');
    return { errors, warnings, rows, counts };
  }
  const seenIds = new Map();
  const seenSig = new Map();

  doc.rounds.forEach((round, i) => {
    const label = isObj(round) && typeof round.id === 'string' ? round.id : `rounds[${i}]`;
    const err = (m) => fail(`${label}: ${m}`);
    const warn = (m) => note(`${label}: ${m}`);
    const row = { n: i + 1, id: label, tier: null, level: null, type: null, skill: '', rule: '', items: null, choices: null, hint: false, explain: false, ok: false };
    rows.push(row);
    if (!isObj(round)) { err('round must be an object'); return; }
    const errCount = errors.length;

    // structure ---------------------------------------------------------------------------
    for (const k of Object.keys(round)) if (!ALL_ROUND_KEYS.has(k)) err(`unknown key "${k}" (allowed: ${[...ALL_ROUND_KEYS].join(', ')})`);
    for (const k of ['id', 'tier', 'level', 'type', 'say']) if (round[k] === undefined) err(`missing required key "${k}"`);

    if (round.id !== undefined) {
      if (typeof round.id !== 'string' || !LIMITS.idPattern.test(round.id) || round.id.length > LIMITS.idMax) {
        err(`id ${show(round.id)} must match ${LIMITS.idPattern} (lowercase letters, digits, "-"; at most ${LIMITS.idMax} chars), e.g. "l-pat-01"`);
      } else if (seenIds.has(round.id)) err(`duplicate id (also round ${seenIds.get(round.id)})`);
      else seenIds.set(round.id, i + 1);
    }
    const tierOk = typeof round.tier === 'string' && tierIds.has(round.tier);
    if (round.tier !== undefined && !tierOk) err(`tier ${show(round.tier)} does not exist (tiers: ${[...tierIds].join(', ')})`);
    if (round.level !== undefined && (!isInt(round.level) || round.level < LIMITS.levels[0] || round.level > LIMITS.levels[1])) err(`level must be 1, 2 or 3, got ${show(round.level)}`);
    const typeOk = ROUND_TYPES.includes(round.type);
    if (round.type !== undefined && !typeOk) err(`type ${show(round.type)} must be one of ${ROUND_TYPES.join(', ')}`);
    row.tier = tierOk ? round.tier : null;
    row.level = isInt(round.level) ? round.level : null;
    row.type = typeOk ? round.type : null;
    row.skill = typeof round.skill === 'string' ? round.skill : '';
    row.rule = typeof round.rule === 'string' ? round.rule : '';
    row.hint = typeof round.hint === 'string';
    row.explain = typeof round.explain === 'string';

    if (typeOk) {
      const spec = TYPE_FIELDS[round.type];
      for (const k of spec.required) if (round[k] === undefined) err(`a ${round.type} round needs "${k}"`);
      const allowed = new Set([...COMMON_KEYS, ...spec.required, ...spec.optional]);
      for (const k of Object.keys(round)) if (ALL_ROUND_KEYS.has(k) && !allowed.has(k)) err(`"${k}" is not used by ${round.type} rounds (remove it)`);
    }
    if (typeof round.id === 'string' && typeOk && tierOk) {
      const m = /^([a-z])-([a-z]{3})-/.exec(round.id);
      if (m && (m[1] !== round.tier[0] || m[2] !== TYPE_CODES[round.type])) {
        warn(`id does not follow the "${round.tier[0]}-${TYPE_CODES[round.type]}-NN" convention for a ${round.tier} ${round.type} round`);
      }
    }

    checkSpoken(round.say, 'say', true, err, warn);
    checkSpoken(round.hint, 'hint', false, err, warn);
    checkSpoken(round.explain, 'explain', false, err, warn);
    if (round.skill !== undefined && (typeof round.skill !== 'string' || !LIMITS.skillPattern.test(round.skill))) err(`skill ${show(round.skill)} must be a lowercase label like "rhyme" or "missing-letter"`);
    if (round.ruleLabel !== undefined && (typeof round.ruleLabel !== 'string' || !round.ruleLabel.trim() || round.ruleLabel.length > LIMITS.ruleLabelMax)) {
      err(`ruleLabel must be a non-empty string of at most ${LIMITS.ruleLabelMax} characters`);
    }
    if (round.rule !== undefined && (typeof round.rule !== 'string' || !round.rule.trim())) err('rule must be a non-empty string');
    if (isInt(round.level) && round.level >= 2 && round.hint === undefined) warn(`level ${round.level} round has no "hint" (spoken when the hint shows; give a strategy, not the answer)`);
    // Belt pictures and numbers do not react to taps (only answer buttons and order word cards do).
    if (round.type !== 'order' && typeof round.hint === 'string' && /\b(touch|tap|press|poke)\s+(each|every)\b/i.test(round.hint)) {
      warn(`"hint" asks the child to ${round.hint.match(/\b(touch|tap|press|poke)\b/i)[0].toLowerCase()} each item, but the pictures on the belt do not respond to taps; say "Point to each ..." instead`);
    }

    if (!typeOk || !tierOk) return;
    const little = round.tier === 'little';
    const T = round.type;
    const ctx = { little, err, warn };

    // show ---------------------------------------------------------------------------------
    let showOk = false;
    if (round.show !== undefined) {
      if (!Array.isArray(round.show) || round.show.length < 1 || round.show.length > LIMITS.showMax) {
        err(`"show" must be an array of 1..${LIMITS.showMax} tokens`);
      } else {
        showOk = checkTokenList(round.show, 'show', { ...ctx, wordsAsPictureWarn: T === 'word' });
        row.items = round.show.length;
        if (round.show.length > LIMITS.showComfort) warn(`"show" has ${round.show.length} items; the belt is laid out for up to ${LIMITS.showComfort}`);
      }
    }
    // per type -----------------------------------------------------------------------------
    if (T === 'order') {
      const w = round.words;
      if (!Array.isArray(w) || w.length < LIMITS.orderWords[0] || w.length > LIMITS.orderWords[1]) {
        err(`"words" must be an array of ${LIMITS.orderWords[0]}..${LIMITS.orderWords[1]} word cards in the correct order`);
      } else {
        row.items = w.length;
        w.forEach((t, j) => {
          if (typeof t !== 'string' || !isWordToken(t)) {
            err(`words[${j}] ${show(t)} must be a word card (a string of 1-24 characters that is not a picture id or a symbol${isPicture(t) ? `; "${t}" is a picture id - add punctuation or rephrase` : ''})`);
          } else if (/\s/.test(t)) warn(`words[${j}] "${t}" contains a space; use one card per word`);
        });
        if (little) err('the little tier must not need reading: no order rounds');
        if (typeof w[0] === 'string' && !/^[A-Z]/.test(w[0])) warn(`the sentence should start with a capital letter ("${w[0]}")`);
        const last = w[w.length - 1];
        if (typeof last === 'string' && !/[.!?]$/.test(last)) warn(`the sentence should end with . ! or ? ("${last}")`);
        const dup = w.filter((x, j) => w.indexOf(x) !== j);
        if (dup.length) warn(`duplicate word card(s) ${[...new Set(dup)].map((x) => `"${x}"`).join(', ')}; identical cards must be interchangeable in the game`);
        const plain = (s) => String(s).toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
        const sentence = plain(w.join(' '));
        if (typeof round.say === 'string' && sentence.length > 8 && plain(round.say).includes(sentence)) warn('"say" reads out the whole sentence; the child should build it');
        if (typeof round.explain === 'string' && sentence.length > 8 && plain(round.explain).includes(sentence)) {
          warn('"explain" repeats the sentence; the game already reads the finished sentence aloud right before the explain, so teach the rule instead ("Questions end with a question mark!")');
        }
        const dets = [...new Set(w.filter((x) => ORDER_DETERMINERS.includes(x)))];
        if (dets.length >= 2) {
          warn(`the cards ${dets.map((x) => `"${x}"`).join(' and ')} can usually swap places and still make a sentence ("At a beach, we built the sandcastle."), but the game accepts only one order; keep one determiner (use a plural or a number instead)`);
        }
        const join = w.find((x) => typeof x === 'string' && /^(and|or)[.,!?]?$/.test(x));
        if (join) warn(`"${join}" joins two parts that can often swap ("cats and dogs" / "dogs and cats"); make sure only one order is grammatical`);
      }
      for (const k of ['choices', 'answer', 'show']) if (round[k] !== undefined) err(`order rounds have no "${k}" (the game shuffles "words")`);
    } else if (T === 'count') {
      if (!isPicture(round.target)) err(`"target" must be a picture token (what to count), got ${show(round.target)}`);
      if (showOk) {
        if (round.show.includes('?')) err('count rounds have no "?" in "show" (the child counts the pictures)');
        round.show.forEach((t, j) => { if (!isPicture(t)) err(`show[${j}] ${show(t)} must be a picture (count rounds show only pictures)`); });
      }
      if (checkChoices(round, err, warn, little, { kinds: ['number'] }) && little) checkLittleNumbers(round, warn);
      if (!isInt(round.answer) || round.answer < LIMITS.countAnswer[0] || round.answer > LIMITS.countAnswer[1]) {
        err(`"answer" must be a whole number ${LIMITS.countAnswer[0]}..${LIMITS.countAnswer[1]}, got ${show(round.answer)}`);
      } else if (showOk && isPicture(round.target)) {
        const n = round.show.filter((t) => t === round.target).length;
        if (n !== round.answer) err(`answer is ${round.answer} but "show" has ${n} ${tokenName(round.target)} picture(s)`);
        if (isInt(round.level) && round.level >= 2 && round.show.every((t) => t === round.target)) {
          warn(`level ${round.level} count round shows only ${tokenName(round.target)} pictures; levels 2-3 count the target among other pictures (make the total one of the distractors)`);
        }
      }
    } else if (T === 'pattern') {
      let q = -1;
      if (showOk) {
        q = questionIndex(round, err);
        round.show.forEach((t, j) => { if (t !== '?' && !isPicture(t)) err(`show[${j}] ${show(t)} must be a picture token (pattern rounds are picture loops)`); });
      }
      const choicesOk = checkChoices(round, err, warn, little, { kinds: ['picture'] });
      const allowGrowing = round.rule === 'growing';
      if (round.rule !== undefined && !allowGrowing) warn(`pattern rule ${show(round.rule)} is not machine-checked (only "growing" is); the loop itself is still verified`);
      if (q >= 0 && choicesOk && isPicture(round.answer) && round.show.every((t) => t === '?' || isPicture(t))) {
        const fill = (c) => round.show.map((t) => (t === '?' ? c : t));
        const fit = patternFit(fill(round.answer), { allowGrowing });
        if (!fit) {
          err(allowGrowing
            ? 'with the answer filled in, the belt is not a growing pattern (head, tail x k, head, tail x k+1, ...) or a loop that repeats at least twice'
            : 'with the answer filled in, the belt is not a loop: its repeating unit must appear at least twice in view (or the shape loop and the color loop must each repeat twice)');
        } else {
          if (allowGrowing && fit.kind !== 'growing') warn(`rule "growing" but the belt is a plain repeating loop (${fit.kind})`);
          if (fit.kind === 'attributes') {
            row.rule = row.rule || `shape/${fit.shapePeriod} color/${fit.colorPeriod}`;
            if (little) warn(`two-attribute loop (shape repeats every ${fit.shapePeriod}, color every ${fit.colorPeriod}) is too hard for ages 4-6; change one attribute only`);
          }
          if (fit.kind === 'repeat') {
            row.rule = row.rule || `unit ${fit.period}`;
            const seq = fill(round.answer);
            if (little && seq.every(isShapeColor)) {
              const sp = minPeriod(seq.map((t) => t.split('-')[0])) || 0;
              const cp = minPeriod(seq.map((t) => t.split('-')[1])) || 0;
              if (sp > 1 && cp > 1 && sp !== cp) warn(`shape and color change on different cycles (${sp} and ${cp}); too hard for the little tier`);
            }
            if (typeof round.skill === 'string' && /^[a-d]{2,6}$/.test(round.skill)) {
              const sig = unitSignature(seq.slice(0, fit.period));
              if (sig !== round.skill) warn(`skill "${round.skill}" but the loop unit is "${sig}"`);
            }
          }
          for (const c of round.choices) {
            if (sameAnswer(c, round.answer)) continue;
            const s = fill(c);
            const other = patternFit(s, { allowGrowing });
            if (other) err(`choice ${show(c)} ALSO completes a loop (${other.kind}); every round needs exactly one defensible answer`);
            else {
              for (let off = 1; off <= Math.min(2, q); off++) {
                const p = minPeriod(s.slice(off));
                if (p && p >= 2) { warn(`choice ${show(c)} makes the belt look like a loop if the first ${off} item(s) are ignored; move the "?" or change that choice`); break; }
              }
            }
          }
        }
      }
    } else if (T === 'sequence') {
      let q = -1;
      if (showOk) {
        q = questionIndex(round, err);
        round.show.forEach((t, j) => { if (t !== '?' && !isNumberToken(t)) err(`show[${j}] ${show(t)} must be a number (sequence rounds are number loops)`); });
        if (round.show.length < LIMITS.minSequenceShow) err(`"show" needs at least ${LIMITS.minSequenceShow - 1} numbers plus the "?" (fewer numbers fit too many rules)`);
      }
      const choicesOk = checkChoices(round, err, warn, little, { kinds: ['number'] });
      if (choicesOk && little) checkLittleNumbers(round, warn);
      if (round.rule === undefined) warn(`sequence has no machine-checkable "rule" (${SEQUENCE_RULE_HELP})`);
      if (round.ruleLabel === undefined) warn('sequence has no "ruleLabel" (short visual hint like "+2", "x2", "add the two before")');
      if (q >= 0 && choicesOk && isNumberToken(round.answer) && round.show.every((t) => t === '?' || isNumberToken(t)) && round.show.length >= LIMITS.minSequenceShow) {
        const fill = (c) => round.show.map((t) => (t === '?' ? c : t));
        const seq = fill(round.answer);
        if (round.rule !== undefined) {
          const res = checkSequenceRule(round.rule, seq);
          if (!res.known) warn(`rule ${show(round.rule)} is not machine-checkable (known: ${SEQUENCE_RULE_HELP}); the numbers were not verified`);
          else if (!res.ok) err(`the numbers (with the answer) do not obey rule "${round.rule}": ${res.why}`);
        } else if (!simpleRulesFitting(seq).length) warn('the numbers (with the answer) fit none of the simple rules; add a "rule" and double-check');
        for (const c of round.choices) {
          if (sameAnswer(c, round.answer) || !isNumberToken(c)) continue;
          const fits = simpleRulesFitting(fill(c));
          const hard = fits.filter((f) => f.hard);
          if (hard.length) err(`choice ${c} ALSO makes a sensible sequence (${hard.map((f) => f.rule).join('; ')}); pick a distractor that breaks every simple rule`);
          else if (fits.length) warn(`choice ${c} can be read as a sequence too (${fits.map((f) => f.rule).join('; ')})`);
        }
        if (round.hint !== undefined && mentions(round.hint, round.answer)) warn(`"hint" mentions the answer ${round.answer}; hints give a strategy, not the answer`);
      }
    } else if (T === 'word') {
      let q = -1;
      if (showOk) q = questionIndex(round, err);
      const choicesOk = checkChoices(round, err, warn, little, { wordsAsPictureWarn: true });
      if (round.skill === undefined) warn('word round has no "skill" (e.g. rhyme, opposite, compound, missing-letter, word-family, plural, analogy, synonym, antonym, homophone, prefix, suffix)');
      if (q >= 0 && choicesOk) {
        const sh = round.show;
        const skill = round.skill;
        const wordsIn = sh.filter((t) => typeof t === 'string' && isWordToken(t));
        if (skill === 'compound') {
          const lc = (s) => String(s).toLowerCase();
          let made = null;
          let check = null;
          if (sh.length === 5 && sh[1] === '+' && sh[3] === '=') {
            if (sh[4] === '?') { made = (c) => lc(sh[0]) + lc(sh[2]) === lc(c); check = `${sh[0]} + ${sh[2]}`; } else if (sh[0] === '?') { made = (c) => lc(c) + lc(sh[2]) === lc(sh[4]); check = `? + ${sh[2]} = ${sh[4]}`; } else if (sh[2] === '?') { made = (c) => lc(sh[0]) + lc(c) === lc(sh[4]); check = `${sh[0]} + ? = ${sh[4]}`; }
          }
          if (!made) warn('compound round: expected show like ["sun", "+", "shine", "=", "?"] (or with the "?" in place of either part) so it can be checked');
          else {
            if (!made(round.answer)) err(`compound: ${show(round.answer)} does not fit ${check}`);
            for (const c of round.choices) if (!sameAnswer(c, round.answer) && made(c)) err(`compound: choice ${show(c)} also fits ${check}`);
          }
        } else if (skill === 'missing-letter') {
          sh.forEach((t, j) => { if (t !== '?' && !isLetter(t)) warn(`missing-letter: show[${j}] ${show(t)} should be a single letter`); });
          round.choices.forEach((c, j) => { if (!isLetter(c)) err(`missing-letter: choices[${j}] ${show(c)} must be a single letter`); });
          const whole = sh.map((t) => (t === '?' ? round.answer : t)).join('');
          if (/^[a-z]+$/i.test(whole) && !new RegExp(`(^|[^a-z])${whole}(?![a-z])`, 'i').test(String(round.say))) {
            warn(`missing-letter: "say" should name the word ("Which letter is missing from the word ${whole.toLowerCase()}?"); otherwise other letters may make real words too (c?t: cat, cot, cut)`);
          }
        } else if (skill === 'word-family') {
          const end = commonEnding(wordsIn);
          if (end.length < 2) warn('word-family: the words on the belt should share an ending of at least 2 letters');
          else {
            if (typeof round.answer !== 'string' || !round.answer.toLowerCase().endsWith(end)) err(`word-family: answer ${show(round.answer)} does not end in "${end}" like the family`);
            for (const c of round.choices) if (!sameAnswer(c, round.answer) && typeof c === 'string' && c.toLowerCase().endsWith(end)) err(`word-family: choice "${c}" also ends in "${end}"`);
          }
        } else if (skill === 'rhyme') {
          const base = wordsIn[0];
          if (base) {
            const r0 = rime(base);
            for (const c of round.choices) {
              if (!sameAnswer(c, round.answer) && typeof c === 'string' && rime(c) === r0) warn(`rhyme: choice "${c}" may also rhyme with "${base}" (same ending "${r0}"); only ONE choice may rhyme`);
            }
          }
        }
        if (round.hint !== undefined && mentions(round.hint, round.answer)) warn(`"hint" mentions the answer "${round.answer}"; hints give a strategy, not the answer`);
      }
    } else if (T === 'set') {
      if (showOk && round.show.includes('?')) err('set rounds have no "?" in "show" (each choice is a whole group)');
      if (round.target !== undefined && !isPicture(round.target)) err(`"target" must be a picture token, got ${show(round.target)}`);
      const choicesOk = checkChoices(round, err, warn, little, { set: true, wordsAsPictureWarn: !little });
      if (round.skill === undefined) warn('set round has no "skill" (e.g. more, fewer, category, verbs, adjectives, nouns, adverbs, synonyms)');
      if (choicesOk && Array.isArray(round.answer)) {
        const how = SET_COUNT_SKILLS[round.skill];
        if (how) {
          const value = (g) => (round.target !== undefined ? g.filter((t) => sameAnswer(t, round.target)).length : g.length);
          const vals = round.choices.map(value);
          const best = how === 'max' ? Math.max(...vals) : Math.min(...vals);
          const a = value(round.answer);
          if (a !== best) err(`${round.skill}: the answer group has ${a}${round.target ? ` ${tokenName(round.target)}` : ' item'}(s) but another group has ${best}`);
          else if (vals.filter((v) => v === best).length > 1) err(`${round.skill}: two groups tie at ${best}; the answer must be strictly the ${how === 'max' ? 'biggest' : 'smallest'}`);
        } else if (round.target !== undefined) warn('"target" is only used by "more" / "fewer" set rounds');
      }
    }

    // duplicates ---------------------------------------------------------------------------
    const sig = canon([T, round.show ?? null, Array.isArray(round.choices) ? round.choices.map(canon).sort() : null, round.words ?? null]);
    if (seenSig.has(sig)) warn(`duplicate question (same as ${seenSig.get(sig)})`);
    else seenSig.set(sig, label);

    row.choices = Array.isArray(round.choices) ? round.choices.length : null;
    row.ok = errors.length === errCount;
    if (row.tier && row.level && row.type) {
      const t = (counts[row.tier] ??= {});
      const l = (t[row.level] ??= {});
      l[row.type] = (l[row.type] || 0) + 1;
    }
  });

  // --- coverage ----------------------------------------------------------------------------
  for (const tier of TIER_IDS) {
    if (!tierIds.has(tier)) continue;
    const t = counts[tier] || {};
    const total = Object.values(t).reduce((n, l) => n + Object.values(l).reduce((a, b) => a + b, 0), 0);
    if (total < LIMITS.minTierRounds) note(`tier "${tier}": only ${total} valid round(s); aim for at least ${LIMITS.minTierRounds} so sessions stay fresh`);
    for (let level = 1; level <= 3; level++) {
      const l = t[level] || {};
      const n = Object.values(l).reduce((a, b) => a + b, 0);
      if (n < LIMITS.minLevelRounds) note(`tier "${tier}" level ${level}: only ${n} round(s); aim for at least ${LIMITS.minLevelRounds}`);
      else if (Object.keys(l).length < 2) note(`tier "${tier}" level ${level}: every round is a ${Object.keys(l)[0]} round; mix at least 2 types`);
    }
    if (isInt(doc.sessionLength) && total && total < doc.sessionLength) note(`tier "${tier}": ${total} round(s) is fewer than sessionLength ${doc.sessionLength}`);
  }

  return { errors, warnings, rows, counts };
}

// =============================================================================================
// CLI

function countsTable(counts) {
  const head = ['tier', 'level', ...ROUND_TYPES, 'total'];
  const body = [];
  const grand = Object.fromEntries(ROUND_TYPES.map((t) => [t, 0]));
  for (const tier of TIER_IDS) {
    const sum = Object.fromEntries(ROUND_TYPES.map((t) => [t, 0]));
    for (let level = 1; level <= 3; level++) {
      const l = (counts[tier] || {})[level] || {};
      const cells = ROUND_TYPES.map((t) => l[t] || 0);
      ROUND_TYPES.forEach((t) => { sum[t] += l[t] || 0; });
      body.push([tier, String(level), ...cells.map(String), String(cells.reduce((a, b) => a + b, 0))]);
    }
    const cells = ROUND_TYPES.map((t) => sum[t]);
    ROUND_TYPES.forEach((t) => { grand[t] += sum[t]; });
    body.push([tier, 'all', ...cells.map(String), String(cells.reduce((a, b) => a + b, 0))]);
  }
  const g = ROUND_TYPES.map((t) => grand[t]);
  body.push(['ALL', '', ...g.map(String), String(g.reduce((a, b) => a + b, 0))]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cols) => cols.map((c, i) => (i < 2 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  return [line(head), line(w.map((x) => '-'.repeat(x))), ...body.map(line)].join('\n');
}

const fmtTok = (t) => (Array.isArray(t) ? `[${t.map(fmtTok).join(' ')}]` : typeof t === 'number' ? String(t) : t);

function listRounds(doc) {
  const out = [];
  for (const r of Array.isArray(doc.rounds) ? doc.rounds : []) {
    if (!isObj(r)) continue;
    const parts = [`${String(r.id).padEnd(9)} ${r.tier}/${r.level} ${String(r.type).padEnd(8)} "${r.say}"`];
    if (Array.isArray(r.show)) parts.push(`show: ${r.show.map(fmtTok).join(' ')}`);
    if (r.target !== undefined) parts.push(`target: ${r.target}`);
    if (Array.isArray(r.choices)) parts.push(`choices: ${r.choices.map(fmtTok).join(' | ')}`);
    if (r.answer !== undefined) parts.push(`answer: ${fmtTok(r.answer)}`);
    if (Array.isArray(r.words)) parts.push(`words: ${r.words.join(' ')}`);
    if (r.rule) parts.push(`rule: ${r.rule}`);
    out.push(parts.join('  |  '));
  }
  return out.join('\n');
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const unknown = [...flags].filter((f) => !['--json', '--list'].includes(f));
  if (unknown.length) {
    console.error(`unknown option(s): ${unknown.join(' ')}\nusage: node tools/validate-machine.mjs [file] [--list] [--json]`);
    return 2;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fileArg = argv.find((a) => !a.startsWith('--'));
  const file = fileArg ? path.resolve(fileArg) : path.join(here, '..', 'data', 'machine', 'rounds.json');

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    console.error(`ERROR ${file}: ${e.code === 'ENOENT' ? 'file not found' : `invalid JSON: ${e.message}`}`);
    return 1;
  }
  const result = validateMachine(doc);
  if (flags.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return result.errors.length ? 1 : 0;
  }
  const rel = path.relative(process.cwd(), file);
  console.log(`Loop Machine rounds: ${rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file}  (${FORMAT}, sessionLength ${doc.sessionLength})\n`);
  console.log(countsTable(result.counts));
  const withHint = result.rows.filter((r) => r.hint).length;
  const withExplain = result.rows.filter((r) => r.explain).length;
  console.log(`\nhints: ${withHint}/${result.rows.length}   explains: ${withExplain}/${result.rows.length}\n`);
  if (flags.has('--list')) console.log(`${listRounds(doc)}\n`);
  for (const w of result.warnings) console.log(`WARNING ${w}`);
  for (const e of result.errors) console.log(`ERROR   ${e}`);
  console.log(`\n${result.rows.length} round(s), ${result.errors.length} error(s), ${result.warnings.length} warning(s)`);
  return result.errors.length ? 1 : 0;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  try { return norm(process.argv[1]) === norm(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (invokedDirectly) process.exitCode = main(process.argv.slice(2));

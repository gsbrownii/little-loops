// Loop Machine — DOM builders for tokens (belt items, answer contents, groups) and a
// canvas text measurer used by the layout. Content strings are only ever set via
// textContent; picture/symbol markup comes from fixed whitelists (tokens.js / art.js).
import { h, fromMarkup } from '../../core/dom.js';
import { tokenKind, tokenSVG, tokenName } from './tokens.js';
import { qmarkSVG, symbolSVG } from './art.js';

let measureCtx = null;
let family = '';

/** Width in px of `str` rendered bold at `px` font size (app font). */
export function textWidth(str, px, weight = 800) {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
    family = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
  }
  if (!measureCtx) return String(str).length * px * 0.6;
  measureCtx.font = `${weight} ${px}px ${family}`;
  return measureCtx.measureText(String(str)).width;
}

/** Display text for numbers/words (real minus sign for negatives). */
export function tokenText(t) {
  if (typeof t === 'number') return t < 0 ? `−${Math.abs(t)}` : String(t);
  return String(t);
}

/** One item on the belt. */
export function beltToken(t) {
  const kind = t === '?' ? 'q' : tokenKind(t);
  if (kind === 'q') {
    return h('div', { class: 'mc-tok mc-qbox', dataset: { kind: 'q' } },
      h('div', { class: 'mc-qmark' }, fromMarkup(qmarkSVG())),
      h('div', { class: 'mc-qfill' }));
  }
  if (kind === 'picture') {
    return h('div', { class: 'mc-tok mc-tok-pic', dataset: { kind, token: t } }, fromMarkup(tokenSVG(t)));
  }
  if (kind === 'symbol') {
    return h('div', { class: 'mc-tok mc-tok-sym', dataset: { kind } }, fromMarkup(symbolSVG(t)));
  }
  const el = h('div', { class: `mc-tok mc-tok-${kind === 'number' ? 'num' : 'word'}`, dataset: { kind } });
  el.append(h('span', { class: 'mc-tok-text' }, tokenText(t)));
  return el;
}

/** A small group of tokens (a 'set' choice). `where` = 'ans' (button) or 'belt' (filled box). */
export function groupEl(tokens, where = 'ans') {
  // Picture-only groups stay on one line: a group split over two rows is hard to compare by size.
  const pics = tokens.length > 0 && tokens.every((t) => tokenKind(t) === 'picture');
  return h('div', { class: `mc-group mc-group-${where}${pics ? ' mc-group-pics' : ''}` }, tokens.map((t) => {
    if (tokenKind(t) === 'picture') return h('span', { class: 'mc-mini mc-mini-pic' }, fromMarkup(tokenSVG(t)));
    return h('span', { class: `mc-mini mc-mini-word${typeof t === 'number' ? ' is-num' : ''}` }, tokenText(t));
  }));
}

/** The inside of an answer button (also flown into the ? box on success). */
export function answerContent(choice) {
  let inner;
  if (Array.isArray(choice)) inner = groupEl(choice, 'ans');
  else if (tokenKind(choice) === 'picture') inner = h('span', { class: 'mc-ans-pic' }, fromMarkup(tokenSVG(choice)));
  else inner = h('span', { class: `mc-ans-text${typeof choice === 'number' ? ' is-num' : ''}` }, tokenText(choice));
  return h('span', { class: 'mc-ans-content' }, inner);
}

/** The answer drawn inside the filled ? box. */
export function filledContent(answer) {
  if (Array.isArray(answer)) return groupEl(answer, 'belt');
  if (tokenKind(answer) === 'picture') return fromMarkup(tokenSVG(answer));
  return h('span', { class: `mc-tok-text${typeof answer === 'number' ? ' is-num' : ''}` }, tokenText(answer));
}

/** Spoken name for a choice ("red circle", "12", "run, jump, swim"). */
export function choiceName(c) {
  return Array.isArray(c) ? c.map(tokenName).join(', ') : tokenName(c);
}

export const isPictureChoice = (c) => (Array.isArray(c) ? c.every((t) => tokenKind(t) === 'picture') : tokenKind(c) === 'picture');

// ---------- belt widths (px) at token size s, matching machine.css ----------

export function beltWidth(t, s) {
  const kind = t === '?' ? 'q' : tokenKind(t);
  if (kind === 'picture') return s;
  if (kind === 'symbol') return Math.round(s * 0.5);
  if (kind === 'number') return Math.max(s * 0.86, textWidth(tokenText(t), s * 0.5, 900) + s * 0.38);
  if (kind === 'word') return Math.max(s * 0.86, textWidth(tokenText(t), s * 0.42, 800) + s * 0.46);
  return s;
}

/** Width of a 'set' group drawn on the belt (inside the filled box) at size s. */
export function groupWidth(tokens, s) {
  const gap = s * 0.06;
  let w = 0;
  for (const t of tokens) {
    w += tokenKind(t) === 'picture' ? s * 0.5 : textWidth(tokenText(t), s * 0.28, 800) + s * 0.26;
  }
  return w + gap * Math.max(0, tokens.length - 1) + s * 0.3;
}

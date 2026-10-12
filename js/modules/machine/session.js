// Loop Machine — a play session (#/machine/<tier>). See docs/ARCHITECTURE.md, "Module spec: Loop Machine".
//
//   meter (one star slot per round)
//   machine: top (funnel, lights, display, gear, dial) / window with the belt / conveyor
//   panel:   answer buttons | word tray (order rounds) | Play again + Machines (end)
//
// Test hooks: .mc-play[data-round-id][data-type][data-state="intro|ready|checking|solved|done"],
// answer buttons .mc-ans[data-choice=<JSON>], order cards .mc-word[data-word], slots .mc-slot[data-slot].
import { h, icon, fromMarkup, flash, prefersReducedMotion } from '../../core/dom.js';
import { draggable } from '../../core/drag.js';
import { RATES } from '../../core/speech.js';
import { storage } from '../../core/storage.js';
import { sameAnswer, tokenKind, isNumberToken, choicesParts, wordsParts } from './tokens.js';
import { buildSession, pushRecent, shuffle, scrambleOrder, loopPeriod, hops, hopLabel } from './rounds.js';
import {
  beltToken, answerContent, filledContent, choiceName, isPictureChoice, beltWidth, groupWidth, textWidth,
} from './view.js';
import { starSVG, trophySVG, funnelSVG, dialSVG, gearSVG, faceSVG, miniStarsSVG } from './art.js';

const STEP_MS = 170; // one belt item sliding in
// Kind words after a wrong answer. Entry 2 points at what to look at, so it follows the round
// type: only pattern rounds show a "loop" (count and set rounds show pictures or an empty box).
const NUDGES = [
  'Hmm, not that one. Try again!',
  'Good try! Pick another one.',
  'Almost! Look again.',
  'Not quite. You can do it!',
  'Ooh, so close! Try a different one.',
];
const NUDGE_LOOK = {
  pattern: 'Almost! Look at the loop again.',
  sequence: 'Almost! Look at the numbers again.',
  count: 'Almost! Count again carefully.',
  set: 'Almost! Look at each group again.',
};
const ORDER_SOME = [
  'The green words are in the right spot! Try the others.',
  'Some words fit! Move the other words around.',
];
const ORDER_NONE = [
  'Hmm, not quite. Try a different order!',
  'Good try! Read it again and swap the words.',
];
const ORDER_MORE = [ // later misses, while the order hint is already on
  'Good try! Here comes another word.',
  'Nice try! Watch the next word hop in.',
  'Almost! Here’s one more word.',
];
// Spoken when a round has no "hint" of its own (the validator only asks for one from level 2).
const HINT_DEFAULT = {
  pattern: 'Here’s a hint! Look at the loop again.',
  sequence: 'Here’s a hint! See how the numbers change.',
  count: 'Here’s a hint! Count each one just once.',
  set: 'Here’s a hint! Look at each group carefully.',
};
const HINT_PLAIN = 'Here’s a hint! Look again carefully.';
const HINT_ORDER = 'Here’s a hint! Watch the next word hop in.';
// Celebration speech: how long to wait for it before the next round, as a safety net for
// engines that never report the end (at the normal rate; slower rates scale it up).
const SAY_BASE_MS = 2000;
const SAY_MS_PER_CHAR = 110;
const SAY_MAX_MS = 30000;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const BREAK = '\n'; // a line break between belt items (never a real token)

export function mountSession(root, ctx, data, tier) {
  const store = ctx.store;
  const reduced = prefersReducedMotion();
  const readAloud = store.get('readAloud', false) === true;
  const littleTier = tier.index === 0;
  const pool = data.byTier[tier.id] || [];
  const session = buildSession(pool, data.sessionLength, store.get(`recent.${tier.id}`, []));
  if (!session.length) {
    ctx.navigate('#/machine', { replace: true });
    return undefined;
  }

  // ---------- lifecycle ----------
  let alive = true;
  const timers = new Set();
  const anims = new Set();
  let roundOffs = [];
  let layoutRaf = 0;
  const ok = () => alive && ctx.isActive();
  const later = (ms) => new Promise((resolve) => {
    const t = setTimeout(() => { timers.delete(t); resolve(); }, ms);
    timers.add(t);
  });
  const after = (ms, fn) => {
    const t = setTimeout(() => { timers.delete(t); if (ok()) fn(); }, ms);
    timers.add(t);
    return t;
  };
  const animate = (el, frames, opts) => {
    if (!el.animate) return null;
    const a = el.animate(frames, opts);
    anims.add(a);
    a.finished.then(() => anims.delete(a), () => anims.delete(a));
    return a;
  };
  const done = (a) => (a ? a.finished.catch(() => {}) : Promise.resolve());
  let lastNudge = -1;
  const pick = (list) => {
    let i;
    do { i = Math.floor(Math.random() * list.length); } while (list.length > 1 && i === lastNudge);
    lastNudge = i;
    return list[i];
  };

  // ---------- state ----------
  const results = [];
  let idx = -1;
  let round = null;
  let rseq = 0;
  let state = 'intro';
  let misses = 0;
  let hintOn = false;
  let items = []; // belt: [{ t, el }]
  let qbox = null;
  let answers = []; // [{ choice, el }]
  let order = null; // order round state
  let fitU = 48; // answer content unit (px)
  let beltS = 64; // belt token size (px)
  let wordFont = 22; // order card font size (px)
  let beltIW = 300; // belt inner width (px)

  // ---------- top bar ----------
  ctx.chrome.setBack({ icon: 'back', to: '#/machine', label: 'All machines' });
  ctx.chrome.setActions([
    h('div', {
      class: 'mc-badge',
      role: 'img',
      'aria-label': `${tier.name} machine`,
      style: { '--n': String(tier.stars) },
    }, fromMarkup(miniStarsSVG(tier.stars))),
  ]);

  // ---------- DOM ----------
  const pips = session.map(() => h('span', { class: 'mc-pip' }, fromMarkup(starSVG('empty'))));
  const meter = h('div', { class: 'mc-meter', 'aria-hidden': 'true' }, pips);

  const face = h('div', { class: 'mc-face' });
  const rule = h('div', { class: 'mc-rule' });
  const display = h('div', { class: 'mc-display' }, face, rule);
  const lights = h('div', { class: 'mc-lights' }, [0, 1, 2, 3].map((i) => h('span', { class: `mc-bulb mc-bulb-${i}` })));
  const top = h('div', { class: 'mc-top' },
    h('div', { class: 'mc-funnel' }, fromMarkup(funnelSVG())),
    lights,
    display,
    h('div', { class: 'mc-gear' }, fromMarkup(gearSVG())),
    h('div', { class: 'mc-dial' }, fromMarkup(dialSVG())));
  const belt = h('div', { class: 'mc-belt' });
  const hopLayer = h('div', { class: 'mc-hops', 'aria-hidden': 'true' });
  const ticketWrap = h('div', { class: 'mc-ticket-wrap' });
  const windowEl = h('div', { class: 'mc-window' }, belt, hopLayer, ticketWrap);
  const rollers = h('div', { class: 'mc-rollers' });
  const conveyor = h('div', { class: 'mc-conveyor', 'aria-hidden': 'true' }, rollers);
  const machine = h('div', { class: 'mc-machine' }, top, windowEl, conveyor);
  const panel = h('div', { class: 'mc-panel' });
  const stage = h('div', { class: 'mc-stage' }, machine, panel);
  const play = h('div', {
    class: 'mc-play',
    dataset: { tier: tier.id, tierIndex: String(tier.index), state: 'intro' },
  }, meter, stage);
  const fx = h('div', { class: 'mc-fx', 'aria-hidden': 'true' });
  root.append(play, fx);

  function setState(s) {
    state = s;
    play.dataset.state = s;
  }

  function setFace(mood) {
    face.replaceChildren(fromMarkup(faceSVG(mood)));
    display.dataset.mood = mood;
  }

  function setRule(text) {
    const long = !!text && text.length > 6;
    rule.textContent = text || '';
    display.classList.toggle('has-rule', !!text);
    rule.classList.toggle('is-long', long);
    machine.classList.toggle('has-long-rule', long);
  }

  // ---------- speech ----------
  function speakChoices(list) {
    if (!list.length) return;
    if (list.some((c) => Array.isArray(c) && isPictureChoice(c))) return; // "which group has more" etc.
    // Parts ("Is it", "lake,", "or cat?") so the voice pack can play a recorded clip for each.
    ctx.say(choicesParts(list), { interrupt: false });
  }

  function liveChoices() {
    return answers.filter((a) => !a.el.disabled).map((a) => a.choice);
  }

  // ---------- rounds ----------
  function clearRound() {
    roundOffs.forEach((off) => off());
    roundOffs = [];
    items = [];
    qbox = null;
    answers = [];
    order = null;
    belt.replaceChildren();
    hopLayer.replaceChildren();
    panel.replaceChildren();
    panel.classList.remove('is-ready', 'is-leaving');
    belt.classList.remove('is-leaving');
    play.classList.remove('is-hint', 'is-solved');
    machine.classList.remove('is-party', 'is-running');
  }

  async function startRound(i) {
    const my = ++rseq;
    const first = idx < 0;
    idx = i;
    round = session[i];
    misses = 0;
    hintOn = false;
    setState('intro');
    pips.forEach((p, k) => p.classList.toggle('is-current', k === i));

    if (!first) {
      // The finished loop rides off to the right.
      ctx.sound.play('whoosh');
      machine.classList.add('is-running');
      belt.classList.add('is-leaving');
      panel.classList.add('is-leaving');
      await later(reduced ? 40 : 360);
      if (!ok() || my !== rseq) return;
    }
    clearRound();
    play.dataset.roundId = round.id;
    play.dataset.type = round.type;
    setFace('idle');
    setRule('');
    store.set(`recent.${tier.id}`, pushRecent(store.get(`recent.${tier.id}`, []), round.id));

    if (round.type === 'order') buildOrder();
    else buildChoices();
    layout();

    // Speech: question (after the tier greeting on the first round), then the choices
    // for the little machine or when the grown-up turned on "read word answers aloud".
    if (first) {
      ctx.instruct(round.say, { speak: false });
      ctx.say(tier.say);
      ctx.say(round.say, { interrupt: false });
    } else {
      ctx.instruct(round.say);
    }
    if (round.type === 'order') {
      if (readAloud) ctx.say(wordsParts(order.cards.map((c) => c.word)), { interrupt: false });
    } else if (littleTier || readAloud) {
      speakChoices(answers.map((a) => a.choice));
    }

    // Belt items slide in one by one.
    machine.classList.add('is-running');
    const incoming = round.type === 'order' ? order.slots.map((s) => s.el) : tokenItems().map((it) => it.el);
    for (const el of incoming) {
      if (!ok() || my !== rseq) return;
      el.classList.add('is-in');
      if (!el.classList.contains('mc-tok-sym')) ctx.sound.play('step');
      await later(reduced ? 20 : STEP_MS);
    }
    await later(reduced ? 20 : 180);
    if (!ok() || my !== rseq) return;
    machine.classList.remove('is-running');
    panel.classList.add('is-ready');
    setState('ready');
  }

  // ---------- choice rounds (pattern / count / sequence / word / set) ----------
  function buildChoices() {
    let show = Array.isArray(round.show) ? round.show.slice() : [];
    if (round.type === 'count') show = show.filter((t) => t !== '?');
    const needBox = round.type === 'count' || !show.includes('?');
    items = show.map((t) => ({ t, el: beltToken(t) }));
    if (needBox) items.push({ t: '?', el: beltToken('?') });
    // "puppy → dog / kitten → ?": put the two pairs on their own lines.
    if (show.length === 6 && show[1] === '→' && show[4] === '→') {
      items.splice(3, 0, { t: BREAK, el: h('div', { class: 'mc-break' }) });
    }
    const q = items.find((it) => it.t === '?');
    qbox = q.el;
    if (round.type === 'count') {
      const badge = h('div', { class: 'mc-qbox-target' }, beltToken(round.target).firstChild);
      qbox.append(badge);
      qbox.classList.add('has-target');
    }
    if (round.type === 'set') qbox.classList.add('is-set');
    belt.append(...items.map((it) => it.el));

    const choices = shuffle(round.choices);
    const kind = contentKind(choices);
    answers = choices.map((choice, k) => {
      const el = h('button', {
        class: `mc-ans is-${kind}`,
        type: 'button',
        dataset: { choice: JSON.stringify(choice) },
        'aria-label': choiceName(choice),
        style: { '--i': String(k) },
      }, answerContent(choice));
      const a = { choice, el };
      const off = draggable(el, {
        ghost: () => {
          const g = el.cloneNode(true);
          g.classList.remove('is-pressed');
          g.style.setProperty('--u', `${fitU}px`);
          return g;
        },
        onTap: () => choose(a),
        onStart: () => { if (state === 'ready') ctx.sound.play('pick'); },
        onMove: ({ over }) => qbox && qbox.classList.toggle('is-target', state === 'ready' && overMachine(over)),
        onDrop: ({ over }) => {
          if (qbox) qbox.classList.remove('is-target');
          if (overMachine(over)) choose(a, true);
        },
        onCancel: () => qbox && qbox.classList.remove('is-target'),
      });
      const key = (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        choose(a);
      };
      el.addEventListener('keydown', key);
      roundOffs.push(() => { off(); el.removeEventListener('keydown', key); });
      return a;
    });
    panel.append(h('div', { class: 'mc-answers', dataset: { kind, n: String(answers.length) } }, answers.map((a) => a.el)));
  }

  const overMachine = (over) => !!over && machine.contains(over);
  const tokenItems = () => items.filter((it) => it.t !== BREAK);

  function contentKind(choices) {
    if (choices.some((c) => Array.isArray(c))) return 'set';
    if (choices.every((c) => tokenKind(c) === 'picture')) return 'pic';
    return 'text';
  }

  function choose(a, dropped = false) {
    if (state !== 'ready' || a.el.disabled) return;
    if (sameAnswer(a.choice, round.answer)) solve(a, dropped);
    else miss(a);
  }

  function miss(a) {
    misses++;
    a.el.disabled = true;
    a.el.classList.add('is-wrong');
    // Web Animations, not a CSS class: swapping the CSS `animation` would replay the pop-in entrance.
    if (!reduced) {
      animate(a.el, [0, -6, 6, -4, 3, 0].map((deg) => ({ transform: `translateY(4px) rotate(${deg}deg)` })),
        { duration: 500, easing: 'ease-in-out' });
    }
    ctx.sound.play('tryAgain');
    setFace('think');
    after(1300, () => { if (state === 'ready') setFace(hintOn ? 'hint' : 'idle'); });
    // The hint comes while it can still help: once only two answers are left (after 2 misses
    // with 4 choices, after the first miss with 3), never later than the 2nd miss. With one
    // answer left there is nothing to reason about, so a 2-choice round just gets a nudge.
    const live = liveChoices().length;
    if (!hintOn && live >= 2 && (misses >= 2 || live === 2)) showHint();
    else {
      const n = pick(NUDGES);
      ctx.say(n === NUDGES[2] && live >= 2 ? NUDGE_LOOK[round.type] || n : n);
    }
  }

  function showHint() {
    hintOn = true;
    play.classList.add('is-hint');
    setFace('hint');
    setRule(round.ruleLabel || '');
    ctx.sound.play('unlock');
    ctx.say(round.hint || HINT_DEFAULT[round.type] || HINT_PLAIN);

    if (round.type === 'pattern') {
      const toks = tokenItems();
      const full = toks.map((it) => (it.t === '?' ? round.answer : it.t));
      const p = loopPeriod(full);
      if (p) toks.slice(0, p).forEach((it) => it.el.classList.add('is-unit'));
    } else if (round.type === 'count') {
      items.forEach((it) => {
        if (it.t === round.target) it.el.classList.add('is-target-item');
        else if (it.t !== '?') it.el.classList.add('is-other-item');
      });
    }
    drawHintMarks();
    // While the hint shows, the two answers still in play are read aloud too.
    speakChoices(liveChoices());
  }

  async function solve(a, dropped) {
    const my = rseq;
    setState('solved');
    const gold = misses === 0;
    results[idx] = gold ? 'gold' : 'silver';
    a.el.classList.add('is-right');
    answers.forEach((x) => { if (x !== a) x.el.classList.add('is-dim'); });
    ctx.sound.play(dropped ? 'drop' : 'pick');
    // A dragged answer was let go right on the box: it lands there (no second flight from the button).
    if (!dropped) await flyInto(a.el.querySelector('.mc-ans-content'), qbox);
    if (!ok() || my !== rseq) return;
    qbox.querySelector('.mc-qfill').replaceChildren(filledContent(round.answer));
    qbox.classList.add('is-filled');
    sizeSetBox();
    flash(qbox, 'mc-pop', 500);
    await celebrateRound(my, gold, [round.explain || ctx.praise()]);
  }

  async function celebrateRound(my, gold, lines) {
    play.classList.add('is-solved');
    machine.classList.add('is-party');
    setFace('happy');
    const loopEls = round.type === 'order' ? order.slots.map((s) => s.el) : tokenItems().map((it) => it.el);
    loopEls.forEach((el, k) => {
      el.style.setProperty('--k', String(k));
      el.classList.add('is-looping');
    });
    const cel = ctx.celebrate();
    // The first line interrupts, the rest queue; `said` resolves when the LAST one ends (at once
    // when speech is off or unsupported). The next round's question would cut the explain off,
    // so wait for all of it. The cap is only a safety net, sized to the text and the voice speed.
    const spoken = lines.filter(Boolean).map(String);
    let said = Promise.resolve(false);
    spoken.forEach((line, k) => { said = ctx.say(line, { interrupt: k === 0 }); });
    const chars = spoken.reduce((n, l) => n + l.length, 0);
    const r = RATES[storage.get('settings.rate', 'normal')];
    const rate = typeof r === 'number' && r > 0 ? r : RATES.normal;
    const cap = Math.min(SAY_MAX_MS, Math.round((SAY_BASE_MS + SAY_MS_PER_CHAR * chars) * (RATES.normal / rate)));
    await later(reduced ? 100 : 450);
    if (!ok() || my !== rseq) return;
    dropStar(idx, gold);
    await Promise.all([cel, Promise.race([said, later(cap)]), later(reduced ? 900 : 1900)]);
    if (!ok() || my !== rseq) return;
    if (idx + 1 < session.length) startRound(idx + 1);
    else finish();
  }

  async function flyInto(src, dst) {
    if (!src || !dst || reduced) return;
    const r1 = src.getBoundingClientRect();
    const r2 = dst.getBoundingClientRect();
    if (!r1.width || !r2.width) return;
    const ghost = src.cloneNode(true);
    ghost.classList.add('mc-flyer');
    Object.assign(ghost.style, { left: `${r1.left}px`, top: `${r1.top}px`, width: `${r1.width}px`, height: `${r1.height}px` });
    ghost.style.setProperty('--u', `${fitU}px`);
    fx.append(ghost);
    const dx = r2.left + r2.width / 2 - (r1.left + r1.width / 2);
    const dy = r2.top + r2.height / 2 - (r1.top + r1.height / 2);
    const sc = clamp(Math.min(r2.width / r1.width, r2.height / r1.height) * 0.95, 0.3, 1.4);
    const a = animate(ghost, [
      { transform: 'translate(0, 0) scale(1)' },
      { transform: `translate(${dx * 0.55}px, ${dy * 0.55 - 50}px) scale(${(1 + sc) * 0.6})`, offset: 0.55 },
      { transform: `translate(${dx}px, ${dy}px) scale(${sc})` },
    ], { duration: 460, easing: 'cubic-bezier(.4,0,.3,1)', fill: 'forwards' });
    await done(a);
    ghost.remove();
  }

  function dropStar(i, gold) {
    const pip = pips[i];
    if (!pip) return;
    pip.replaceChildren(fromMarkup(starSVG(gold ? 'gold' : 'silver')));
    pip.classList.remove('is-current');
    pip.classList.add('is-earned', gold ? 'is-gold' : 'is-silver');
    ctx.sound.play('drop');
  }

  /**
   * Hint marks drawn over the belt (in the window's coordinates, from layout offsets so the
   * pulsing ? box doesn't drag them around): a bracket over one repeat of a picture loop, or
   * hop arrows between numbers labelled with the step.
   */
  function drawHintMarks() {
    hopLayer.replaceChildren();
    if (!hintOn || !round) return;
    if (round.type === 'pattern') drawBracket();
    else if (round.type === 'sequence') drawHops();
  }

  /** Layout box of a belt item relative to the belt (= the window; transforms ignored). */
  const boxOf = (el) => ({ l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });

  function drawBracket() {
    const unit = tokenItems().filter((it) => it.el.classList.contains('is-unit'));
    const rows = [];
    for (const it of unit) {
      const b = boxOf(it.el);
      const last = rows[rows.length - 1];
      if (last && Math.abs(last.t - b.t) < 4) last.r = b.l + b.w;
      else rows.push({ t: b.t, l: b.l, r: b.l + b.w });
    }
    const hh = Math.max(8, Math.round(beltS * 0.16));
    const lift = Math.max(3, Math.round(beltS * 0.07));
    rows.forEach((row, k) => {
      const cls = `mc-bracket${k === 0 ? ' is-start' : ''}${k === rows.length - 1 ? ' is-end' : ''}`;
      hopLayer.append(h('div', {
        class: cls,
        style: { left: `${row.l + 4}px`, width: `${Math.max(8, row.r - row.l - 8)}px`, top: `${row.t - hh - lift}px`, height: `${hh}px` },
      }));
    });
  }

  function drawHops() {
    const nums = items.filter((it) => isNumberToken(it.t) || it.t === '?');
    const steps = hops(nums.map((it) => (it.t === '?' ? null : it.t)));
    for (let k = 0; k < steps.length; k++) {
      const a = boxOf(nums[k].el);
      const b = boxOf(nums[k + 1].el);
      if (Math.abs(a.t - b.t) > 4 || b.l < a.l) continue; // different rows
      const x1 = a.l + a.w / 2;
      const x2 = b.l + b.w / 2;
      const hh = Math.max(14, beltS * 0.3);
      const y = a.t + 2;
      const w = x2 - x1;
      const svg = fromMarkup(`<svg class="mc-hop" viewBox="0 0 ${w.toFixed(1)} ${hh.toFixed(1)}" preserveAspectRatio="none" style="left:${x1.toFixed(1)}px;top:${(y - hh).toFixed(1)}px;width:${w.toFixed(1)}px;height:${hh.toFixed(1)}px"><path d="M3 ${hh - 1} Q${w / 2} ${-hh * 0.7} ${w - 3} ${hh - 1}" fill="none" stroke="#FF9F1C" stroke-width="4" stroke-linecap="round"/><path d="M${w - 3} ${hh - 1} l-9 -4 M${w - 3} ${hh - 1} l-2 -9" fill="none" stroke="#FF9F1C" stroke-width="4" stroke-linecap="round"/></svg>`);
      hopLayer.append(svg);
      const unknown = nums[k].t === '?' || nums[k + 1].t === '?';
      const label = unknown ? '?' : hopLabel(steps[k]);
      if (label) {
        hopLayer.append(h('span', {
          class: `mc-hop-label${unknown ? ' is-q' : ''}`,
          style: { left: `${(x1 + x2) / 2}px`, top: `${y - hh * 0.62}px` },
        }, label));
      }
    }
  }

  // ---------- order rounds ----------
  function buildOrder() {
    const words = round.words;
    const perm = scrambleOrder(words);
    order = { words, slots: [], cards: [], plan: null, tray: null, trayOrder: perm.map((_, k) => k) };
    order.slots = words.map((_, i) => {
      const el = h('div', { class: 'mc-slot', dataset: { slot: String(i) } });
      return { el, card: null };
    });
    belt.append(...order.slots.map((s) => s.el));
    const tray = h('div', { class: 'mc-tray' });
    order.tray = tray;
    order.cards = perm.map((w, k) => {
      const home = h('div', { class: 'mc-home', style: { '--i': String(k) } });
      const el = h('button', {
        class: 'mc-word',
        type: 'button',
        dataset: { word: words[w] },
        'aria-label': words[w],
      }, h('span', { class: 'mc-word-text' }, words[w]));
      home.append(el);
      tray.append(home);
      const c = { word: words[w], el, home, slot: null, locked: false, last: 0, anim: null };
      const off = draggable(el, {
        ghost: () => {
          const g = el.cloneNode(true);
          g.classList.remove('is-pressed');
          g.style.setProperty('--wf', `${wordFont}px`);
          return g;
        },
        onTap: () => tapWord(c),
        onStart: () => { if (state === 'ready') ctx.sound.play('pick'); },
        onMove: ({ over }) => markSlot(state === 'ready' ? slotUnder(over) : null),
        onDrop: ({ over }) => { markSlot(null); dropWord(c, over); },
        onCancel: () => markSlot(null),
      });
      const key = (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        tapWord(c);
      };
      el.addEventListener('keydown', key);
      roundOffs.push(() => { off(); el.removeEventListener('keydown', key); });
      return c;
    });
    panel.append(tray);
  }

  function slotUnder(over) {
    const el = over && over.closest ? over.closest('.mc-slot') : null;
    if (!el || !belt.contains(el)) return null;
    return order.slots[Number(el.dataset.slot)] || null;
  }

  function markSlot(slot) {
    if (!order) return;
    order.slots.forEach((s) => s.el.classList.toggle('is-drop', s === slot && !(s.card && s.card.locked)));
  }

  const firstEmpty = () => order.slots.findIndex((s) => !s.card);

  /**
   * Move card elements to new parents with a FLIP animation. All cards are measured first and
   * re-parented together, so a swap animates both words from where they really were.
   * moves: [{ c, parent, bounce }]
   */
  function moveCards(moves) {
    const before = moves.map((m) => m.c.el.getBoundingClientRect());
    moves.forEach((m) => {
      if (m.c.anim) m.c.anim.cancel();
      m.c.anim = null;
      m.parent.append(m.c.el);
    });
    sizeSlots();
    if (reduced) return;
    moves.forEach((m, k) => {
      const afterR = m.c.el.getBoundingClientRect();
      const dx = before[k].left - afterR.left;
      const dy = before[k].top - afterR.top;
      if (!dx && !dy) return;
      m.c.anim = animate(m.c.el, m.bounce ? [
        { transform: `translate(${dx}px, ${dy}px)` },
        { transform: `translate(${dx * 0.4}px, ${dy * 0.4 - 30}px) rotate(-6deg)`, offset: 0.45 },
        { transform: 'translate(0, 0)' },
      ] : [
        { transform: `translate(${dx}px, ${dy}px) scale(1.06)` },
        { transform: 'translate(0, 0) scale(1)' },
      ], { duration: m.bounce ? 420 : 260, easing: 'cubic-bezier(.3,.7,.4,1)' });
    });
  }

  /**
   * The slot model, in one place: card c now sits in slot i (or in the tray when i is null).
   * The slot it leaves is cleared only if it still holds c — during a swap the other card may
   * already have moved in.
   */
  function assign(c, i) {
    const old = c.slot != null ? order.slots[c.slot] : null;
    if (old && old.card === c) {
      old.card = null;
      old.el.classList.remove('is-full');
    }
    c.slot = i;
    if (i != null) {
      order.slots[i].card = c;
      order.slots[i].el.classList.add('is-full');
    }
  }

  function putInSlot(c, i) {
    assign(c, i);
    moveCards([{ c, parent: order.slots[i].el }]);
  }

  function sendHome(c, bounce = false) {
    assign(c, null);
    moveCards([{ c, parent: c.home, bounce }]);
  }

  function tapWord(c) {
    if (state !== 'ready' || c.locked) return;
    const now = performance.now();
    if (now - c.last < 260) return; // a double tap is one tap
    c.last = now;
    if (c.slot == null) {
      const s = firstEmpty();
      if (s < 0) return;
      ctx.sound.play('drop');
      putInSlot(c, s);
    } else {
      ctx.sound.play('remove');
      sendHome(c);
    }
    afterOrderChange();
  }

  function dropWord(c, over) {
    if (state !== 'ready' || c.locked) return;
    c.last = performance.now();
    const slot = slotUnder(over);
    if (slot && !(slot.card && slot.card.locked)) {
      const i = order.slots.indexOf(slot);
      const other = slot.card;
      if (other !== c) {
        const from = c.slot;
        if (other && from != null) {
          // Two placed words trade places.
          assign(other, from);
          assign(c, i);
          moveCards([{ c: other, parent: order.slots[from].el }, { c, parent: slot.el }]);
        } else {
          if (other) sendHome(other);
          putInSlot(c, i);
        }
      }
      ctx.sound.play('drop');
      afterOrderChange();
      return;
    }
    if (over && machine.contains(over) && c.slot == null) {
      const s = firstEmpty();
      if (s >= 0) {
        ctx.sound.play('drop');
        putInSlot(c, s);
        afterOrderChange();
      }
      return;
    }
    if (over && panel.contains(over) && c.slot != null) {
      ctx.sound.play('remove');
      sendHome(c);
      afterOrderChange();
    }
  }

  function afterOrderChange() {
    if (firstEmpty() >= 0) return;
    setState('checking');
    const my = rseq;
    after(reduced ? 60 : 420, () => { if (my === rseq) checkOrder(); });
  }

  function lockCard(c) {
    c.locked = true;
    c.el.setAttribute('aria-disabled', 'true');
    c.el.classList.add('is-locked');
    order.slots[c.slot].el.classList.add('is-locked');
  }

  function checkOrder() {
    const right = order.slots.every((s, i) => s.card && s.card.word === order.words[i]);
    if (right) {
      solveOrder();
      return;
    }
    misses++;
    order.slots.forEach((s, i) => {
      if (s.card && !s.card.locked && s.card.word === order.words[i]) lockCard(s.card);
    });
    const back = order.slots.filter((s) => s.card && !s.card.locked).map((s) => s.card);
    ctx.sound.play('tryAgain');
    setFace('think');
    const my = rseq;
    const stagger = reduced ? 0 : 70;
    back.forEach((c, k) => after(k * stagger, () => { if (my === rseq && !c.locked) sendHome(c, true); }));
    const anyLocked = order.slots.some((s) => s.card && s.card.locked);
    if (misses < 2) ctx.say(pick(anyLocked ? ORDER_SOME : ORDER_NONE));
    // Editing opens again once every word is back in the tray (so a quick tap can't race the bounce).
    after(back.length * stagger, () => {
      if (my !== rseq || state !== 'checking') return;
      setState('ready');
      if (misses >= 2) after(reduced ? 50 : 450, () => { if (my === rseq) hintOrder(); });
      else after(1300, () => { if (state === 'ready') setFace('idle'); });
    });
  }

  /** Hint: the next correct word hops into its place by itself (again after every later miss). */
  function hintOrder() {
    if (state !== 'ready' || !order) return;
    if (!hintOn) {
      hintOn = true;
      play.classList.add('is-hint');
      ctx.say(round.hint || HINT_ORDER);
    } else {
      ctx.say(pick(ORDER_MORE));
    }
    setFace('hint');
    ctx.sound.play('unlock');
    const i = order.slots.findIndex((s) => !(s.card && s.card.locked));
    if (i < 0) return;
    const want = order.words[i];
    const c = order.cards.find((x) => !x.locked && x.word === want && x.slot == null)
      || order.cards.find((x) => !x.locked && x.word === want);
    if (!c) return;
    const occupant = order.slots[i].card;
    if (occupant && occupant !== c) sendHome(occupant);
    putInSlot(c, i);
    lockCard(c);
    flash(c.el, 'mc-pop', 500);
    afterOrderChange();
  }

  async function solveOrder() {
    const my = rseq;
    setState('solved');
    const gold = misses === 0;
    results[idx] = gold ? 'gold' : 'silver';
    order.cards.forEach((c) => { if (!c.locked) lockCard(c); });
    // Read the finished sentence back, then the explanation or a cheer.
    await celebrateRound(my, gold, [order.words.join(' '), round.explain || ctx.praise()]);
  }

  // ---------- end of session ----------
  async function finish() {
    const my = ++rseq;
    setState('done');
    clearRound();
    delete play.dataset.roundId;
    play.dataset.type = 'end';
    play.classList.add('is-done');
    pips.forEach((p) => p.classList.remove('is-current'));
    setFace('happy');
    setRule('');

    const golds = results.filter((r) => r === 'gold').length;
    const silvers = results.filter((r) => r === 'silver').length;
    const prevRaw = Number(store.get(`best.${tier.id}`, 0));
    const prev = Number.isFinite(prevRaw) ? prevRaw : 0;
    const newBest = golds > prev;
    if (newBest) store.set(`best.${tier.id}`, golds);
    play.dataset.gold = String(golds);
    play.dataset.silver = String(silvers);

    const row = (kind, n) => h('div', { class: `mc-ticket-row is-${kind}` },
      h('span', { class: 'mc-ticket-star' }, fromMarkup(starSVG(kind))),
      h('span', { class: 'mc-ticket-n' }, String(n)));
    const ticket = h('div', { class: 'mc-ticket', role: 'img', 'aria-label': `${golds} gold stars, ${silvers} silver stars` },
      h('div', { class: 'mc-ticket-rows' }, row('gold', golds), silvers ? row('silver', silvers) : null),
      newBest ? h('div', { class: 'mc-ticket-best' }, fromMarkup(trophySVG())) : null);
    ticketWrap.replaceChildren(h('div', { class: 'mc-slotbar' }), ticket);

    const again = h('button', { class: 'mc-end-btn mc-again', type: 'button', 'aria-label': 'Play again' }, icon('retry'));
    const machinesBtn = h('button', { class: 'mc-end-btn mc-machines', type: 'button', 'aria-label': 'All machines' }, icon('grid'));
    again.addEventListener('click', () => { ctx.sound.play('tap'); ctx.navigate(`#/machine/${encodeURIComponent(tier.id)}`); });
    machinesBtn.addEventListener('click', () => { ctx.sound.play('tap'); ctx.navigate('#/machine'); });
    panel.append(h('div', { class: 'mc-endbtns' }, again, machinesBtn));
    layout();

    const plural = (n, w) => `${n} ${w} star${n === 1 ? '' : 's'}`;
    const line = golds && silvers
      ? `You earned ${plural(golds, 'gold')} and ${plural(silvers, 'silver')}!`
      : golds ? `You earned ${plural(golds, 'gold')}!` : `You earned ${plural(silvers, 'silver')}!`;
    ctx.instruct(line);
    if (newBest) ctx.say('That’s your best score ever!', { interrupt: false });
    ctx.say('Play again, or pick a machine.', { interrupt: false });

    // The machine "prints" the prize ticket.
    machine.classList.add('is-party', 'is-printing');
    ctx.celebrate({ big: true });
    const steps = reduced ? 1 : 5;
    for (let k = 1; k <= steps; k++) {
      ticket.style.setProperty('--print', String(k / steps));
      ctx.sound.play('step');
      await later(reduced ? 10 : 150);
      if (!ok() || my !== rseq) return;
    }
    machine.classList.remove('is-printing');
    panel.classList.add('is-ready');
  }

  // ---------- layout ----------
  function scheduleLayout() {
    if (!layoutRaf) layoutRaf = requestAnimationFrame(() => { layoutRaf = 0; layout(); });
  }

  /** Machine part sizes from its width and (expected) height. */
  function machineDims(Mw, Mh, decor) {
    const m = Math.min(Mw, Mh);
    const P = Math.round(clamp(m * 0.035, 6, 14));
    const T = decor ? Math.round(clamp(Mh * 0.17, 30, 64)) : 0;
    const Tg = decor ? Math.round(P * 0.6) : 0;
    const C = Math.round(clamp(Mh * 0.07, 12, 26));
    const Wp = Math.round(clamp(m * 0.025, 6, 12));
    return { P, T, Tg, C, Wp, chrome: 2 * P + T + Tg + C };
  }

  function applyMachine(Mw, Mh, d) {
    machine.style.width = `${Math.floor(Mw)}px`;
    machine.style.height = `${Math.floor(Mh)}px`;
    machine.style.setProperty('--P', `${d.P}px`);
    machine.style.setProperty('--T', `${d.T}px`);
    machine.style.setProperty('--Tg', `${d.Tg}px`);
    machine.style.setProperty('--C', `${d.C}px`);
    machine.style.setProperty('--Wp', `${d.Wp}px`);
    machine.classList.toggle('no-top', !d.T);
    // Optional parts drop out when the top row gets crowded.
    const room = (Mw - 2 * d.P) / Math.max(1, d.T);
    machine.classList.toggle('no-gear', room < 7.2);
    machine.classList.toggle('no-dial', room < 6.2);
    machine.classList.toggle('no-funnel', room < 4.6);
    const n = Math.max(3, Math.floor((Mw - 2 * d.P) / (d.C * 1.5)));
    if (rollers.childElementCount !== n) {
      rollers.replaceChildren(...Array.from({ length: n }, () => h('span', { class: 'mc-roller' })));
    }
  }

  function layout() {
    if (!ok()) return;
    const cs = getComputedStyle(play);
    const W = play.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const H = play.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (W <= 0 || H <= 0) return;
    const land = W > H * 1.12;
    // Short landscape (phones on their side): the star meter stands up along the left edge,
    // so every pixel of height goes to the machine and the answers.
    const side = land && H < 480;
    play.classList.toggle('is-landscape', land);
    play.classList.toggle('is-side-meter', side);
    const g = Math.round(clamp(Math.min(W, H) * 0.028, 8, 20));
    const n = pips.length;
    const pg = n > 12 ? 2 : 4;
    play.style.setProperty('--g', `${g}px`);
    play.style.setProperty('--pg', `${pg}px`);
    let avW = W;
    let avH;
    if (side) {
      const pip = Math.max(8, Math.min(30, Math.floor((H - (n - 1) * pg) / n)));
      play.style.setProperty('--pip', `${pip}px`);
      play.style.setProperty('--meter-h', `${pip}px`);
      avW = W - pip - g;
      avH = H;
    } else {
      const meterH = Math.round(clamp(H * (land ? 0.075 : 0.05), 18, 34));
      const pip = Math.min(meterH, Math.floor((W - (n - 1) * pg) / n));
      play.style.setProperty('--meter-h', `${meterH}px`);
      play.style.setProperty('--pip', `${Math.max(8, pip)}px`);
      avH = H - meterH - g;
    }
    if (state === 'done') layoutEnd(avW, avH, land, g);
    else if (round && round.type === 'order') layoutOrder(avW, avH, land, g);
    else if (round) layoutChoices(avW, avH, land, g);
    if (hintOn) drawHintMarks();
  }

  // Answer buttons: try each column count, measure the biggest content that fits.
  function fitAnswers(Aw, AhMax, land) {
    const box = panel.querySelector('.mc-answers');
    const kind = box.dataset.kind;
    const n = answers.length;
    const ag = Math.round(clamp(Aw * 0.035, 8, 16));
    const maxBtnH = land ? Math.min(170, AhMax) : Math.min(160, Math.max(84, AhMax * 0.5));
    box.style.setProperty('--ag', `${ag}px`);
    box.style.width = `${Math.floor(Aw)}px`;
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const btnW = Math.floor((Aw - (cols - 1) * ag) / cols);
      if (btnW < 64) break;
      const roomH = Math.floor((AhMax - (rows - 1) * ag) / rows);
      const fits = roomH >= 72;
      const btnH = Math.max(72, Math.min(maxBtnH, roomH));
      box.style.setProperty('--bw', `${btnW}px`);
      box.style.setProperty('--bh', `${btnH}px`);
      const u = measureU(box, btnH);
      // Fewer rows leave more room for the machine (portrait). A 'set' reads best as one
      // group per line, so one wide column wins whenever it fits.
      let score = (fits ? 1000 : 0) + u * (land ? 1 : 1 - 0.07 * (rows - 1));
      if (kind === 'set' && cols === 1 && fits && u >= 44) score += 500;
      if (!best || score > best.score + 0.5) best = { cols, rows, btnW, btnH, u, score };
    }
    // Trim spare height (never below what the content needs, never below 72px).
    box.style.setProperty('--bw', `${best.btnW}px`);
    box.style.setProperty('--bh', `${best.btnH}px`);
    box.style.setProperty('--u', `${best.u}px`);
    const innerH = Math.max(0, ...[...box.querySelectorAll('.mc-ans-content')].map((c) => c.firstElementChild?.offsetHeight || 0));
    const want = Math.max(innerH + 12 + best.u * 0.14, best.u * 0.95);
    const btnH = Math.max(72, Math.min(best.btnH, Math.ceil(want)));
    box.style.setProperty('--bh', `${btnH}px`);
    fitU = best.u;
    box.dataset.cols = String(best.cols);
    return { h: best.rows * btnH + (best.rows - 1) * ag, w: Aw };
  }

  function measureU(box, btnH) {
    const contents = [...box.querySelectorAll('.mc-ans-content')];
    const fitsAt = (u) => {
      box.style.setProperty('--u', `${u}px`);
      // Layout sizes (not rects: the buttons may be mid pop-in animation).
      return contents.every((c) => {
        const inner = c.firstElementChild;
        if (!inner) return true;
        const w = Math.max(inner.offsetWidth, inner.scrollWidth);
        const hh = Math.max(inner.offsetHeight, inner.scrollHeight);
        return w <= c.clientWidth + 0.5 && hh <= c.clientHeight + 0.5;
      });
    };
    let lo = 16;
    // A picture group ("which group has more?") draws its pictures at 0.44u on one line, so u may
    // outgrow the button height; fitsAt() below still proves the row fits the button.
    const picSet = box.dataset.kind === 'set' && !box.querySelector('.mc-mini-word');
    let hi = Math.max(lo, (btnH - 10) * (picSet ? 1.6 : 1));
    if (fitsAt(hi)) return hi;
    if (!fitsAt(lo)) return lo;
    while (hi - lo > 1.5) {
      const mid = (lo + hi) / 2;
      if (fitsAt(mid)) lo = mid; else hi = mid;
    }
    return Math.floor(lo);
  }

  function layoutChoices(W, avH, land, g) {
    const kind = panel.querySelector('.mc-answers')?.dataset.kind || 'text';
    let Mw;
    let Mh;
    if (!land) {
      const AhMax = Math.round(avH * (kind === 'set' ? 0.52 : 0.44));
      const a = fitAnswers(W, AhMax, false);
      panel.style.width = `${Math.floor(W)}px`;
      panel.style.height = `${Math.ceil(a.h)}px`;
      Mw = W;
      Mh = Math.min(avH - a.h - g, Math.max(W * 0.86, 240));
    } else {
      // A picture 'set' ("which group has more?") with only the ? box on the belt: the machine
      // needs little room, the rows of pictures to count need it more.
      const picSet = kind === 'set' && tokenItems().length <= 1 && round.choices.every(isPictureChoice);
      const frac = picSet ? 0.56 : kind === 'set' ? 0.46 : kind === 'text' ? 0.42 : 0.36;
      const Aw = Math.round(clamp(W * frac, 200, 540));
      const a = fitAnswers(Aw, avH, true);
      panel.style.width = `${Aw}px`;
      panel.style.height = `${Math.ceil(a.h)}px`;
      Mw = W - Aw - g;
      Mh = Math.min(avH, Math.max(Mw * 0.62, 200));
    }
    let d = machineDims(Mw, Mh, true);
    if (Mh - d.chrome < 72) d = machineDims(Mw, Mh, false);
    applyMachine(Mw, Mh, d);
    fitBelt(d);
  }

  /**
   * Width of the ? box: big enough for any choice (so its size gives nothing away).
   * A 'set' box starts square and grows to fit the group once it is filled.
   */
  function qWidth(s) {
    if (!round || !Array.isArray(round.choices)) return s;
    if (round.type === 'set') {
      return qbox && qbox.classList.contains('is-filled') ? Math.min(beltIW * 0.9, groupWidth(round.answer, s)) : s;
    }
    let w = s;
    for (const c of round.choices) {
      const cw = Array.isArray(c) ? groupWidth(c, s) : beltWidth(c, s);
      w = Math.max(w, cw);
    }
    return w;
  }

  function fitBelt(d) {
    const iw = windowEl.clientWidth - 2 * d.Wp;
    const ih = windowEl.clientHeight - 2 * d.Wp;
    if (iw <= 0 || ih <= 0 || !items.length) return;
    beltIW = iw;
    const loop = round.type === 'pattern' || round.type === 'sequence';
    const extra = loop ? 0.36 : 0.06;
    const breaks = items.filter((it) => it.t === BREAK).length;
    const widthOf = (it, s) => (it.t === BREAK ? 0 : it.t === '?' ? Math.min(iw, qWidth(s)) : beltWidth(it.t, s));
    const packRows = (s) => {
      const gap = Math.max(4, s * 0.12);
      let rows = 1;
      let x = 0;
      for (const it of items) {
        if (it.t === BREAK) { if (x > 0) { rows++; x = 0; } continue; }
        const w = widthOf(it, s);
        if (w > iw + 0.5) return Infinity;
        if (x > 0 && x + gap + w > iw) { rows++; x = w; } else x += (x > 0 ? gap : 0) + w;
      }
      return rows;
    };
    // (+ a little room so the pulsing ? box never touches the window edge)
    const heightOf = (rows, s) => rows * s * (1 + extra) + (rows - 1 + breaks) * s * 0.14 + s * 0.08;
    const cap = Math.min(round.type === 'set' ? 120 : 132, ih / (1 + extra));
    const search = (maxRows) => {
      const okAt = (s) => {
        const r = packRows(s);
        return r <= maxRows && heightOf(r, s) <= ih;
      };
      let lo = 14;
      let hi = cap;
      if (okAt(hi)) return hi;
      if (!okAt(lo)) return 0;
      while (hi - lo > 0.75) {
        const mid = (lo + hi) / 2;
        if (okAt(mid)) lo = mid; else hi = mid;
      }
      return lo;
    };
    // One row reads best as a loop (or a little equation like "sun + flower = ?"); wrap only
    // when one row would be much smaller.
    const s1 = breaks ? 0 : search(1);
    const many = items.length > 10 ? 3 : 2 + breaks;
    const sW = search(many) || search(8) || 14;
    const few = tokenItems().length <= 5;
    const oneRow = s1 && (s1 >= 76 || (s1 >= 46 && s1 >= sW * (loop ? 0.66 : few ? 0.55 : 0.8)) || (few && s1 >= 40));
    const s = Math.floor(oneRow ? s1 : sW);
    beltS = s;
    windowEl.style.setProperty('--s', `${s}px`);
    windowEl.style.setProperty('--cg', `${Math.max(4, Math.floor(s * 0.12))}px`);
    windowEl.style.setProperty('--rg', `${Math.floor(s * 0.14)}px`);
    windowEl.style.setProperty('--extra', `${Math.floor(s * extra)}px`);
    for (const it of items) if (it.t !== BREAK) it.el.style.width = `${Math.floor(widthOf(it, s))}px`;
    sizeSetBox();
  }

  /** A filled 'set' box widens for its group, which stays on one line (scaled down if needed). */
  function sizeSetBox() {
    if (!round || round.type !== 'set' || !qbox || !qbox.classList.contains('is-filled')) return;
    const room = beltIW * 0.9;
    const gw = groupWidth(round.answer, beltS);
    const k = Math.min(1, room / gw);
    const gs = beltS * k;
    qbox.style.setProperty('--gs', `${gs.toFixed(1)}px`);
    qbox.style.width = `${Math.floor(Math.min(room, gw))}px`;
    // ...and only as tall as the group needs (no big empty frame around a small line of words).
    qbox.style.height = `${Math.round(clamp(gs * 0.95, beltS * 0.5, beltS))}px`;
  }

  // ---------- order layout: sentence slots flow like text; the tray keeps each word's home ----------
  const ORDER_GAP = 8;
  const wordW = (w, f) => Math.max(64, Math.ceil(textWidth(w, f, 800) + f + 12));
  const cardH = (f) => Math.max(64, Math.round(f * 2.3));
  const emptyW = (f) => {
    const ws = order.words.map((w) => wordW(w, f));
    return Math.round(clamp(ws.reduce((a, b) => a + b, 0) / ws.length, 64, Math.max(...ws)));
  };
  function packCount(ws, room) {
    let rows = 1;
    let x = 0;
    for (const w of ws) {
      if (w > room) return Infinity;
      if (x > 0 && x + ORDER_GAP + w > room) { rows++; x = w; } else x += (x > 0 ? ORDER_GAP : 0) + w;
    }
    return rows;
  }

  /**
   * Tray rows when each row is filled first-fit: keep the shuffled order, but let a later short
   * word fill a gap at the end of a row. -> { rows, seq } (seq = card indices in tray order).
   * The browser's flex-wrap reproduces exactly these rows when the homes are in `seq` order.
   */
  function trayPack(f, room) {
    const ws = order.cards.map((c) => wordW(c.word, f));
    const left = order.trayOrder.slice();
    const seq = [];
    let rows = 0;
    while (left.length) {
      rows++;
      let x = 0;
      for (let k = 0; k < left.length;) {
        const wk = ws[left[k]];
        if (wk > room) return { rows: Infinity, seq: null };
        const add = (x > 0 ? ORDER_GAP : 0) + wk;
        if (x + add <= room) { x += add; seq.push(left[k]); left.splice(k, 1); } else k++;
      }
    }
    return { rows, seq };
  }

  /** Put the tray homes in `seq` order (never in sentence order). */
  function applyTrayOrder(seq) {
    if (!seq || seq.every((ci, k) => ci === order.trayOrder[k])) return;
    if (seq.every((ci, k) => order.cards[ci].word === order.words[k])) return;
    order.trayOrder = seq.slice();
    order.tray.append(...seq.map((ci) => order.cards[ci].home));
  }

  function layoutOrder(W, avH, land, g) {
    const words = order.words;
    const trayPad = 8;
    const blockH = (rows, f) => rows * cardH(f) + (rows - 1) * ORDER_GAP;
    // Rows the sentence needs: finished sentence or all-empty slots, whichever is more.
    const beltRows = (f, room) => Math.max(packCount(words.map((w) => wordW(w, f)), room), packCount(words.map(() => emptyW(f)), room));
    const fMax = Math.round(clamp(Math.min(W, avH) * 0.05, 18, 34));

    const tryFit = (f, decor, reserve) => {
      if (!land) {
        const tp = trayPack(f, W - 2 * trayPad);
        const trayH = blockH(tp.rows, f) + 2 * trayPad;
        const d = machineDims(W, avH * 0.42, decor);
        const room = W - 2 * d.P - 2 * d.Wp - 1;
        const rows = beltRows(f, room) + reserve;
        const Mh = blockH(rows, f) + 2 * d.Wp + d.chrome;
        if (rows < Infinity && tp.rows < Infinity && Mh + g + trayH <= avH) return { f, d, Mw: W, Mh, Aw: W, Ah: trayH, room, rows, seq: tp.seq };
        return null;
      }
      for (const frac of [0.44, 0.38, 0.5, 0.56]) {
        const Aw = Math.round(W * frac);
        const tp = trayPack(f, Aw - 2 * trayPad);
        const trayH = blockH(tp.rows, f) + 2 * trayPad;
        if (trayH > avH) continue;
        const Mw = W - Aw - g;
        const d = machineDims(Mw, avH * 0.75, decor);
        const room = Mw - 2 * d.P - 2 * d.Wp - 1;
        const rows = beltRows(f, room) + reserve;
        const Mh = blockH(rows, f) + 2 * d.Wp + d.chrome;
        if (rows < Infinity && Mh <= avH) {
          const MhShown = Math.min(avH, Math.max(Mh, Mw * 0.5));
          // The tray box matches the machine's height (or more, if the words need it).
          return { f, d, Mw, Mh: MhShown, Aw, Ah: Math.min(avH, Math.max(trayH, MhShown)), room, rows, seq: tp.seq };
        }
      }
      return null;
    };

    let fit = null;
    const plans = [[true, 1, 18], [true, 0, 16], [false, 0, 15], [false, 0, 12]];
    for (const [decor, reserve, fMin] of plans) {
      for (let f = fMax; f >= fMin && !fit; f--) fit = tryFit(f, decor, reserve);
      if (fit) break;
    }
    let tight = false;
    if (!fit) {
      // Extreme content on a tiny screen: smallest words, the tray scrolls inside itself.
      tight = true;
      const f = 12;
      const Mw = land ? W * 0.5 - g : W;
      const d = machineDims(Mw, avH * 0.5, false);
      const room = Mw - 2 * d.P - 2 * d.Wp - 1;
      const rows = Math.min(beltRows(f, room), 6);
      const Mh = Math.min(land ? avH : avH * 0.6, blockH(rows, f) + 2 * d.Wp + d.chrome);
      const Aw = land ? W * 0.5 : W;
      fit = { f, d, Mw, Mh, Aw, Ah: land ? avH : avH - Mh - g, room, rows, seq: trayPack(f, Aw - 2 * trayPad).seq };
    }
    wordFont = fit.f;
    applyTrayOrder(fit.seq);
    order.plan = { f: fit.f, room: fit.room, rows: fit.rows };
    play.style.setProperty('--wf', `${fit.f}px`);
    play.style.setProperty('--wh', `${cardH(fit.f)}px`);
    order.cards.forEach((c) => { c.home.style.width = `${wordW(c.word, fit.f)}px`; });
    panel.style.width = `${Math.floor(fit.Aw)}px`;
    panel.style.height = `${Math.floor(fit.Ah)}px`;
    panel.classList.toggle('is-tight', tight);
    applyMachine(fit.Mw, fit.Mh, fit.d);
    windowEl.style.setProperty('--cg', `${ORDER_GAP}px`);
    windowEl.style.setProperty('--rg', `${ORDER_GAP}px`);
    windowEl.style.setProperty('--extra', '0px');
    sizeSlots();
  }

  /** Slot widths follow their words; shrink the sentence font if an odd order needs more rows. */
  function sizeSlots() {
    if (!order || !order.plan) return;
    const { f, room, rows } = order.plan;
    const widthsAt = (ff) => order.slots.map((sl) => (sl.card ? wordW(sl.card.word, ff) : emptyW(ff)));
    let fs = f;
    while (fs > 11 && packCount(widthsAt(fs), room) > rows) fs--;
    windowEl.style.setProperty('--wfs', `${fs}px`);
    widthsAt(fs).forEach((w, i) => { order.slots[i].el.style.width = `${w}px`; });
  }

  function layoutEnd(W, avH, land, g) {
    let Mw;
    let Mh;
    if (!land) {
      const bh = Math.round(clamp(avH * 0.16, 80, 120));
      panel.style.width = `${Math.floor(W)}px`;
      panel.style.height = `${bh}px`;
      panel.style.setProperty('--eb', `${bh}px`);
      Mw = W;
      Mh = Math.min(avH - bh - g, Math.max(W * 0.85, 260));
    } else {
      const bw = Math.round(clamp(W * 0.2, 96, 170));
      const bh = Math.min(bw, Math.floor((avH - g) / 2));
      panel.style.width = `${bw}px`;
      panel.style.height = `${Math.floor(avH)}px`;
      panel.style.setProperty('--eb', `${bh}px`);
      Mw = W - bw - g;
      Mh = Math.min(avH, Math.max(Mw * 0.6, 220));
    }
    const d = machineDims(Mw, Mh, true);
    applyMachine(Mw, Mh, d);
    // Ticket width; its height is about 0.8 x width with two rows (less with one).
    const rowsH = results.some((r) => r === 'silver') ? 0.86 : 0.62;
    const tk = Math.min(windowEl.clientWidth * 0.62, (windowEl.clientHeight - 16) / rowsH);
    ticketWrap.style.setProperty('--tk', `${Math.max(90, Math.floor(tk))}px`);
  }

  const ro = new ResizeObserver(() => scheduleLayout());
  ro.observe(play);

  // ---------- go ----------
  startRound(0);

  return () => {
    alive = false;
    rseq++;
    timers.forEach((t) => clearTimeout(t));
    timers.clear();
    anims.forEach((a) => { try { a.cancel(); } catch { /* ignore */ } });
    anims.clear();
    if (layoutRaf) cancelAnimationFrame(layoutRaf);
    ro.disconnect();
    roundOffs.forEach((off) => off());
    roundOffs = [];
    fx.replaceChildren();
  };
}

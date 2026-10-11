// Tap guard: a tap meant for one screen must never act on the next one.
//
// Kids double-tap, and base.css sets `touch-action: manipulation`, so every tap is its own click.
// Without a guard the second tap of a double-tap lands on whatever the NEW screen shows under the
// finger: the start button opens a game, a home tile starts a reading tier, Back skips a menu.
//
//   holdTaps()       a screen change has begun: ignore taps on the app until the new screen is in
//                    place (with a failsafe, so a stalled download never freezes the Home button)
//   releaseTaps(ms)  the new screen is in place: keep ignoring taps until `ms` (default 400 ms)
//                    after it has actually been painted (a long task, e.g. the first audio set-up
//                    or a slow tablet, can delay that); a tap 500 ms after a screen appears is a
//                    deliberate one and must work
//
// js/app.js calls these on every route change. A module that swaps whole screens without a route
// change (e.g. a wizard step) may call releaseTaps() after the swap.
//
// While the guard is on, pointerdown / pointerup / click inside the guarded container (#app: the
// top bar + the screen) are stopped in the capture phase. A press that began before the new screen
// appeared is stopped too when it ends on it, and a rapid burst (a child hammering the button) keeps
// being ignored while it lasts. Everything outside the container (the parent gate,
// overlays, #print-root) is never blocked. Clicks with detail === 0 (keyboard, switch access,
// assistive tech) are only blocked during the short window itself, never by the press rules.
// Times come from event.timeStamp (when the finger really touched), not from when a busy main
// thread got round to dispatching the event.
//
// document.body.dataset.tapGuard is 'on' while taps are ignored (tests wait for it to go away).

const SETTLE_MS = 400;
const BURST_MS = 300;     // an ignored tap keeps the guard on this much longer (a child mashing taps 3-5 times a second)
const FAILSAFE_MS = 2500;
const PAINT_FALLBACK_MS = 1000;

let guardUntil = 0;
let mountedAt = 0;
let failsafe = 0;
let offTimer = 0;
let paintTimer = 0;
let releaseSeq = 0;
let installed = false;
const presses = new Map(); // pointerId -> { down, blocked }
let lastPress = null;      // the press that ended most recently ({ stale, blocked }); its click follows

const now = () => performance.now();

/** When an event happened, on the performance.now() clock (old engines report epoch ms). */
export function eventTime(e) {
  const t = e.timeStamp;
  return typeof t === 'number' && t > 0 && t <= now() + 50 ? t : now();
}
const when = eventTime;

function setFlag(on) {
  if (!document.body) return;
  if (on) document.body.dataset.tapGuard = 'on';
  else delete document.body.dataset.tapGuard;
}

function scheduleOff() {
  clearTimeout(offTimer);
  if (guardUntil === Infinity) return; // held: releaseTaps() schedules the end
  const left = guardUntil - now();
  if (left <= 0) setFlag(false);
  else offTimer = setTimeout(scheduleOff, left + 5);
}

/** A screen change has begun: ignore taps on the app until releaseTaps() (or the failsafe). */
export function holdTaps() {
  releaseSeq++; // cancels a release still waiting for its paint
  clearTimeout(paintTimer);
  guardUntil = Infinity;
  clearTimeout(offTimer);
  setFlag(true);
  clearTimeout(failsafe);
  failsafe = setTimeout(() => releaseTaps(0), FAILSAFE_MS);
}

/** The new screen is in place: let taps through again `ms` after it has been painted. */
export function releaseTaps(ms = SETTLE_MS) {
  clearTimeout(failsafe);
  clearTimeout(offTimer);
  clearTimeout(paintTimer);
  guardUntil = Infinity;
  setFlag(true);
  const mine = ++releaseSeq;
  const start = () => {
    if (mine !== releaseSeq) return; // a newer hold/release took over
    releaseSeq++;
    clearTimeout(paintTimer);
    mountedAt = now();
    guardUntil = mountedAt + Math.max(0, ms);
    scheduleOff();
  };
  // Count from the moment the new screen is on the glass: a requestAnimationFrame callback runs
  // just before the next paint and a task queued from it runs just after. The timer covers pages
  // that are not being rendered (hidden), where no tap can happen anyway.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(start, 0));
  paintTimer = setTimeout(start, PAINT_FALLBACK_MS);
}

/** True while taps on the app are being ignored. */
export function tapsHeld() {
  return now() < guardUntil;
}

/** Install the capture-phase listeners once (js/app.js boot). `container` = #app. */
export function installTapGuard(container) {
  if (installed || !container) return;
  installed = true;
  const inside = (e) => e.target instanceof Node && container.contains(e.target);
  const stop = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };

  document.addEventListener('pointerdown', (e) => {
    const t = when(e);
    const blocked = inside(e) && t < guardUntil;
    presses.set(e.pointerId, { down: t, blocked });
    if (blocked) {
      stop(e);
      // Part of a burst: keep ignoring the taps that follow quickly (the window can only grow).
      if (guardUntil !== Infinity && t + BURST_MS > guardUntil) { guardUntil = t + BURST_MS; scheduleOff(); }
    }
  }, true);

  document.addEventListener('pointerup', (e) => {
    const p = presses.get(e.pointerId);
    presses.delete(e.pointerId);
    // A press that began on the old screen (or was already ignored) must not finish on this one.
    lastPress = { stale: !!p && p.down < mountedAt, blocked: !!p && p.blocked };
    if (inside(e) && (when(e) < guardUntil || lastPress.stale || lastPress.blocked)) stop(e);
  }, true);

  document.addEventListener('pointercancel', (e) => { presses.delete(e.pointerId); }, true);

  document.addEventListener('click', (e) => {
    if (!inside(e)) return;
    const fromPress = e.detail > 0 && lastPress;
    if (when(e) < guardUntil || (fromPress && (lastPress.stale || lastPress.blocked))) stop(e);
  }, true);
}

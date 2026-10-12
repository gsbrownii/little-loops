// Parent gate: press and hold a button for 3 seconds. Used before printing and settings.
// const ok = await parentGate();  // true = grown-up held for the full time, false = cancelled
import { h, icon } from './dom.js';
import { speech } from './speech.js';
import { sound } from './sound.js';
import { eventTime } from './tapguard.js';

const HOLD_MS = 3000;
let open = null;
let closeOpen = null;

/** Eat the one synthetic click that follows the releasing touch/mouse-up (fallback for browsers
 *  that still synthesize it). Any later click goes through normally: only a pointer click whose
 *  own timestamp is within `ms` of the release is eaten, so a grown-up's next tap still works when
 *  a busy page (e.g. settings loading the games) runs the clean-up timer late. */
function swallowNextClick(releasedAt, ms = 700) {
  const eat = (e) => {
    stop();
    if (e.detail > 0 && eventTime(e) - releasedAt <= ms) { e.preventDefault(); e.stopPropagation(); }
  };
  const stop = () => { clearTimeout(t); window.removeEventListener('click', eat, true); };
  const t = setTimeout(stop, ms);
  window.addEventListener('click', eat, true);
}

/** Close the gate if it is showing (e.g. the screen changed underneath it). */
export function closeGate() {
  if (closeOpen) closeOpen();
}

export function parentGate({ hold = HOLD_MS } = {}) {
  if (open) return open; // already showing
  open = new Promise((resolve) => {
    const R = 54;
    const C = 2 * Math.PI * R;
    const ring = h('div', {
      class: 'gate-ring',
      html: `<svg viewBox="0 0 128 128" aria-hidden="true"><circle cx="64" cy="64" r="${R}" class="gate-ring-track"/><circle cx="64" cy="64" r="${R}" class="gate-ring-fill" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>`,
    });
    const fill = ring.querySelector('.gate-ring-fill');
    const holdBtn = h('button', { class: 'gate-hold', type: 'button', 'aria-label': 'Press and hold for 3 seconds' }, ring, icon('lock', 'gate-lock'));
    const closeBtn = h('button', { class: 'btn-round gate-close', type: 'button', 'aria-label': 'Close' }, icon('close'));
    const card = h(
      'div',
      { class: 'gate-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Grown-ups only' },
      closeBtn,
      h('div', { class: 'gate-title' }, 'Grown-ups only'),
      h('div', { class: 'gate-text' }, 'Press and hold the button for 3 seconds.'), // not spoken
      holdBtn
    );
    const overlay = h('div', { class: 'overlay gate' }, card);
    document.body.append(overlay);
    speech.say('Ask a grown-up for help!');

    let start = 0;
    let raf = 0;
    let holding = false;
    let ready = false; // held long enough; resolves when the finger lifts (a real tap for print())
    let readyTimer = 0;
    let pointerId = null;
    let finished = false;

    const setProgress = (p) => fill.setAttribute('stroke-dashoffset', String(C * (1 - Math.min(1, p))));

    function tick(now) {
      if (!holding) return;
      const p = (now - start) / hold;
      setProgress(p);
      if (p >= 1) {
        holding = false;
        ready = true;
        holdBtn.classList.add('is-ready');
        holdBtn.replaceChildren(ring, icon('check', 'gate-lock'));
        sound.play('unlock');
        // Fallback in case the release never arrives.
        readyTimer = setTimeout(() => done(true), 2000);
        return;
      }
      raf = requestAnimationFrame(tick);
    }

    function down(e) {
      if (holding || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      holding = true;
      pointerId = e.pointerId;
      try { holdBtn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      holdBtn.classList.add('is-holding');
      start = performance.now();
      raf = requestAnimationFrame(tick);
    }

    function up(e) {
      if (e && pointerId !== null && e.pointerId !== pointerId) return;
      if (ready) { swallowNextClick(e ? eventTime(e) : performance.now()); done(true); return; }
      if (!holding) return;
      holding = false;
      cancelAnimationFrame(raf);
      holdBtn.classList.remove('is-holding');
      setProgress(0);
    }

    function key(e) {
      if (e.key === 'Escape') done(false);
    }

    function done(ok) {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(raf);
      clearTimeout(readyTimer);
      closeOpen = null;
      document.removeEventListener('keydown', key);
      overlay.remove();
      if (!ok) speech.stop();
      open = null;
      resolve(ok);
    }

    // The touch that completes the hold must not also "click" whatever is under the finger
    // once the overlay is gone (a home tile, a settings switch...).
    holdBtn.addEventListener('touchend', (e) => { if (ready && e.cancelable) e.preventDefault(); }, { passive: false });
    holdBtn.style.touchAction = 'none';
    holdBtn.addEventListener('pointerdown', down);
    holdBtn.addEventListener('pointerup', up);
    holdBtn.addEventListener('pointercancel', up);
    holdBtn.addEventListener('lostpointercapture', up);
    holdBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    closeBtn.addEventListener('click', () => { sound.play('tap'); done(false); });
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', key);
    closeOpen = () => done(false);
  });
  return open;
}

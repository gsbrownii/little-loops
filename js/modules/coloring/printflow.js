// Print button flow (grown-ups): parent gate -> print.
//
// The core gate (ctx.parentGate) resolves true when the grown-up's finger LIFTS after the 3 s
// hold, i.e. inside a real tap. iPad/iPhone only open the print sheet from a fresh tap, so
// window.print() is called synchronously right after the await: no other awaits or timers first.
//
// Fallback: if the browser says the gesture no longer counts (navigator.userActivation.isActive
// is false, e.g. the gate's own safety timer resolved while the finger stayed down), one big
// "print" button is shown and printing happens from its click instead.
//
// A false result (close button, Escape, a tap outside, or the screen changed: the core closes the
// gate on every route change) simply ends the flow. Nothing is printed and nothing is left open.
import { h, icon } from '../../core/dom.js';

const SWALLOW_MS = 1500;

const activationOK = () => {
  const ua = typeof navigator !== 'undefined' ? navigator.userActivation : null;
  return !ua || ua.isActive === true;
};

/**
 * @param {object} o
 * @param {object} o.ctx              module context
 * @param {() => boolean} o.print     fills #print-root and calls window.print() (printer.print)
 * @param {(printed:boolean) => void} [o.onDone]  called when the flow ends (printed or not)
 */
export function createPrintFlow({ ctx, print, onDone }) {
  let gateOpen = false;
  let alive = true;
  let ask = null; // { overlay, off }
  let unswallow = null;

  const finish = (printed) => {
    if (onDone && alive) onDone(printed);
  };

  /**
   * The finger that held the gate lifts over whatever lies under the (now gone) overlay. Browsers
   * should not turn a 3 s hold into a click, but if one does, it must not paint or pick a colour:
   * swallow the next click until a new press starts or SWALLOW_MS pass.
   */
  function swallowNextClick() {
    if (unswallow) unswallow();
    const swallow = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      disarm();
    };
    const disarm = () => {
      clearTimeout(t);
      window.removeEventListener('click', swallow, true);
      window.removeEventListener('pointerdown', disarm, true);
      if (unswallow === disarm) unswallow = null;
    };
    window.addEventListener('click', swallow, true);
    window.addEventListener('pointerdown', disarm, true);
    const t = setTimeout(disarm, SWALLOW_MS);
    unswallow = disarm;
  }

  /** Print now, inside the current user gesture. */
  function printNow() {
    closeAsk();
    let printed = false;
    try {
      printed = print() !== false;
    } catch (err) {
      console.warn('[coloring] print failed', err);
    }
    finish(printed);
  }

  // ---- fallback: one big print button ----
  function closeAsk() {
    if (!ask) return;
    ask.off();
    ask.overlay.remove();
    ask = null;
  }

  function showAsk() {
    closeAsk();
    const go = h('button', { class: 'col-ask-print', type: 'button', 'aria-label': 'Print' }, icon('print'));
    const close = h('button', { class: 'btn-round col-ask-close', type: 'button', 'aria-label': 'Close' }, icon('close'));
    const card = h('div', { class: 'col-ask-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Print' },
      close, go, h('div', { class: 'col-ask-text' }, 'Ready! Tap to print.')); // not spoken
    const overlay = h('div', { class: 'overlay col-ask' }, card);
    const cancel = () => {
      closeAsk();
      finish(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') cancel(); };
    go.addEventListener('click', () => {
      ctx.sound.play('tap');
      printNow(); // synchronous: this click is the user gesture
    });
    close.addEventListener('click', () => { ctx.sound.play('tap'); cancel(); });
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) cancel(); });
    document.addEventListener('keydown', onKey);
    (document.getElementById('overlay-root') || document.body).append(overlay);
    ask = { overlay, off: () => document.removeEventListener('keydown', onKey) };
    ctx.instruct('Tap the printer to print!');
  }

  return {
    /** The Print button's click handler. */
    async start() {
      if (gateOpen || ask || !alive) return;
      gateOpen = true;
      ctx.sound.play('tap');
      let ok = false;
      try {
        ok = (await ctx.parentGate()) === true;
      } catch {
        ok = false;
      } finally {
        gateOpen = false;
      }
      // Everything below runs synchronously in the gate's finger-lift event.
      if (!alive || !ctx.isActive()) return; // the screen changed under the gate
      if (!ok) {
        finish(false);
        return;
      }
      swallowNextClick();
      if (activationOK()) printNow();
      else showAsk();
    },

    destroy() {
      alive = false;
      closeAsk();
      if (unswallow) unswallow();
      // An open parent gate is closed by the core on every route change (closeGate()).
    },
  };
}

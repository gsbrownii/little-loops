// Printing a clean outline page: the scene in renderScene mode 'print' (white regions, pure black
// lines) goes into #print-root, which base.css shows (and #app hides) in print media.
// coloring.css sizes it to fill one portrait page.
//
// The paint screen calls printer.print(sceneOptions) only after ctx.parentGate() said yes.
// #print-root is cleared on 'afterprint', after a 60 s fallback, and when the screen unmounts.
// It is invisible on screen, so keeping it a little longer is harmless; that is why an
// 'afterprint' that arrives instantly (some mobile browsers fire it before the print sheet has
// captured the page) is ignored and the fallback timer cleans up instead.
import { h } from '../../core/dom.js';
import { renderScene } from './scene.js';

const FALLBACK_MS = 60000;
const EARLY_AFTERPRINT_MS = 1000;

export function createPrinter(getScene) {
  const target = document.getElementById('print-root');
  let filled = false;
  let printedAt = 0;
  let timer = 0;

  function clear() {
    clearTimeout(timer);
    timer = 0;
    if (filled && target) target.replaceChildren();
    filled = false;
  }

  function fill(scene) {
    if (!target) return false;
    const markup = renderScene({ ...scene, mode: 'print', className: 'print-art' });
    target.replaceChildren(h('div', { class: 'print-coloring', html: markup }));
    filled = true;
    clearTimeout(timer);
    timer = setTimeout(clear, FALLBACK_MS);
    return true;
  }

  const onAfterPrint = () => {
    if (printedAt && performance.now() - printedAt < EARLY_AFTERPRINT_MS) return;
    clear();
  };
  // A grown-up using the browser's own Print (Ctrl+P / menu) on the paint screen gets the
  // outline too, instead of a blank page.
  const onBeforePrint = () => {
    if (filled) return;
    const scene = getScene && getScene();
    if (scene && fill(scene)) printedAt = 0;
  };
  window.addEventListener('afterprint', onAfterPrint);
  window.addEventListener('beforeprint', onBeforePrint);

  return {
    /** Fill #print-root and open the system print dialog. Returns false if printing is unavailable. */
    print(scene) {
      if (!fill(scene)) return false;
      printedAt = performance.now();
      try {
        if (typeof window.print !== 'function') return false;
        window.print();
        return true;
      } catch (err) {
        console.warn('[coloring] print failed', err);
        return false;
      }
    },
    get filled() { return filled; },
    clear,
    destroy() {
      window.removeEventListener('afterprint', onAfterPrint);
      window.removeEventListener('beforeprint', onBeforePrint);
      clear();
    },
  };
}

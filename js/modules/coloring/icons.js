// Coloring-only UI icons (same 48x48 / currentColor conventions as ICONS in core/dom.js).
import { fromMarkup } from '../../core/dom.js';

const S = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';

const MARKUP = {
  // A framed picture (hill + sun) with a "+" badge: "make a new picture".
  newPicture:
    `<rect x="4" y="7" width="33" height="30" rx="6" ${S} stroke-width="4.5"/>`
    + `<circle cx="14" cy="17" r="4" fill="currentColor"/>`
    + `<path d="M8 32 L17 24 L23 29 L28 25 L33 29" ${S} stroke-width="4"/>`
    + `<circle cx="36" cy="36" r="11" fill="currentColor"/>`
    + `<path d="M36 30 V42 M30 36 H42" fill="none" stroke="#FFFFFF" stroke-width="4" stroke-linecap="round"/>`,
};

export function colIcon(name, extraClass = '') {
  return fromMarkup(`<svg class="icon ${extraClass}" viewBox="0 0 48 48" aria-hidden="true" focusable="false">${MARKUP[name] || ''}</svg>`);
}

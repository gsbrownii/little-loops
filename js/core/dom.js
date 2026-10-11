// DOM helpers + the shared UI icon set (original, simple SVG; all use currentColor).

/**
 * h('button', { class: 'btn', onClick: fn, 'aria-label': 'Play' }, child1, 'text', [more])
 * Props: class, style (object), dataset (object), on<Event> (function), html (raw markup),
 * boolean true -> empty attribute, false/null -> skipped. Anything else -> setAttribute.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sk.startsWith('--')) el.style.setProperty(sk, sv);
          else el.style[sk] = sv;
        }
      }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of [children].flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Parse an SVG (or any single-root) markup string into an element. */
export function fromMarkup(markup) {
  const t = document.createElement('template');
  t.innerHTML = String(markup).trim();
  return t.content.firstElementChild;
}

const S = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';

export const ICONS = {
  home: `<path d="M24 5 L3 24 H10 V43 H20 V31 H28 V43 H38 V24 H45 Z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`,
  back: `<path d="M30 8 L13 24 L30 40" ${S} stroke-width="8"/>`,
  next: `<path d="M8 24 H38 M26 11 L39 24 L26 37" ${S} stroke-width="7"/>`,
  speaker: `<path d="M5 18 H14 L26 7 V41 L14 30 H5 Z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M32 17 Q37 24 32 31" ${S} stroke-width="4"/><path d="M37 11 Q46 24 37 37" ${S} stroke-width="4"/>`,
  play: `<path d="M15 8 L40 24 L15 40 Z" fill="currentColor" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/>`,
  stop: `<rect x="11" y="11" width="26" height="26" rx="5" fill="currentColor"/>`,
  undo: `<path d="M18 11 L8 21 L18 31" ${S} stroke-width="6"/><path d="M9 21 H28 A10 10 0 0 1 28 41 H19" ${S} stroke-width="6"/>`,
  trash: `<path d="M9 13 H39" ${S} stroke-width="5"/><path d="M19 12 V8 H29 V12" ${S} stroke-width="4"/><path d="M12 15 L14.5 42 H33.5 L36 15 Z" fill="currentColor"/>`,
  print: `<rect x="14" y="5" width="20" height="12" rx="2" ${S} stroke-width="4"/><rect x="5" y="17" width="38" height="17" rx="5" fill="currentColor"/><rect x="14" y="27" width="20" height="15" rx="2" fill="#fff" stroke="currentColor" stroke-width="4"/>`,
  gear: `<g fill="currentColor">${[0, 45, 90, 135, 180, 225, 270, 315]
    .map((a) => `<rect x="20.5" y="3" width="7" height="10" rx="2" transform="rotate(${a} 24 24)"/>`)
    .join('')}</g><circle cx="24" cy="24" r="11" fill="none" stroke="currentColor" stroke-width="8"/>`,
  lock: `<rect x="9" y="21" width="30" height="22" rx="5" fill="currentColor"/><path d="M15 21 V15 A9 9 0 0 1 33 15 V21" ${S} stroke-width="5"/>`,
  check: `<path d="M8 25 L19 36 L40 12" ${S} stroke-width="8"/>`,
  close: `<path d="M12 12 L36 36 M36 12 L12 36" ${S} stroke-width="7"/>`,
  star: `<polygon points="24,3 29.6,16.6 44.2,17.7 33,27.1 36.5,41.4 24,33.6 11.5,41.4 15,27.1 3.8,17.7 18.4,16.6" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`,
  retry: `<path d="M39 24 A15 15 0 1 1 34.6 13.4" ${S} stroke-width="6"/><path d="M36 4 V14 H26" ${S} stroke-width="6"/>`,
  grid: `<g fill="currentColor"><rect x="5" y="5" width="16" height="16" rx="4"/><rect x="27" y="5" width="16" height="16" rx="4"/><rect x="5" y="27" width="16" height="16" rx="4"/><rect x="27" y="27" width="16" height="16" rx="4"/></g>`,
  dice: `<rect x="6" y="6" width="36" height="36" rx="9" ${S} stroke-width="5"/><g fill="currentColor"><circle cx="16" cy="16" r="3.6"/><circle cx="32" cy="16" r="3.6"/><circle cx="24" cy="24" r="3.6"/><circle cx="16" cy="32" r="3.6"/><circle cx="32" cy="32" r="3.6"/></g>`,
  brush: `<path d="M38 6 L22 26" ${S} stroke-width="7"/><path d="M20 24 C12 24 10 32 8 40 C16 40 26 38 26 30 Z" fill="currentColor" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>`,
};

/** icon('home') -> <svg class="icon"> element. */
export function icon(name, extraClass = '') {
  const body = ICONS[name] || ICONS.star;
  const el = fromMarkup(
    `<svg class="icon ${extraClass}" viewBox="0 0 48 48" aria-hidden="true" focusable="false">${body}</svg>`
  );
  return el;
}

/** Restart a one-shot CSS animation class (e.g. 'wobble'). */
export function flash(el, cls, ms = 600) {
  el.classList.remove(cls);
  void el.offsetWidth; // reflow so the animation can replay
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

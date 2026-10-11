// Pointer-based drag & drop that works the same for touch, pen and mouse.
// Usage:
//   const off = draggable(cardEl, {
//     onTap: () => {...},                       // pointer released without moving past threshold
//     onStart: () => {...},                     // drag began (ghost created)
//     onMove: ({ x, y, over }) => {...},        // over = element under the finger (ghost excluded)
//     onDrop: ({ x, y, over }) => {...},        // finger lifted after dragging
//     onCancel: () => {...},                    // drag interrupted (pointercancel, second drag, etc.)
//     ghost: () => element,                     // optional custom ghost (default: clone of el)
//     threshold: 10,                            // px of movement before it counts as a drag
//   });
//   off(); // remove listeners
// Only one drag can be active at a time across the app (extra fingers are ignored).

let active = null;

export function isDragging() {
  return !!active;
}

/** Cancel any drag in progress (call from module unmount). */
export function cancelDrag() {
  if (active) active.cancel();
}

export function draggable(el, opts = {}) {
  const threshold = opts.threshold ?? 10;
  el.style.touchAction = 'none';
  el.addEventListener('contextmenu', preventDefault);
  el.addEventListener('dragstart', preventDefault); // native HTML5 image drag

  function onDown(e) {
    if (active || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const state = {
      el,
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      offX: e.clientX - (rect.left + rect.width / 2),
      offY: e.clientY - (rect.top + rect.height / 2),
      dragging: false,
      ghost: null,
      cancel: () => finish(null, true),
    };
    active = state;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    el.classList.add('is-pressed');

    function overAt(x, y) {
      const hit = document.elementFromPoint(x, y);
      return hit && state.ghost && state.ghost.contains(hit) ? null : hit;
    }

    function place(x, y) {
      // Lift the ghost a little above the finger so the child can see what they carry.
      const lift = e.pointerType === 'touch' ? 28 : 0;
      state.ghost.style.transform = `translate(${x - state.gw / 2}px, ${y - state.gh / 2 - lift}px) scale(1.12)`;
    }

    function move(ev) {
      if (ev.pointerId !== state.id) return;
      const x = ev.clientX;
      const y = ev.clientY;
      if (!state.dragging) {
        if (Math.hypot(x - state.startX, y - state.startY) < threshold) return;
        state.dragging = true;
        const g = opts.ghost ? opts.ghost() : el.cloneNode(true);
        g.classList.add('drag-ghost');
        g.removeAttribute('id');
        g.style.width = `${rect.width}px`;
        g.style.height = `${rect.height}px`;
        document.body.append(g);
        state.ghost = g;
        state.gw = rect.width;
        state.gh = rect.height;
        el.classList.add('is-drag-source');
        opts.onStart?.();
      }
      place(x, y);
      opts.onMove?.({ x, y, over: overAt(x, y) });
    }

    function up(ev) {
      if (ev.pointerId !== state.id) return;
      finish(ev, false);
    }

    function cancelEv(ev) {
      if (ev.pointerId !== state.id) return;
      finish(null, true);
    }

    function finish(ev, cancelled) {
      if (active !== state) return;
      active = null;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancelEv);
      el.removeEventListener('lostpointercapture', cancelEv);
      try { el.releasePointerCapture(state.id); } catch { /* ignore */ }
      el.classList.remove('is-pressed', 'is-drag-source');
      const ghost = state.ghost;
      if (cancelled) {
        ghost?.remove();
        if (state.dragging) opts.onCancel?.();
        return;
      }
      if (state.dragging) {
        const x = ev.clientX;
        const y = ev.clientY;
        const over = overAt(x, y);
        ghost?.remove();
        opts.onDrop?.({ x, y, over });
      } else {
        opts.onTap?.(ev);
      }
    }

    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancelEv);
    el.addEventListener('lostpointercapture', cancelEv);
  }

  el.addEventListener('pointerdown', onDown);
  return () => {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('contextmenu', preventDefault);
    el.removeEventListener('dragstart', preventDefault);
    if (active && active.el === el) active.cancel();
  };
}

function preventDefault(e) {
  e.preventDefault();
}

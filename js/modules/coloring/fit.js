// Call fn(width, height) now and whenever `el` changes size (rotation, split screen, URL bar).
// Returns an off() function. Uses ResizeObserver when available, window resize otherwise.
export function watchSize(el, fn) {
  let raf = 0;
  let lastW = -1;
  let lastH = -1;
  const run = () => {
    raf = 0;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h || (w === lastW && h === lastH)) return;
    lastW = w;
    lastH = h;
    fn(w, h);
  };
  const kick = () => {
    if (!raf) raf = requestAnimationFrame(run);
  };
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(kick);
    ro.observe(el);
  }
  window.addEventListener('resize', kick);
  window.addEventListener('orientationchange', kick);
  run();
  return () => {
    cancelAnimationFrame(raf);
    if (ro) ro.disconnect();
    window.removeEventListener('resize', kick);
    window.removeEventListener('orientationchange', kick);
  };
}

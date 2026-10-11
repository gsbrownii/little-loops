// Service worker registration + install prompt capture.
// Updates: a new service worker waits until the app is on the splash screen, then we
// activate it and reload — never in the middle of a child's game.
let registration = null;
let installEvent = null;
const installListeners = new Set();

/** Ask the browser not to evict saved progress (granted silently for installed apps on most browsers). */
export function requestPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch { /* ignore */ }
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Service workers need http(s); skip for file:// previews.
  if (!/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker
    .register('./sw.js', { scope: './' })
    .then((reg) => {
      registration = reg;
      // An update that finishes installing while the splash is still up can be applied right away.
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (sw) {
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && isSafeMoment()) applyWaitingUpdate();
          });
        }
      });
      // Installed apps are usually resumed, not relaunched: look for a new version when shown
      // again, and swap it in if the child is only on the splash or home screen.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (isSafeMoment()) applyWaitingUpdate();
        reg.update().catch(() => {});
      });
    })
    .catch((err) => console.warn('Service worker registration failed:', err));
}

/** Reloading now would not interrupt a game. */
function isSafeMoment() {
  const b = document.body;
  return b.classList.contains('is-splash') || b.dataset.screen === 'home';
}

/**
 * If an updated version is waiting, activate it and reload. Call only when it is safe
 * to reload (the splash screen). Resolves true if a reload is underway.
 */
export async function applyWaitingUpdate() {
  if (!('serviceWorker' in navigator)) return false;
  const reg = registration || (await navigator.serviceWorker.getRegistration().catch(() => null));
  if (!reg || !reg.waiting || !navigator.serviceWorker.controller) return false;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
  reg.waiting.postMessage({ type: 'SKIP_WAITING' });
  return true;
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // we show our own button in grown-up settings
  installEvent = e;
  installListeners.forEach((fn) => fn(true));
});
window.addEventListener('appinstalled', () => {
  installEvent = null;
  installListeners.forEach((fn) => fn(false));
});

export const install = {
  available: () => !!installEvent,
  onChange(fn) { installListeners.add(fn); return () => installListeners.delete(fn); },
  async prompt() {
    if (!installEvent) return false;
    const e = installEvent;
    installEvent = null;
    e.prompt();
    const choice = await e.userChoice.catch(() => null);
    return choice?.outcome === 'accepted';
  },
  isStandalone: () =>
    (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true,
};

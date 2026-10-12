// App shell: splash (unlocks audio), home screen, hash router, module loader.
//
// Routes:  #/            home
//          #/settings    grown-up settings (only after the parent gate)
//          #/<module>/…  a module from data/app.json, e.g. #/robot/3 -> params ['3']
//
// Module contract (see docs/ARCHITECTURE.md):
//   export default { id, mount(root, ctx) -> cleanup?|Promise, unmount?(), settings?: [...] }
//
// Robustness rules kept here:
//  - Every route change holds taps until the new screen is in place, then for a short moment
//    more (core/tapguard.js), so a double-tap never acts on the next screen.
//  - Nothing is ever blank and silent: if loading takes a moment (first visit on slow Wi-Fi),
//    a bobbing robot and "Getting ready!" show until the screen is ready.
//  - A file that fails to load is retried: the registry (data/app.json) and stylesheets on the
//    next try; a game's code (which the browser will not re-import) by reloading the page from
//    the Oops screen, but only when the network is back.
import { APP } from './config.js';
import { storage } from './core/storage.js';
import { speech } from './core/speech.js';
import { sound } from './core/sound.js';
import { loadJSON, assetURL } from './core/data.js';
import { h, icon, flash } from './core/dom.js';
import { createChrome } from './core/screen.js';
import { parentGate, closeGate } from './core/gate.js';
import { celebrate, praise } from './core/celebrate.js';
import { renderSettings } from './core/settings.js';
import { registerServiceWorker, applyWaitingUpdate, requestPersistentStorage } from './core/pwa.js';
import { cancelDrag } from './core/drag.js';
import { installTapGuard, holdTaps, releaseTaps } from './core/tapguard.js';

const screenEl = document.getElementById('screen');
const chrome = createChrome(document.getElementById('topbar'), { go });
let registry = { modules: [] };
let registryLoad = null;
let started = false;
let seq = 0;
let current = null; // { module, cleanups: [], active, loadingDone } for the screen on show
let settingsUnlocked = false;
const loadedCSS = new Map();

const GETTING_READY = 'Getting ready!';
const LOADING_SHOW_MS = 400;  // show the placeholder only if loading takes longer than this…
const LOADING_SPEAK_MS = 1000; // …and say it only if it takes longer still (no clipped "Get—")

/** Navigate to a hash route. replace=true avoids adding a history entry. */
export function go(hash, { replace = false } = {}) {
  holdTaps(); // the screen is about to change; route() releases once the new one is in place
  if (location.hash === hash || (hash === '#/' && !location.hash)) {
    route();
    return;
  }
  if (replace) location.replace(hash);
  else location.hash = hash;
}

/** Load data/app.json (the home tiles). Retried while it has not loaded: on every route and
 *  when the browser comes back online. Never rejects. */
function loadRegistry() {
  if (registry.modules.length) return Promise.resolve(registry);
  if (!registryLoad) {
    registryLoad = loadJSON('data/app.json')
      .then((r) => {
        const modules = Array.isArray(r?.modules) ? r.modules.filter((m) => m && typeof m === 'object' && typeof m.id === 'string') : [];
        registry = { ...r, modules };
      }, (err) => {
        console.warn('Could not load data/app.json (will retry)', err);
      })
      .then(() => {
        registryLoad = null;
        return registry;
      });
  }
  return registryLoad;
}

/** Load a module stylesheet once. Rejects if it fails (and forgets it, so the next visit retries
 *  with a fresh <link>); a slow one just stops being waited for after 3 s and applies on arrival. */
function ensureCSS(href) {
  if (!href) return Promise.resolve();
  const url = assetURL(href);
  if (!loadedCSS.has(url)) {
    loadedCSS.set(url, new Promise((resolve, reject) => {
      const link = h('link', { rel: 'stylesheet', href: url });
      const t = setTimeout(resolve, 3000);
      link.addEventListener('load', () => { clearTimeout(t); resolve(); });
      link.addEventListener('error', () => {
        clearTimeout(t);
        link.remove();
        loadedCSS.delete(url);
        reject(new Error(`Could not load ${href}`));
      });
      document.head.append(link);
    }));
  }
  return loadedCSS.get(url);
}

/** Retire a screen exactly once: mark it inactive and run its cleanups, newest first. */
function retire(state) {
  if (!state || !state.active) return;
  state.active = false;
  for (const fn of state.cleanups.splice(0).reverse()) {
    try { fn(); } catch (err) { console.error('cleanup failed', err); }
  }
}

function teardown() {
  cancelDrag();
  closeGate();
  speech.stop();
  const c = current;
  current = null;
  retire(c);
  chrome.reset();
  screenEl.replaceChildren();
  delete document.body.dataset.screen;
}

/**
 * While a screen loads: after LOADING_SHOW_MS show a bobbing robot + "Getting ready!" (caption),
 * after LOADING_SPEAK_MS also say it. Sets state.loadingDone(), which removes it (idempotent);
 * it is also a cleanup, so leaving the screen clears the timers.
 */
function loadingPlaceholder(state, mySeq) {
  let el = null;
  const live = () => mySeq === seq && state.active;
  const showT = setTimeout(() => {
    if (!live() || chrome.instruction) return; // the screen already said what to do
    el = h('div', { class: 'screen-loading', 'aria-hidden': 'true' },
      h('img', { class: 'screen-loading-art', src: assetURL('art/robot.svg'), alt: '', width: '120', height: '120', draggable: 'false' }));
    screenEl.append(el);
    chrome.setInstruction(GETTING_READY, { speak: false });
  }, LOADING_SHOW_MS);
  const speakT = setTimeout(() => {
    if (live() && el && chrome.instruction === GETTING_READY) speech.say(GETTING_READY);
  }, LOADING_SPEAK_MS);
  const done = () => {
    clearTimeout(showT);
    clearTimeout(speakT);
    if (el) {
      el.remove();
      el = null;
      if (chrome.instruction === GETTING_READY) chrome.setInstruction('', { speak: false });
    }
  };
  state.loadingDone = done;
  state.cleanups.push(done);
}

/** The new screen is in place: drop the placeholder and let taps through after a short settle. */
function screenReady(state) {
  state.loadingDone?.();
  releaseTaps();
}

async function route() {
  if (!started) return;
  holdTaps();
  const mySeq = ++seq;
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  const [id, ...params] = parts;
  teardown();

  const state = { module: null, cleanups: [], active: true, loadingDone: null };
  current = state;
  const stillMine = () => mySeq === seq && state.active;
  loadingPlaceholder(state, mySeq);

  if (!registry.modules.length) {
    await loadRegistry(); // first visit on a flaky network: try again now
    if (!stillMine()) return;
  }

  if (!id) {
    state.loadingDone();
    showHome();
    screenReady(state);
    return;
  }

  if (id === 'settings') {
    if (!settingsUnlocked) return go('#/', { replace: true });
    settingsUnlocked = false;
    state.loadingDone();
    document.body.dataset.screen = 'settings';
    const root = h('div', { class: 'screen-root' });
    screenEl.append(root);
    const cleanup = await renderSettings(root, { chrome, registry, go });
    if (typeof cleanup === 'function') {
      if (state.active) state.cleanups.push(cleanup);
      else cleanup();
    }
    if (stillMine()) screenReady(state);
    return;
  }

  const entry = registry.modules.find((m) => m.id === id);
  if (!entry || entry.status !== 'ready' || !entry.entry) return go('#/', { replace: true });

  document.body.dataset.screen = id;
  const root = h('div', { class: `screen-root mod-${id}` });
  let importFailed = false;
  try {
    const [code, css] = await Promise.allSettled([import(assetURL(entry.entry)), ensureCSS(entry.css)]);
    if (!stillMine()) return; // the child already went somewhere else
    if (code.status === 'rejected') { importFailed = true; throw code.reason; }
    // Never mount a game without its styles (it would be unusable); the next visit retries.
    if (css.status === 'rejected') throw css.reason;
    const mod = code.value && code.value.default;
    if (!mod || typeof mod.mount !== 'function') throw new Error(`Module "${id}" has no mount()`);
    state.module = mod;
    screenEl.append(root);
    const ctx = makeContext(entry, params, state);
    if (typeof mod.unmount === 'function') state.cleanups.push(() => mod.unmount());
    const ret = await mod.mount(root, ctx);
    if (typeof ret === 'function') {
      if (state.active) state.cleanups.push(ret);
      else ret();
    }
    if (stillMine()) screenReady(state);
  } catch (err) {
    console.error(`Module "${id}" failed`, err);
    // Retire the half-built screen now: its listeners, timers and top-bar buttons must not
    // stay live behind the Oops screen.
    if (current === state) current = null;
    retire(state);
    if (mySeq === seq) showOops({ entry, importFailed });
  }
}

function makeContext(entry, params, state) {
  return {
    app: APP,
    id: entry.id,
    entry,
    params,
    chrome,
    instruct: (text, opts) => {
      if (!state.active) return Promise.resolve(false); // a screen that is gone can't change the caption
      state.loadingDone?.();
      return chrome.setInstruction(text, opts);
    },
    say: (text, opts) => speech.say(text, opts),
    sound,
    celebrate,
    praise,
    parentGate,
    navigate: (hash, opts) => go(hash, opts),
    loadJSON,
    asset: assetURL,
    store: storage.scope(entry.id),
    onCleanup: (fn) => { if (state.active) state.cleanups.push(fn); else fn(); },
    isActive: () => state.active,
  };
}

function showHome() {
  document.body.dataset.screen = 'home';
  chrome.setBack(null);
  const gear = h('button', { class: 'btn-round btn-gear', type: 'button', 'aria-label': 'Grown-up settings' }, icon('gear'));
  gear.addEventListener('click', async () => {
    sound.play('tap');
    // Settings list each game's options; start loading the games' code now, so the 3 s hold
    // hides it (the browser shares one load per file with the settings screen).
    registry.modules.forEach((m) => {
      if (m.status === 'ready' && m.entry) import(assetURL(m.entry)).catch(() => {});
    });
    if (await parentGate()) {
      settingsUnlocked = true;
      go('#/settings');
    } else {
      chrome.setInstruction(registry.modules.length ? 'Pick a game! Tap a picture.' : 'Oops! Tap to try again.', { speak: false });
    }
  });
  chrome.setActions([gear]);

  if (!registry.modules.length) {
    // data/app.json could not be loaded (first visit on a flaky network): never an empty grid.
    screenEl.append(
      h('div', { class: 'screen-root oops home-retry' },
        h('img', { class: 'oops-art', src: assetURL('art/robot.svg'), alt: '', width: '120', height: '120', draggable: 'false' }),
        h('button', {
          class: 'btn-big btn-go', type: 'button', 'aria-label': 'Try again',
          onClick: () => { sound.play('tap'); go('#/'); },
        }, icon('retry')))
    );
    chrome.setInstruction('Oops! Tap to try again.');
    return;
  }

  const tiles = registry.modules.map((m) => {
    const locked = m.status !== 'ready';
    const small = locked;
    const img = h('img', { class: 'tile-art', src: assetURL(m.tile?.art || ''), alt: '', draggable: 'false' });
    img.addEventListener('error', () => img.replaceWith(icon(locked ? 'lock' : 'star', 'tile-art')));
    const tile = h('button', {
      class: small ? 'tile tile-small' : 'tile',
      type: 'button',
      dataset: { status: locked ? 'locked' : 'ready', id: m.id },
      'aria-label': locked ? `${m.title} (coming soon)` : m.title,
      style: { '--tile-color': m.tile?.color || '#4CC9F0' },
    },
      img,
      h('span', { class: 'tile-text' },
        h('span', { class: 'tile-label' }, m.title),
        locked ? h('span', { class: 'tile-soon' }, 'Coming soon') : null),
      locked ? h('span', { class: 'tile-lock' }, icon('lock')) : null
    );
    tile.addEventListener('click', () => {
      if (locked) {
        sound.play('locked');
        flash(tile, 'wobble');
        speech.say(m.lockedSay || `${m.title} is coming soon!`); // voice: enumerated (data/app.json)
      } else {
        sound.play('tap');
        go(`#/${m.id}`);
      }
    });
    return tile;
  });

  // Playable games get big tiles; "coming soon" ones sit in a smaller row underneath.
  const ready = tiles.filter((t) => t.dataset.status === 'ready');
  const soon = tiles.filter((t) => t.dataset.status !== 'ready');
  screenEl.append(
    h('div', { class: 'screen-root home' },
      h('div', { class: 'home-main', dataset: { count: String(ready.length) } }, ...ready),
      soon.length ? h('div', { class: 'home-soon' }, ...soon) : null)
  );
  chrome.setInstruction('Pick a game! Tap a picture.');
}

/** Is it safe to reload the page? Not while offline with nothing cached (that would show the
 *  browser's own "no internet" page and lose the games that still work). */
async function canReload(entry) {
  if (navigator.serviceWorker && navigator.serviceWorker.controller) return true; // app shell cached
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = setTimeout(() => { if (ctrl) ctrl.abort(); }, 4000);
  try {
    const r = await fetch(assetURL(entry.entry), { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Something went wrong opening a game. The button (and the top-bar Home) go home; if the game's
 * code failed to download, the browser will never re-import it in this page, so once the
 * network is back they reload the app instead (it opens on the start screen, then home).
 */
function showOops({ entry = null, importFailed = false } = {}) {
  document.body.dataset.screen = 'oops';
  let busy = false;
  const leave = async () => {
    if (busy) return;
    busy = true;
    if (importFailed && entry && (await canReload(entry))) {
      history.replaceState(history.state, '', `${location.pathname}${location.search}#/`);
      location.reload();
      return;
    }
    busy = false;
    go('#/');
  };
  chrome.setBack({ icon: 'home', to: leave });
  chrome.setActions([]);
  screenEl.replaceChildren(
    h('div', { class: 'screen-root oops' },
      h('img', { class: 'oops-art', src: assetURL('art/robot.svg'), alt: '', width: '120', height: '120', draggable: 'false' }),
      h('button', { class: 'btn-big btn-go', type: 'button', 'aria-label': 'Go home', onClick: () => { sound.play('tap'); leave(); } }, icon('home')))
  );
  chrome.setInstruction('Oops! Let’s go back home.');
  releaseTaps();
}

function showSplash() {
  document.body.classList.add('is-splash');
  const play = h('button', { class: 'splash-play', type: 'button', 'aria-label': 'Start' }, icon('play'));
  const splash = h('div', { class: 'splash' },
    // width/height reserve the logo's space, so the Start button doesn't jump when the image loads
    h('img', { class: 'splash-logo', src: assetURL('art/robot.svg'), alt: '', width: '120', height: '120', draggable: 'false' }),
    h('div', { class: 'splash-title' }, APP.name),
    play
  );
  screenEl.replaceChildren(splash);
  play.addEventListener('click', () => {
    // Must run synchronously inside the tap: unlocks speech + audio on iOS/Chrome.
    speech.unlock();
    sound.unlock();
    sound.play('pick');
    requestPersistentStorage();
    started = true;
    document.body.classList.remove('is-splash');
    route(); // waits for data/app.json if it is still on its way
  }, { once: true });
  // A newer version downloaded last time? Swap it in now, before play starts.
  applyWaitingUpdate();
}

function boot() {
  installTapGuard(document.getElementById('app'));
  registerServiceWorker();
  speech.loadPack(APP.voicePack); // the recorded voice; falls back to the device voice
  window.addEventListener('hashchange', route);
  // Back online after the registry failed to load: show the games without another tap.
  window.addEventListener('online', () => {
    if (registry.modules.length) return;
    loadRegistry().then(() => {
      if (started && registry.modules.length && document.body.dataset.screen === 'home') go('#/');
    });
  });
  showSplash();   // draw right away; the registry loads while the child looks at the splash
  loadRegistry();
}

boot();

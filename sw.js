/* Little Loops service worker (classic script, no imports).
 *
 * - install:  precaches every app file in PRECACHE (fetched with cache:'reload', all-or-nothing).
 *             It does NOT skipWaiting: an update waits until js/core/pwa.js sends {type:'SKIP_WAITING'}
 *             from the splash screen and reloads — never in the middle of a child's game.
 * - activate: removes this app's caches from older versions, then claims open pages.
 * - fetch:    same-origin GET requests inside the scope only (never cross-origin).
 *             Navigations to the app (scope root or index.html, any ?query) get the cached index.html,
 *             falling back to the network. Everything else is cache-first (query string ignored);
 *             on a miss it goes to the network and keeps a copy of good same-origin responses.
 *
 * All URLs are resolved against self.registration.scope, so the app works from a GitHub Pages
 * sub-path (https://user.github.io/little-loops/).
 *
 * The CACHE version and the PRECACHE list are GENERATED: after changing any app file run
 *   node tools/precache.mjs          (CI / pre-deploy check: node tools/precache.mjs --check)
 */
'use strict';

const CACHE = 'little-loops-3b640fb9a4';

const PRECACHE = [
// <precache>
  './',
  'art/robot.svg',
  'art/tiles/builder.svg',
  'art/tiles/coloring.svg',
  'art/tiles/machine.svg',
  'art/tiles/robot.svg',
  'art/tiles/story.svg',
  'css/base.css',
  'data/app.json',
  'data/coloring/accessories.json',
  'data/coloring/animals.json',
  'data/coloring/backgrounds.json',
  'data/machine/rounds.json',
  'data/robot/levels.json',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/icon.svg',
  'index.html',
  'js/app.js',
  'js/config.js',
  'js/core/celebrate.js',
  'js/core/data.js',
  'js/core/dom.js',
  'js/core/drag.js',
  'js/core/gate.js',
  'js/core/pwa.js',
  'js/core/screen.js',
  'js/core/settings.js',
  'js/core/sound.js',
  'js/core/speech.js',
  'js/core/storage.js',
  'js/core/tapguard.js',
  'js/modules/coloring/coloring.css',
  'js/modules/coloring/coloring.js',
  'js/modules/coloring/colors.js',
  'js/modules/coloring/fit.js',
  'js/modules/coloring/icons.js',
  'js/modules/coloring/layout.js',
  'js/modules/coloring/paint.js',
  'js/modules/coloring/parts.js',
  'js/modules/coloring/printflow.js',
  'js/modules/coloring/printing.js',
  'js/modules/coloring/scene.js',
  'js/modules/coloring/tapassist.js',
  'js/modules/coloring/wizard.js',
  'js/modules/machine/art.js',
  'js/modules/machine/machine.css',
  'js/modules/machine/machine.js',
  'js/modules/machine/picker.js',
  'js/modules/machine/rounds.js',
  'js/modules/machine/session.js',
  'js/modules/machine/tokens.js',
  'js/modules/machine/view.js',
  'js/modules/robot/art.js',
  'js/modules/robot/levels.js',
  'js/modules/robot/logic.js',
  'js/modules/robot/program.js',
  'js/modules/robot/puzzle.js',
  'js/modules/robot/robot.css',
  'js/modules/robot/robot.js',
  'js/modules/robot/select.js',
  'manifest.webmanifest',
// </precache>
];

const PREFIX = 'little-loops-';
const SCOPE = self.registration.scope;
const INDEX_URL = new URL('index.html', SCOPE).href;
const MATCH = { ignoreSearch: true, ignoreVary: true };

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE.map((path) => new Request(new URL(path, SCOPE).href, { cache: 'reload' })));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Remove old versions of THIS app. Only entries under our scope are touched, so another copy of
    // Little Loops at a different path on the same origin (e.g. a /little-loops-beta/ deploy) is safe.
    for (const name of await caches.keys()) {
      if (!name.startsWith(PREFIX) || name === CACHE) continue;
      const old = await caches.open(name);
      const keys = await old.keys();
      const ours = keys.filter((req) => req.url.startsWith(SCOPE));
      if (ours.length === keys.length) await caches.delete(name);
      else await Promise.all(ours.map((req) => old.delete(req)));
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (!req.url.startsWith(SCOPE)) return; // cross-origin, or outside our sub-path: browser default
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  if (req.headers.has('range')) return; // partial (media) requests: not cacheable, let the browser handle them

  if (req.mode === 'navigate' && isAppPage(req.url)) {
    event.respondWith(appShell(req));
  } else {
    event.respondWith(cacheFirst(req, event));
  }
});

/** The scope root or index.html, ignoring ?query and #hash. */
function isAppPage(url) {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.href === SCOPE || u.href === INDEX_URL;
}

async function appShell(req) {
  const cache = await caches.open(CACHE);
  const hit = (await cache.match(INDEX_URL, MATCH)) || (await cache.match(SCOPE, MATCH));
  if (hit) return navigable(hit);
  try {
    return await fetch(req);
  } catch {
    return Response.error();
  }
}

async function cacheFirst(req, event) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, MATCH);
  if (hit) return req.mode === 'navigate' ? navigable(hit) : hit;
  let res;
  try {
    res = await fetch(req);
  } catch {
    return Response.error(); // offline and not cached
  }
  if (res.status === 200 && res.type === 'basic') {
    event.waitUntil(cache.put(req, res.clone()).catch(() => { /* quota or opaque: skip */ }));
  }
  return res;
}

/**
 * Browsers refuse a redirected response for a navigation. Hosts that redirect index.html -> ./
 * (some do) would leave a redirected copy in the cache, so re-wrap it as a plain response.
 */
async function navigable(res) {
  if (!res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

// Tiny localStorage wrapper. Everything lives under one JSON blob (APP.storageKey).
// Falls back to memory-only if storage is unavailable (private mode, blocked site data).
//
// Several copies of the app can share the blob at the same time: two tabs, the installed app
// plus a browser tab, or a second deploy on the same github.io origin. So every write is
// read-modify-write: it re-reads the stored blob, changes only its own path and writes it back,
// and a 'storage' event from another copy drops the cached blob. One copy never erases what
// another one saved (two writes to the very same path: the last one wins).
//
// Paths are dot-separated ('robot.done.r01') and their segments come from content ids, so they
// are hardened: '__proto__', 'constructor' and 'prototype' are stored under an escaped key
// ('~__proto__') and never touch Object.prototype, and a node that is not a plain object (an
// array or a value left by a corrupt or foreign blob) counts as missing and is replaced on write.
import { APP } from '../config.js';

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const seg = (k) => (RESERVED.has(k) ? `~${k}` : k);

const UNREADABLE = 0; // localStorage itself threw (private mode, blocked site data)
const CORRUPT = 1;    // something is stored, but it is not a JSON object

let data = null;
let persistent = true;

/** The stored blob as a plain object ({} when nothing is stored), or UNREADABLE / CORRUPT. */
function readStored() {
  let raw;
  try {
    raw = window.localStorage.getItem(APP.storageKey);
  } catch {
    return UNREADABLE;
  }
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (isObj(v)) return v;
  } catch { /* fall through */ }
  return CORRUPT;
}

function load() {
  if (data) return data;
  const stored = readStored();
  // Only an unreadable storage means "not saving". A corrupt blob is simply started afresh
  // (the next save overwrites it).
  if (stored === UNREADABLE) persistent = false;
  data = isObj(stored) ? stored : {};
  return data;
}

/** Before a write: pick up what other copies of the app saved since we last looked. */
function refresh() {
  if (data && persistent) {
    const stored = readStored();
    if (isObj(stored)) data = stored; // unreadable / corrupt: keep what we have in memory
  }
  return load();
}

function save() {
  try {
    window.localStorage.setItem(APP.storageKey, JSON.stringify(data));
    persistent = true;
  } catch {
    persistent = false;
  }
}

function walk(path, create) {
  const keys = String(path).split('.').map(seg);
  const last = keys.pop();
  let node = load();
  for (const k of keys) {
    if (!own(node, k) || !isObj(node[k])) {
      if (!create) return [null, last];
      node[k] = {};
    }
    node = node[k];
  }
  return [node, last];
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // Another tab / the installed app changed the blob (key null = it cleared all storage).
  // Memory-only mode keeps its unsaved state instead.
  window.addEventListener('storage', (e) => {
    if (persistent && (e.key === APP.storageKey || e.key === null)) data = null;
  });
}

export const storage = {
  /** get('robot.done.r01', false) */
  get(path, fallback) {
    const [node, last] = walk(path, false);
    if (!node || !own(node, last)) return fallback;
    return node[last];
  },
  set(path, value) {
    refresh();
    const [node, last] = walk(path, true);
    node[last] = value;
    save();
  },
  remove(path) {
    refresh();
    const [node, last] = walk(path, false);
    if (node && own(node, last)) {
      delete node[last];
      save();
    }
  },
  /** Wipe all progress but keep grown-up settings (and any extra dot-paths in `keep`). */
  resetProgress(keep = []) {
    refresh();
    const kept = keep.map((p) => [p, storage.get(p)]).filter(([, v]) => v !== undefined);
    const settings = load().settings;
    data = isObj(settings) ? { settings } : {};
    // Write the kept paths straight into the new blob (storage.set would re-read the old one).
    for (const [p, v] of kept) {
      const [node, last] = walk(p, true);
      node[last] = v;
    }
    save();
  },
  /** A view of storage rooted at `prefix` (each module gets storage.scope(moduleId)). */
  scope(prefix) {
    return {
      get: (p, fallback) => storage.get(`${prefix}.${p}`, fallback),
      set: (p, v) => storage.set(`${prefix}.${p}`, v),
      remove: (p) => storage.remove(`${prefix}.${p}`),
      all: () => storage.get(prefix, {}),
    };
  },
  isPersistent: () => (load(), persistent),
};

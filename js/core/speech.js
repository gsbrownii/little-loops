// Spoken instructions. Two engines behind one queue:
//
//  1. The VOICE PACK: every line the app can say, recorded in a natural voice
//     (audio/<voice>/index.json + small MP3 clips, made by tools/voice/make_voice.py from the list
//     tools/voice-lines.mjs collects). Used for every line that has a recording. Works offline.
//  2. The device's text-to-speech (speechSynthesis) for anything without a recording (e.g. new
//     content that hasn't been recorded yet), preferring a device voice with the pack's accent.
//     Or for everything, when a grown-up picks a device voice in settings.
//
// say(text | parts[], { interrupt }) — parts are short pieces spoken back to back
// ("Is it", "lake,", "or cat?") so each can have its own clip; a device voice reads them joined.
// Lines play one at a time. An interrupting say() (the default) drops everything queued.
//
// Browser quirks handled:
//  - iOS/Chrome need audio + speech started inside a user gesture -> speech.unlock() on the start tap
//    (one shared <audio> element is unlocked and reused; Web Audio is the fallback if iOS refuses)
//  - Chrome can drop an utterance spoken right after cancel()    -> wait CANCEL_GAP_MS after a cancel
//  - Chrome may garbage-collect an utterance and never fire onend -> strong refs + safety timers
//  - Network voices fail offline                                 -> prefer local voices, fall back on error
import { storage } from './storage.js';
import { audioContext } from './sound.js';

const synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
const ttsSupported = !!synth && typeof window.SpeechSynthesisUtterance === 'function';

/** Device-voice speaking rates (the "Voice speed" setting). */
export const RATES = { slow: 0.75, normal: 0.92, fast: 1.08 };
/** The same setting for recorded clips (pitch is preserved). */
const CLIP_RATES = { slow: 0.8, normal: 0.92, fast: 1.05 }; // recordings are brisk; "normal" is a little slower for young kids
const CANCEL_GAP_MS = 90;
const SILENCE = 'audio/silence.mp3';

const listeners = new Set();
const badVoices = new Set();
const live = new Set(); // strong refs to in-flight utterances (Chrome GC bug)
const missing = new Set(); // keys spoken by the device voice although the pack is on (coverage checks)
// started = clips that began playing; clips = clips played to the end (interrupted ones don't count)
const stats = { started: 0, clips: 0, device: 0, clipErrors: 0, webAudio: 0 }; // for tests and troubleshooting
let speaking = false;
let cachedVoice; // undefined = not chosen yet, null = none available
let lastCancelAt = -Infinity;
let pack = null; // { voice, name, lang, base, lines: Map<key, file> }
const queue = [];
let running = null;
let gen = 0; // bumped by every interrupt / stop
let stopCurrent = null; // aborts whatever the running job is playing

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Normalized lookup key for a spoken line (shared with tools/voice-lines.mjs). */
export function speechKey(text) {
  return String(text)
    .normalize('NFKC')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function setSpeaking(v) {
  if (speaking === v) return;
  speaking = v;
  listeners.forEach((fn) => {
    try { fn(v); } catch { /* ignore listener errors */ }
  });
}

const rateSetting = () => storage.get('settings.rate', 'normal');
const voiceSetting = () => storage.get('settings.voiceURI', '');
/** The pack is used unless a grown-up picked a specific device voice. */
const packActive = () => !!pack && (voiceSetting() === '' || voiceSetting() === 'pack');

// ---------------------------------------------------------------- device voices (text-to-speech)

function englishVoices() {
  if (!ttsSupported) return [];
  let all = [];
  try { all = synth.getVoices() || []; } catch { all = []; }
  return all.filter((v) => /^en([-_]|$)/i.test(v.lang || ''));
}

const PREFERRED = {
  us: [/Samantha/i, /Ava/i, /Allison/i, /Karen/i, /Moira/i, /Tessa/i, /Google US English/i, /Microsoft (Aria|Jenny|Ana|Zira)/i, /Google UK English Female/i],
  gb: [/Serena/i, /Kate/i, /Martha/i, /Stephanie/i, /Google UK English Female/i, /Microsoft (Sonia|Libby|Hazel|Susan)/i, /Daniel/i, /Arthur/i],
};

function chooseVoice() {
  const voices = englishVoices().filter((v) => !badVoices.has(v.voiceURI));
  if (!voices.length) return null;
  const saved = voiceSetting();
  if (saved && saved !== 'pack') {
    const v = voices.find((x) => x.voiceURI === saved);
    if (v) return v;
  }
  // Filling in for the voice pack: match its accent so the switch is less noticeable.
  const gb = pack && /GB/i.test(pack.lang || '');
  const langRe = gb ? /en[-_]GB/i : /en[-_]US/i;
  const local = voices.filter((v) => v.localService !== false);
  for (const pool of [local, voices]) {
    for (const re of gb ? PREFERRED.gb : PREFERRED.us) {
      const v = pool.find((x) => re.test(x.name) && (!gb || langRe.test(x.lang)));
      if (v) return v;
    }
    const sameAccent = pool.find((x) => langRe.test(x.lang));
    if (sameAccent) return sameAccent;
  }
  return local[0] || voices[0];
}

function voice() {
  if (cachedVoice === undefined || (cachedVoice === null && englishVoices().length)) cachedVoice = chooseVoice();
  return cachedVoice;
}

if (ttsSupported) {
  const reset = () => { cachedVoice = undefined; };
  if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', reset);
  else synth.onvoiceschanged = reset;
}
if (typeof document !== 'undefined') {
  // Speech that continues after the app is hidden is confusing; stop it.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) speech.stop();
  });
}

/** Speak one utterance with the device voice. Resolves true when it finished normally. */
function ttsSpeak(text, opts, myGen) {
  if (!ttsSupported) return Promise.resolve(false);
  return new Promise((resolve) => {
    const start = async (attempt) => {
      const gap = CANCEL_GAP_MS - (nowMs() - lastCancelAt);
      if (gap > 0) await wait(gap);
      if (myGen !== gen) return resolve(false);
      const u = new SpeechSynthesisUtterance(text);
      const v = voice();
      if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = pack && /GB/i.test(pack.lang || '') ? 'en-GB' : 'en-US'; }
      u.rate = opts.rate ?? RATES[rateSetting()] ?? RATES.normal;
      u.pitch = opts.pitch ?? 1.05;
      u.volume = 1;
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        live.delete(u);
        stopCurrent = null;
        resolve(ok);
      };
      const safetyMs = Math.round((2500 + text.length * 110) * (RATES.normal / (u.rate || RATES.normal)));
      const timer = setTimeout(() => finish(false), safetyMs);
      u.onend = () => finish(true);
      u.onerror = (e) => {
        const err = e && e.error;
        if (err === 'interrupted' || err === 'canceled') return finish(false);
        // Voice failed (e.g. a network voice while offline): blacklist it and retry once.
        if (v) badVoices.add(v.voiceURI);
        cachedVoice = undefined;
        if (attempt === 0 && myGen === gen) {
          done = true;
          clearTimeout(timer);
          live.delete(u);
          start(1);
        } else finish(false);
      };
      stopCurrent = () => {
        try { synth.cancel(); } catch { /* ignore */ }
        lastCancelAt = nowMs();
        finish(false);
      };
      live.add(u);
      try {
        synth.speak(u);
        if (synth.paused) synth.resume();
      } catch {
        finish(false);
      }
    };
    start(0);
  });
}

// ---------------------------------------------------------------- voice pack (recorded clips)

// A small pool of <audio> elements, all unlocked on the start tap (iOS only lets an element play
// later if it was started inside a tap). While one part plays, the next is already loading in
// another element, so the parts of a line ("Is it", "lake,", "or cat?") follow without gaps.
const POOL_SIZE = 3;
let pool = null;
let poolNext = 0;

function audioPool() {
  if (!pool && typeof Audio === 'function') {
    pool = Array.from({ length: POOL_SIZE }, () => {
      const a = new Audio();
      a.preload = 'auto';
      return a;
    });
  }
  return pool;
}

/** URLs for every part, or null if any part has no recording. */
function clipsFor(parts) {
  if (!packActive()) return null;
  const urls = [];
  for (const p of parts) {
    const file = pack.lines.get(speechKey(p));
    if (!file) return null;
    urls.push(pack.base + file);
  }
  return urls;
}

/** Start loading `url` into `el`. Resolves when it can play (or after a timeout / an error: play() decides). */
function prime(el, url) {
  return new Promise((resolve) => {
    let t = 0;
    const done = () => {
      clearTimeout(t);
      el.removeEventListener('canplaythrough', done);
      el.removeEventListener('canplay', done);
      el.removeEventListener('error', done);
      resolve();
    };
    el.addEventListener('canplaythrough', done);
    el.addEventListener('canplay', done);
    el.addEventListener('error', done);
    t = setTimeout(done, 4000);
    try {
      el.pause();
      el.src = url;
      el.load();
    } catch {
      done();
    }
  });
}

/** Play a primed element to its end. Resolves 'ended' | 'stopped' | 'blocked' | 'error'. */
function playPrimed(el, rate) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
      stopCurrent = null;
      resolve(r);
    };
    const onEnded = () => done('ended');
    const onError = () => done('error');
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);
    stopCurrent = () => {
      try { el.pause(); } catch { /* ignore */ }
      done('stopped');
    };
    const ms = Number.isFinite(el.duration) && el.duration > 0 ? (el.duration / rate) * 1000 + 2500 : 15000;
    timer = setTimeout(() => done('error'), ms);
    try {
      if (el.error) return done('error');
      el.defaultPlaybackRate = rate;
      el.playbackRate = rate;
      el.preservesPitch = true;
      el.webkitPreservesPitch = true;
      el.mozPreservesPitch = true;
      el.currentTime = 0;
      const p = el.play();
      if (p && typeof p.then === 'function') {
        p.then(() => { stats.started++; }, (err) => done(err && err.name === 'NotAllowedError' ? 'blocked' : 'error'));
      } else {
        stats.started++;
      }
    } catch {
      done('error');
    }
  });
}

const decoded = new Map(); // url -> Promise<AudioBuffer>

/** Fallback when the browser refuses <audio> playback: decode and play through Web Audio. */
async function playOnWebAudio(url, rate) {
  const ac = audioContext();
  if (!ac) return 'error';
  try {
    if (!decoded.has(url)) {
      decoded.set(url, fetch(url).then((r) => r.arrayBuffer()).then((b) => new Promise((ok, bad) => ac.decodeAudioData(b, ok, bad))));
    }
    const buf = await decoded.get(url);
    return await new Promise((resolve) => {
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate; // Web Audio can't keep the pitch; only used as a fallback
      src.connect(ac.destination);
      let settled = false;
      const done = (r) => {
        if (settled) return;
        settled = true;
        stopCurrent = null;
        resolve(r);
      };
      src.onended = () => done('ended');
      stopCurrent = () => {
        try { src.stop(); } catch { /* ignore */ }
        done('stopped');
      };
      src.start();
      stats.started++;
    });
  } catch {
    decoded.delete(url);
    return 'error';
  }
}

/** Play clips back to back. Returns { ok, failedAt } (failedAt = index of a clip that failed). */
async function playClips(urls, rate, myGen) {
  const els = audioPool();
  if (!els) return { ok: false, failedAt: 0 };
  const base = poolNext;
  poolNext = (poolNext + urls.length) % POOL_SIZE;
  const elAt = (i) => els[(base + i) % POOL_SIZE];
  const primed = [];
  const primeAt = (i) => { if (i < urls.length && !primed[i]) primed[i] = prime(elAt(i), urls[i]); };
  primeAt(0);
  primeAt(1);
  for (let i = 0; i < urls.length; i++) {
    await primed[i];
    if (myGen !== gen) return { ok: false };
    primeAt(i + 2); // the element that played part i-1 is free again
    let r = await playPrimed(elAt(i), rate);
    if (r === 'blocked' && myGen === gen) { stats.webAudio++; r = await playOnWebAudio(urls[i], rate === CLIP_RATES.normal ? 1 : rate); } // no pitch-safe slowdown there
    if (r === 'stopped' || myGen !== gen) return { ok: false };
    if (r !== 'ended') { stats.clipErrors++; return { ok: false, failedAt: i }; }
    stats.clips++;
  }
  return { ok: true };
}

// ---------------------------------------------------------------- the queue

async function runJob(job) {
  const myGen = job.gen;
  const urls = clipsFor(job.parts);
  if (urls) {
    const rate = CLIP_RATES[rateSetting()] ?? 1;
    const r = await playClips(urls, rate, myGen);
    if (r.ok) return true;
    // A clip failed: say the rest with the device voice rather than going silent.
    if (r.failedAt != null && myGen === gen) return ttsSpeak(job.parts.slice(r.failedAt).join(' '), job.opts, myGen);
    return false;
  }
  if (packActive()) job.parts.forEach((p) => { if (!pack.lines.has(speechKey(p))) missing.add(speechKey(p)); });
  stats.device++;
  return ttsSpeak(job.parts.join(' '), job.opts, myGen);
}

function pump() {
  if (running || !queue.length) {
    if (!running && !queue.length) setSpeaking(false);
    return;
  }
  const job = queue.shift();
  running = job;
  setSpeaking(true);
  runJob(job)
    .catch(() => false)
    .then((ok) => {
      running = null;
      job.resolve(ok);
      pump();
    });
}

/** Drop the queue and stop what is playing. */
function interruptAll() {
  gen++;
  while (queue.length) queue.shift().resolve(false);
  if (stopCurrent) stopCurrent();
  if (ttsSupported && (synth.speaking || synth.pending)) {
    try { synth.cancel(); } catch { /* ignore */ }
    lastCancelAt = nowMs();
  }
  live.clear();
}

export const speech = {
  /** Something can speak: a voice pack is loaded or the device has text-to-speech. */
  get supported() { return ttsSupported || !!pack; },

  /** True while a line is playing (or queued lines are waiting their turn). */
  get speaking() { return speaking; },

  /**
   * Speak `text` (a string, or an array of short parts said back to back).
   * Interrupts anything already speaking unless { interrupt: false }, which queues it.
   * Resolves true when finished, false if interrupted/failed/disabled. Never rejects.
   */
  say(text, opts = {}) {
    const parts = (Array.isArray(text) ? text : [text]).filter((p) => p != null && String(p).trim()).map(String);
    if (!parts.length || !speech.supported) return Promise.resolve(false);
    if (storage.get('settings.voice', true) === false) return Promise.resolve(false);
    if (opts.interrupt !== false) interruptAll();
    return new Promise((resolve) => {
      queue.push({ parts, opts, resolve, gen });
      pump();
    });
  },

  stop() {
    interruptAll();
    setSpeaking(false);
  },

  /** Call synchronously inside the first user gesture (iOS + Chrome autoplay rules). */
  unlock() {
    // Start every pooled <audio> element inside this tap so each may play later (iOS rule).
    for (const a of audioPool() || []) {
      try {
        a.src = new URL(SILENCE, document.baseURI).href;
        const p = a.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch { /* ignore */ }
    }
    if (ttsSupported) {
      try {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        synth.speak(u);
      } catch { /* ignore */ }
    }
  },

  /** Load the voice pack index (audio/<voice>/index.json). Never throws; resolves true if loaded. */
  async loadPack(path) {
    try {
      const url = new URL(path, document.baseURI);
      const r = await fetch(url.href);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const doc = await r.json();
      const lines = new Map(Object.entries(doc.lines || {}).filter(([k, f]) => typeof f === 'string' && /^[a-z0-9]+\.mp3$/.test(f)).map(([k, f]) => [speechKey(k), f]));
      if (!lines.size) return false;
      pack = { voice: doc.voice || '', name: doc.name || 'Little Loops voice', lang: doc.lang || 'en-US', base: new URL('./', url).href, lines };
      cachedVoice = undefined; // fallback voice now prefers the pack's accent
      return true;
    } catch (err) {
      console.warn('Voice pack not loaded; using the device voice.', err && err.message);
      return false;
    }
  },

  /** { name, lang, lines } of the loaded voice pack, or null. */
  packInfo() {
    return pack ? { name: pack.name, lang: pack.lang, lines: pack.lines.size } : null;
  },

  /** Lines spoken with the device voice while the pack was on (missing recordings). */
  missing,

  /** Counters: clips played, lines given to the device voice, clip failures, Web Audio fallbacks. */
  stats,

  /** Subscribe to speaking on/off. Returns an unsubscribe function. */
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** English device voices for the grown-up settings screen. */
  voices() {
    return englishVoices().map((v) => ({ uri: v.voiceURI, name: v.name, lang: v.lang, local: v.localService !== false }));
  },

  /** '' when the voice pack is in use, otherwise the device voice's URI. */
  currentVoiceURI() {
    if (packActive()) return '';
    const v = voice();
    return v ? v.voiceURI : '';
  },

  /** Forget the cached choice (after the grown-up picks a different voice). */
  refreshVoice() { cachedVoice = undefined; },
};

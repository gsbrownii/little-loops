// Spoken instructions via the Web Speech API (speechSynthesis).
// Handles the usual browser quirks:
//  - iOS/Chrome need the first speak() inside a user gesture  -> speech.unlock() on the splash tap
//  - Chrome can drop an utterance spoken right after cancel()  -> nothing is spoken until
//    CANCEL_GAP_MS after the last cancel(), including the one speech.stop() does on a route change
//  - Chrome may garbage-collect an utterance and never fire onend -> keep a strong ref + timeout
//  - Network voices fail offline                                -> prefer local voices, fall back on error
import { storage } from './storage.js';

const synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
const supported = !!synth && typeof window.SpeechSynthesisUtterance === 'function';

export const RATES = { slow: 0.75, normal: 0.92, fast: 1.08 };

const listeners = new Set();
const badVoices = new Set();
let current = null; // the utterance currently speaking (or most recently submitted)
const live = new Set(); // strong refs to every submitted utterance (Chrome GC bug)
let speaking = false;
let cachedVoice; // undefined = not chosen yet, null = none available
let seq = 0;
let pendingStart = null; // resolves when a delayed (post-cancel) utterance is submitted
const CANCEL_GAP_MS = 90;
let lastCancelAt = -Infinity; // performance.now() of the last synth.cancel()
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function setSpeaking(v) {
  if (speaking === v) return;
  speaking = v;
  listeners.forEach((fn) => {
    try { fn(v); } catch { /* ignore listener errors */ }
  });
}

function englishVoices() {
  if (!supported) return [];
  let all = [];
  try { all = synth.getVoices() || []; } catch { all = []; }
  return all.filter((v) => /^en([-_]|$)/i.test(v.lang || ''));
}

const PREFERRED = [
  /Samantha/i, /Ava/i, /Allison/i, /Karen/i, /Moira/i, /Tessa/i,
  /Google US English/i, /Microsoft (Aria|Jenny|Ana|Zira)/i, /Google UK English Female/i,
];

function chooseVoice() {
  const voices = englishVoices().filter((v) => !badVoices.has(v.voiceURI));
  if (!voices.length) return null;
  const saved = storage.get('settings.voiceURI', '');
  if (saved) {
    const v = voices.find((x) => x.voiceURI === saved);
    if (v) return v;
  }
  const local = voices.filter((v) => v.localService !== false);
  for (const pool of [local, voices]) {
    for (const re of PREFERRED) {
      const v = pool.find((x) => re.test(x.name));
      if (v) return v;
    }
    const us = pool.find((x) => /en[-_]US/i.test(x.lang));
    if (us) return us;
  }
  return local[0] || voices[0];
}

function voice() {
  if (cachedVoice === undefined || (cachedVoice === null && englishVoices().length)) cachedVoice = chooseVoice();
  return cachedVoice;
}

if (supported) {
  const reset = () => { cachedVoice = undefined; };
  if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', reset);
  else synth.onvoiceschanged = reset;
  // Speech that continues after the app is hidden is confusing; stop it.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) speech.stop();
  });
}

function speakNow(text, opts, attempt, resolve, waitsInQueue = false) {
  const u = new SpeechSynthesisUtterance(text);
  const v = voice();
  if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'en-US'; }
  u.rate = opts.rate ?? RATES[storage.get('settings.rate', 'normal')] ?? RATES.normal;
  u.pitch = opts.pitch ?? 1.1;
  u.volume = 1;

  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    live.delete(u);
    if (current === u) { current = null; setSpeaking(false); }
    resolve(ok);
  };
  const safetyMs = Math.round((2500 + text.length * 110) * (RATES.normal / (u.rate || RATES.normal)));
  u.onstart = () => {
    if (done) return;
    current = u;
    setSpeaking(true);
    // A queued line's safety clock starts when it actually begins speaking.
    if (waitsInQueue && !done) { clearTimeout(timer); timer = setTimeout(() => finish(false), safetyMs); }
  };
  u.onend = () => finish(true);
  u.onerror = (e) => {
    const err = e && e.error;
    if (err === 'interrupted' || err === 'canceled') return finish(false);
    // Voice failed (e.g. a network voice while offline): blacklist it and retry once.
    if (v) badVoices.add(v.voiceURI);
    cachedVoice = undefined;
    if (attempt === 0 && (current === u || current === null)) {
      done = true;
      clearTimeout(timer);
      live.delete(u);
      speakNow(text, opts, 1, resolve);
    } else finish(false);
  };
  // Safety net: some engines never fire onend. Queued lines get extra time to wait their turn.
  let timer = setTimeout(() => finish(false), waitsInQueue ? safetyMs + 15000 : safetyMs);
  live.add(u);
  if (!waitsInQueue || !current) current = u;
  try {
    synth.speak(u);
    if (synth.paused) synth.resume();
  } catch {
    finish(false);
  }
}

export const speech = {
  supported,

  /** True while an utterance is playing. */
  get speaking() { return speaking; },

  /**
   * Speak `text`. Interrupts anything already speaking unless { interrupt: false }.
   * Resolves true when finished, false if interrupted/failed/disabled. Never rejects.
   */
  say(text, opts = {}) {
    if (!supported || !text) return Promise.resolve(false);
    if (storage.get('settings.voice', true) === false) return Promise.resolve(false);
    // Queued lines ({ interrupt: false }) never cancel an interrupting line that is
    // still waiting out its post-cancel delay; they wait for it to start instead.
    const queued = opts.interrupt === false;
    const mySeq = queued ? seq : ++seq;
    return new Promise((resolve) => {
      const busy = synth.speaking || synth.pending;
      const sinceCancel = nowMs() - lastCancelAt;
      // Start this line after `ms`, as the pending start that queued lines wait for.
      const delayed = (ms, inQueue) => {
        const p = new Promise((started) => {
          setTimeout(() => {
            started();
            if (pendingStart === p) pendingStart = null;
            if (mySeq !== seq) return resolve(false); // a newer interrupting say() (or stop()) won
            speakNow(text, opts, 0, resolve, inQueue && (synth.speaking || synth.pending));
          }, ms);
        });
        pendingStart = p;
      };
      if (!queued && (busy || sinceCancel < CANCEL_GAP_MS)) {
        // Interrupt. cancel() clears speaking/pending at once, so "not busy" right after a
        // cancel (e.g. speech.stop() on a route change) still has to wait out the gap.
        current = null;
        if (busy) {
          synth.cancel();
          lastCancelAt = nowMs();
          delayed(CANCEL_GAP_MS, false);
        } else {
          delayed(Math.max(0, CANCEL_GAP_MS - sinceCancel), false);
        }
      } else if (queued && pendingStart) {
        pendingStart.then(() => (mySeq !== seq ? resolve(false) : speakNow(text, opts, 0, resolve, true)));
      } else if (queued && sinceCancel < CANCEL_GAP_MS) {
        delayed(Math.max(0, CANCEL_GAP_MS - sinceCancel), true);
      } else {
        speakNow(text, opts, 0, resolve, queued && (synth.speaking || synth.pending));
      }
    });
  },

  stop() {
    seq++;
    current = null;
    live.clear();
    pendingStart = null;
    if (supported) {
      try { synth.cancel(); } catch { /* ignore */ }
      lastCancelAt = nowMs();
    }
    setSpeaking(false);
  },

  /** Call synchronously inside the first user gesture (iOS + Chrome autoplay rules). */
  unlock() {
    if (!supported) return;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      synth.speak(u);
    } catch { /* ignore */ }
  },

  /** Subscribe to speaking on/off. Returns an unsubscribe function. */
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** English voices for the grown-up settings screen. */
  voices() {
    return englishVoices().map((v) => ({ uri: v.voiceURI, name: v.name, lang: v.lang, local: v.localService !== false }));
  },

  currentVoiceURI() {
    const v = voice();
    return v ? v.voiceURI : '';
  },

  /** Forget the cached choice (after the grown-up picks a different voice). */
  refreshVoice() { cachedVoice = undefined; },
};

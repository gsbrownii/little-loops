// Sound effects synthesized with Web Audio — no audio files, so nothing to download or cache.
// sound.play('success'). Names: tap, pick, drop, remove, step, bump, tryAgain, success,
// fanfare, fill, locked, unlock, whoosh, select.
import { storage } from './storage.js';

let ac = null;
let master = null;

function ensure() {
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ac = new AC(); } catch { return null; }
    master = ac.createGain();
    master.gain.value = 0.55;
    master.connect(ac.destination);
  }
  if (ac.state !== 'running') ac.resume().catch(() => {});
  return ac;
}

function tone(freq, at, dur, { type = 'sine', vol = 0.22, to = null, attack = 0.012 } = {}) {
  const t0 = ac.currentTime + at;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g);
  g.connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

function noise(at, dur, { vol = 0.15, freq = 800, to = null } = {}) {
  const t0 = ac.currentTime + at;
  const len = Math.max(1, Math.floor(ac.sampleRate * dur));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const f = ac.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.setValueAtTime(freq, t0);
  if (to) f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f);
  f.connect(g);
  g.connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

function sparkle(at) {
  [1568, 2093, 2637].forEach((f, i) => tone(f, at + i * 0.06, 0.18, { type: 'sine', vol: 0.08 }));
}

const LIB = {
  tap: () => tone(740, 0, 0.07, { type: 'triangle', vol: 0.16 }),
  select: () => tone(660, 0, 0.1, { type: 'triangle', vol: 0.18, to: 990 }),
  pick: () => tone(587, 0, 0.09, { type: 'triangle', vol: 0.18, to: 880 }),
  drop: () => { tone(880, 0, 0.08, { vol: 0.22, to: 1320 }); tone(1320, 0.06, 0.08, { vol: 0.1 }); },
  remove: () => tone(620, 0, 0.16, { vol: 0.2, to: 200 }),
  step: () => tone(392, 0, 0.1, { type: 'square', vol: 0.05, to: 523 }),
  bump: () => { tone(150, 0, 0.25, { vol: 0.42, to: 70 }); noise(0, 0.12, { vol: 0.12, freq: 300 }); },
  tryAgain: () => { tone(494, 0, 0.16, { type: 'triangle', vol: 0.2 }); tone(392, 0.17, 0.3, { type: 'triangle', vol: 0.2 }); },
  success: () => {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.09, 0.3, { type: 'triangle', vol: 0.2 }));
    sparkle(0.38);
  },
  fanfare: () => {
    const notes = [523.25, 523.25, 659.25, 783.99, 659.25, 783.99, 1046.5];
    const times = [0, 0.12, 0.24, 0.36, 0.56, 0.68, 0.84];
    notes.forEach((f, i) => tone(f, times[i], i === notes.length - 1 ? 0.6 : 0.16, { type: 'triangle', vol: 0.22 }));
    sparkle(1.0);
  },
  fill: () => { tone(300, 0, 0.14, { vol: 0.2, to: 620 }); noise(0, 0.08, { vol: 0.05, freq: 2000 }); },
  locked: () => { tone(392, 0, 0.12, { type: 'triangle', vol: 0.16 }); tone(370, 0.15, 0.16, { type: 'triangle', vol: 0.16 }); },
  unlock: () => [440, 554.37, 659.25].forEach((f, i) => tone(f, i * 0.07, 0.16, { type: 'triangle', vol: 0.18 })),
  whoosh: () => noise(0, 0.3, { vol: 0.12, freq: 400, to: 2400 }),
};

export const sound = {
  play(name) {
    if (storage.get('settings.sound', true) === false) return;
    if (!LIB[name] || !ensure()) return;
    try { LIB[name](); } catch { /* audio is best-effort */ }
  },

  /** Call synchronously inside the first user gesture. */
  unlock() {
    const a = ensure();
    if (!a) return;
    try {
      const b = a.createBuffer(1, 1, 22050);
      const s = a.createBufferSource();
      s.buffer = b;
      s.connect(a.destination);
      s.start(0);
    } catch { /* ignore */ }
    // iOS 17+: let sounds play even when the ring/silent switch is on (instructions are essential).
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* ignore */ }
  },
};

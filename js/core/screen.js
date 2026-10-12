// The persistent top bar: [home/back] [module actions…] [caption] [replay-audio].
// Every screen sets an instruction; the replay button speaks it again.
import { h, icon, flash } from './dom.js';
import { speech } from './speech.js';
import { sound } from './sound.js';

export function createChrome(topbar, { go }) {
  const backBtn = h('button', { class: 'btn-round topbar-back', type: 'button', 'aria-label': 'Home' }, icon('home'));
  const actions = h('div', { class: 'topbar-actions' });
  const caption = h('div', { class: 'topbar-caption', 'aria-live': 'polite' });
  const replayBtn = h('button', { class: 'btn-round topbar-replay', type: 'button', 'aria-label': 'Say it again' }, icon('speaker'));
  topbar.replaceChildren(backBtn, actions, caption, replayBtn);

  let instruction = ''; // the caption text
  let instructionParts = []; // the same line as speech parts (what replay says)
  let back = null;

  backBtn.addEventListener('click', () => {
    if (!back) return;
    sound.play('tap');
    if (typeof back.to === 'function') back.to();
    else go(back.to);
  });

  replayBtn.addEventListener('click', () => chrome.replay());
  speech.onChange((on) => replayBtn.classList.toggle('is-speaking', on));

  // speech.js drops lines asked for while the app is hidden (e.g. a win line from a game timer).
  // When the app is shown again, say the current instruction so a child who can't read still
  // hears what to do next.
  let droppedAtHide = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      droppedAtHide = speech.stats.hidden;
      return;
    }
    if (speech.stats.hidden > droppedAtHide && !speech.speaking) chrome.replay();
  });

  const chrome = {
    /**
     * setBack({ icon: 'home' | 'back', to: '#/robot' | () => void, label }) or setBack(null) to hide.
     */
    setBack(opt) {
      back = opt || null;
      backBtn.hidden = !back;
      if (back) {
        backBtn.replaceChildren(icon(back.icon || 'home'));
        backBtn.setAttribute('aria-label', back.label || (back.icon === 'back' ? 'Back' : 'Home'));
      }
    },

    /** Extra buttons shown next to the back button (e.g. settings gear on home). */
    setActions(nodes = []) {
      actions.replaceChildren(...nodes);
    },

    /**
     * Set (and by default speak) the current screen's instruction. `text` is a string or an
     * array of speech parts (['Woo-hoo!', 'Tap the green arrow for the next puzzle!']): the caption
     * shows them joined, and speech and the replay button say each part's own recording.
     */
    setInstruction(text, { speak = true } = {}) {
      instructionParts = (Array.isArray(text) ? text : [text]).filter((p) => p != null && String(p).trim()).map(String);
      instruction = instructionParts.join(' ');
      caption.textContent = instruction;
      if (speak && instructionParts.length) return speech.say(instructionParts);
      return Promise.resolve(false);
    },

    /** The caption text (always a string, also when it was set as parts). */
    get instruction() { return instruction; },

    replay() {
      if (!instruction) return;
      if (!speech.supported) {
        flash(replayBtn, 'wobble');
        return;
      }
      speech.say(instructionParts);
    },

    reset() {
      instruction = '';
      instructionParts = [];
      caption.textContent = '';
      actions.replaceChildren();
      chrome.setBack({ icon: 'home', to: '#/' });
    },
  };
  chrome.reset();
  return chrome;
}

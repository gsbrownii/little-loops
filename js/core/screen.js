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

  let instruction = '';
  let back = null;

  backBtn.addEventListener('click', () => {
    if (!back) return;
    sound.play('tap');
    if (typeof back.to === 'function') back.to();
    else go(back.to);
  });

  replayBtn.addEventListener('click', () => chrome.replay());
  speech.onChange((on) => replayBtn.classList.toggle('is-speaking', on));

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

    /** Set (and by default speak) the current screen's instruction. */
    setInstruction(text, { speak = true } = {}) {
      instruction = text || '';
      caption.textContent = instruction;
      if (speak && instruction) return speech.say(instruction);
      return Promise.resolve(false);
    },

    get instruction() { return instruction; },

    replay() {
      if (!instruction) return;
      if (!speech.supported) {
        flash(replayBtn, 'wobble');
        return;
      }
      speech.say(instruction);
    },

    reset() {
      instruction = '';
      caption.textContent = '';
      actions.replaceChildren();
      chrome.setBack({ icon: 'home', to: '#/' });
    },
  };
  chrome.reset();
  return chrome;
}

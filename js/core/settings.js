// Grown-up settings screen (only reachable through the parent gate).
// Modules can add their own options by exporting `settings` on their default export:
//   settings: [{ key: 'unlockAll', label: 'Unlock all puzzle levels', type: 'toggle', default: false }]
// Values are stored in the module's storage scope (storage.scope(moduleId)).
//
// The page is drawn at once with the core sections; each game's section is filled in as its code
// arrives (games load in parallel, and only the first time). "Reset progress" waits for them, so
// it always knows which game settings to keep.
import { APP } from '../config.js';
import { h, icon, wait } from './dom.js';
import { storage } from './storage.js';
import { speech, RATES } from './speech.js';
import { sound } from './sound.js';
import { install } from './pwa.js';
import { assetURL } from './data.js';

function toggle(label, get, set, hint) {
  const input = h('input', { type: 'checkbox', class: 'switch-input' });
  input.checked = !!get();
  input.addEventListener('change', () => { set(input.checked); sound.play('tap'); });
  return h('label', { class: 'set-row' },
    h('span', { class: 'set-label' }, label, hint ? h('small', null, hint) : null),
    h('span', { class: 'switch' }, input, h('span', { class: 'switch-track' }))
  );
}

function segmented(label, options, get, set) {
  const wrap = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
  const render = () => {
    wrap.replaceChildren(
      ...options.map(([value, text]) =>
        h('button', {
          type: 'button',
          role: 'radio',
          'aria-checked': String(get() === value),
          class: get() === value ? 'is-on' : '',
          onClick: () => { set(value); render(); },
        }, text)
      )
    );
  };
  render();
  return h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, label), wrap);
}

function section(title, ...rows) {
  return h('section', { class: 'set-section' }, h('h2', null, title), ...rows);
}

export function renderSettings(root, { chrome, registry, go }) {
  chrome.setBack({ icon: 'home', to: '#/' });
  chrome.setInstruction('Settings for grown-ups.', { speak: false });
  let alive = true;

  const voiceSelect = h('select', { class: 'set-select', 'aria-label': 'Voice' });
  // An online ("needs internet") voice sends the spoken words to its provider: say so.
  const voiceNote = h('p', { class: 'set-note set-voice-note', hidden: true },
    'This voice is online: it needs internet, and the browser sends the spoken words to its provider. ' +
    'Choose a voice without “needs internet” to keep speech on this device. If every voice needs internet, this device has no built-in English voice.');
  const updateVoiceNote = (voices = speech.voices(), cur = speech.currentVoiceURI()) => {
    const v = voices.find((x) => x.uri === cur);
    voiceNote.hidden = !(v && v.local === false);
  };
  const fillVoices = () => {
    const voices = speech.voices();
    const cur = speech.currentVoiceURI();
    const pack = speech.packInfo();
    // The recorded Little Loops voice comes first (value ''); device voices follow.
    const first = h('option', { value: '' }, pack ? `${pack.name}: Little Loops voice (works offline)` : 'Automatic');
    first.selected = cur === '';
    voiceSelect.replaceChildren(
      first,
      ...voices.map((v) => {
        const o = h('option', { value: v.uri }, `Device: ${v.name} (${v.lang})${v.local ? '' : ' — needs internet'}`);
        o.selected = cur !== '' && v.uri === cur;
        return o;
      })
    );
    updateVoiceNote(voices, cur);
  };
  fillVoices();
  voiceSelect.addEventListener('change', () => {
    storage.set('settings.voiceURI', voiceSelect.value);
    speech.refreshVoice();
    updateVoiceNote();
    speech.say('Hi! This is my voice.');
  });
  // Voices often arrive late on Chrome/Android.
  const voiceRetry = setTimeout(fillVoices, 800);

  const speechRows = speech.supported
    ? [
        toggle('Spoken instructions', () => storage.get('settings.voice', true), (v) => { storage.set('settings.voice', v); if (!v) speech.stop(); }),
        segmented('Voice speed', [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']],
          () => storage.get('settings.rate', 'normal'),
          (v) => { storage.set('settings.rate', v); speech.say('This is how fast I talk.', { rate: RATES[v] }); }),
        h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Voice'), voiceSelect),
        voiceNote,
        h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, ''),
          h('button', { type: 'button', class: 'btn-pill', onClick: () => speech.say('Hi! Let’s play and learn together.') }, icon('speaker'), 'Test voice')),
      ]
    : [h('p', { class: 'set-note' }, 'This browser cannot speak instructions. Try Safari (iPad/iPhone) or Chrome (Android) for the full experience.')];

  // Module-provided settings (their paths survive "Reset progress"). Each game gets a slot in
  // registry order, filled when its code arrives, whatever order the imports finish in.
  const ready = (registry?.modules || []).filter((x) => x.status === 'ready' && x.entry);
  const slots = ready.map(() => h('div', { class: 'set-module-slot' }));
  const keepOnReset = [];
  const known = new Set(); // games whose settings list we have seen
  const modulesLoaded = Promise.allSettled(ready.map(async (m, i) => {
    const mod = (await import(assetURL(m.entry))).default;
    known.add(m.id);
    if (!mod?.settings?.length) return;
    const scope = storage.scope(m.id);
    mod.settings.forEach((s) => keepOnReset.push(`${m.id}.${s.key}`));
    if (alive) {
      slots[i].replaceWith(
        section(m.title, ...mod.settings.map((s) => toggle(s.label, () => scope.get(s.key, s.default ?? false), (v) => scope.set(s.key, v), s.hint)))
      );
    }
  })).then((results) => results.forEach((r, i) => {
    if (r.status === 'rejected') console.warn('Settings: could not load module', ready[i].id, r.reason);
  }));

  const installBtn = h('button', { type: 'button', class: 'btn-pill', onClick: async () => { await install.prompt(); renderInstall(); } }, 'Install app');
  const installRow = h('div', { class: 'set-row' });
  const renderInstall = () => {
    if (install.isStandalone()) installRow.replaceChildren(h('span', { class: 'set-label' }, 'Installed', h('small', null, 'Running as an app.')));
    else if (install.available()) installRow.replaceChildren(h('span', { class: 'set-label' }, 'Install', h('small', null, 'Adds an icon to your home screen and works offline.')), installBtn);
    else installRow.replaceChildren(h('span', { class: 'set-label' }, 'Install', h('small', null, 'iPad/iPhone: tap Share, then “Add to Home Screen”. Android: browser menu → “Install app”.')));
  };
  renderInstall();
  const offInstall = install.onChange(renderInstall);

  const resetBtn = h('button', {
    type: 'button',
    class: 'btn-pill btn-danger',
    onClick: async () => {
      if (!window.confirm('Reset all progress? Puzzle stars and saved pictures will be cleared.')) return;
      resetBtn.disabled = true;
      // Know every game's settings first, so none of them is wiped (bounded: a stalled download
      // must not leave the button stuck). A game whose code could not be loaded keeps its saved
      // data rather than losing settings we cannot see.
      await Promise.race([modulesLoaded, wait(10000)]);
      const unknown = ready.filter((m) => !known.has(m.id)).map((m) => m.id);
      storage.resetProgress([...keepOnReset, ...unknown]);
      sound.play('remove');
      resetBtn.textContent = 'Progress cleared';
    },
  }, icon('trash'), 'Reset progress');

  const page = h('div', { class: 'settings scroll' },
    h('h1', null, 'Grown-up settings'),
    section('Sound', ...speechRows,
      toggle('Sound effects', () => storage.get('settings.sound', true), (v) => storage.set('settings.sound', v))),
    ...slots,
    section('App', installRow,
      h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Progress', h('small', null, storage.isPersistent() ? 'Saved on this device only.' : 'This browser is not saving progress (private mode?).')), resetBtn)),
    section('Privacy',
      h('p', { class: 'set-note' }, `${APP.name} has no accounts, no ads and no tracking, and collects no data itself. Progress is saved only on this device. After the first visit it works offline.`),
      h('p', { class: 'set-note' }, 'Spoken instructions use the recorded Little Loops voice, which is part of the app and plays on this device. If you pick a device voice instead (or a new line has no recording yet), this device’s text-to-speech speaks; with a voice marked “needs internet”, the browser sends the spoken words to that voice provider (for example Google or Microsoft).')),
    h('p', { class: 'set-version' }, `${APP.name} v${APP.version}`),
    h('div', { class: 'set-done' }, h('button', { type: 'button', class: 'btn-big btn-go', 'aria-label': 'Done', onClick: () => go('#/') }, icon('check')))
  );
  root.replaceChildren(page);

  return () => { alive = false; clearTimeout(voiceRetry); offInstall(); };
}

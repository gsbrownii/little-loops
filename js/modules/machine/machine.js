// Loop Machine — module entry (see docs/ARCHITECTURE.md, "Module spec: Loop Machine").
//   #/machine          tier picker (little / big / super)
//   #/machine/<tier>   a session of rounds from that tier
// Tokens: tokens.js (pure). Round data + session builder: rounds.js (pure).
// Screens: picker.js, session.js. DOM pieces: view.js. Art: art.js.
import { prepareData } from './rounds.js';
import { mountPicker } from './picker.js';
import { mountSession } from './session.js';

let prepared = null; // { src, data } — loadJSON caches the file, so re-prepare only when it changes

async function loadData(ctx) {
  const src = await ctx.loadJSON('data/machine/rounds.json');
  if (!prepared || prepared.src !== src) prepared = { src, data: prepareData(src) };
  return prepared.data;
}

export default {
  id: 'machine',

  settings: [
    { key: 'readAloud', label: 'Read word answers aloud', type: 'toggle', default: false, hint: 'For Big and Super machines' },
  ],

  async mount(root, ctx) {
    const data = await loadData(ctx);
    if (!ctx.isActive()) return undefined;

    const p = ctx.params[0];
    if (p == null || p === '') return mountPicker(root, ctx, data);

    const tier = data.tiers.find((t) => t.id === p);
    if (!tier || ctx.params.length > 1) {
      ctx.navigate('#/machine', { replace: true });
      return undefined;
    }
    return mountSession(root, ctx, data, tier);
  },
};

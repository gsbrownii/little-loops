// Coloring module entry (see "Module spec: Coloring" in docs/ARCHITECTURE.md).
//   #/coloring        "Make a picture" wizard (animal -> accessory -> background)  -> wizard.js
//   #/coloring/paint  paint the picture, undo, print (grown-ups)                    -> paint.js
// All art is data (data/coloring/*.json) drawn only by scene.js; parts.js loads + validates it.
import { loadParts } from './parts.js';
import { mountWizard } from './wizard.js';
import { mountPaint } from './paint.js';

// One-shot note handed from the wizard to the paint screen across the route change
// (e.g. "this picture came from the surprise button"). Consumed on the next mount.
let handoff = null;

export default {
  id: 'coloring',

  async mount(root, ctx) {
    const note = handoff || {};
    handoff = null;
    const [view] = ctx.params;
    if (view && view !== 'paint') {
      ctx.navigate('#/coloring', { replace: true });
      return;
    }
    const parts = await loadParts(ctx.loadJSON);
    if (!ctx.isActive()) return;
    if (view === 'paint') {
      mountPaint(root, ctx, parts, note);
    } else {
      mountWizard(root, ctx, parts, { onSurprise: () => { handoff = { surprise: true }; } });
    }
  },
};

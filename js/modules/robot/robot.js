// Robot Puzzles — module entry (see docs/ARCHITECTURE.md, "Module spec: Robot Puzzles").
//   #/robot      level select
//   #/robot/<n>  puzzle n (1-based); a locked puzzle redirects to the level select
// Rules: logic.js (pure). Strip model: program.js. Art: art.js. Screens: select.js, puzzle.js.
// Levels come from data/robot/levels.json and are sanitized in levels.js.
import { loadLevels, isUnlocked } from './levels.js';
import { mountLevelSelect } from './select.js';
import { mountPuzzle } from './puzzle.js';

export default {
  id: 'robot',

  settings: [
    { key: 'unlockAll', label: 'Unlock all puzzle levels', type: 'toggle', default: false, hint: 'Lets a child jump to any puzzle.' },
  ],

  async mount(root, ctx) {
    const data = await loadLevels(ctx);
    if (!ctx.isActive()) return undefined;

    const p = ctx.params[0];
    if (p == null || p === '') return mountLevelSelect(root, ctx, data);

    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > data.levels.length || String(n) !== p) {
      ctx.navigate('#/robot', { replace: true });
      return undefined;
    }
    // The lock is enforced on every route in, not just on the level select: Back/history
    // (e.g. after a grown-up resets progress or turns "Unlock all" off), bookmarks and links
    // must not open a puzzle that is still locked. replace: true keeps Back from looping.
    if (!isUnlocked(ctx.store, data.levels, n - 1)) {
      ctx.navigate('#/robot', { replace: true });
      return undefined;
    }
    return mountPuzzle(root, ctx, data, n);
  },
};

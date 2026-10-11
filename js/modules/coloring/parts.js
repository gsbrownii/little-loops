// Coloring content + the saved picture. Content is data: the three JSON files are loaded,
// every part is checked with validatePart() (broken / AI-generated junk is skipped with a
// console.warn), and nothing here knows how many parts there are.
//
// Saved state (ctx.store, i.e. localStorage "coloring.*"):
//   picture:  the current picture
//             { animal: id, accessory: id|null, background: id|null, fills: { regionKey: '#RRGGBB' }, done: bool }
//   previous: the last coloured picture (same shape). Starting a new picture (wizard or dice)
//             keeps it here so the wizard's "Keep painting" button can bring it back.
//             See choosePicture() / resumePicture().
//   color:    the last picked palette colour (paint.js)
// "Reset progress" (grown-up settings) wipes the whole "coloring" scope, "previous" included.
import { validatePart, regionKeys, DEFAULT_PLACEMENT } from './scene.js';
import { WHITE } from './colors.js';

export const FILES = {
  animal: 'data/coloring/animals.json',
  accessory: 'data/coloring/accessories.json',
  background: 'data/coloring/backgrounds.json',
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const KEY_PICTURE = 'picture';
const KEY_PREVIOUS = 'previous';

// One bad part never takes the screen down: anything validatePart() rejects, or that makes it
// (or the checks below) throw, is skipped with a console.warn and the rest still load.
function cleanList(doc, kind) {
  const items = doc && Array.isArray(doc.items) ? doc.items : [];
  const seen = new Set();
  const out = [];
  items.forEach((item, i) => {
    try {
      const errs = validatePart(item, kind);
      if (!Array.isArray(errs)) throw new Error('validator gave no answer');
      if (errs.length) {
        console.warn(`[coloring] skipping ${kind} #${i}: ${errs.join('; ')}`);
        return;
      }
      if (seen.has(item.id)) {
        console.warn(`[coloring] skipping duplicate ${kind} id "${item.id}"`);
        return;
      }
      seen.add(item.id);
      out.push(item);
    } catch (err) {
      console.warn(`[coloring] skipping ${kind} #${i}: could not check it`, err);
    }
  });
  return out;
}

function cleanPlacement(p) {
  const n = (v, d) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);
  if (!p || typeof p !== 'object') return { ...DEFAULT_PLACEMENT };
  const scale = n(p.scale, DEFAULT_PLACEMENT.scale);
  return {
    x: n(p.x, DEFAULT_PLACEMENT.x),
    y: n(p.y, DEFAULT_PLACEMENT.y),
    scale: scale > 0 ? scale : DEFAULT_PLACEMENT.scale,
  };
}

/** Load + validate all parts. Throws only when there is nothing at all to draw. */
export async function loadParts(loadJSON) {
  const load = (path) => loadJSON(path).catch((err) => {
    console.warn(`[coloring] could not load ${path}`, err);
    return null;
  });
  const [a, c, b] = await Promise.all([load(FILES.animal), load(FILES.accessory), load(FILES.background)]);
  const animals = cleanList(a, 'animal');
  const accessories = animals.length ? cleanList(c, 'accessory') : []; // accessories need an animal
  const backgrounds = cleanList(b, 'background');
  if (!animals.length && !backgrounds.length) throw new Error('No coloring art available');
  return { animals, accessories, backgrounds, placement: cleanPlacement(a && a.placement) };
}

/** The line spoken when a part is picked: its own `say` from the JSON, else "<name>!". */
export function sayOf(item) {
  if (!item) return '';
  if (typeof item.say === 'string' && item.say.trim()) return item.say.trim();
  return `${item.name}!`;
}

const byId = (list, id) => (id == null ? null : list.find((x) => x.id === id) || null);

/** Picture = { animal, accessory, background } part objects; unknown ids fall back to the first item. */
export function resolvePicture(parts, ids = {}) {
  return {
    animal: byId(parts.animals, ids.animal) || parts.animals[0] || null,
    accessory: byId(parts.accessories, ids.accessory) || parts.accessories[0] || null,
    background: byId(parts.backgrounds, ids.background) || parts.backgrounds[0] || null,
  };
}

export function pictureIds(pic) {
  return {
    animal: pic.animal ? pic.animal.id : null,
    accessory: pic.animal && pic.accessory ? pic.accessory.id : null,
    background: pic.background ? pic.background.id : null,
  };
}

export function sameCombo(a, b) {
  const x = pictureIds(a);
  const y = pictureIds(b);
  return x.animal === y.animal && x.accessory === y.accessory && x.background === y.background;
}

/** Options for renderScene / regionKeys (scene.js). */
export function sceneParts(parts, pic) {
  return {
    animal: pic.animal || undefined,
    accessory: (pic.animal && pic.accessory) || undefined,
    background: pic.background || undefined,
    placement: parts.placement,
  };
}

/** Keep only fills for regions that exist in this scene, with valid colours (white = unfilled). */
export function cleanFills(fills, keys) {
  const out = {};
  if (!fills || typeof fills !== 'object') return out;
  for (const k of keys) {
    const v = fills[k];
    if (typeof v === 'string' && HEX.test(v) && v.toUpperCase() !== WHITE) out[k] = v.toUpperCase();
  }
  return out;
}

/** The saved picture (resolved against the current content), or null if none was saved. */
export function readSaved(store, parts) {
  const raw = store.get(KEY_PICTURE, null);
  if (!raw || typeof raw !== 'object') return null;
  const pic = resolvePicture(parts, raw);
  const keys = regionKeys(sceneParts(parts, pic));
  return { pic, fills: cleanFills(raw.fills, keys), done: raw.done === true };
}

export function writeSaved(store, pic, fills, done = false) {
  store.set(KEY_PICTURE, { ...pictureIds(pic), fills: { ...fills }, done: !!done });
}

export function hasSaved(store) {
  const raw = store.get(KEY_PICTURE, null);
  return !!raw && typeof raw === 'object';
}

/** Does a stored picture (raw, as saved) have any real colour in it? White counts as unfilled. */
function hasColour(raw) {
  if (!raw || typeof raw !== 'object' || !raw.fills || typeof raw.fills !== 'object') return false;
  return Object.values(raw.fills).some((v) => typeof v === 'string' && HEX.test(v) && v.toUpperCase() !== WHITE);
}

/** Is a coloured picture kept under "previous" (waiting for "Keep painting")? */
export function hasPrevious(store) {
  return hasColour(store.get(KEY_PREVIOUS, null));
}

/**
 * Make `pic` the current picture, always as a fresh, uncoloured copy ("New picture" means new,
 * even for the same animal + accessory + place). The painting being left is not thrown away: if
 * the outgoing picture has any colour, it is first kept under "previous" (one slot, so it takes
 * the place of an older kept painting), and the wizard's "Keep painting" button brings it back
 * (resumePicture). An uncoloured outgoing picture never replaces "previous", so pressing the dice
 * again and again, or picking again in the wizard, keeps the painting safe.
 */
export function choosePicture(store, pic) {
  const raw = store.get(KEY_PICTURE, null);
  if (hasColour(raw)) store.set(KEY_PREVIOUS, { ...raw, fills: { ...raw.fills } });
  writeSaved(store, pic, {}, false);
}

/**
 * "Keep painting": when the current picture has no colour yet (a fresh pick nobody painted) and a
 * coloured picture is kept under "previous", that one becomes the current picture again, exactly
 * as it was (fills and `done`, so the celebration does not repeat). The blank pick is dropped,
 * which loses nothing. Otherwise the current picture stays as it is.
 */
export function resumePicture(store) {
  const prev = store.get(KEY_PREVIOUS, null);
  if (!hasColour(prev) || hasColour(store.get(KEY_PICTURE, null))) return;
  store.set(KEY_PICTURE, { ...prev, fills: { ...prev.fills } });
  store.remove(KEY_PREVIOUS);
}

const rand = (list) => (list.length ? list[Math.floor(Math.random() * list.length)] : null);

/** A random combination, different from `avoid` when more than one exists. */
export function randomPicture(parts, avoid = null) {
  const combos = Math.max(1, parts.animals.length) * Math.max(1, parts.accessories.length) * Math.max(1, parts.backgrounds.length);
  let pic;
  for (let i = 0; i < 12; i++) {
    pic = { animal: rand(parts.animals), accessory: rand(parts.accessories), background: rand(parts.backgrounds) };
    if (!avoid || combos < 2 || !sameCombo(pic, avoid)) break;
  }
  return pic;
}

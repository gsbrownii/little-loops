#!/usr/bin/env node
// Check ALL Little Loops content in one go (run before every commit / deploy, and on any
// AI-generated content before it is used). Zero dependencies.
//
//   node tools/validate.mjs              # the app this file lives in
//   node tools/validate.mjs --root DIR   # another copy of the app (e.g. a folder with generated content)
//   options:  --quiet   only problems and the result line
//             --json    machine-readable result: { ok, errors, warnings, sections: [...] }
//
// Sections:
//   1. Data files      every data/**/*.json parses (BOM tolerated with a warning)
//   2. Registry        data/app.json: ids unique + valid, status ready|locked, files exist, paths relative
//   3. Robot levels    tools/validate-levels.mjs (validateLevels) on data/robot/*.json + any robot-levels/1 file
//   4. Loop Machine    tools/validate-machine.mjs (validateMachine) on data/machine/*.json + any machine-rounds/1 file
//                      (3 and 4 come from RULE_VALIDATORS; a validator file that is absent is SKIPPED with a
//                      warning, one that exists but cannot be loaded is an ERROR)
//   5. Coloring art    tools/validate-art.mjs (validateArt) on data/coloring/{animals,accessories,backgrounds}.json
//   6. Stories         DRAFT format (story-draft/1): cross-references to coloring ids, timeline rules
//   7. Schemas         schemas/*.schema.json are sound, and every data file conforms to the JSON Schema of
//                      its format (2020-12 subset checker below)
//   8. Offline cache   sw.js precache list is up to date (warning only: run node tools/precache.mjs)
//  10. Recorded voice  every line the app can speak has a clip in the voice pack (warning only:
//                      a line without one is spoken by the device voice; run npm run voice)
//   9. Spoken text     every say / hint / explain / lockedSay / story line in every content file:
//                      emoji (and, for robot levels, < > { }) are ERRORS; scolding words and British
//                      spellings are WARNINGS (see docs/CONTENT-FORMAT.md section 2)
//
// A file's format comes from WHERE it is (CONTENT_PLACES: data/robot/ = robot-levels/1, ...), not
// only from its "schema" field, so a typo there is an error and never switches the checks off.
// Every section runs in its own guard: a crash inside one check FAILs that section, never the run.
// Exit code 1 if there is any ERROR; warnings never fail.
// Reusable: import { checkSchema, lintSchema, validateRegistry, validateStories, checkSpokenText, runAll } from './validate.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateArt, formatArtReport } from './validate-art.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');

// =============================================================================================
// Minimal JSON Schema 2020-12 checker (the subset used by schemas/*.schema.json).
// Unsupported keywords are REPORTED (never silently ignored), so a schema can't pass by accident.

const ANNOTATION_KEYWORDS = new Set([
  '$schema', '$id', '$comment', '$defs', 'definitions', '$anchor', 'title', 'description', 'default',
  'examples', 'deprecated', 'readOnly', 'writeOnly', 'format', 'contentMediaType', 'contentEncoding',
]);
const VALIDATION_KEYWORDS = new Set([
  '$ref', 'type', 'enum', 'const',
  'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems', 'contains', 'minContains', 'maxContains',
  'properties', 'required', 'additionalProperties', 'patternProperties', 'propertyNames',
  'minProperties', 'maxProperties', 'dependentRequired',
  'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else',
]);
const TYPES = ['null', 'boolean', 'object', 'array', 'number', 'integer', 'string'];

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
function isType(v, t) {
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (t === 'integer') return Number.isInteger(v);
  if (t === 'object') return isObj(v);
  return typeOf(v) === t;
}
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const deepEq = (a, b) => canon(a) === canon(b);
const short = (v) => {
  const s = JSON.stringify(v);
  return s && s.length > 40 ? `${s.slice(0, 37)}...` : s;
};
const ptrEsc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');

function resolveRef(root, ref) {
  if (ref === '#') return root;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) throw new Error(`only local $ref "#/..." is supported, got ${JSON.stringify(ref)}`);
  let node = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, key)) throw new Error(`$ref ${ref} does not resolve`);
    node = node[key];
  }
  return node;
}

const regexCache = new Map();
function re(pattern) {
  if (!regexCache.has(pattern)) regexCache.set(pattern, new RegExp(pattern, 'u'));
  return regexCache.get(pattern);
}

/**
 * Validate `data` against `schema` (2020-12 subset). Returns an array of messages like
 * "/items/2/shapes/0/r: must be > 0". Empty array = valid.
 */
export function checkSchema(schema, data, root = schema) {
  return validateNode(schema, data, '', root);
}

function validateNode(schema, value, at, root) {
  if (schema === true || schema === undefined) return [];
  const where = at || '/';
  if (schema === false) return [`${where}: is not allowed here`];
  const errs = [];
  const e = (m) => errs.push(`${where}: ${m}`);
  for (const k of Object.keys(schema)) {
    if (!ANNOTATION_KEYWORDS.has(k) && !VALIDATION_KEYWORDS.has(k)) e(`(schema problem) unsupported keyword "${k}"`);
  }
  if (schema.$ref !== undefined) {
    let target;
    try { target = resolveRef(root, schema.$ref); } catch (err) { e(`(schema problem) ${err.message}`); }
    if (target !== undefined) errs.push(...validateNode(target, value, at, root));
  }
  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some((t) => isType(value, t))) {
      e(`must be ${types.join(' or ')}, got ${typeOf(value)}${value !== null && typeof value !== 'object' ? ` ${short(value)}` : ''}`);
      return errs; // the other keywords would only add noise
    }
  }
  if (Object.hasOwn(schema, 'const') && !deepEq(value, schema.const)) e(`must be ${short(schema.const)}, got ${short(value)}`);
  if (schema.enum && !schema.enum.some((v) => deepEq(v, value))) e(`must be one of ${schema.enum.map(short).join(', ')}, got ${short(value)}`);

  if (typeof value === 'string') {
    const len = [...value].length;
    if (schema.minLength !== undefined && len < schema.minLength) e(`must have at least ${schema.minLength} character(s)`);
    if (schema.maxLength !== undefined && len > schema.maxLength) e(`must have at most ${schema.maxLength} characters (has ${len})`);
    if (schema.pattern !== undefined) {
      try {
        if (!re(schema.pattern).test(value)) e(`${short(value)} does not match the pattern ${schema.pattern}`);
      } catch (err) { e(`(schema problem) bad pattern: ${err.message}`); }
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) e(`must be >= ${schema.minimum}, got ${value}`);
    if (schema.maximum !== undefined && value > schema.maximum) e(`must be <= ${schema.maximum}, got ${value}`);
    if (schema.exclusiveMinimum !== undefined && !(value > schema.exclusiveMinimum)) e(`must be > ${schema.exclusiveMinimum}, got ${value}`);
    if (schema.exclusiveMaximum !== undefined && !(value < schema.exclusiveMaximum)) e(`must be < ${schema.exclusiveMaximum}, got ${value}`);
    if (schema.multipleOf !== undefined && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) e(`must be a multiple of ${schema.multipleOf}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) e(`must have at least ${schema.minItems} item(s), has ${value.length}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) e(`must have at most ${schema.maxItems} items, has ${value.length}`);
    if (schema.uniqueItems === true) {
      const seen = new Set();
      value.forEach((v, i) => {
        const c = canon(v);
        if (seen.has(c)) e(`items must be unique (item ${i} repeats ${short(v)})`);
        seen.add(c);
      });
    }
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    prefix.forEach((s, i) => { if (i < value.length) errs.push(...validateNode(s, value[i], `${at}/${i}`, root)); });
    if (schema.items !== undefined) {
      for (let i = prefix.length; i < value.length; i++) errs.push(...validateNode(schema.items, value[i], `${at}/${i}`, root));
    }
    if (schema.contains !== undefined) {
      const n = value.filter((v, i) => !validateNode(schema.contains, v, `${at}/${i}`, root).length).length;
      const min = schema.minContains ?? 1;
      if (n < min) e(`must contain at least ${min} item(s) matching ${short(schema.contains)}`);
      if (schema.maxContains !== undefined && n > schema.maxContains) e(`must contain at most ${schema.maxContains} matching item(s)`);
    }
  }
  if (isObj(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) e(`must have at least ${schema.minProperties} properties`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) e(`must have at most ${schema.maxProperties} properties`);
    for (const r of schema.required || []) if (!Object.hasOwn(value, r)) e(`missing required property "${r}"`);
    if (isObj(schema.dependentRequired)) {
      for (const [k, deps] of Object.entries(schema.dependentRequired)) {
        if (Object.hasOwn(value, k)) for (const d of deps) if (!Object.hasOwn(value, d)) e(`"${k}" requires "${d}"`);
      }
    }
    const props = isObj(schema.properties) ? schema.properties : {};
    const pats = isObj(schema.patternProperties) ? Object.entries(schema.patternProperties) : [];
    for (const k of keys) {
      const sub = `${at}/${ptrEsc(k)}`;
      let matched = false;
      if (Object.hasOwn(props, k)) { matched = true; errs.push(...validateNode(props[k], value[k], sub, root)); }
      for (const [p, s] of pats) if (re(p).test(k)) { matched = true; errs.push(...validateNode(s, value[k], sub, root)); }
      if (!matched && schema.additionalProperties !== undefined) {
        if (schema.additionalProperties === false) e(`unknown property "${k}"`);
        else errs.push(...validateNode(schema.additionalProperties, value[k], sub, root));
      }
      if (schema.propertyNames !== undefined) {
        for (const m of validateNode(schema.propertyNames, k, sub, root)) e(`property name ${short(k)}: ${m.replace(/^[^:]*: /, '')}`);
      }
    }
  }
  for (const s of schema.allOf || []) errs.push(...validateNode(s, value, at, root));
  if (Array.isArray(schema.anyOf)) {
    const results = schema.anyOf.map((s) => validateNode(s, value, at, root));
    if (!results.some((r) => !r.length)) {
      const best = results.reduce((a, b) => (b.length < a.length ? b : a));
      e(`does not match any allowed form; closest: ${best[0] || '?'}`);
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const results = schema.oneOf.map((s) => validateNode(s, value, at, root));
    const ok = results.filter((r) => !r.length).length;
    if (ok === 0) {
      const best = results.reduce((a, b) => (b.length < a.length ? b : a));
      e(`does not match any allowed form; closest: ${best[0] || '?'}`);
    } else if (ok > 1) e(`matches more than one of the allowed forms (oneOf)`);
  }
  if (schema.not !== undefined && !validateNode(schema.not, value, at, root).length) e(`must not match ${short(schema.not)}`);
  if (schema.if !== undefined) {
    const pass = !validateNode(schema.if, value, at, root).length;
    if (pass && schema.then !== undefined) errs.push(...validateNode(schema.then, value, at, root));
    if (!pass && schema.else !== undefined) errs.push(...validateNode(schema.else, value, at, root));
  }
  return errs;
}

/**
 * Static sanity check of a schema document: unknown keywords, unresolvable $refs, patterns that
 * do not compile, bad "type"/"required" values. Returns an array of problems (empty = sound).
 */
export function lintSchema(root) {
  const problems = [];
  const MAPS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];
  const SINGLE = ['additionalProperties', 'items', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems'];
  const LISTS = ['prefixItems', 'allOf', 'anyOf', 'oneOf'];
  const walk = (s, at) => {
    if (typeof s === 'boolean') return;
    if (!isObj(s)) { problems.push(`${at || '#'}: a schema must be an object or boolean`); return; }
    for (const k of Object.keys(s)) {
      if (!ANNOTATION_KEYWORDS.has(k) && !VALIDATION_KEYWORDS.has(k)) problems.push(`${at || '#'}: unsupported keyword "${k}"`);
    }
    if (s.$ref !== undefined) { try { resolveRef(root, s.$ref); } catch (err) { problems.push(`${at || '#'}: ${err.message}`); } }
    if (s.pattern !== undefined) { try { re(s.pattern); } catch (err) { problems.push(`${at || '#'}: pattern does not compile: ${err.message}`); } }
    if (s.type !== undefined && ![].concat(s.type).every((t) => TYPES.includes(t))) problems.push(`${at || '#'}: unknown type ${JSON.stringify(s.type)}`);
    if (s.required !== undefined && !(Array.isArray(s.required) && s.required.every((r) => typeof r === 'string'))) problems.push(`${at || '#'}: "required" must be an array of strings`);
    if (s.enum !== undefined && !(Array.isArray(s.enum) && s.enum.length)) problems.push(`${at || '#'}: "enum" must be a non-empty array`);
    for (const m of MAPS) if (isObj(s[m])) for (const [k, v] of Object.entries(s[m])) walk(v, `${at}/${m}/${ptrEsc(k)}`);
    if (isObj(s.patternProperties)) for (const p of Object.keys(s.patternProperties)) { try { re(p); } catch (err) { problems.push(`${at || '#'}: patternProperties key does not compile: ${err.message}`); } }
    for (const k of SINGLE) if (s[k] !== undefined) walk(s[k], `${at}/${k}`);
    for (const k of LISTS) if (Array.isArray(s[k])) s[k].forEach((v, i) => walk(v, `${at}/${k}/${i}`));
  };
  walk(root, '');
  return problems;
}

// =============================================================================================
// Registry (data/app.json)

export const REGISTRY_FORMAT = 'app-registry/1';
const MODULE_KEYS = ['id', 'title', 'status', 'entry', 'css', 'lockedSay', 'tile'];
const MODULE_ID = /^[a-z][a-z0-9-]*$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const PRECACHED_DIRS = ['css', 'js', 'data', 'art', 'icons', 'audio']; // see tools/precache.mjs
/** Home screen capacity: big tiles for ready modules, a small "coming soon" row for locked ones. */
export const HOME = { big: 4, soon: 4, max: 8 };

/** Problem with a path in the registry, or null if it is a clean app-relative path. */
export function relPathProblem(p) {
  if (typeof p !== 'string' || !p) return 'must be a non-empty string';
  if (p.length > 200) return 'is longer than 200 characters';
  if (p.includes('\\')) return 'must use forward slashes';
  if (p.includes(':') || p.startsWith('//')) return 'must be a file inside the app, not a URL';
  if (p.startsWith('/')) return 'must be relative (no leading "/"): the app runs from a sub-path on GitHub Pages';
  if (p.includes('..')) return 'must not contain ".." (stay inside the app folder)';
  if (!/^[A-Za-z0-9._/-]+$/.test(p)) return 'may only use letters, digits, ".", "_", "-" and "/"';
  return null;
}

/**
 * Check data/app.json. `root` = app folder (to check that files exist).
 * @returns {{ errors: string[], warnings: string[], modules: object[] }}
 */
export function validateRegistry(doc, root) {
  const errors = [];
  const warnings = [];
  const modules = [];
  if (!isObj(doc)) return { errors: ['data/app.json must be a JSON object { "schema", "modules" }'], warnings, modules };
  for (const k of Object.keys(doc)) if (!['$schema', 'schema', 'modules'].includes(k)) errors.push(`unknown top-level key "${k}"`);
  if (doc.schema !== REGISTRY_FORMAT) errors.push(`"schema" must be "${REGISTRY_FORMAT}", got ${JSON.stringify(doc.schema)}`);
  if (!Array.isArray(doc.modules) || !doc.modules.length) {
    errors.push('"modules" must be a non-empty array');
    return { errors, warnings, modules };
  }
  // Home layout (js/app.js showHome): "ready" modules are big tiles (2 per row in portrait, an odd
  // last one spanning the row; one row in landscape); "locked" ones sit in a smaller "coming soon"
  // row underneath. Both groups are comfortable with up to HOME.big / HOME.soon tiles on a phone.
  const nReady = doc.modules.filter((m) => isObj(m) && m.status === 'ready').length;
  const nLocked = doc.modules.filter((m) => isObj(m) && m.status === 'locked').length;
  if (doc.modules.length > HOME.max) errors.push(`${doc.modules.length} modules; max ${HOME.max}`);
  if (!nReady) errors.push('no module has status "ready": the home screen would have nothing to play');
  if (nReady > HOME.big) warnings.push(`${nReady} "ready" modules; each is a big home tile and the screen is designed for up to ${HOME.big} (tiles get small on phones)`);
  if (nLocked > HOME.soon) warnings.push(`${nLocked} "locked" modules; the "coming soon" row under the big tiles is designed for up to ${HOME.soon}`);

  const seen = new Set();
  const fileCheck = (m, label, p, { ext, required, used }) => {
    const where = `${m.id || '?'}: ${label}`;
    if (p === undefined) {
      if (required) errors.push(`${where} is required for a "ready" module`);
      return;
    }
    const prob = relPathProblem(p);
    if (prob) { errors.push(`${where} "${p}" ${prob}`); return; }
    if (ext && !ext.test(p)) errors.push(`${where} "${p}" has the wrong file type (expected ${ext.source.replace(/\\|\$/g, '')})`);
    const abs = path.join(root, p);
    let exists = false;
    try { exists = fs.statSync(abs).isFile(); } catch { exists = false; }
    if (!exists) (used ? errors : warnings).push(`${where} "${p}" does not exist${used ? '' : ' (not used while the module is locked)'}`);
    if (!PRECACHED_DIRS.includes(p.split('/')[0])) warnings.push(`${where} "${p}" is outside ${PRECACHED_DIRS.map((d) => `${d}/`).join(' ')}, so it is not cached for offline use`);
    return exists ? abs : null;
  };

  doc.modules.forEach((m, i) => {
    if (!isObj(m)) { errors.push(`modules[${i}] must be an object`); return; }
    const label = typeof m.id === 'string' ? m.id : `modules[${i}]`;
    const row = { id: label, status: m.status, title: m.title };
    modules.push(row);
    for (const k of Object.keys(m)) if (!MODULE_KEYS.includes(k)) errors.push(`${label}: unknown key "${k}" (allowed: ${MODULE_KEYS.join(', ')})`);
    if (typeof m.id !== 'string' || !MODULE_ID.test(m.id) || m.id.length > 24) errors.push(`${label}: id must be lowercase letters, digits and dashes, starting with a letter (max 24)`);
    else if (m.id === 'settings') errors.push(`${label}: id "settings" is reserved for the grown-up settings route`);
    else if (seen.has(m.id)) errors.push(`${label}: duplicate id (ids must be unique; they are routes and save keys)`);
    seen.add(m.id);
    if (typeof m.title !== 'string' || !m.title.trim() || m.title.length > 30) errors.push(`${label}: title must be a non-empty string of at most 30 characters`);
    if (!['ready', 'locked'].includes(m.status)) errors.push(`${label}: status must be "ready" or "locked", got ${JSON.stringify(m.status)}`);
    const ready = m.status === 'ready';
    const entryAbs = fileCheck(m, 'entry', m.entry, { ext: /\.m?js$/, required: ready, used: ready });
    fileCheck(m, 'css', m.css, { ext: /\.css$/, required: false, used: ready });
    if (entryAbs) {
      const src = fs.readFileSync(entryAbs, 'utf8');
      if (!/export\s+default\b/.test(src)) (ready ? errors : warnings).push(`${label}: entry "${m.entry}" has no "export default" (the module contract needs one)`);
      if (!m.entry.startsWith(`js/modules/${m.id}/`)) warnings.push(`${label}: entry "${m.entry}" is not under js/modules/${m.id}/ (convention)`);
    }
    if (m.lockedSay !== undefined) {
      if (typeof m.lockedSay !== 'string' || !m.lockedSay.trim() || m.lockedSay.length > 110) errors.push(`${label}: lockedSay must be a short spoken sentence (1-110 characters)`);
      else if (words(m.lockedSay) > 15) warnings.push(`${label}: lockedSay has ${words(m.lockedSay)} words; keep spoken lines to 15 or fewer`);
    }
    if (!isObj(m.tile)) errors.push(`${label}: tile must be { "art", "color" }`);
    else {
      for (const k of Object.keys(m.tile)) if (!['art', 'color'].includes(k)) errors.push(`${label}: tile has unknown key "${k}"`);
      fileCheck(m, 'tile.art', m.tile.art, { ext: /\.(svg|png|webp)$/, required: true, used: true });
      if (m.tile.art === undefined) errors.push(`${label}: tile.art is required`);
      if (typeof m.tile.color !== 'string' || !HEX.test(m.tile.color)) errors.push(`${label}: tile.color must be "#RRGGBB", got ${JSON.stringify(m.tile.color)}`);
    }
  });
  return { errors, warnings, modules };
}

// =============================================================================================
// Stories (DRAFT format story-draft/1) - cross-references the JSON Schema cannot express

export const STORY_FORMAT = 'story-draft/1';

/**
 * @param {object} doc parsed story file
 * @param {{animals: Set<string>, accessories: Set<string>, backgrounds: Set<string>}} ids coloring ids
 */
export function validateStories(doc, ids) {
  const errors = [];
  const warnings = [];
  let scenes = 0;
  const shape = `story file must be { "schema": "${STORY_FORMAT}", "stories": [...] }`;
  if (!isObj(doc)) return { errors: [shape], warnings, scenes, stories: 0 };
  if (doc.schema !== STORY_FORMAT) errors.push(`"schema" must be "${STORY_FORMAT}" (the Story Movie format is a DRAFT), got ${JSON.stringify(doc.schema)}`);
  if (!Array.isArray(doc.stories)) {
    errors.push(`"stories" must be an array of stories (${shape})`);
    return { errors, warnings, scenes, stories: 0 };
  }
  const given = isObj(ids) ? ids : {};
  ids = Object.fromEntries(['animals', 'accessories', 'backgrounds'].map((k) => [k, given[k] instanceof Set ? given[k] : new Set()]));
  const storyIds = new Set();
  const speak = (txt, where) => {
    if (typeof txt === 'string' && words(txt) > 15) warnings.push(`${where}: ${words(txt)} words; keep spoken lines to 15 or fewer`);
  };
  doc.stories.forEach((st, si) => {
    if (!isObj(st)) return;
    const sid = typeof st.id === 'string' ? st.id : `stories[${si}]`;
    if (storyIds.has(st.id)) errors.push(`${sid}: duplicate story id`);
    storyIds.add(st.id);
    speak(st.say, `${sid} say`);
    (Array.isArray(st.scenes) ? st.scenes : []).forEach((sc, ci) => {
      if (!isObj(sc)) return;
      scenes++;
      const w = `${sid} scene ${ci + 1}`;
      if (typeof sc.background === 'string' && !ids.backgrounds.has(sc.background)) errors.push(`${w}: background "${sc.background}" is not in data/coloring/backgrounds.json (have: ${[...ids.backgrounds].join(', ')})`);
      const cast = new Map();
      (Array.isArray(sc.characters) ? sc.characters : []).forEach((c, k) => {
        if (!isObj(c)) return;
        const cw = `${w} character "${c.id ?? k}"`;
        if (cast.has(c.id)) errors.push(`${cw}: duplicate character id in this scene`);
        cast.set(c.id, c);
        if (typeof c.animal === 'string' && !ids.animals.has(c.animal)) errors.push(`${cw}: animal "${c.animal}" is not in data/coloring/animals.json (have: ${[...ids.animals].join(', ')})`);
        if (c.accessory !== undefined && typeof c.accessory === 'string' && !ids.accessories.has(c.accessory)) errors.push(`${cw}: accessory "${c.accessory}" is not in data/coloring/accessories.json (have: ${[...ids.accessories].join(', ')})`);
        const size = typeof c.size === 'number' ? c.size : 0.6;
        if (typeof c.x === 'number' && typeof c.y === 'number') {
          const half = 150 * size;
          if (c.x - half < 0 || c.x + half > 600 || c.y - 300 * size < 0) warnings.push(`${cw}: its ${300 * size}-unit box at feet (${c.x},${c.y}) sticks out of the 600x600 scene`);
        }
      });
      const acted = new Set();
      const entered = new Set();
      (Array.isArray(sc.timeline) ? sc.timeline : []).forEach((a, ai) => {
        if (!isObj(a)) return;
        const aw = `${w} timeline[${ai}] ${a.action}`;
        if (a.action === 'wait') return;
        if (!cast.has(a.who)) { errors.push(`${aw}: who "${a.who}" is not a character in this scene (have: ${[...cast.keys()].join(', ') || 'none'})`); return; }
        if (a.action === 'enter') {
          if (entered.has(a.who)) errors.push(`${aw}: "${a.who}" enters twice`);
          else if (acted.has(a.who)) errors.push(`${aw}: "${a.who}" already acted on stage; enter must be its first action`);
          entered.add(a.who);
        }
        acted.add(a.who);
        if (a.action === 'say') speak(a.text, aw);
        if (a.action === 'move-to' && typeof a.x === 'number') {
          const half = 150 * (typeof cast.get(a.who).size === 'number' ? cast.get(a.who).size : 0.6);
          if (a.x - half < 0 || a.x + half > 600) warnings.push(`${aw}: target x ${a.x} puts "${a.who}" partly outside the scene`);
        }
      });
      (Array.isArray(sc.narration) ? sc.narration : []).forEach((n, k) => speak(n, `${w} narration[${k}]`));
    });
  });
  return { errors, warnings, scenes, stories: doc.stories.length };
}

// =============================================================================================
// Spoken text: the rules of docs/CONTENT-FORMAT.md section 2 for every line the app reads aloud,
// in every content file, whatever its own validator checks. Children only HEAR these lines, so:
//   ERROR    an emoji / pictograph (speech reads out its name, e.g. "robot face")
//   ERROR    < > { } where no schema or module validator already rejects them (robot levels)
//   WARNING  a scolding word (wrong, fail, bad, lose, game over): a warning only, because these
//            words can be real content ("good is the opposite of bad")
//   WARNING  British spelling (content is US English) - also on Loop Machine word tokens, where
//            the spelling is what the child reads

const MARKUP = /[<>{}]/;
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}⃣]/gu;
const EMOJI_PART = /^[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}‍️⃣]+$/u;
const SCOLD = /\b(wrong|fail(?:s|ed|ure)?|bad|lose|loser|game over)\b/i;
/** British spellings to flag, whole words only ("mum" never matches "minimum"). */
export const BRITISH = [
  [/\bcolour(s|ed|ing|ful)?\b/i, 'color'],
  [/\bfavourite(s)?\b/i, 'favorite'],
  [/\bflavour(s|ed)?\b/i, 'flavor'],
  [/\bneighbour(s|hood)?\b/i, 'neighbor'],
  [/\bhonour(s|ed)?\b/i, 'honor'],
  [/\bcentre(s|d)?\b/i, 'center'],
  [/\b(metre|litre|theatre)s?\b/i, 'meter / liter / theater'],
  [/\bgrey(s|ed|ish)?\b/i, 'gray'],
  [/\bmums?\b/i, 'mom'],
  [/\bmaths\b/i, 'math'],
  [/\bpyjamas\b/i, 'pajamas'],
  [/\btyres?\b/i, 'tire'],
  [/\bjewellery\b/i, 'jewelry'],
  [/\btravell(ed|ing|er|ers)\b/i, 'traveled / traveling'],
  [/\b(organis|recognis|realis|apologis|memoris)(e|es|ed|ing)\b/i, '-ize'],
];

const strings = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : []);
const arr = (v) => (Array.isArray(v) ? v : []);
const nameOf = (o, fallback) => (isObj(o) && typeof o.id === 'string' && o.id ? o.id : fallback);

/**
 * Where each format keeps its spoken lines: lines(doc) -> [{ where, key, text }], plus (Loop
 * Machine) words(doc) -> [{ where, text }] that the child reads. `markup` = also report < > { }
 * (only where nothing else does: the machine, coloring, story and registry schemas already do).
 */
export const SPOKEN_FIELDS = {
  'robot-levels/1': {
    markup: true,
    lines: (d) => arr(d.levels).flatMap((lv, i) => (isObj(lv) ? ['say', 'hint'].map((key) => ({ where: nameOf(lv, `levels[${i}]`), key, text: lv[key] })) : [])),
  },
  'app-registry/1': {
    lines: (d) => arr(d.modules).flatMap((m, i) => (isObj(m) ? [{ where: nameOf(m, `modules[${i}]`), key: 'lockedSay', text: m.lockedSay }] : [])),
  },
  'machine-rounds/1': {
    lines: (d) => [
      ...arr(d.tiers).flatMap((t, i) => (isObj(t) ? [{ where: `tier ${nameOf(t, i)}`, key: 'say', text: t.say }] : [])),
      ...arr(d.rounds).flatMap((r, i) => (isObj(r) ? ['say', 'hint', 'explain'].map((key) => ({ where: nameOf(r, `rounds[${i}]`), key, text: r[key] })) : [])),
    ],
    words: (d) => arr(d.rounds).flatMap((r, i) => (isObj(r) ? strings([r.show, r.choices, r.answer, r.words]).map((text) => ({ where: nameOf(r, `rounds[${i}]`), text })) : [])),
  },
  'coloring-parts/1': {
    lines: (d) => arr(d.items).flatMap((it, i) => (isObj(it) ? [{ where: `${typeof d.kind === 'string' ? d.kind : 'part'} ${nameOf(it, `items[${i}]`)}`, key: 'say', text: it.say }] : [])),
  },
  [STORY_FORMAT]: {
    lines: (d) => arr(d.stories).flatMap((st, si) => {
      if (!isObj(st)) return [];
      const sid = nameOf(st, `stories[${si}]`);
      return [
        { where: sid, key: 'say', text: st.say },
        ...arr(st.scenes).flatMap((sc, ci) => (isObj(sc) ? [
          ...arr(sc.narration).map((text, k) => ({ where: `${sid} scene ${ci + 1}`, key: `narration[${k}]`, text })),
          ...arr(sc.timeline).flatMap((a, ai) => (isObj(a) && a.action === 'say' ? [{ where: `${sid} scene ${ci + 1}`, key: `timeline[${ai}] say text`, text: a.text }] : [])),
        ] : [])),
      ];
    }),
  },
};

/** British spellings in `text` as a message fragment, or null. */
function britishIn(text) {
  const found = [];
  for (const [rx, us] of BRITISH) {
    const m = text.match(rx);
    if (m) found.push([m[0], us]);
  }
  if (!found.length) return null;
  return `uses British spelling ${found.map(([w]) => `"${w}"`).join(', ')}; content is US English (${found.map(([, us]) => us).join(', ')})`;
}

/**
 * Check the spoken lines of one parsed content file of format `format`.
 * @returns {{ errors: string[], warnings: string[], lines: number }} (lines = spoken lines checked)
 */
export function checkSpokenText(format, doc) {
  const errors = [];
  const warnings = [];
  const rules = SPOKEN_FIELDS[format];
  if (!rules || !isObj(doc)) return { errors, warnings, lines: 0 };
  let lines = 0;
  for (const { where, key, text } of rules.lines(doc)) {
    if (typeof text !== 'string') continue; // missing / wrong type: the schema reports it
    lines++;
    const at = `${where}: "${key}"`;
    if (rules.markup && MARKUP.test(text)) errors.push(`${at} must be plain words (no < > { }): it is read aloud`);
    const emoji = text.match(EMOJI);
    if (emoji) errors.push(`${at} contains an emoji or pictograph (${[...new Set(emoji)].join(' ')}); spoken text is read aloud, so use plain words`);
    const scold = text.match(SCOLD);
    if (scold) warnings.push(`${at} uses "${scold[0]}": spoken lines never scold; make sure it is not aimed at the child`);
    const brit = britishIn(text);
    if (brit) warnings.push(`${at} ${brit}`);
  }
  for (const { where, text } of rules.words ? rules.words(doc) : []) {
    if (typeof text !== 'string') continue;
    const brit = britishIn(text);
    if (brit) warnings.push(`${where}: word "${text}" ${brit}`);
  }
  return { errors, warnings, lines };
}

/**
 * True when a Loop Machine "unusual characters" warning lists only emoji: the Spoken text section
 * reports those as errors already, so the warning would only repeat it.
 */
function emojiOnlyWarning(msg) {
  const m = /contains unusual characters \((.+?)\); keep spoken text/.exec(msg);
  return !!m && m[1].split(' ').filter(Boolean).every((c) => EMOJI_PART.test(c));
}

// =============================================================================================
// Runner

function listJSON(dir, root) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.toLowerCase().endsWith('.json')) out.push(rel(root, p));
    }
  };
  walk(dir);
  return out.sort();
}

function readJSON(abs) {
  let text = fs.readFileSync(abs, 'utf8');
  let bom = false;
  if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); bom = true; }
  return { doc: JSON.parse(text), bom };
}

function section(id, title) {
  return { id, title, status: 'OK', summary: '', details: [], errors: [], warnings: [] };
}

// ---------------------------------------------------------------------------------------------
// Where content lives. A JSON file in one of these places is read by the app (or reserved for a
// module), so it MUST have that place's format: its validator and JSON Schema are applied to it
// whatever its "schema" field says, and a different or missing value is an ERROR. This way a typo
// such as "robot-level/1" can never quietly switch the checks off.
// `loaded` lists the files the app actually fetches (other files there get a warning);
// null = no module reads this place yet.

export const CONTENT_PLACES = [
  { path: 'data/app.json', format: REGISTRY_FORMAT, loaded: ['data/app.json'] },
  { path: 'data/robot/', format: 'robot-levels/1', loaded: ['data/robot/levels.json'] },
  { path: 'data/coloring/', format: 'coloring-parts/1', loaded: ['data/coloring/animals.json', 'data/coloring/accessories.json', 'data/coloring/backgrounds.json'] },
  { path: 'data/machine/', format: 'machine-rounds/1', loaded: ['data/machine/rounds.json'] },
  { path: 'data/stories/', format: STORY_FORMAT, loaded: null },
];

/** The content place ({ path, format, loaded }) a data file such as "data/robot/levels.json" is in, or null. */
export function contentPlace(file) {
  return CONTENT_PLACES.find((p) => (p.path.endsWith('/') ? file.startsWith(p.path) : file === p.path)) || null;
}

/** The format a data file is checked as: its place's format, else the "schema" value it declares. */
export function formatOf(file, doc) {
  const place = contentPlace(file);
  if (place) return place.format;
  return isObj(doc) && typeof doc.schema === 'string' ? doc.schema : undefined;
}

// Rule validators: game rules a JSON Schema cannot express, one per format. Each one lives in
// tools/<file> and exports <fn>(doc, options) -> { errors, warnings, rows }. It runs on every data
// file of its format. A validator file that does not exist is SKIPPED with a warning; one that
// exists but cannot be loaded (syntax error, broken import) is an ERROR.

export const RULE_VALIDATORS = [
  {
    id: 'levels', title: 'Robot levels', format: 'robot-levels/1', main: 'data/robot/levels.json', module: 'robot',
    file: 'validate-levels.mjs', fn: 'validateLevels', unit: 'level',
    options: (f) => ({ curriculum: f === 'data/robot/levels.json' }),
    details: levelDetails,
  },
  {
    id: 'machine', title: 'Loop Machine rounds', format: 'machine-rounds/1', main: 'data/machine/rounds.json', module: 'machine',
    file: 'validate-machine.mjs', fn: 'validateMachine', unit: 'round',
    options: () => undefined,
    details: machineDetails,
    covered: emojiOnlyWarning, // emoji in spoken text: reported once, as an error, in 9. Spoken text
  },
];

function levelDetails(res, doc, mod) {
  const rows = Array.isArray(res.rows) ? res.rows : [];
  if (!rows.length) return [];
  const fmt = typeof mod.formatProgram === 'function' ? mod.formatProgram : () => '';
  const levels = isObj(doc) && Array.isArray(doc.levels) ? doc.levels : [];
  const out = ['#   id    palette       max  opt  moves  obst  reference solution'];
  rows.forEach((r, i) => {
    if (!isObj(r)) return;
    let sol = '';
    try { sol = isObj(levels[i]) && Array.isArray(levels[i].solution) ? fmt(levels[i].solution) : ''; } catch { sol = '?'; }
    out.push(`${String(r.n).padEnd(3)} ${String(r.id).padEnd(5)} ${String(r.cards || '').padEnd(13)} ${String(r.maxCards ?? '?').padStart(3)}  ${String(r.optimal ?? '-').padStart(3)}  ${String(r.moves ?? '?').padStart(5)}  ${String(r.obstacles ?? '?').padStart(4)}  ${sol}`);
  });
  return out;
}

function machineDetails(res) {
  const rows = Array.isArray(res.rows) ? res.rows : [];
  if (!rows.length) return [];
  const by = new Map();
  for (const r of rows) {
    const key = isObj(r) && typeof r.tier === 'string' ? r.tier : '?';
    by.set(key, (by.get(key) || 0) + 1);
  }
  return [`rounds per tier: ${[...by].map(([t, n]) => `${t} ${n}`).join(', ')}`];
}

/** Import tools/<v.file>: { mod } | { missing: true } | { error }. */
async function loadValidator(v) {
  const abs = path.join(HERE, v.file);
  if (!fs.existsSync(abs)) return { missing: true };
  try {
    const mod = await import(pathToFileURL(abs).href);
    if (typeof mod[v.fn] !== 'function') return { error: `tools/${v.file} does not export ${v.fn}(doc)` };
    return { mod };
  } catch (err) {
    return { error: `could not load tools/${v.file}: ${err && err.message}` };
  }
}

function crashMessage(err) {
  const frame = err && typeof err.stack === 'string' ? (err.stack.split('\n').find((l) => /^\s+at /.test(l)) || '').trim() : '';
  return `this check crashed (a validator bug, or content it did not expect): ${err && err.message ? err.message : err}${frame ? ` [${frame}]` : ''}`;
}

/** Run every check. Returns { ok, errors, warnings, root, sections }. Never throws for bad content. */
export async function runAll({ root = REPO_ROOT } = {}) {
  root = path.resolve(root);
  const sections = [];
  const docs = new Map(); // 'data/x.json' -> parsed
  let jsonFiles = [];
  let registry = null;
  const readyModules = () => new Set(registry ? registry.modules.filter((m) => m.status === 'ready').map((m) => m.id) : []);
  const unparsed = (f) => jsonFiles.includes(f) && !docs.has(f);

  // Each section runs in its own guard: if a check throws, that section FAILs with the message
  // and the others still run (so a generator always gets a complete report).
  const run = async (id, title, body) => {
    const s = section(id, title);
    sections.push(s);
    try { await body(s); } catch (err) { s.errors.push(crashMessage(err)); }
  };

  // 1. data files ---------------------------------------------------------------------------
  await run('data', 'Data files', (s) => {
    const dataDir = path.join(root, 'data');
    if (!fs.existsSync(dataDir)) s.errors.push(`no data/ folder in ${root}`);
    jsonFiles = listJSON(dataDir, root);
    for (const f of jsonFiles) {
      try {
        const { doc, bom } = readJSON(path.join(root, f));
        docs.set(f, doc);
        if (bom) s.warnings.push(`${f}: starts with a byte-order mark (save as UTF-8 without BOM)`);
      } catch (err) {
        s.errors.push(`${f}: invalid JSON: ${err.message}`);
      }
    }
    for (const f of jsonFiles) {
      const place = contentPlace(f);
      if (place && place.loaded && !place.loaded.includes(f)) {
        s.warnings.push(`${f}: the app only loads ${place.loaded.join(', ')}; this file is checked as "${place.format}" but not used`);
      }
    }
    s.summary = `${docs.size} of ${jsonFiles.length} JSON file(s) parse`;
  });

  // 2. registry -----------------------------------------------------------------------------
  await run('registry', 'Module registry (data/app.json)', (s) => {
    if (!docs.has('data/app.json')) {
      s.errors.push(unparsed('data/app.json') ? 'data/app.json could not be parsed (see 1. Data files)' : 'data/app.json is missing');
      return;
    }
    registry = validateRegistry(docs.get('data/app.json'), root);
    s.errors.push(...registry.errors);
    s.warnings.push(...registry.warnings);
    const by = (st) => registry.modules.filter((m) => m.status === st).map((m) => m.id);
    s.summary = `${registry.modules.length} module(s): ready ${by('ready').join(', ') || '-'}; locked ${by('locked').join(', ') || '-'}`;
  });

  // 3.. rule validators (robot levels, loop machine rounds, ...) ----------------------------
  for (const v of RULE_VALIDATORS) {
    await run(v.id, `${v.title} (${v.main})`, async (s) => {
      const files = [...docs.keys()].filter((f) => formatOf(f, docs.get(f)) === v.format);
      if (unparsed(v.main)) s.errors.push(`${v.main} could not be parsed (see 1. Data files)`);
      else if (!docs.has(v.main) && readyModules().has(v.module)) s.errors.push(`${v.main} is missing, but the "${v.module}" module is ready and loads it`);
      if (!files.length) {
        if (!s.errors.length) s.status = 'SKIP';
        s.summary = `no ${v.format} files`;
        return;
      }
      const loaded = await loadValidator(v);
      if (loaded.missing) {
        s.status = 'SKIP';
        s.summary = 'rules not checked';
        s.warnings.push(`tools/${v.file} not found: ${files.join(', ')} ${files.length > 1 ? 'were' : 'was'} only parsed and schema-checked`);
        return;
      }
      if (loaded.error) {
        s.errors.push(loaded.error);
        s.summary = 'rules not checked';
        return;
      }
      let total = 0;
      for (const f of files) {
        const doc = docs.get(f);
        const pre = f === v.main ? '' : `${f}: `;
        try {
          const res = loaded.mod[v.fn](doc, v.options(f));
          if (!res || !Array.isArray(res.errors) || !Array.isArray(res.warnings)) throw new Error(`${v.fn}() did not return { errors, warnings, rows }`);
          s.errors.push(...res.errors.map((m) => pre + m));
          s.warnings.push(...res.warnings.filter((m) => !(v.covered && v.covered(m))).map((m) => pre + m));
          total += Array.isArray(res.rows) ? res.rows.length : 0;
          if (f === v.main) s.details.push(...v.details(res, doc, loaded.mod));
        } catch (err) {
          s.errors.push(`${f}: ${v.fn}() crashed: ${err && err.message}`);
        }
      }
      s.summary = `${total} ${v.unit}(s) in ${files.length} file(s)`;
    });
  }

  // coloring art ----------------------------------------------------------------------------
  await run('art', 'Coloring art (data/coloring)', (s) => {
    const names = { animals: 'animals.json', accessories: 'accessories.json', backgrounds: 'backgrounds.json' };
    const paths = Object.fromEntries(Object.entries(names).map(([k, n]) => [k, `data/coloring/${n}`]));
    const artDocs = Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, docs.get(p)]));
    if (!Object.values(paths).some((p) => jsonFiles.includes(p)) && !readyModules().has('coloring')) {
      s.status = 'SKIP';
      s.summary = 'no coloring files';
      return;
    }
    const art = validateArt(artDocs);
    // A file that exists but did not parse is reported once, as such (not as "missing").
    const broken = Object.entries(paths).filter(([, p]) => unparsed(p)).map(([k]) => names[k]);
    s.errors.push(...broken.map((n) => `data/coloring/${n} could not be parsed (see 1. Data files)`));
    s.errors.push(...art.errors.filter((e) => !broken.some((n) => e.startsWith(`${n}: missing`))));
    s.warnings.push(...art.warnings);
    s.details.push(...formatArtReport(art));
    s.summary = `${art.rows.length} part(s), ${art.combos.checked} animal x accessory combo(s)`;
  });

  // stories (draft) -------------------------------------------------------------------------
  await run('stories', 'Stories (DRAFT format, data/stories)', (s) => {
    const files = [...docs.keys()].filter((f) => formatOf(f, docs.get(f)) === STORY_FORMAT);
    if (!files.length) {
      s.status = 'SKIP';
      s.summary = 'no story files yet (draft format: schemas/story.schema.json)';
      return;
    }
    // Ids straight from the coloring files (independent of the art section, which may have failed).
    const idsOf = (p) => {
      const d = docs.get(p);
      return new Set(isObj(d) && Array.isArray(d.items) ? d.items.filter(isObj).map((x) => x.id) : []);
    };
    const colorIds = { animals: idsOf('data/coloring/animals.json'), accessories: idsOf('data/coloring/accessories.json'), backgrounds: idsOf('data/coloring/backgrounds.json') };
    let n = 0;
    let scenes = 0;
    for (const f of files) {
      const r = validateStories(docs.get(f), colorIds);
      s.errors.push(...r.errors.map((m) => `${f}: ${m}`));
      s.warnings.push(...r.warnings.map((m) => `${f}: ${m}`));
      n += r.stories || 0;
      scenes += r.scenes || 0;
    }
    s.summary = `${n} story(ies), ${scenes} scene(s) in ${files.length} file(s)`;
  });

  // schemas ---------------------------------------------------------------------------------
  await run('schemas', 'JSON Schemas (schemas/*.schema.json)', (s) => {
    const formats = new Map(); // format id -> { file, schema }
    const schemaDir = path.join(root, 'schemas');
    const schemaFiles = fs.existsSync(schemaDir) ? fs.readdirSync(schemaDir).filter((f) => f.endsWith('.schema.json')).sort() : [];
    if (!schemaFiles.length) s.errors.push('no schemas/*.schema.json files found');
    for (const f of schemaFiles) {
      const label = `schemas/${f}`;
      let schema;
      try { schema = readJSON(path.join(schemaDir, f)).doc; } catch (err) { s.errors.push(`${label}: invalid JSON: ${err.message}`); continue; }
      if (!isObj(schema)) { s.errors.push(`${label}: a schema must be a JSON object`); continue; }
      if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') s.warnings.push(`${label}: "$schema" should be "https://json-schema.org/draft/2020-12/schema"`);
      if (!schema.title || !schema.description) s.warnings.push(`${label}: needs a "title" and a "description" (content generators read them)`);
      for (const p of lintSchema(schema)) s.errors.push(`${label}: ${p}`);
      const fmt = isObj(schema.properties) && isObj(schema.properties.schema) ? schema.properties.schema.const : undefined;
      if (typeof fmt !== 'string') s.warnings.push(`${label}: does not declare its format id (properties.schema.const)`);
      else if (formats.has(fmt)) s.errors.push(`${label}: format "${fmt}" is also declared by ${formats.get(fmt).file}`);
      else formats.set(fmt, { file: label, schema });
    }
    let conform = 0;
    for (const [f, d] of docs) {
      const place = contentPlace(f);
      const fmt = formatOf(f, d);
      if (typeof fmt !== 'string') { s.warnings.push(`${f}: has no "schema" field; every content file should declare its format`); continue; }
      const entry = formats.get(fmt);
      if (!entry) { s.warnings.push(`${f}: no schema in schemas/ declares format "${fmt}"${place ? ` (the format of ${place.path})` : ''}`); continue; }
      const problems = checkSchema(entry.schema, d);
      if (problems.length) {
        const max = 12;
        s.errors.push(...problems.slice(0, max).map((p) => `${f} (${entry.file}): ${p}`));
        if (problems.length > max) s.errors.push(`${f}: ... and ${problems.length - max} more schema problem(s)`);
      } else conform++;
    }
    s.summary = `${formats.size} format(s) [${[...formats.keys()].join(', ')}]; ${conform} of ${docs.size} data file(s) conform`;
  });

  // offline cache ---------------------------------------------------------------------------
  await run('precache', 'Offline cache (sw.js precache list)', async (s) => {
    // Warning-only by design: a stale list is fixed by running precache.mjs, not by editing content.
    const swFile = path.join(root, 'sw.js');
    if (!fs.existsSync(swFile)) { s.warnings.push('sw.js not found'); return; }
    let pre;
    let current;
    let pc;
    let next;
    try {
      pre = await import(pathToFileURL(path.join(HERE, 'precache.mjs')).href);
      current = fs.readFileSync(swFile, 'utf8');
      pc = pre.buildPrecache(root);
      next = pre.applyToSW(current, pc);
    } catch (err) {
      s.status = 'SKIP';
      s.summary = 'not checked';
      s.warnings.push(`could not run the precache check (tools/precache.mjs): ${err && err.message}`);
      return;
    }
    if (next === current) s.summary = `up to date (${pc.files.length} files, version ${pc.version})`;
    else {
      const old = pre.readSW ? pre.readSW(current) : { urls: [] };
      const oldSet = new Set(old.urls);
      const newSet = new Set(pc.urls);
      const added = pc.urls.filter((u) => !oldSet.has(u));
      const removed = old.urls.filter((u) => !newSet.has(u));
      s.summary = 'STALE';
      s.warnings.push(`sw.js precache is stale${added.length ? `, missing ${added.slice(0, 5).join(', ')}${added.length > 5 ? ` (+${added.length - 5})` : ''}` : ''}${removed.length ? `, lists removed ${removed.slice(0, 5).join(', ')}` : ''}${!added.length && !removed.length ? ' (file contents changed)' : ''}: run node tools/precache.mjs before deploying`);
    }
  });

  // spoken text ------------------------------------------------------------------------------
  await run('spoken', 'Spoken text (say, hint, explain, lockedSay, story lines)', (s) => {
    let lines = 0;
    let files = 0;
    for (const [f, d] of docs) {
      const fmt = formatOf(f, d);
      if (!Object.hasOwn(SPOKEN_FIELDS, fmt)) continue;
      files++;
      const r = checkSpokenText(fmt, d);
      s.errors.push(...r.errors.map((m) => `${f}: ${m}`));
      s.warnings.push(...r.warnings.map((m) => `${f}: ${m}`));
      lines += r.lines;
    }
    if (!files) {
      s.status = 'SKIP';
      s.summary = 'no content files';
      return;
    }
    s.summary = `${lines} spoken line(s) in ${files} file(s)`;
  });

  // recorded voice --------------------------------------------------------------------------
  await run('voice', 'Recorded voice (audio/ voice pack)', async (s) => {
    // Warning-only: a line without a recording still works (the device voice says it).
    let mod;
    try { mod = await import(pathToFileURL(path.join(HERE, 'voice-lines.mjs')).href); } catch (err) {
      s.status = 'SKIP'; s.summary = 'not checked'; s.warnings.push(`could not load tools/voice-lines.mjs: ${err && err.message}`); return;
    }
    const r = await mod.checkVoice(root);
    // The service worker must cache the pack's index and the iOS unlock clip WITH the app
    // (all-or-nothing core entries, no ?v=), and look files up exactly (ERRORS: offline voice).
    const swFile = path.join(root, 'sw.js');
    if (fs.existsSync(swFile)) {
      const swText = fs.readFileSync(swFile, 'utf8');
      try {
        const { readSW } = await import(pathToFileURL(path.join(HERE, 'precache.mjs')).href);
        const listed = readSW(swText).urls;
        for (const f of [r.pack, 'audio/silence.mp3']) {
          if (!fs.existsSync(path.join(root, f))) continue;
          if (!listed.includes(f)) s.errors.push(`sw.js must precache "${f}" as a core entry (without ?v=): a partial voice download would otherwise lose the whole recorded voice offline (tools/precache.mjs isMedia)`);
        }
      } catch (err) {
        s.warnings.push(`could not read the sw.js precache list: ${err && err.message}`);
      }
      if (/\bignoreSearch\s*:\s*true/.test(swText)) s.errors.push('sw.js uses ignoreSearch: true. Chromium then scans the whole cache (1300+ entries) on every request; look entries up by their exact precached URL (keyFor) instead');
    }
    if (!r.name) { s.warnings.push(`no voice pack at ${r.pack}: the device voice says everything (run npm run voice)`); s.summary = 'no voice pack'; return; }
    s.summary = `${r.name}: ${r.total - r.missing.length} of ${r.total} line(s) recorded`;
    if (r.missing.length) {
      s.warnings.push(`${r.missing.length} line(s) have no recording and will use the device voice (run npm run voice, then npm run precache), e.g. ${r.missing.slice(0, 3).map((l) => JSON.stringify(l.text)).join(', ')}`);
    }
    let idx = null;
    try { idx = JSON.parse(fs.readFileSync(path.join(root, r.pack), 'utf8')); } catch { idx = null; }
    const have = new Set(Object.keys((idx && idx.lines) || {}));
    // Word-order read-aloud ("The words are: ago, Dinosaurs, ...") lists the cards in scrambled
    // order, so every word is needed both mid-list ("ago,") and last ("ago."). Checked from the
    // rounds directly, so a gap in the collector can't hide it.
    try {
      const { wordsParts } = await import(pathToFileURL(path.join(root, 'js/modules/machine/tokens.js')).href);
      const { speechKey } = await import(pathToFileURL(path.join(root, 'js/core/speech.js')).href);
      const rounds = JSON.parse(fs.readFileSync(path.join(root, 'data/machine/rounds.json'), 'utf8').replace(/^﻿/, '')).rounds || [];
      const gaps = new Set();
      for (const rd of rounds) {
        if (!rd || rd.type !== 'order' || !Array.isArray(rd.words)) continue;
        const [intro, ...listed] = wordsParts(rd.words);
        for (const t of [intro, ...listed.flatMap((p) => [`${p.slice(0, -1)},`, `${p.slice(0, -1)}.`])]) {
          if (!have.has(speechKey(t))) gaps.add(t);
        }
      }
      if (gaps.size) s.warnings.push(`${gaps.size} word-order read-aloud part(s) have no recording (the whole "The words are: ..." line then uses the device voice), e.g. ${[...gaps].slice(0, 5).map((t) => JSON.stringify(t)).join(', ')}: run npm run voice`);
    } catch (err) {
      s.warnings.push(`could not check the word-order read-aloud parts: ${err && err.message}`);
    }
    // A line built with a template literal right inside a speech call is one long string the
    // collector can't enumerate (it gets the device voice). Pass parts instead, e.g.
    // ctx.instruct([line, SAY.next]); mark a line whose results ARE enumerated in
    // tools/voice-lines.mjs with a trailing `// voice: enumerated`.
    const jsDir = path.join(root, 'js');
    const built = [];
    const walkJs = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkJs(p);
        else if (e.name.endsWith('.js')) {
          fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
            if (/\b(instruct|setInstruction|say)\s*\(/.test(line) && /`[^`]*\$\{/.test(line) && !/\/\/\s*voice: enumerated/.test(line)) built.push(`${rel(root, p)}:${i + 1}`);
          });
        }
      }
    };
    if (fs.existsSync(jsDir)) walkJs(jsDir);
    if (built.length) s.warnings.push(`spoken line(s) built with a template literal (pass an array of parts instead; see docs/ARCHITECTURE.md "Speech notes"): ${built.slice(0, 5).join(', ')}`);
    // Clips that no line uses any more (removed by the next npm run voice), and stray packs.
    const wanted = new Set(mod.collectLines(root).map((l) => l.key));
    const unused = [...have].filter((k) => !wanted.has(k));
    if (unused.length) {
      const dir = path.dirname(path.join(root, r.pack));
      const kb = unused.reduce((n, k) => { try { return n + fs.statSync(path.join(dir, idx.lines[k])).size; } catch { return n; } }, 0) / 1024;
      s.warnings.push(`${unused.length} recorded clip(s) (${kb.toFixed(0)} KB) are no longer spoken but still downloaded by every device: run npm run voice (removes them), then npm run precache`);
    }
    const packDir = path.posix.dirname(r.pack);
    const audioDir = path.join(root, 'audio');
    if (fs.existsSync(audioDir)) {
      for (const e of fs.readdirSync(audioDir, { withFileTypes: true })) {
        if (e.isDirectory() && `audio/${e.name}` !== packDir) s.warnings.push(`audio/${e.name}/ is not the voice pack in js/config.js (${r.pack}) but is still shipped to every device: delete it if it is no longer used`);
      }
    }
  });

  for (const s of sections) {
    if (s.errors.length) s.status = 'FAIL';
    else if (s.warnings.length && s.status !== 'SKIP') s.status = 'WARN';
  }
  const errors = sections.reduce((n, s) => n + s.errors.length, 0);
  const warnings = sections.reduce((n, s) => n + s.warnings.length, 0);
  return { ok: errors === 0, errors, warnings, root, sections };
}

// =============================================================================================
// CLI

function paint(useColor) {
  const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { green: c('32'), yellow: c('33'), red: c('31'), dim: c('2'), bold: c('1') };
}

function printReport(result, { quiet, color }) {
  const C = paint(color);
  const badge = { OK: C.green('OK  '), WARN: C.yellow('WARN'), FAIL: C.red('FAIL'), SKIP: C.dim('SKIP') };
  if (!quiet) console.log(C.bold(`Little Loops content check`) + C.dim(`  (${result.root})`) + '\n');
  result.sections.forEach((s, i) => {
    const show = !quiet || s.errors.length || s.warnings.length;
    if (!show) return;
    const title = `${i + 1}. ${s.title}`;
    console.log(`${badge[s.status]}  ${C.bold(title)}${s.summary ? `  ${C.dim('-')} ${s.summary}` : ''}`);
    if (!quiet) for (const d of s.details) console.log(`        ${C.dim(d)}`);
    for (const w of s.warnings) console.log(`        ${C.yellow('warning')} ${w}`);
    for (const e of s.errors) console.log(`        ${C.red('ERROR')}   ${e}`);
    if (!quiet) console.log('');
  });
  const verdict = result.ok ? C.green('PASSED') : C.red('FAILED');
  console.log(`${verdict}: ${result.errors} error(s), ${result.warnings} warning(s)`);
}

async function main(argv) {
  const known = ['--root', '--quiet', '--json'];
  const unknown = argv.filter((a) => a.startsWith('--') && !known.includes(a));
  if (unknown.length) {
    console.error(`unknown option(s): ${unknown.join(' ')}\nusage: node tools/validate.mjs [--root DIR] [--quiet] [--json]`);
    return 2;
  }
  const ri = argv.indexOf('--root');
  const root = ri >= 0 && argv[ri + 1] ? path.resolve(argv[ri + 1]) : REPO_ROOT;
  const result = await runAll({ root });
  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printReport(result, { quiet: argv.includes('--quiet'), color: process.stdout.isTTY && !process.env.NO_COLOR });
  }
  return result.ok ? 0 : 1;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  try { return norm(process.argv[1]) === norm(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}

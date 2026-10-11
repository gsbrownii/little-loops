#!/usr/bin/env node
// Validate the Coloring line art: data/coloring/{animals,accessories,backgrounds}.json
// (format "coloring-parts/1", schema: schemas/coloring-parts.schema.json, docs: docs/CONTENT-FORMAT.md).
//
// Every part first goes through validatePart() from js/modules/coloring/scene.js (the renderer the
// app uses), so the validator and the app can never disagree about what is drawable. On top of that
// it checks what a JSON Schema cannot:
//   - file "schema" is "coloring-parts/1" and "kind" matches the file; unique ids; 6 items (warning)
//   - no unknown keys; numbers are JSON numbers; each shape type has its geometry fields; sizes > 0
//   - path data parses (starts with M, right number of values) and region outlines are closed
//   - region ids give unique region keys (saved colours are keyed by them)
//   - bounding boxes: backgrounds inside the 600x600 scene, animals inside their 300x300 box,
//     anchors inside the animal box, every accessory on every animal inside the scene after
//     placement + anchor transform (warning), regions narrower than 16 units (warning)
//
// Malformed structure (e.g. "shapes": {} or a string where a shape object belongs) is reported as
// an ERROR; it never crashes the validator (validatePart is called on a sanitized view).
//
// Bounding boxes are GEOMETRIC (outline thickness not included). They are exact for circle,
// ellipse, rect, line, polygon, polyline and for path data: relative commands are converted to
// absolute, smooth curves use the reflected control point, cubic/quadratic curves use their true
// extremes, and arcs use the SVG endpoint-to-center conversion (radii scaled up when too small,
// exactly as browsers do). Where an approximation remains, it errs on the large side:
// rotated anchors transform the four bbox corners (a superset of the real box), and "narrow region"
// uses the region's bbox (a thin diagonal sliver has a big bbox, so it is not flagged).
//
//   node tools/validate-art.mjs                    # data/coloring/*.json
//   node tools/validate-art.mjs path/to/folder     # a folder holding animals.json, accessories.json, backgrounds.json
//   node tools/validate-art.mjs --animals a.json --accessories b.json --backgrounds c.json
//                                                  # any subset; the rest come from data/coloring
//   options:  --json    print { errors, warnings, rows, files, combos } as JSON
//             --quiet   only problems and the totals line
//
// Exit code 1 if there is any ERROR (warnings never fail). Reusable from other tools:
//   import { validateArt } from './validate-art.mjs';
//   const { errors, warnings, rows } = validateArt({ animals, accessories, backgrounds }); // parsed JSON docs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validatePart, SCENE, ANIMAL_BOX, DEFAULT_PLACEMENT, ANCHORS, KINDS, SHAPE_TYPES,
} from '../js/modules/coloring/scene.js';

export const FORMAT = 'coloring-parts/1';
/** kind -> default file name in data/coloring (and the key used in validateArt's `docs`). */
export const FILES = { animal: 'animals.json', accessory: 'accessories.json', background: 'backgrounds.json' };
const DOC_KEY = { animal: 'animals', accessory: 'accessories', background: 'backgrounds' };

export const LIMITS = {
  itemsExpected: 6, // the picker is designed for 6 tiles per step (warning otherwise)
  itemsMax: 24, // schema maxItems
  idMax: 40,
  nameMax: 40,
  sayMaxChars: 110, // speech gets cut off beyond this (schema maxLength)
  sayMaxWords: 15, // warning only
  shapesMax: 200, // schema maxItems (error)
  shapesBusy: 100, // warning: too busy for small children
  dataMax: 8000, // max chars of a path "d" / polygon "points" (schema maxLength)
  wMax: 3, // max outline-width multiplier
  minRegion: 16, // warning: a region narrower than this (scene units) is hard to tap
  attachReach: 30, // warning: accessory drawn farther than this from its attach point (0,0)
  anchorScale: [0.25, 4], // warning outside this range
  tolerance: 0.5, // bbox slack for float noise
};

// Mirrors of scene.js internals (validatePart() is still the authority; these only give better messages).
const ID_OK = /^[a-z0-9][a-z0-9-]*$/;
const PATH_OK = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]+$/;
const POINTS_OK = /^[0-9eE.,+\-\s]+$/;

const COMMON_SHAPE_KEYS = ['type', 'kind', 'id', 'w'];
export const GEOMETRY = {
  path: { required: ['d'], optional: [] },
  circle: { required: ['cx', 'cy', 'r'], optional: [] },
  ellipse: { required: ['cx', 'cy', 'rx', 'ry'], optional: [] },
  rect: { required: ['x', 'y', 'width', 'height'], optional: ['rx'] },
  polygon: { required: ['points'], optional: [] },
  polyline: { required: ['points'], optional: [] },
  line: { required: ['x1', 'y1', 'x2', 'y2'], optional: [] },
};
const STRING_FIELDS = new Set(['d', 'points']);
const POSITIVE = new Set(['r', 'width', 'height']); // ellipse rx/ry handled per type (rect rx may be 0)
/** Kinds allowed per shape type: lines have no inside, so they cannot be a region (or white: invisible). */
export const KINDS_FOR_TYPE = { line: ['line', 'ink'], polyline: ['line', 'ink'] };
const TOP_KEYS = { animal: ['$schema', 'schema', 'kind', 'placement', 'items'], accessory: ['$schema', 'schema', 'kind', 'items'], background: ['$schema', 'schema', 'kind', 'items'] };
const ITEM_KEYS = {
  animal: ['id', 'name', 'say', 'anchors', 'shapes'],
  accessory: ['id', 'name', 'say', 'anchor', 'viewBox', 'shapes'],
  background: ['id', 'name', 'say', 'shapes'],
};
const ANCHOR_KEYS = ['x', 'y', 'scale', 'rotate'];
const PLACEMENT_KEYS = ['x', 'y', 'scale'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
const r1 = (v) => Math.round(v * 10) / 10;
const fmtBox = (b) => (b ? `${r1(b[0])},${r1(b[1])} .. ${r1(b[2])},${r1(b[3])}` : '-');

// ---------------------------------------------------------------------------------------------
// Geometry: bounding boxes [x0, y0, x1, y1]

const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const NUM_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

/**
 * Parse SVG path data into absolute-or-relative segments exactly as a browser reads it.
 * Returns { segs: [{ cmd, args }], error } (cmd keeps its case; implicit repeats are expanded,
 * so "M0 0 10 10" gives M + L). Arc flags may be packed ("a5 5 0 0110 10").
 */
export function parsePath(d) {
  const segs = [];
  if (typeof d !== 'string') return { segs, error: 'path data must be a string' };
  let i = 0;
  const n = d.length;
  const skip = () => { while (i < n && /[\s,]/.test(d[i])) i++; };
  const readNum = () => {
    skip();
    NUM_RE.lastIndex = i;
    const m = NUM_RE.exec(d);
    if (!m) return null;
    i = NUM_RE.lastIndex;
    return Number(m[0]);
  };
  const readFlag = () => {
    skip();
    if (d[i] === '0' || d[i] === '1') return Number(d[i++]);
    return null;
  };
  skip();
  if (i >= n) return { segs, error: 'path data is empty' };
  if (d[i] !== 'M' && d[i] !== 'm') return { segs, error: `path data must start with M (moveto), found "${d[i]}"` };
  let cmd = null;
  while (true) {
    skip();
    if (i >= n) break;
    const ch = d[i];
    if (/[A-Za-z]/.test(ch)) {
      if (!ARITY.hasOwnProperty(ch.toUpperCase())) return { segs, error: `unknown path command "${ch}" at character ${i}` };
      cmd = ch;
      i++;
      if (cmd.toUpperCase() === 'Z') { segs.push({ cmd, args: [] }); cmd = null; continue; }
    } else if (cmd === null) {
      return { segs, error: `number without a command at character ${i} (after Z start a new command)` };
    }
    // read one argument group for `cmd`
    const up = cmd.toUpperCase();
    const args = [];
    for (let k = 0; k < ARITY[up]; k++) {
      const v = up === 'A' && (k === 3 || k === 4) ? readFlag() : readNum();
      if (v === null || !Number.isFinite(v)) {
        return { segs, error: `"${cmd}" needs ${ARITY[up]} numbers${up === 'A' ? ' (rx ry rotation large-arc-flag sweep-flag x y; flags are 0 or 1)' : ''}; problem at character ${i}` };
      }
      args.push(v);
    }
    segs.push({ cmd, args });
    if (up === 'M') cmd = cmd === 'M' ? 'L' : 'l'; // extra pairs after a moveto are linetos
  }
  return { segs, error: null };
}

class Box {
  constructor() { this.b = null; }
  add(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!this.b) this.b = [x, y, x, y];
    else {
      if (x < this.b[0]) this.b[0] = x;
      if (y < this.b[1]) this.b[1] = y;
      if (x > this.b[2]) this.b[2] = x;
      if (y > this.b[3]) this.b[3] = y;
    }
  }
}

/** Roots in (0,1) of a*t^2 + b*t + c = 0. */
function unitRoots(a, b, c) {
  const out = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) out.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      out.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return out.filter((t) => t > 0 && t < 1);
}

function cubicExtent(box, p0, p1, p2, p3) {
  box.add(p0[0], p0[1]);
  box.add(p3[0], p3[1]);
  const at = (t, k) => {
    const u = 1 - t;
    return u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k];
  };
  for (const k of [0, 1]) {
    const a = -p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k];
    const b = 2 * (p0[k] - 2 * p1[k] + p2[k]);
    const c = p1[k] - p0[k];
    for (const t of unitRoots(a, b, c)) box.add(at(t, 0), at(t, 1));
  }
}

function quadExtent(box, p0, p1, p2) {
  box.add(p0[0], p0[1]);
  box.add(p2[0], p2[1]);
  for (const k of [0, 1]) {
    const den = p0[k] - 2 * p1[k] + p2[k];
    if (Math.abs(den) < 1e-12) continue;
    const t = (p0[k] - p1[k]) / den;
    if (t > 0 && t < 1) {
      const u = 1 - t;
      box.add(u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]);
    }
  }
}

/** Exact extent of an SVG elliptical arc (spec F.6.5 endpoint -> center parameterization). */
function arcExtent(box, x1, y1, rxIn, ryIn, phiDeg, fa, fs, x2, y2) {
  box.add(x1, y1);
  box.add(x2, y2);
  if (x1 === x2 && y1 === y2) return; // arc omitted
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (!rx || !ry) return; // straight line
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cos * dx2 + sin * dy2;
  const y1p = -sin * dx2 + cos * dy2;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (fa !== fs ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (coef * -ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI;
  if (fs && dt < 0) dt += 2 * Math.PI;
  const TAU = 2 * Math.PI;
  const swept = (t) => {
    const off = dt >= 0 ? (((t - t1) % TAU) + TAU) % TAU : (((t1 - t) % TAU) + TAU) % TAU;
    return off <= Math.abs(dt) + 1e-9;
  };
  const tx = Math.atan2(-ry * sin, rx * cos); // dx/dtheta = 0
  const ty = Math.atan2(ry * cos, rx * sin); // dy/dtheta = 0
  for (const t of [tx, tx + Math.PI, ty, ty + Math.PI]) {
    if (swept(t)) {
      box.add(cx + rx * cos * Math.cos(t) - ry * sin * Math.sin(t), cy + rx * sin * Math.cos(t) + ry * cos * Math.sin(t));
    }
  }
}

/**
 * Geometry of path data: { bbox, subpaths, open, error }. `open` counts drawn subpaths that are
 * not closed (no Z and the last point is not the start point) - a gap in a region's outline.
 */
export function pathInfo(d) {
  const { segs, error } = parsePath(d);
  if (error) return { bbox: null, subpaths: 0, open: 0, error };
  const box = new Box();
  let cur = [0, 0];
  let start = [0, 0];
  let lastCtrl = null; // [x, y, 'C'|'Q']
  let subpaths = 0;
  let open = 0;
  let drawn = false;
  let closed = false;
  const endSub = () => {
    if (drawn) {
      subpaths++;
      if (!closed && (Math.abs(cur[0] - start[0]) > 0.01 || Math.abs(cur[1] - start[1]) > 0.01)) open++;
    }
    drawn = false;
    closed = false;
  };
  for (const { cmd, args } of segs) {
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    const ox = rel ? cur[0] : 0;
    const oy = rel ? cur[1] : 0;
    let ctrl = null;
    switch (up) {
      case 'M':
        endSub();
        cur = [ox + args[0], oy + args[1]];
        start = cur;
        break;
      case 'L': {
        const p = [ox + args[0], oy + args[1]];
        box.add(cur[0], cur[1]); box.add(p[0], p[1]);
        cur = p; drawn = true; closed = false;
        break;
      }
      case 'H': {
        const p = [(rel ? cur[0] : 0) + args[0], cur[1]];
        box.add(cur[0], cur[1]); box.add(p[0], p[1]);
        cur = p; drawn = true; closed = false;
        break;
      }
      case 'V': {
        const p = [cur[0], (rel ? cur[1] : 0) + args[0]];
        box.add(cur[0], cur[1]); box.add(p[0], p[1]);
        cur = p; drawn = true; closed = false;
        break;
      }
      case 'C':
      case 'S': {
        let c1;
        let c2;
        let p;
        if (up === 'C') {
          c1 = [ox + args[0], oy + args[1]];
          c2 = [ox + args[2], oy + args[3]];
          p = [ox + args[4], oy + args[5]];
        } else {
          c1 = lastCtrl && lastCtrl[2] === 'C' ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur;
          c2 = [ox + args[0], oy + args[1]];
          p = [ox + args[2], oy + args[3]];
        }
        cubicExtent(box, cur, c1, c2, p);
        ctrl = [c2[0], c2[1], 'C'];
        cur = p; drawn = true; closed = false;
        break;
      }
      case 'Q':
      case 'T': {
        let c;
        let p;
        if (up === 'Q') {
          c = [ox + args[0], oy + args[1]];
          p = [ox + args[2], oy + args[3]];
        } else {
          c = lastCtrl && lastCtrl[2] === 'Q' ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur;
          p = [ox + args[0], oy + args[1]];
        }
        quadExtent(box, cur, c, p);
        ctrl = [c[0], c[1], 'Q'];
        cur = p; drawn = true; closed = false;
        break;
      }
      case 'A': {
        const p = [ox + args[5], oy + args[6]];
        arcExtent(box, cur[0], cur[1], args[0], args[1], args[2], args[3], args[4], p[0], p[1]);
        cur = p; drawn = true; closed = false;
        break;
      }
      case 'Z':
        if (drawn) closed = true;
        cur = start;
        break;
      default:
        break;
    }
    lastCtrl = ctrl;
  }
  endSub();
  return { bbox: box.b, subpaths, open, error: null };
}

/** Numbers in a points list, or an error string. */
export function parsePoints(points) {
  if (typeof points !== 'string') return { nums: [], error: 'points must be a string like "10,20 30,40 50,10"' };
  const nums = [];
  const re = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;
  const rest = points.replace(re, (m) => { nums.push(Number(m)); return ' '; });
  if (/[^\s,]/.test(rest)) return { nums, error: 'points may only contain numbers separated by spaces/commas' };
  if (nums.length % 2) return { nums, error: `points has an odd count of numbers (${nums.length}); it needs x,y pairs` };
  return { nums, error: null };
}

/** Geometric bbox of one shape in its own coordinates (null when it cannot be computed). */
export function shapeBBox(s) {
  if (!isObj(s)) return null;
  const N = (v) => Number(v);
  const box = new Box();
  switch (s.type) {
    case 'circle': {
      const r = Math.max(0, N(s.r));
      box.add(N(s.cx) - r, N(s.cy) - r); box.add(N(s.cx) + r, N(s.cy) + r);
      break;
    }
    case 'ellipse': {
      const rx = Math.max(0, N(s.rx));
      const ry = Math.max(0, N(s.ry));
      box.add(N(s.cx) - rx, N(s.cy) - ry); box.add(N(s.cx) + rx, N(s.cy) + ry);
      break;
    }
    case 'rect':
      box.add(N(s.x), N(s.y)); box.add(N(s.x) + Math.max(0, N(s.width)), N(s.y) + Math.max(0, N(s.height)));
      break;
    case 'line':
      box.add(N(s.x1), N(s.y1)); box.add(N(s.x2), N(s.y2));
      break;
    case 'polygon':
    case 'polyline': {
      const { nums, error } = parsePoints(s.points);
      if (error) return null;
      for (let i = 0; i + 1 < nums.length; i += 2) box.add(nums[i], nums[i + 1]);
      break;
    }
    case 'path':
      return pathInfo(s.d).bbox;
    default:
      return null;
  }
  return box.b;
}

const union = (a, b) => (!a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);

/** Transform a bbox by scale/rotate/translate (corners -> conservative superset when rotated). */
function transformBox(b, { x = 0, y = 0, scale = 1, rotate = 0 }) {
  if (!b) return null;
  const rad = (rotate * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const box = new Box();
  for (const [px, py] of [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]]) {
    const qx = px * scale;
    const qy = py * scale;
    box.add(x + qx * c - qy * s, y + qx * s + qy * c);
  }
  return box.b;
}

/** How far a box sticks out of [0,0,w,h] on each side (0 = inside). */
function overflow(b, w, h) {
  return { left: Math.max(0, -b[0]), top: Math.max(0, -b[1]), right: Math.max(0, b[2] - w), bottom: Math.max(0, b[3] - h) };
}
const outsideBy = (o) => Math.max(o.left, o.top, o.right, o.bottom);
const describeOverflow = (o, t = LIMITS.tolerance) => Object.entries(o).filter(([, v]) => v > t).map(([k, v]) => `${r1(v)} past the ${k}`).join(', ');
const fullyOutside = (b, w, h) => b[2] < 0 || b[3] < 0 || b[0] > w || b[1] > h;

/** Placement actually used by the app (js/modules/coloring/parts.js cleanPlacement). */
export function effectivePlacement(p) {
  const n = (v, d) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);
  if (!isObj(p)) return { ...DEFAULT_PLACEMENT };
  const scale = n(p.scale, DEFAULT_PLACEMENT.scale);
  return { x: n(p.x, DEFAULT_PLACEMENT.x), y: n(p.y, DEFAULT_PLACEMENT.y), scale: scale > 0 ? scale : DEFAULT_PLACEMENT.scale };
}

// ---------------------------------------------------------------------------------------------
// Validation

function checkKeys(obj, allowed, where, err) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) err(`${where}: unknown key "${k}" (allowed: ${allowed.join(', ')})`);
}

function checkText(v, key, where, err, warn, required) {
  if (v === undefined) {
    if (required) err(`${where}: missing "${key}"`);
    return;
  }
  if (typeof v !== 'string' || !v.trim()) return err(`${where}: "${key}" must be a non-empty string`);
  const max = key === 'say' ? LIMITS.sayMaxChars : LIMITS.nameMax;
  if (v.length > max) err(`${where}: "${key}" is ${v.length} characters; max ${max}${key === 'say' ? ' (speech gets cut off)' : ''}`);
  if (key === 'say' && words(v) > LIMITS.sayMaxWords) warn(`${where}: "say" has ${words(v)} words; keep spoken lines to ${LIMITS.sayMaxWords} simple words or fewer`);
  if (/[<>{}]/.test(v)) err(`${where}: "${key}" must be plain words (no < > { })`);
}

/**
 * Check one shape beyond validatePart. Returns { kind (effective), bbox, regionKey|null }.
 * `label` is like 'animals.json cat shape 3 (path "tail")'.
 */
function checkShape(s, i, label, err, warn) {
  const info = { kind: null, bbox: null, key: null };
  if (!isObj(s)) { err(`${label}: must be an object`); return info; }
  const geo = typeof s.type === 'string' && Object.hasOwn(GEOMETRY, s.type) ? GEOMETRY[s.type] : null;
  if (!geo) return info; // validatePart reports unknown types
  checkKeys(s, [...COMMON_SHAPE_KEYS, ...geo.required, ...geo.optional], label, err);
  for (const f of geo.required) if (s[f] === undefined) err(`${label}: "${s.type}" needs "${f}"`);
  for (const f of [...geo.required, ...geo.optional, 'w']) {
    if (s[f] === undefined || STRING_FIELDS.has(f)) continue;
    if (!fin(s[f])) err(`${label}: "${f}" must be a JSON number, got ${JSON.stringify(s[f])}`);
  }
  for (const f of geo.required) {
    if (fin(s[f]) && (POSITIVE.has(f) || (s.type === 'ellipse' && (f === 'rx' || f === 'ry'))) && !(s[f] > 0)) err(`${label}: "${f}" must be greater than 0 (got ${s[f]}); the shape would be invisible`);
  }
  if (s.type === 'rect' && fin(s.rx) && s.rx < 0) err(`${label}: "rx" (corner radius) must be 0 or more`);
  if (s.w !== undefined && fin(s.w) && !(s.w > 0 && s.w <= LIMITS.wMax)) err(`${label}: "w" (outline width multiplier) must be > 0 and <= ${LIMITS.wMax}, got ${s.w}`);
  if (s.id !== undefined && (typeof s.id !== 'string' || !ID_OK.test(s.id) || s.id.length > LIMITS.idMax)) {
    err(`${label}: shape id ${JSON.stringify(s.id)} must be lowercase letters, digits and dashes (max ${LIMITS.idMax}), e.g. "left-ear"`);
  }

  const allowedKinds = Object.hasOwn(KINDS_FOR_TYPE, s.type) ? KINDS_FOR_TYPE[s.type] : KINDS;
  if (KINDS.includes(s.kind) && !allowedKinds.includes(s.kind)) {
    err(`${label}: a "${s.type}" cannot have kind "${s.kind}" (${s.kind === 'region' ? 'it has no inside to fill; use a polygon or a closed path for a region' : 'it would be invisible'}); use ${allowedKinds.join(' or ')}`);
  }

  if (s.type === 'path') {
    if (typeof s.d === 'string') {
      if (s.d.length > LIMITS.dataMax) err(`${label}: path data is ${s.d.length} characters; max ${LIMITS.dataMax} (simplify the outline)`);
      const bad = s.d.match(/[^MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]/);
      if (bad) err(`${label}: character ${JSON.stringify(bad[0])} is not allowed in path data (only SVG path commands, numbers, spaces, commas)`);
      else {
        const pi = pathInfo(s.d);
        if (pi.error) err(`${label}: ${pi.error}`);
        else {
          info.bbox = pi.bbox;
          if (!pi.subpaths) err(`${label}: path draws nothing (only moveto)`);
          if (s.kind === 'region' && pi.open) warn(`${label}: region outline is not closed (${pi.open} subpath(s) without Z); end each outline with Z so there is no gap`);
        }
      }
    }
  } else if (s.type === 'polygon' || s.type === 'polyline') {
    if (typeof s.points === 'string') {
      if (s.points.length > LIMITS.dataMax) err(`${label}: points is ${s.points.length} characters; max ${LIMITS.dataMax}`);
      if (!POINTS_OK.test(s.points)) err(`${label}: points may only contain numbers, spaces and commas`);
      const { nums, error } = parsePoints(s.points);
      if (error) err(`${label}: ${error}`);
      else {
        const need = s.type === 'polygon' ? 3 : 2;
        if (nums.length / 2 < need) err(`${label}: a ${s.type} needs at least ${need} points, has ${nums.length / 2}`);
        info.bbox = shapeBBox(s);
      }
    }
  } else {
    info.bbox = shapeBBox(s);
  }
  info.kind = KINDS.includes(s.kind) ? (s.kind === 'region' && (s.type === 'line' || s.type === 'polyline') ? 'line' : s.kind) : null;
  if (info.kind === 'region') info.key = typeof s.id === 'string' && ID_OK.test(s.id) ? s.id : String(i);
  return info;
}

function shapeLabel(file, id, s, i) {
  const t = isObj(s) ? `${s.type || '?'}${typeof s.id === 'string' ? ` "${s.id}"` : ''}` : '?';
  return `${file} ${id} shape ${i} (${t})`;
}

const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `${typeof v} ${JSON.stringify(v)}`);

/**
 * scene.js validatePart(), made crash-proof. validatePart assumes `shapes` is an array of
 * objects; given `"shapes": {}` or `["x"]` it throws (TypeError), which would turn a content
 * problem into a stack trace. So it gets a view of the item where a non-array `shapes` is
 * missing and non-object shape entries are null (it reports both), its messages about those
 * entries are dropped (checkShape reports them more clearly), and any other throw becomes an error.
 */
function safeValidatePart(item, kind) {
  let view = item;
  const bad = [];
  let notArray = false;
  if (isObj(item)) {
    notArray = item.shapes !== undefined && !Array.isArray(item.shapes);
    const shapes = Array.isArray(item.shapes)
      ? item.shapes.map((s, i) => { if (isObj(s)) return s; bad.push(i); return null; })
      : undefined;
    view = { ...item, shapes };
  }
  let msgs;
  try {
    msgs = validatePart(view, kind);
  } catch (e) {
    return [`${kind} "${isObj(item) ? item.id : '?'}": could not be checked by validatePart() in scene.js (${e && e.message})`];
  }
  msgs = msgs.filter((m) => !bad.some((i) => m.includes(` shape ${i}: `)));
  if (notArray) {
    msgs = msgs.filter((m) => !/shapes must be a non-empty array|needs at least one fillable region/.test(m));
    msgs.push(`${kind} "${item.id}": "shapes" must be an array of shape objects [{ "type", "kind", ... }], got ${typeName(item.shapes)}`);
  }
  return msgs;
}

/**
 * Validate the three coloring files.
 * @param {{animals?: object, accessories?: object, backgrounds?: object}} docs parsed JSON documents
 * @param {{names?: {animals?: string, accessories?: string, backgrounds?: string}}} [opts] labels for messages
 * @returns {{ errors: string[], warnings: string[], rows: object[], files: object[], combos: object }}
 */
export function validateArt(docs = {}, { names = {} } = {}) {
  if (!isObj(docs)) docs = {};
  if (!isObj(names)) names = {};
  const errors = [];
  const warnings = [];
  const rows = [];
  const files = [];
  const combos = { checked: 0, outside: [], tightest: null };
  const parts = { animal: [], accessory: [], background: [] }; // valid items with bboxes
  let placement = { ...DEFAULT_PLACEMENT };

  for (const kind of ['animal', 'accessory', 'background']) {
    const file = names[DOC_KEY[kind]] || FILES[kind];
    const doc = docs[DOC_KEY[kind]];
    const err = (m) => errors.push(m);
    const warn = (m) => warnings.push(m);
    const fileRow = { file, kind, items: 0, placement: null };
    files.push(fileRow);

    if (doc === undefined || doc === null) { err(`${file}: missing (expected the ${kind} parts file)`); continue; }
    if (!isObj(doc)) { err(`${file}: must be a JSON object { "schema", "kind", "items" }`); continue; }
    checkKeys(doc, TOP_KEYS[kind], file, err);
    if (doc.$schema !== undefined && typeof doc.$schema !== 'string') err(`${file}: "$schema" must be a string`);
    if (doc.schema !== FORMAT) err(`${file}: "schema" must be "${FORMAT}", got ${JSON.stringify(doc.schema)}`);
    if (doc.kind !== kind) err(`${file}: "kind" must be "${kind}" for this file, got ${JSON.stringify(doc.kind)}`);

    if (kind === 'animal') {
      if (doc.placement !== undefined) {
        if (!isObj(doc.placement)) err(`${file}: "placement" must be { "x", "y", "scale" }`);
        else {
          checkKeys(doc.placement, PLACEMENT_KEYS, `${file} placement`, err);
          for (const k of PLACEMENT_KEYS) if (doc.placement[k] !== undefined && !fin(doc.placement[k])) err(`${file}: placement.${k} must be a number`);
          if (fin(doc.placement.scale) && !(doc.placement.scale > 0)) err(`${file}: placement.scale must be > 0`);
        }
      }
      placement = effectivePlacement(doc.placement);
      fileRow.placement = placement;
      const stage = [placement.x, placement.y, placement.x + ANIMAL_BOX.width * placement.scale, placement.y + ANIMAL_BOX.height * placement.scale];
      fileRow.stage = stage;
      const o = overflow(stage, SCENE.width, SCENE.height);
      if (outsideBy(o) > LIMITS.tolerance) warn(`${file}: placement puts the animal box (${fmtBox(stage)}) outside the ${SCENE.width}x${SCENE.height} scene: ${describeOverflow(o)}`);
    }

    if (!Array.isArray(doc.items) || !doc.items.length) { err(`${file}: "items" must be a non-empty array`); continue; }
    fileRow.items = doc.items.length;
    if (doc.items.length > LIMITS.itemsMax) err(`${file}: ${doc.items.length} items; max ${LIMITS.itemsMax}`);
    else if (doc.items.length !== LIMITS.itemsExpected) warn(`${file}: has ${doc.items.length} items; the picker is designed for ${LIMITS.itemsExpected}`);

    const seen = new Map();
    doc.items.forEach((item, idx) => {
      const id = isObj(item) && typeof item.id === 'string' ? item.id : `items[${idx}]`;
      const where = `${file} ${id}`;
      const before = errors.length;
      for (const e of safeValidatePart(item, kind)) err(`${file}: ${e}`);
      if (!isObj(item)) return;

      checkKeys(item, ITEM_KEYS[kind], where, err);
      if (typeof item.id === 'string') {
        if (item.id.length > LIMITS.idMax) err(`${where}: id is longer than ${LIMITS.idMax} characters`);
        if (seen.has(item.id)) err(`${where}: duplicate id (also items[${seen.get(item.id)}]); ids must be unique within the file`);
        else seen.set(item.id, idx);
      }
      if (item.name !== undefined) checkText(item.name, 'name', where, err, warn, false);
      if (item.say === undefined) warn(`${where}: no "say"; the picker will just say "${item.name}!"`);
      else checkText(item.say, 'say', where, err, warn, false);

      const shapes = Array.isArray(item.shapes) ? item.shapes : [];
      if (shapes.length > LIMITS.shapesMax) err(`${where}: ${shapes.length} shapes; max ${LIMITS.shapesMax}`);
      else if (shapes.length > LIMITS.shapesBusy) warn(`${where}: ${shapes.length} shapes is very busy for ages 4-7 (aim for under ${LIMITS.shapesBusy})`);

      const row = { file, kind, id, anchor: kind === 'accessory' ? item.anchor : '', shapes: shapes.length, regions: 0, lines: 0, inks: 0, whites: 0, bbox: null };
      rows.push(row);
      const keys = new Map();
      const regionBoxes = [];
      const shapeBoxes = [];
      shapes.forEach((s, i) => {
        const label = shapeLabel(file, id, s, i);
        const info = checkShape(s, i, label, err, warn);
        if (info.kind === 'region') row.regions++;
        else if (info.kind === 'line') row.lines++;
        else if (info.kind === 'ink') row.inks++;
        else if (info.kind === 'white') row.whites++;
        if (info.key !== null) {
          if (keys.has(info.key)) err(`${label}: region key "${info.key}" is used twice in ${id} (also shape ${keys.get(info.key)}); give each region a unique id`);
          else keys.set(info.key, i);
          if (isObj(s) && s.id === undefined) warn(`${label}: region has no "id"; its saved colour is keyed by position, so reordering shapes scrambles saved pictures`);
          if (info.bbox) regionBoxes.push({ label: typeof s.id === 'string' ? s.id : `shape ${i}`, bbox: info.bbox });
        }
        if (info.bbox) {
          shapeBoxes.push({ i, label, bbox: info.bbox });
          row.bbox = union(row.bbox, info.bbox);
        }
      });
      if (row.regions === 0 && shapes.length && !errors.slice(before).some((e) => e.includes('fillable region'))) err(`${where}: needs at least one fillable region (lines and polylines cannot be regions)`);

      // ---- per-kind geometry checks ----
      if (kind === 'background' || kind === 'animal') {
        const W = kind === 'background' ? SCENE.width : ANIMAL_BOX.width;
        const H = kind === 'background' ? SCENE.height : ANIMAL_BOX.height;
        const boxName = kind === 'background' ? `${W}x${H} scene` : `${W}x${H} animal box`;
        for (const sb of shapeBoxes) {
          if (fullyOutside(sb.bbox, W, H)) err(`${sb.label}: completely outside the ${boxName} (bbox ${fmtBox(sb.bbox)}); it can never be seen`);
        }
        const sticking = shapeBoxes.filter((sb) => outsideBy(overflow(sb.bbox, W, H)) > LIMITS.tolerance && !fullyOutside(sb.bbox, W, H));
        if (sticking.length) {
          const all = sticking.reduce((a, sb) => union(a, sb.bbox), null);
          const advice = kind === 'background'
            ? 'they are clipped at the edge: fine for big sky/ground shapes, but keep details and small regions inside'
            : `keep the animal inside 0..${W} so accessories, thumbnails and placement line up`;
          warn(`${where}: ${sticking.length} shape(s) reach outside the ${boxName} (${describeOverflow(overflow(all, W, H))}; e.g. shape ${sticking[0].i}); ${advice}`);
        }
      }
      if (kind === 'animal' && isObj(item.anchors)) {
        checkKeys(item.anchors, ANCHORS, `${where} anchors`, err);
        for (const a of ANCHORS) {
          const an = item.anchors[a];
          if (!isObj(an)) continue; // validatePart reports it
          checkKeys(an, ANCHOR_KEYS, `${where} anchor "${a}"`, err);
          for (const k of ANCHOR_KEYS) if (an[k] !== undefined && !fin(an[k])) err(`${where}: anchor "${a}" ${k} must be a JSON number`);
          if (fin(an.x) && fin(an.y) && (an.x < 0 || an.y < 0 || an.x > ANIMAL_BOX.width || an.y > ANIMAL_BOX.height)) {
            err(`${where}: anchor "${a}" (${an.x},${an.y}) is outside the ${ANIMAL_BOX.width}x${ANIMAL_BOX.height} animal box`);
          }
          if (fin(an.scale) && an.scale > 0 && (an.scale < LIMITS.anchorScale[0] || an.scale > LIMITS.anchorScale[1])) warn(`${where}: anchor "${a}" scale ${an.scale} is unusual (expected ${LIMITS.anchorScale[0]}..${LIMITS.anchorScale[1]})`);
          if (fin(an.rotate) && Math.abs(an.rotate) > 180) err(`${where}: anchor "${a}" rotate must be between -180 and 180 degrees`);
        }
      }
      if (kind === 'accessory') {
        if (item.viewBox !== undefined) {
          const vb = item.viewBox;
          if (!Array.isArray(vb) || vb.length !== 4 || !vb.every(fin) || !(vb[2] > 0) || !(vb[3] > 0)) err(`${where}: viewBox must be [minX, minY, width, height] with width and height > 0`);
          else if (row.bbox && (row.bbox[0] < vb[0] - LIMITS.tolerance || row.bbox[1] < vb[1] - LIMITS.tolerance || row.bbox[2] > vb[0] + vb[2] + LIMITS.tolerance || row.bbox[3] > vb[1] + vb[3] + LIMITS.tolerance)) {
            warn(`${where}: drawing (${fmtBox(row.bbox)}) does not fit its viewBox [${vb.join(', ')}]; the standalone thumbnail would cut it off`);
          }
        }
        if (row.bbox) {
          const dx = Math.max(row.bbox[0], 0, -row.bbox[2]);
          const dy = Math.max(row.bbox[1], 0, -row.bbox[3]);
          const dist = Math.hypot(dx, dy);
          if (dist > LIMITS.attachReach) warn(`${where}: drawing (${fmtBox(row.bbox)}) is ${r1(dist)} units from its attach point (0,0); draw accessories around (0,0)`);
        }
      }

      const ok = errors.length === before;
      row.ok = ok;
      if (ok) parts[kind].push({ item, bbox: row.bbox, regionBoxes, where });
    });
  }

  // ---- scale-aware checks: narrow regions, animal in scene, every animal x accessory combo ----
  const P = placement;
  for (const bg of parts.background) {
    const narrow = bg.regionBoxes.filter((r) => Math.min(r.bbox[2] - r.bbox[0], r.bbox[3] - r.bbox[1]) < LIMITS.minRegion);
    if (narrow.length) warnings.push(`${bg.where}: ${narrow.length} region(s) narrower than ${LIMITS.minRegion} units (too small for fingers): ${narrow.slice(0, 6).map((r) => `${r.label} ${r1(r.bbox[2] - r.bbox[0])}x${r1(r.bbox[3] - r.bbox[1])}`).join(', ')}${narrow.length > 6 ? ', ...' : ''}`);
  }
  for (const an of parts.animal) {
    const narrow = an.regionBoxes.filter((r) => Math.min(r.bbox[2] - r.bbox[0], r.bbox[3] - r.bbox[1]) * P.scale < LIMITS.minRegion);
    if (narrow.length) warnings.push(`${an.where}: ${narrow.length} region(s) narrower than ${LIMITS.minRegion} scene units at placement scale ${P.scale} (too small for fingers): ${narrow.slice(0, 6).map((r) => `${r.label} ${r1((r.bbox[2] - r.bbox[0]) * P.scale)}x${r1((r.bbox[3] - r.bbox[1]) * P.scale)}`).join(', ')}${narrow.length > 6 ? ', ...' : ''}`);
    const inScene = transformBox(an.bbox, P);
    if (inScene) {
      const o = overflow(inScene, SCENE.width, SCENE.height);
      if (outsideBy(o) > LIMITS.tolerance) warnings.push(`${an.where}: placed in the scene it reaches outside the ${SCENE.width}x${SCENE.height} scene (${describeOverflow(o)})`);
    }
  }
  for (const acc of parts.accessory) {
    const hosts = parts.animal.map((a) => ({ id: a.item.id, an: a.item.anchors[acc.item.anchor] })).filter((h) => h.an);
    if (!hosts.length) continue;
    const smallest = hosts.reduce((m, h) => ((Number(h.an.scale) || 1) < (Number(m.an.scale) || 1) ? h : m));
    const k = P.scale * (Number(smallest.an.scale) || 1);
    const narrow = acc.regionBoxes.filter((r) => Math.min(r.bbox[2] - r.bbox[0], r.bbox[3] - r.bbox[1]) * k < LIMITS.minRegion);
    if (narrow.length) warnings.push(`${acc.where}: ${narrow.length} region(s) narrower than ${LIMITS.minRegion} scene units on ${smallest.id} (scale ${r1(k * 100) / 100}; too small for fingers): ${narrow.slice(0, 6).map((r) => `${r.label} ${r1((r.bbox[2] - r.bbox[0]) * k)}x${r1((r.bbox[3] - r.bbox[1]) * k)}`).join(', ')}`);
  }
  // Each combo is judged by the ACCESSORY's box in the scene (the animal's own box is checked
  // above, once), so `tightest` really says how much room the accessories have.
  for (const an of parts.animal) {
    for (const acc of parts.accessory) {
      const a = an.item.anchors[acc.item.anchor];
      if (!a || !an.bbox || !acc.bbox) continue;
      combos.checked++;
      const s = Number(a.scale) > 0 ? Number(a.scale) : 1;
      const inAnimal = transformBox(acc.bbox, { x: Number(a.x), y: Number(a.y), scale: s, rotate: Number(a.rotate) || 0 });
      const inScene = transformBox(inAnimal, P);
      const o = overflow(inScene, SCENE.width, SCENE.height);
      const room = { top: inScene[1], left: inScene[0], right: SCENE.width - inScene[2], bottom: SCENE.height - inScene[3] };
      const [side, margin] = Object.entries(room).reduce((m, e) => (e[1] < m[1] ? e : m));
      if (!combos.tightest || margin < combos.tightest.margin) combos.tightest = { animal: an.item.id, accessory: acc.item.id, margin: r1(margin), side };
      if (outsideBy(o) > LIMITS.tolerance) {
        combos.outside.push({ animal: an.item.id, accessory: acc.item.id, bbox: inScene, overflow: o });
        warnings.push(`combo ${an.item.id} + ${acc.item.id}: the ${acc.item.id} reaches outside the ${SCENE.width}x${SCENE.height} scene (${describeOverflow(o)}); adjust the "${acc.item.anchor}" anchor of ${an.item.id} or shrink ${acc.item.id}`);
      }
    }
  }
  return { errors, warnings, rows, files, combos };
}

// ---------------------------------------------------------------------------------------------
// Report

/** Readable report lines (used by this CLI and by tools/validate.mjs). */
export function formatArtReport(result, { quiet = false, indent = '' } = {}) {
  const out = [];
  if (!quiet) {
    for (const f of result.files) {
      const extra = f.placement ? `   placement x=${f.placement.x} y=${f.placement.y} scale=${f.placement.scale} (animal box -> scene ${fmtBox(f.stage)})` : '';
      out.push(`${indent}${f.file}  kind ${f.kind}, ${f.items} item(s)${extra}`);
      const rows = result.rows.filter((r) => r.file === f.file);
      if (!rows.length) continue;
      const head = ['id', f.kind === 'accessory' ? 'anchor' : '', 'shapes', 'regions', 'lines', 'inks', 'whites', 'bbox (own coordinates)', ''];
      const body = rows.map((r) => [r.id, r.anchor || '', r.shapes, r.regions, r.lines, r.inks, r.whites, fmtBox(r.bbox), r.ok ? '' : 'ERROR'].map(String));
      const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
      const line = (cols) => cols.map((c, i) => (i >= 2 && i <= 6 ? c.padStart(w[i]) : c.padEnd(w[i]))).join('  ').trimEnd();
      out.push(`${indent}  ${line(head)}`);
      for (const b of body) out.push(`${indent}  ${line(b)}`);
    }
    const c = result.combos;
    if (c.checked) {
      const t = c.tightest
        ? c.tightest.margin >= 0
          ? ` (least room: ${c.tightest.accessory} on ${c.tightest.animal}, ${c.tightest.margin} units from the ${c.tightest.side} edge)`
          : ` (worst: ${c.tightest.accessory} on ${c.tightest.animal}, ${-c.tightest.margin} units past the ${c.tightest.side} edge)`
        : '';
      out.push(`${indent}combos: ${c.checked} animal x accessory checked, ${c.outside.length ? `${c.outside.length} accessory placement(s) reach outside the scene` : 'every accessory stays inside the 600x600 scene'}${t}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// CLI

function readDoc(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { doc: JSON.parse(text) };
  } catch (e) {
    return { error: e.code === 'ENOENT' ? 'file not found' : `invalid JSON: ${e.message}` };
  }
}

function main(argv) {
  const known = ['--json', '--quiet', '--animals', '--accessories', '--backgrounds'];
  const flags = argv.filter((a) => a.startsWith('--'));
  const unknown = flags.filter((f) => !known.includes(f));
  if (unknown.length) {
    console.error(`unknown option(s): ${unknown.join(' ')}\nusage: node tools/validate-art.mjs [folder] [--animals f] [--accessories f] [--backgrounds f] [--json] [--quiet]`);
    return 2;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const valueOf = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--animals', '--accessories', '--backgrounds'].includes(argv[i - 1])));
  const dir = positional[0] ? path.resolve(positional[0]) : path.join(here, '..', 'data', 'coloring');
  const docs = {};
  const names = {};
  const readErrors = [];
  for (const kind of ['animal', 'accessory', 'background']) {
    const key = DOC_KEY[kind];
    const file = valueOf(`--${key}`) ? path.resolve(valueOf(`--${key}`)) : path.join(dir, FILES[kind]);
    names[key] = path.basename(file);
    const { doc, error } = readDoc(file);
    if (error) readErrors.push(`${names[key]}: ${error} (${file})`);
    else docs[key] = doc;
  }
  const result = validateArt(docs, { names });
  // A file that could not be read is reported once, with the real reason.
  result.errors = result.errors.filter((e) => !readErrors.some((r) => e.startsWith(`${r.split(':')[0]}: missing`)));
  result.errors.unshift(...readErrors);

  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return result.errors.length ? 1 : 0;
  }
  const quiet = argv.includes('--quiet');
  if (!quiet) console.log(`Coloring art: ${path.relative(process.cwd(), dir) || '.'}`);
  for (const l of formatArtReport(result, { quiet })) console.log(l);
  if (!quiet) console.log('');
  for (const w of result.warnings) console.log(`WARNING ${w}`);
  for (const e of result.errors) console.log(`ERROR   ${e}`);
  console.log(`\n${result.rows.length} item(s), ${result.combos.checked} combo(s), ${result.errors.length} error(s), ${result.warnings.length} warning(s)`);
  return result.errors.length ? 1 : 0;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  try { return norm(process.argv[1]) === norm(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (invokedDirectly) process.exitCode = main(process.argv.slice(2));

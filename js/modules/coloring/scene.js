// Coloring scene renderer — PURE functions that return SVG markup strings (no DOM).
// Used by the coloring module in the browser and by tools/*.mjs in Node, so the art
// validator/previewer renders exactly what children see.
//
// Content lives in data/coloring/{animals,accessories,backgrounds}.json (see docs/CONTENT-FORMAT.md).
// Every part is a list of simple shapes. Each shape has a `kind`:
//   region — closed shape a child can tap to fill (starts white, outlined)
//   line   — outline/detail stroke only (never fillable, taps pass through)
//   ink    — solid dark detail (pupils, noses); stays dark when printed
//   white  — solid white detail with no outline (eye shine)
//
// Coordinate systems:
//   scene       600 x 600 (backgrounds draw in this space directly)
//   animal box  300 x 300, placed into the scene by `placement` (default x:150, y:270, scale:1)
//   accessory   drawn around (0,0) = its attach point; placed at the animal's matching
//               anchor { x, y, scale, rotate } (anchor coords are in the animal box).
// Outlines are the same thickness everywhere (compensated for layer scale).

export const SCENE = { width: 600, height: 600 };
export const ANIMAL_BOX = { width: 300, height: 300 };
export const DEFAULT_PLACEMENT = { x: 150, y: 270, scale: 1 };
export const INK = '#2B2D42';
export const PRINT_INK = '#000000';
export const PAPER = '#FFFFFF';
export const STROKE = 5;
export const ANCHORS = ['head', 'eyes', 'neck', 'hand'];
export const KINDS = ['region', 'line', 'ink', 'white'];
export const SHAPE_TYPES = ['path', 'circle', 'ellipse', 'rect', 'polygon', 'polyline', 'line'];

const PATH_OK = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]+$/;
const POINTS_OK = /^[0-9eE.,+\-\s]+$/;
const COLOR_OK = /^#[0-9a-fA-F]{6}$/;
const ID_OK = /^[a-z0-9][a-z0-9-]*$/;

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : d;
};

// Numeric fields a shape must have (a missing one would silently render as 0 = invisible).
const REQUIRED = { circle: ['cx', 'cy', 'r'], ellipse: ['cx', 'cy', 'rx', 'ry'], rect: ['x', 'y', 'width', 'height'], line: ['x1', 'y1', 'x2', 'y2'] };

/** [tagName, geometryAttributes] for a valid shape, else null. Values are sanitized. */
function geometry(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  if ((REQUIRED[s.type] || []).some((k) => s[k] == null || !Number.isFinite(Number(s[k])))) return null;
  switch (s.type) {
    case 'path':
      return typeof s.d === 'string' && PATH_OK.test(s.d) ? ['path', `d="${s.d.trim().replace(/\s+/g, ' ')}"`] : null;
    case 'circle':
      return ['circle', `cx="${num(s.cx)}" cy="${num(s.cy)}" r="${Math.max(0, num(s.r))}"`];
    case 'ellipse':
      return ['ellipse', `cx="${num(s.cx)}" cy="${num(s.cy)}" rx="${Math.max(0, num(s.rx))}" ry="${Math.max(0, num(s.ry))}"`];
    case 'rect':
      return ['rect', `x="${num(s.x)}" y="${num(s.y)}" width="${Math.max(0, num(s.width))}" height="${Math.max(0, num(s.height))}" rx="${Math.max(0, num(s.rx))}"`];
    case 'polygon':
    case 'polyline':
      return typeof s.points === 'string' && POINTS_OK.test(s.points) ? [s.type, `points="${s.points.trim().replace(/\s+/g, ' ')}"`] : null;
    case 'line':
      return ['line', `x1="${num(s.x1)}" y1="${num(s.y1)}" x2="${num(s.x2)}" y2="${num(s.y2)}"`];
    default:
      return null;
  }
}

/** Stable id for a fillable region: "<layer>:<partId>:<shape.id or index>". */
export function regionKey(layer, partId, shape, index) {
  return `${layer}:${partId}:${shape && typeof shape.id === 'string' && ID_OK.test(shape.id) ? shape.id : index}`;
}

function renderShapes(part, layer, { mode, fills, sw, ink }) {
  let out = '';
  const shapes = Array.isArray(part.shapes) ? part.shapes : [];
  shapes.forEach((s, i) => {
    const g = geometry(s);
    if (!g) return;
    const [tag, geom] = g;
    let kind = KINDS.includes(s.kind) ? s.kind : 'line';
    if (kind === 'region' && (tag === 'line' || tag === 'polyline')) kind = 'line';
    const width = Number.isFinite(Number(s.w)) && Number(s.w) > 0 ? ` stroke-width="${num(sw * Number(s.w), sw)}"` : '';
    const passive = mode === 'color' ? ' pointer-events="none"' : '';
    let attrs;
    if (kind === 'region') {
      const k = regionKey(layer, part.id, s, i);
      const fill = mode === 'print' ? PAPER : COLOR_OK.test(fills?.[k] || '') ? fills[k] : PAPER;
      attrs = mode === 'color' ? `fill="${fill}" class="region" data-region="${k}"` : `fill="${fill}"`;
    } else if (kind === 'ink') {
      attrs = `fill="${ink}"${passive}`;
    } else if (kind === 'white') {
      attrs = `fill="${PAPER}" stroke="none"${passive}`;
    } else {
      attrs = `fill="none"${passive}`;
    }
    out += `<${tag} ${geom} ${attrs}${width}/>`;
  });
  return out;
}

function layer(content, { transform, scale, ink, strokeWidth, name }) {
  const t = transform ? ` transform="${transform}"` : '';
  return `<g class="layer-${name}"${t} stroke="${ink}" stroke-width="${num(strokeWidth / scale, strokeWidth)}" stroke-linecap="round" stroke-linejoin="round">${content}</g>`;
}

/**
 * Compose a full scene as an <svg> string.
 * @param {object} o
 * @param {object} [o.background]  background part (scene coords)
 * @param {object} [o.animal]      animal part (animal-box coords, with anchors)
 * @param {object} [o.accessory]   accessory part (anchor-relative coords)
 * @param {object} [o.placement]   where the animal box goes (default DEFAULT_PLACEMENT)
 * @param {object} [o.fills]       { regionKey: '#RRGGBB' }
 * @param {'color'|'print'|'thumb'} [o.mode]  color = interactive (data-region attrs),
 *        print = all regions white + pure black ink, thumb = static preview with fills
 * @param {number} [o.strokeWidth] outline width in scene units
 * @param {string} [o.className]   class on the <svg>
 */
export function renderScene({
  background, animal, accessory, placement, fills = {}, mode = 'color', strokeWidth = STROKE, className = '',
} = {}) {
  const ink = mode === 'print' ? PRINT_INK : INK;
  const P = { ...DEFAULT_PLACEMENT, ...(placement || {}) };
  const pScale = num(P.scale, 1) || 1;
  let body = `<rect x="0" y="0" width="${SCENE.width}" height="${SCENE.height}" fill="${PAPER}" stroke="none"${mode === 'color' ? ' pointer-events="none"' : ''}/>`;

  if (background) {
    body += layer(renderShapes(background, 'bg', { mode, fills, sw: strokeWidth, ink }), { scale: 1, ink, strokeWidth, name: 'bg' });
  }
  if (animal) {
    const t = `translate(${num(P.x)} ${num(P.y)}) scale(${pScale})`;
    body += layer(renderShapes(animal, 'animal', { mode, fills, sw: strokeWidth / pScale, ink }), { transform: t, scale: pScale, ink, strokeWidth, name: 'animal' });
    const a = accessory && animal.anchors && animal.anchors[accessory.anchor];
    if (a) {
      const s = num(a.scale, 1) || 1;
      const t2 = `${t} translate(${num(a.x)} ${num(a.y)}) rotate(${num(a.rotate)}) scale(${s})`;
      const total = pScale * s;
      body += layer(renderShapes(accessory, 'acc', { mode, fills, sw: strokeWidth / total, ink }), { transform: t2, scale: total, ink, strokeWidth, name: 'acc' });
    }
  }
  const cls = className ? ` class="${String(className).replace(/[^a-zA-Z0-9 _-]/g, '')}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SCENE.width} ${SCENE.height}"${cls} preserveAspectRatio="xMidYMid meet">${body}</svg>`;
}

/** Render a single part on its own (for picker thumbnails), framed in its own coordinate box. */
export function renderPart(part, kind, { mode = 'thumb', strokeWidth = STROKE, viewBox } = {}) {
  const ink = mode === 'print' ? PRINT_INK : INK;
  let vb = viewBox;
  if (!vb) {
    if (kind === 'background') vb = [0, 0, SCENE.width, SCENE.height];
    else if (kind === 'animal') vb = [0, 0, ANIMAL_BOX.width, ANIMAL_BOX.height];
    else vb = part.viewBox || [-110, -110, 220, 220];
  }
  const scale = SCENE.width / vb[2]; // keep outlines visually similar to the scene
  const content = renderShapes(part, kind, { mode, fills: {}, sw: strokeWidth / scale, ink });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.map((v) => num(v)).join(' ')}" preserveAspectRatio="xMidYMid meet"><g stroke="${ink}" stroke-width="${num(strokeWidth / scale)}" stroke-linecap="round" stroke-linejoin="round">${content}</g></svg>`;
}

/** All fillable region keys a scene would contain (for undo/restore bookkeeping). */
export function regionKeys({ background, animal, accessory } = {}) {
  const keys = [];
  const collect = (part, layerName) => {
    (Array.isArray(part?.shapes) ? part.shapes : []).forEach((s, i) => {
      const g = geometry(s);
      if (g && s.kind === 'region' && g[0] !== 'line' && g[0] !== 'polyline') keys.push(regionKey(layerName, part.id, s, i));
    });
  };
  if (background) collect(background, 'bg');
  if (animal) {
    collect(animal, 'animal');
    if (accessory && animal.anchors && animal.anchors[accessory.anchor]) collect(accessory, 'acc');
  }
  return keys;
}

/**
 * Validate one part. kind: 'animal' | 'accessory' | 'background'.
 * Returns an array of human-readable problems (empty = valid). Used by tools/validate-art.mjs
 * and at runtime to skip broken (e.g. badly generated) parts.
 */
export function validatePart(part, kind) {
  const errs = [];
  const where = `${kind} "${part && part.id}"`;
  if (!part || typeof part !== 'object') return [`${kind}: not an object`];
  if (typeof part.id !== 'string' || !ID_OK.test(part.id)) errs.push(`${where}: id must be lowercase letters, digits, dashes`);
  if (typeof part.name !== 'string' || !part.name.trim()) errs.push(`${where}: missing name`);
  const shapes = Array.isArray(part.shapes) ? part.shapes : [];
  if (!shapes.length) errs.push(`${where}: shapes must be a non-empty array`);
  let regions = 0;
  shapes.forEach((s, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) { errs.push(`${where} shape ${i}: must be an object`); return; }
    if (!SHAPE_TYPES.includes(s && s.type)) errs.push(`${where} shape ${i}: unknown type "${s && s.type}"`);
    else if (!geometry(s)) errs.push(`${where} shape ${i}: invalid geometry`);
    if (!KINDS.includes(s && s.kind)) errs.push(`${where} shape ${i}: kind must be one of ${KINDS.join(', ')}`);
    if (s.kind === 'region' && s.type !== 'line' && s.type !== 'polyline') regions++;
    for (const f of ['cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'w']) {
      if (s && f in s && !Number.isFinite(Number(s[f]))) errs.push(`${where} shape ${i}: ${f} is not a number`);
    }
  });
  if (!regions) errs.push(`${where}: needs at least one fillable region`);
  if (kind === 'animal') {
    for (const a of ANCHORS) {
      const an = part.anchors && part.anchors[a];
      if (!an || !Number.isFinite(Number(an.x)) || !Number.isFinite(Number(an.y))) errs.push(`${where}: anchor "${a}" needs numeric x and y`);
      else if (an.scale != null && !(Number(an.scale) > 0)) errs.push(`${where}: anchor "${a}" scale must be > 0`);
    }
  }
  if (kind === 'accessory' && !ANCHORS.includes(part.anchor)) errs.push(`${where}: anchor must be one of ${ANCHORS.join(', ')}`);
  return errs;
}

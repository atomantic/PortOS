/**
 * Music Video — reusable code character definitions for a procedural Cast & Sets
 * direction (pure).
 *
 * A procedural direction describes a character in prose; a DEFINITION makes it
 * executable and reviewable: a renderer id, geometry parts in a fixed 200×200
 * box, a named palette, named expressions and poses (per-part overrides) and
 * motion rules. The same definition is drawn into the check-in sheet as inline
 * SVG and handed to the code-authoring request so every scene reuses it.
 *
 * Everything here is bounded and sanitized: numbers are finite and clamped,
 * colors are hex or a palette name, a path may hold only drawing commands. The
 * preview is built from those validated values alone (no script, no URL, no
 * font), so it is safe inside the sandboxed sheet and offline.
 *
 * Absent-vs-empty: `normalizeDefinitions(undefined)` is `null` (keep the current
 * value); `{ characters: [] }` is an intentional clear.
 */

import { trimTo } from '../../lib/textUtils.js';

export const CAST_SETS_DEFINITION_RENDERERS = Object.freeze(['svg', 'canvas2d', 'three']);
export const CAST_SETS_DEFINITION_SHAPES = Object.freeze(['circle', 'ellipse', 'rect', 'polygon', 'path', 'line']);
export const CAST_SETS_MOTION_PROPERTIES = Object.freeze(['rotate', 'scale', 'translateX', 'translateY', 'opacity']);
export const CAST_SETS_MOTION_TRIGGERS = Object.freeze(['idle', 'beat', 'downbeat', 'lyric', 'section']);
export const CAST_SETS_MOTION_EASINGS = Object.freeze(['linear', 'ease-in-out', 'ease-out', 'bounce', 'step']);
export const CAST_SETS_DEFINITION_LIMITS = Object.freeze({
  characters: 4,
  parts: 20,
  palette: 12,
  expressions: 8,
  poses: 8,
  motion: 8,
  points: 16,
  path: 400,
  box: 200,
});

const NAME = 60;
const NOTE = 200;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
// A path may hold drawing commands, numbers and separators — nothing else.
const PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9\s.,+-]+$/;

// Local escape (the sheet imports this module, so it cannot be imported back).
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const slug = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const round = (n) => Math.round(n * 100) / 100;
const num = (v, min, max) => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? round(Math.min(max, Math.max(min, n))) : null;
};
const coord = (v) => num(v, 0, CAST_SETS_DEFINITION_LIMITS.box);
const pair = (v) => {
  if (!Array.isArray(v) || v.length < 2) return null;
  const x = coord(v[0]);
  const y = coord(v[1]);
  return x == null || y == null ? null : [x, y];
};

function normalizePalette(raw) {
  // Either [{ name, hex }] or { name: hex }.
  const entries = Array.isArray(raw)
    ? raw.filter(isObject).map((e) => [e.name, e.hex ?? e.color])
    : (isObject(raw) ? Object.entries(raw) : []);
  const seen = new Set();
  const out = [];
  for (const [name, hex] of entries) {
    const key = slug(name);
    if (!key || seen.has(key) || typeof hex !== 'string' || !HEX.test(hex.trim())) continue;
    seen.add(key);
    out.push({ name: key, hex: hex.trim().toLowerCase() });
    if (out.length >= CAST_SETS_DEFINITION_LIMITS.palette) break;
  }
  return out;
}

// A color is `none`, a hex, or the name of a palette entry; anything else is dropped.
function normalizeColor(v, palette) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if (t.toLowerCase() === 'none') return 'none';
  if (HEX.test(t)) return t.toLowerCase();
  const key = slug(t);
  return palette.some((p) => p.name === key) ? key : '';
}

function normalizePart(raw, palette, index) {
  if (!isObject(raw)) return null;
  const shape = oneOf(raw.shape, CAST_SETS_DEFINITION_SHAPES, null);
  if (!shape) return null;
  const part = { id: slug(raw.id) || `part-${index + 1}`, shape };
  const box = CAST_SETS_DEFINITION_LIMITS.box;
  if (shape === 'circle') {
    const [x, y, r] = [coord(raw.x), coord(raw.y), num(raw.r, 0, box)];
    if (x == null || y == null || !r) return null;
    Object.assign(part, { x, y, r });
  } else if (shape === 'ellipse') {
    const [x, y, rx, ry] = [coord(raw.x), coord(raw.y), num(raw.rx, 0, box), num(raw.ry, 0, box)];
    if (x == null || y == null || !rx || !ry) return null;
    Object.assign(part, { x, y, rx, ry });
  } else if (shape === 'rect') {
    const [x, y, width, height] = [coord(raw.x), coord(raw.y), num(raw.width, 0, box), num(raw.height, 0, box)];
    if (x == null || y == null || !width || !height) return null;
    Object.assign(part, { x, y, width, height });
    const radius = num(raw.radius, 0, box);
    if (radius) part.radius = radius;
  } else if (shape === 'line') {
    const [x, y, x2, y2] = [coord(raw.x), coord(raw.y), coord(raw.x2), coord(raw.y2)];
    if (x == null || y == null || x2 == null || y2 == null) return null;
    Object.assign(part, { x, y, x2, y2 });
  } else if (shape === 'polygon') {
    const points = (Array.isArray(raw.points) ? raw.points : []).map(pair).filter(Boolean).slice(0, CAST_SETS_DEFINITION_LIMITS.points);
    if (points.length < 3) return null;
    part.points = points;
  } else {
    const d = trimTo(raw.d, CAST_SETS_DEFINITION_LIMITS.path);
    if (!d || !PATH.test(d)) return null;
    part.d = d;
  }
  const fill = normalizeColor(raw.fill, palette);
  const stroke = normalizeColor(raw.stroke, palette);
  if (fill) part.fill = fill;
  if (stroke) part.stroke = stroke;
  const strokeWidth = num(raw.strokeWidth, 0, 40);
  if (strokeWidth != null) part.strokeWidth = strokeWidth;
  const opacity = num(raw.opacity, 0, 1);
  if (opacity != null) part.opacity = opacity;
  const pivot = pair(raw.pivot);
  if (pivot) part.pivot = pivot;
  return part;
}

// Expressions and poses: per-part overrides of the base geometry.
function normalizeStates(raw, partIds, palette, max) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!isObject(entry)) continue;
    const name = trimTo(entry.name, NAME);
    const key = slug(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const overrides = {};
    for (const [partId, o] of Object.entries(isObject(entry.overrides) ? entry.overrides : {})) {
      const id = slug(partId);
      if (!partIds.has(id) || !isObject(o)) continue;
      const next = {};
      const translate = Array.isArray(o.translate) && o.translate.length >= 2 ? [num(o.translate[0], -200, 200), num(o.translate[1], -200, 200)] : null;
      if (translate && translate.every((n) => n != null)) next.translate = translate;
      const rotate = num(o.rotate, -360, 360);
      if (rotate != null) next.rotate = rotate;
      const scale = num(o.scale, 0, 4);
      if (scale != null) next.scale = scale;
      const opacity = num(o.opacity, 0, 1);
      if (opacity != null) next.opacity = opacity;
      const fill = normalizeColor(o.fill, palette);
      if (fill) next.fill = fill;
      if (o.hidden === true) next.hidden = true;
      if (Object.keys(next).length) overrides[id] = next;
    }
    out.push({ name, overrides });
    if (out.length >= max) break;
  }
  return out;
}

function normalizeMotion(raw, partIds) {
  const out = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!isObject(entry)) continue;
    const name = trimTo(entry.name, NAME);
    const property = oneOf(entry.property, CAST_SETS_MOTION_PROPERTIES, null);
    const amplitude = num(entry.amplitude, -360, 360);
    if (!name || !property || amplitude == null) continue;
    const target = slug(entry.target);
    out.push({
      name,
      target: partIds.has(target) ? target : 'all',
      property,
      amplitude,
      periodBeats: num(entry.periodBeats, 0.25, 64) ?? 1,
      easing: oneOf(entry.easing, CAST_SETS_MOTION_EASINGS, 'ease-in-out'),
      trigger: oneOf(entry.trigger, CAST_SETS_MOTION_TRIGGERS, 'idle'),
      ...(trimTo(entry.note, NOTE) ? { note: trimTo(entry.note, NOTE) } : {}),
    });
    if (out.length >= CAST_SETS_DEFINITION_LIMITS.motion) break;
  }
  return out;
}

function normalizeCharacter(raw, index) {
  if (!isObject(raw)) return null;
  const name = trimTo(raw.name, NAME);
  const palette = normalizePalette(raw.palette);
  const seen = new Set();
  const parts = [];
  for (const [i, p] of (Array.isArray(raw.parts) ? raw.parts : []).entries()) {
    const part = normalizePart(p, palette, i);
    if (!part) continue;
    let id = part.id;
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    parts.push({ ...part, id });
    if (parts.length >= CAST_SETS_DEFINITION_LIMITS.parts) break;
  }
  if (!name || !parts.length) return null;
  const partIds = new Set(parts.map((p) => p.id));
  return {
    id: slug(raw.id) || slug(name) || `character-${index + 1}`,
    name,
    renderer: oneOf(raw.renderer, CAST_SETS_DEFINITION_RENDERERS, 'svg'),
    palette,
    parts,
    expressions: normalizeStates(raw.expressions, partIds, palette, CAST_SETS_DEFINITION_LIMITS.expressions),
    poses: normalizeStates(raw.poses, partIds, palette, CAST_SETS_DEFINITION_LIMITS.poses),
    motion: normalizeMotion(raw.motion, partIds),
  };
}

/**
 * Validate and bound a definitions block. Returns `null` when the input is not
 * a definitions object at all (the caller keeps the current value),
 * `{ characters: [] }` for an intentional clear, and `{ characters }` otherwise.
 * Characters that do not validate are dropped; when every character the input
 * carried is unusable the whole block counts as unusable (`null`) rather than
 * as a clear.
 */
export function normalizeDefinitions(raw) {
  if (!isObject(raw) || !Array.isArray(raw.characters)) return null;
  if (!raw.characters.length) return { characters: [] };
  const seen = new Set();
  const characters = [];
  for (const [i, c] of raw.characters.entries()) {
    const character = normalizeCharacter(c, i);
    if (!character) continue;
    let id = character.id;
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    characters.push({ ...character, id });
    if (characters.length >= CAST_SETS_DEFINITION_LIMITS.characters) break;
  }
  return characters.length ? { characters } : null;
}

// ---- preview ----------------------------------------------------------------

const colorOf = (value, palette, fallback) => {
  if (value === 'none') return 'none';
  if (typeof value === 'string' && HEX.test(value)) return value;
  return palette.find((p) => p.name === value)?.hex || fallback;
};

// Where a part turns and scales from when it names no pivot: its own center.
function centerOf(part) {
  if (part.shape === 'rect') return [part.x + part.width / 2, part.y + part.height / 2];
  if (part.shape === 'line') return [(part.x + part.x2) / 2, (part.y + part.y2) / 2];
  if (part.shape === 'polygon') return [round(part.points.reduce((t, [x]) => t + x, 0) / part.points.length), round(part.points.reduce((t, [, y]) => t + y, 0) / part.points.length)];
  if (part.shape === 'path') return [CAST_SETS_DEFINITION_LIMITS.box / 2, CAST_SETS_DEFINITION_LIMITS.box / 2];
  return [part.x, part.y];
}

function partMarkup(part, character, override = {}) {
  if (override.hidden) return '';
  const palette = character.palette;
  const fill = colorOf(override.fill ?? part.fill, palette, part.stroke ? 'none' : '#9aa8a1');
  const stroke = colorOf(part.stroke, palette, 'none');
  const attrs = [`fill="${fill}"`, `stroke="${stroke}"`];
  if (part.strokeWidth != null) attrs.push(`stroke-width="${part.strokeWidth}"`);
  const opacity = override.opacity ?? part.opacity;
  if (opacity != null) attrs.push(`opacity="${opacity}"`);
  const [px, py] = part.pivot || centerOf(part);
  const [tx, ty] = override.translate || [0, 0];
  const transforms = [];
  if (tx || ty) transforms.push(`translate(${tx} ${ty})`);
  if (override.rotate) transforms.push(`rotate(${override.rotate} ${px} ${py})`);
  if (override.scale != null && override.scale !== 1) transforms.push(`translate(${px} ${py}) scale(${override.scale}) translate(${-px} ${-py})`);
  if (transforms.length) attrs.push(`transform="${transforms.join(' ')}"`);
  const body = {
    circle: () => `<circle cx="${part.x}" cy="${part.y}" r="${part.r}"`,
    ellipse: () => `<ellipse cx="${part.x}" cy="${part.y}" rx="${part.rx}" ry="${part.ry}"`,
    rect: () => `<rect x="${part.x}" y="${part.y}" width="${part.width}" height="${part.height}"${part.radius ? ` rx="${part.radius}"` : ''}`,
    line: () => `<line x1="${part.x}" y1="${part.y}" x2="${part.x2}" y2="${part.y2}"`,
    polygon: () => `<polygon points="${part.points.map(([x, y]) => `${x},${y}`).join(' ')}"`,
    path: () => `<path d="${part.d}"`,
  }[part.shape]();
  return `${body} ${attrs.join(' ')}/>`;
}

/**
 * One character as an inline `<svg>` string, drawn in the base pose or with a
 * named expression or pose applied. Input is re-validated, so a hand-edited or
 * stale record can never smuggle markup into the sheet.
 */
export function renderCharacterSvg(character, stateName = null, { size = 160 } = {}) {
  const safe = normalizeDefinitions({ characters: [character] })?.characters?.[0];
  if (!safe) return '';
  const key = slug(stateName);
  const state = key ? [...safe.expressions, ...safe.poses].find((s) => slug(s.name) === key) : null;
  const parts = safe.parts.map((part) => partMarkup(part, safe, state?.overrides?.[part.id])).join('');
  const label = `${safe.name}${state ? `: ${state.name}` : ''}`;
  return `<svg viewBox="0 0 ${CAST_SETS_DEFINITION_LIMITS.box} ${CAST_SETS_DEFINITION_LIMITS.box}" width="${size}" height="${size}" role="img" aria-label="${escapeHtml(label)}">${parts}</svg>`;
}

/** The sheet's "Character design" section for a direction's definitions ('' when it has none). */
export function renderDefinitionsSection(definitions) {
  const characters = normalizeDefinitions(definitions)?.characters || [];
  if (!characters.length) return '';
  const e = escapeHtml;
  const cards = characters.map((c) => {
    const states = [{ name: 'Base', label: 'Base pose' }, ...c.expressions.map((s) => ({ name: s.name, label: s.name })), ...c.poses.map((s) => ({ name: s.name, label: `${s.name} (pose)` }))];
    const tiles = states.map((s) => `<figure class="def-tile">${renderCharacterSvg(c, s.name === 'Base' ? null : s.name)}<figcaption>${e(s.label)}</figcaption></figure>`).join('');
    const swatches = c.palette.map((p) => `<span class="swatch"><i style="background:${p.hex}"></i>${e(p.name)} <code>${p.hex}</code></span>`).join('');
    const motion = c.motion.map((m) => `<tr><td>${e(m.name)}</td><td>${e(m.target)}</td><td>${e(m.property)} ±${m.amplitude}</td><td>${m.periodBeats} beat${m.periodBeats === 1 ? '' : 's'}, ${e(m.easing)}, on ${e(m.trigger)}${m.note ? ` — ${e(m.note)}` : ''}</td></tr>`).join('');
    return `<div class="def"><h3>${e(c.name)} <span>${e(c.renderer)} · ${c.parts.length} part${c.parts.length === 1 ? '' : 's'}</span></h3>
<div class="def-tiles">${tiles}</div>
${swatches ? `<div class="swatches">${swatches}</div>` : ''}
${motion ? `<div class="tablewrap"><table><tr><td><b>Motion</b></td><td><b>Target</b></td><td><b>Change</b></td><td><b>Timing</b></td></tr>${motion}</table></div>` : ''}</div>`;
  }).join('');
  return `<section><h2><small>Character design</small>Reusable code definitions</h2><p class="sub">Every scene reuses these exact parts, palette, expressions and motion rules.</p>${cards}</section>`;
}

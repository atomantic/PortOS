/**
 * Pure helpers for the Place greybox editor. The scene itself is validated
 * server-side (`server/lib/greyboxScene.js`; the client has no zod), so these
 * build editable rows and shots, check draft cross-references and numeric
 * bounds, and map a shot's lens/aspect to the numbers a Three.js camera needs.
 */

import { GREYBOX_ASPECTS, GREYBOX_SHOT_ROLE_PREFIX } from '../../../server/lib/greyboxVocabulary.js';

export { GREYBOX_ASPECTS };
export const DEFAULT_FOCAL_LENGTH_MM = 35;
const DEFAULT_ZONE_COLOR = '#8a8f98';

/** Width / height for an aspect label like `16:9`. */
export function aspectRatio(aspect) {
  const [w, h] = String(aspect).split(':').map(Number);
  return w > 0 && h > 0 ? w / h : 16 / 9;
}

// A 35mm-equivalent lens is quoted against the 24mm full-frame sensor height,
// so the vertical field of view is 2·atan(12 / f). Matches the server's
// "focalLengthMm" meaning in the scene contract.
export const fovFromFocalLength = (mm) => (2 * Math.atan(12 / mm) * 180) / Math.PI;

/** The role a shot's captured reference image carries on the place's media. */
const shotRole = (shotId) => `${GREYBOX_SHOT_ROLE_PREFIX}${shotId}`;

/** The media row holding a shot's capture, if one is attached. */
export const captureForShot = (media, shotId) =>
  (media || []).find((m) => !m.deleted && m.role === shotRole(shotId)) || null;

export const roundVec = (v) => v.map((n) => Math.round(n * 100) / 100);

// Ids must start with a letter and use letters, digits, `_`, `-` (server rule).
function uniqueId(base, taken) {
  const stem = (String(base).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'shot').replace(/^[^a-z]/, 'x$&').slice(0, 48);
  if (!taken.has(stem)) return stem;
  let n = 2;
  while (taken.has(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
}

/** A new shot from the live camera. `scene.shots` supplies the taken ids. */
export function shotFromCamera(scene, { label, position, target, focalLengthMm, aspect }) {
  const taken = new Set(scene.shots.map((s) => s.id));
  const name = (label || '').trim() || `Shot ${scene.shots.length + 1}`;
  return {
    id: uniqueId(name, taken),
    label: name,
    position,
    target,
    focalLengthMm,
    aspect,
    figures: [],
  };
}

/** The scene with `shot` replaced (by id) or appended. */
export function withShot(scene, shot) {
  const { shots } = scene;
  return shots.some((s) => s.id === shot.id)
    ? { ...scene, shots: shots.map((s) => (s.id === shot.id ? shot : s)) }
    : { ...scene, shots: [...shots, shot] };
}

export const withoutShot = (scene, shotId) => ({ ...scene, shots: scene.shots.filter((s) => s.id !== shotId) });

/** A one-room scene so a place can be laid out by hand with no AI call. */
export function blankGreybox() {
  return {
    version: 1,
    source: 'spec',
    parts: [
      { id: 'floor', label: 'Floor', type: 'box', size: [20, 0.1, 14], position: [0, -0.05, 0], rotationDegrees: [0, 0, 0] },
    ],
    zones: [],
    landmarks: [],
    anchors: [],
    shots: [
      { id: 'wide', label: 'Wide', position: [0, 6, 16], target: [0, 1, 0], focalLengthMm: 28, aspect: '16:9', figures: [] },
    ],
  };
}

/** Tint for a part: its zone's colour, else neutral grey. */
export function partColor(scene, part) {
  return scene.zones.find((z) => z.id === part.zone)?.color || DEFAULT_ZONE_COLOR;
}

/** New editable rows use immutable ids; references therefore survive renaming. */
export function newGreyboxItem(scene, collection, type = 'box') {
  const id = uniqueId(collection.slice(0, -1), new Set(scene[collection].map((item) => item.id)));
  if (collection === 'zones') return { id, label: 'New zone', color: '#8a8f98' };
  if (collection === 'landmarks') return { id, label: 'New landmark', position: [0, 0, 0], note: '' };
  if (collection === 'anchors') return { id, label: 'New anchor', kind: 'figure', position: [0, 0, 0], facingDegrees: 0, heightMeters: 1.7 };
  const shape = {
    box: { size: [1, 1, 1] }, plane: { size: [1, 1] }, cylinder: { radius: 0.5, height: 1 },
    extrude: { outline: [[-1, -1], [1, -1], [1, 1], [-1, 1]], height: 1 },
  }[type];
  return { id, label: 'New part', type, ...shape, position: [0, 0.5, 0], rotationDegrees: [0, 0, 0] };
}

/** Removing a referenced row clears only its dependent references. */
export function withoutGreyboxItem(scene, collection, id) {
  const next = { ...scene, [collection]: scene[collection].filter((item) => item.id !== id) };
  if (collection === 'anchors') next.shots = scene.shots.map((shot) => ({ ...shot, figures: shot.figures.filter((figure) => figure.anchorId !== id) }));
  if (collection === 'zones') next.parts = scene.parts.map((part) => {
    if (part.zone !== id) return part;
    const { zone: _zone, ...rest } = part;
    return rest;
  });
  return next;
}

/** Fast editor checks; the PUT's server schema remains authoritative. */
export function greyboxEditErrors(scene) {
  const errors = [];
  const limits = { parts: 400, zones: 24, landmarks: 80, anchors: 80, shots: 60 };
  const number = (value, min, max, name, positive = false) => {
    if (!Number.isFinite(value) || value < min || value > max || (positive && value === 0)) errors.push(`${name} must be ${positive ? 'greater than 0' : `at least ${min}`} and at most ${max}.`);
  };
  const vector = (values, name, positive = false) => values.forEach((value) => number(value, positive ? 0 : -1000, 1000, name, positive));
  for (const [key, max] of Object.entries(limits)) {
    if (scene[key].length > max) errors.push(`Too many ${key} (maximum ${max}).`);
    const ids = new Set();
    for (const item of scene[key]) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.id)) errors.push(`Invalid ${key} id.`);
      if (ids.has(item.id)) errors.push(`Duplicate ${key} id: ${item.id}.`);
      ids.add(item.id);
      if ((key !== 'parts' || item.label !== undefined) && (!item.label?.trim() || item.label.trim().length > 120)) errors.push(`${key} labels need 1–120 characters.`);
      if (item.position) vector(item.position, `${key} position`);
    }
  }
  if (scene.source === 'spec' && !scene.parts.length) errors.push('Keep at least one part in the layout.');
  const zones = new Set(scene.zones.map((zone) => zone.id));
  for (const zone of scene.zones) if (!/^#[0-9a-fA-F]{6}$/.test(zone.color)) errors.push('Zone colors must use six hexadecimal digits.');
  for (const part of scene.parts) {
    if (part.zone && !zones.has(part.zone)) errors.push(`Part ${part.id} names an unknown zone.`);
    vector(part.rotationDegrees, 'Part rotation');
    if (part.size) vector(part.size, 'Part size', true);
    if (part.radius !== undefined) number(part.radius, 0, 1000, 'Part radius', true);
    if (part.height !== undefined) number(part.height, 0, 1000, 'Part height', true);
    if (part.outline) {
      if (part.outline.length < 3 || part.outline.length > 96) errors.push('An outline needs 3–96 points.');
      part.outline.forEach((point) => vector(point, 'Outline position'));
    }
  }
  for (const anchor of scene.anchors) {
    number(anchor.facingDegrees, -360, 360, 'Anchor facing');
    number(anchor.heightMeters, 0, 50, 'Anchor height', true);
  }
  const anchors = new Set(scene.anchors.map((anchor) => anchor.id));
  for (const shot of scene.shots) {
    if (shot.figures.length > 24) errors.push('A shot can contain at most 24 figures.');
    for (const figure of shot.figures) {
      if (!anchors.has(figure.anchorId)) errors.push(`Shot ${shot.id} names an unknown anchor.`);
      if ((figure.pose || '').trim().length > 120) errors.push('Pose notes must be at most 120 characters.');
    }
  }
  return [...new Set(errors)];
}

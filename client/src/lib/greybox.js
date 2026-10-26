/**
 * Pure helpers for the Place greybox editor. The scene itself is validated
 * server-side (`server/lib/greyboxScene.js`; the client has no zod), so these
 * only read an already-validated scene, build shots from a camera, and map a
 * shot's lens/aspect to the numbers a Three.js camera needs.
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

/**
 * Music Video — each planned shot's structured camera move (#10589).
 *
 * The planner asks the model for `camera: { move, speed, endFraming, onBeat,
 * reason }` per shot, drawn from the shared camera-movement catalog
 * (lib/cameraMovements.js). This module validates that answer against the
 * catalog and the planning rules, and fills every gap deterministically, so a
 * plan made without a provider (or with a partial answer) still varies its
 * camera instead of locking off:
 *
 *   - at most MAX_FAMILY_RUN consecutive shots from the same move family;
 *   - hit points (a chorus/hook/drop's first shot, the opening hook) snap on
 *     the downbeat when the planner picks;
 *   - a still camera (lock-off, locked time-lapse) must give its reason;
 *   - performance shots keep their frontal lip-sync framing, so they never take
 *     a snap, orbit, roll or other high-energy move.
 *
 * Title cards are graphic beats with no camera. Pure; the planner persists the
 * result on the Board scenes as `scene.camera`.
 */

import {
  CAMERA_FRAMINGS, CAMERA_SPEEDS, SNAP_CAMERA_MOVEMENTS, cameraMovementCatalogForPrompt, cameraMovementId, getCameraMovement,
} from '../../lib/cameraMovements.js';

export const MAX_FAMILY_RUN = 2;
const HIT_SECTION = /chorus|hook|drop/i;
const REASON_MAX = 300;

// Deterministic picks per energy tier; the snap pool serves hit points.
const POOLS = Object.freeze({
  calm: ['slow-dolly-in', 'cinematic-arc', 'pedestal-up', 'slider-parallax', 'slow-dolly-out', 'tilt-up', 'focus-reveal', 'pan-right'],
  medium: ['truck-right', 'orbit-180', 'crane-up', 'steadicam-follow', 'push-past', 'pan-left', 'side-tracking', 'zoom-in'],
  high: ['fast-dolly-in', 'whip-pan', 'drone-dive', 'barrel-roll', 'chase-tracking', 'orbit-360', 'handheld', 'crash-zoom'],
});
const SNAP_POOL = SNAP_CAMERA_MOVEMENTS;
const PERFORMANCE_POOL = ['slow-dolly-in', 'slider-parallax', 'pedestal-up', 'handheld', 'zoom-in', 'ots-drift'];
const PERFORMANCE_FAMILIES = new Set(['static', 'push-pull', 'lateral', 'vertical', 'lens', 'tracking']);

const familyOf = (camera) => getCameraMovement(camera?.move)?.family || null;

/** calm / medium / high for a shot's normalized section energy (a chorus with no analysis reads high). */
export function shotEnergyTier(shot) {
  const energy = shot?.sectionEnergy;
  if (typeof energy !== 'number' || !Number.isFinite(energy)) return HIT_SECTION.test(shot?.sectionLabel || '') ? 'high' : 'medium';
  return energy >= 0.67 ? 'high' : energy >= 0.34 ? 'medium' : 'calm';
}

/** A hit point: the opening hook, or the first shot of a chorus / hook / drop section. */
export const isHitShot = (shot) => shot?.hook === true || (shot?.shotIndex === 0 && HIT_SECTION.test(shot?.sectionLabel || ''));

const performanceSafe = (move) => PERFORMANCE_FAMILIES.has(move.family) && move.energy !== 'high' && !move.snap;

/**
 * Validate a model-proposed camera against the catalog. Accepts an object or a
 * bare id/label. Returns the normalized `{ move, speed?, endFraming?, onBeat?,
 * reason? }`, or null for an unknown move or a still camera with no reason.
 */
export function parseShotCamera(raw) {
  const value = typeof raw === 'string' ? { move: raw } : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const move = cameraMovementId(typeof value.move === 'string' ? value.move : '');
  if (!move) return null;
  const reason = typeof value.reason === 'string' && !/^\s*<.+>\s*$/.test(value.reason) ? value.reason.trim().slice(0, REASON_MAX) : '';
  if (getCameraMovement(move).still && !reason) return null;
  return {
    move,
    ...(CAMERA_SPEEDS.includes(value.speed) ? { speed: value.speed } : {}),
    ...(CAMERA_FRAMINGS.includes(value.endFraming) ? { endFraming: value.endFraming } : {}),
    ...(value.onBeat === true ? { onBeat: true } : {}),
    ...(reason ? { reason } : {}),
  };
}

function pick(shot, index, blockedFamily, previousMove) {
  const performance = shot.shotMode === 'performance';
  const hit = !performance && isHitShot(shot);
  const pool = performance ? PERFORMANCE_POOL : hit ? SNAP_POOL : POOLS[shotEnergyTier(shot)];
  for (let step = 0; step < pool.length; step++) {
    const move = pool[(index + step) % pool.length];
    if (move === previousMove || getCameraMovement(move).family === blockedFamily) continue;
    return hit ? { move, speed: 'snap', onBeat: true } : { move };
  }
  // Every candidate collided (a one-family pool); any calm move outside the blocked family.
  return { move: POOLS.calm.find((move) => getCameraMovement(move).family !== blockedFamily) };
}

/**
 * One camera per shot, in shot order (null for title cards). `proposed` maps a
 * shot index to the model's raw camera answer; a valid answer is kept unless it
 * would make a third consecutive shot from one family or break a performance
 * shot's framing, in which case the deterministic pick replaces it.
 */
export function planShotCameras(shots, proposed = new Map()) {
  const cameras = [];
  for (const [index, shot] of shots.entries()) {
    if (shot.visualLayer === 'card') { cameras.push(null); continue; }
    const [a, b] = cameras.slice(-MAX_FAMILY_RUN).map(familyOf);
    const blockedFamily = cameras.length >= MAX_FAMILY_RUN && a && a === b ? a : null;
    let camera = parseShotCamera(proposed.get(index));
    if (camera && familyOf(camera) === blockedFamily) camera = null;
    if (camera && shot.shotMode === 'performance' && !performanceSafe(getCameraMovement(camera.move))) camera = null;
    cameras.push(camera || pick(shot, index, blockedFamily, cameras.at(-1)?.move));
  }
  return cameras;
}

/** The camera vocabulary and rules the shot-planning prompt carries. */
export function shotCameraPromptSection() {
  return `CAMERA VOCABULARY — give every shot a "camera" whose "move" is one of these ids (id (label) [family, energy]: what the camera does):
${cameraMovementCatalogForPrompt({ detail: true })}
Camera rules:
- At most ${MAX_FAMILY_RUN} consecutive shots may use moves from the same family.
- High-energy shots (energy 0.67 or more) use high-energy moves; calm shots use calm or medium ones.
- Hit points — a chorus's first downbeat, the OPENING HOOK, a hook word — take a snap move (${SNAP_POOL.join(', ')}) with "onBeat": true.
- A static camera (${['locked-off', 'locked-time-lapse'].join(', ')}) must give its "reason".
- Performance shots keep the frontal medium close-up: calm or medium push, lateral, vertical, lens or tracking moves only — no snap, orbit or roll.
- "speed" is one of ${CAMERA_SPEEDS.join(', ')}; "endFraming" is one of ${CAMERA_FRAMINGS.join(', ')}.
- Describe the camera only in "camera"; the motion "prompt" covers subject action, staging and mood.`;
}

const clock = (sec) => Number.isFinite(sec) ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}` : null;
const STATIC_RUN = 3;

/**
 * The production review's camera-variety notes (#10589), never blocking.
 * `shots` are the storyboard shots in timeline order as `{ label, move,
 * sectionKey, sectionLabel, startSec }`, where `move` is a catalog id or null
 * (unknown). Flags runs of STATIC_RUN+ still shots and chorus / hook / drop
 * sections whose shots carry no snap move.
 */
export function cameraVarietyReport(shots) {
  const staticRuns = [];
  let run = [];
  const flush = () => { if (run.length >= STATIC_RUN) staticRuns.push(run.map((s) => s.label)); run = []; };
  for (const shot of shots) {
    if (getCameraMovement(shot.move)?.still) run.push(shot);
    else flush();
  }
  flush();
  // Consecutive shots of one chorus/hook/drop section form one hit section.
  const sections = [];
  for (const [index, shot] of shots.entries()) {
    if (!HIT_SECTION.test(shot.sectionLabel || '')) continue;
    const last = sections.at(-1);
    if (last && last.key === shot.sectionKey && last.endIndex === index - 1) { last.shots.push(shot); last.endIndex = index; }
    else sections.push({ key: shot.sectionKey, label: shot.sectionLabel, startSec: shot.startSec, shots: [shot], endIndex: index });
  }
  const snaplessChoruses = sections.filter((s) => !s.shots.some((shot) => getCameraMovement(shot.move)?.snap))
    .map((s) => ({ label: s.label, startSec: Number.isFinite(s.startSec) ? s.startSec : null }));
  const notes = [
    ...staticRuns.map((labels) => `${labels.length} static shots in a row (${labels[0]} – ${labels.at(-1)}): give one of them a move, or make sure each hold is motivated.`),
    ...snaplessChoruses.map((c) => `${c.label}${clock(c.startSec) ? ` at ${clock(c.startSec)}` : ''} has no snap move: land a ${SNAP_POOL.join(', ')} on its first downbeat.`),
  ];
  return { staticRuns, snaplessChoruses, notes };
}

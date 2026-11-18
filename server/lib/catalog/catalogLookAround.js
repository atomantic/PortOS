/**
 * Place "look around": the camera motions, the prompt PortOS writes for each, and the frame analysis that turns one rotating-camera clip into labelled angles.
 *
 * One image-to-video clip from a place's main plate, prompted as a locked-tripod pan, keeps one
 * geometry and one light all the way round, so stills pulled from it agree with each other (#16145).
 * This module is pure: the service renders the clip, decodes frames and stores what the director keeps.
 *
 * Angles are labelled from the frames, not from the prompt: hosted models have turned the opposite way
 * to the one asked for. `estimateHorizontalShift` reads how far the picture slid between two frames
 * from their column-brightness profiles; the running total says which way the camera turned and how far
 * through the sweep each frame sits, which also absorbs a model that eases in and out of the turn.
 */

export const LOOK_AROUND_MOTIONS = Object.freeze({
  'full-turn': Object.freeze({ id: 'full-turn', label: 'Full turn (360°)', sweepDeg: 360, direction: 'right', defaultSec: 15,
    move: 'The camera stays in one spot at eye height and turns slowly to the right through one full 360-degree turn, ending back on the opening view.' }),
  'half-right': Object.freeze({ id: 'half-right', label: 'Half turn right (180°)', sweepDeg: 180, direction: 'right', defaultSec: 10,
    move: 'The camera stays in one spot at eye height and turns slowly to the right through a half turn of 180 degrees, ending on the view directly behind the opening view.' }),
  'half-left': Object.freeze({ id: 'half-left', label: 'Half turn left (180°)', sweepDeg: 180, direction: 'left', defaultSec: 10,
    move: 'The camera stays in one spot at eye height and turns slowly to the left through a half turn of 180 degrees, ending on the view directly behind the opening view.' }),
  'push-forward': Object.freeze({ id: 'push-forward', label: 'Slow push forward', sweepDeg: 0, direction: null, defaultSec: 8,
    move: 'The camera moves slowly straight forward at eye height, without turning, tilting or rolling.' }),
});
export const LOOK_AROUND_MOTION_IDS = Object.freeze(Object.keys(LOOK_AROUND_MOTIONS));
export const DEFAULT_LOOK_AROUND_MOTION = 'full-turn';
// Long enough on a range model (5-15 s) that a full turn stays sharp: 360° in 8 s blurred at its fastest.
export const DEFAULT_LOOK_AROUND_MODEL = 'minimax/h3-max-turbo/image-to-video';
// The media row role the kept clip carries on the place, beside its angle plates.
export const LOOK_AROUND_CLIP_ROLE = 'look-around';
// How many angles the picker suggests from one clip, spread across its sweep.
export const LOOK_AROUND_STRIP_SIZE = 12;
export const LOOK_AROUND_MAX_ANGLES = 24;

/**
 * The exact prompt PortOS writes for a motion. It is shown before the render and sent as written;
 * a director who edits it sends their own text instead.
 */
export function composeLookAroundPrompt(motionId) {
  const motion = LOOK_AROUND_MOTIONS[motionId];
  if (!motion) throw new Error(`Unknown look-around motion "${motionId}"`);
  return [
    `Locked-off tripod shot of this exact place. ${motion.move}`,
    'Steady, even speed from start to finish: no speed-ups, no pauses, no cuts.',
    'The horizon stays level.',
    'The place is empty: no people, no animals, no moving vehicles, and nothing in the place moves.',
    'The light stays the same on every side: keep the sun or glow where the opening frame has it, with the same time of day, weather and exposure throughout.',
    'Every structure, material and color stays consistent as the view comes round. No text or captions.',
  ].join(' ');
}

const normDeg = (deg) => ((Math.round(deg) % 360) + 360) % 360;

/** The angle's name from its bearing (degrees clockwise from the main plate), or its push progress. */
export function lookAroundAngleLabel({ motion, bearingDeg = 0, progress = 0 } = {}) {
  if (motion === 'push-forward') return `Pushed in ${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
  const b = normDeg(Math.round(Number(bearingDeg) / 5) * 5);
  if (b === 0) return 'Main plate view';
  if (b === 180) return '180° behind';
  return b < 180 ? `${b}° right` : `${360 - b}° left`;
}

/** Mean brightness of each column of a raw single-channel frame: what a horizontal pan slides sideways. */
export function columnProfile(frame) {
  const { width, height, data } = frame;
  const profile = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) profile[x] += data[row + x];
  }
  for (let x = 0; x < width; x++) profile[x] /= height;
  return profile;
}

/**
 * How many pixels the picture slid left between profile `a` and profile `b` (positive: the content moved
 * left, so the camera turned right). Pearson correlation over the overlap, at least half the width.
 * Returns `{ shift, correlation }`; a flat profile pair correlates at 0 and reads as no shift.
 */
function estimateHorizontalShift(a, b, { maxShift = Math.floor(Math.min(a.length, b.length) / 4) } = {}) {
  const width = Math.min(a.length, b.length);
  const limit = Math.max(0, Math.min(maxShift, Math.floor(width / 2)));
  let best = { shift: 0, correlation: 0 };
  for (let s = -limit; s <= limit; s++) {
    const start = Math.max(0, -s);
    const end = Math.min(width, width - s);
    const n = end - start;
    if (n < width / 2) continue;
    let sa = 0; let sb = 0;
    for (let x = start; x < end; x++) { sa += a[x + s]; sb += b[x]; }
    const ma = sa / n; const mb = sb / n;
    let cov = 0; let va = 0; let vb = 0;
    for (let x = start; x < end; x++) {
      const da = a[x + s] - ma; const db = b[x] - mb;
      cov += da * db; va += da * da; vb += db * db;
    }
    const correlation = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
    if (correlation > best.correlation) best = { shift: s, correlation };
  }
  return best;
}

// Below this total slide (in frame widths) the clip did not visibly turn, so its frames are placed by time.
const MIN_TURN_WIDTHS = 0.25;

/**
 * Place each scanned frame in the sweep. `frames` are in clip order: `{ atSec, sharpness, profile? }`.
 * Returns the frames with `progress` (0..1 through the move), `bearingDeg` and `label`, plus the
 * direction the camera actually turned and whether that came from the frames or, when the pan is too
 * small to read, from the motion asked for.
 */
export function analyzeLookAroundFrames(frames, { motion: motionId, durationSec, width } = {}) {
  const motion = LOOK_AROUND_MOTIONS[motionId] || LOOK_AROUND_MOTIONS[DEFAULT_LOOK_AROUND_MOTION];
  const list = Array.isArray(frames) ? frames : [];
  const duration = durationSec > 0 ? durationSec : (list.at(-1)?.atSec || 1);
  const byTime = (frame) => Math.max(0, Math.min(1, frame.atSec / duration));
  let progressOf = byTime;
  let direction = motion.direction;
  let directionSource = 'prompt';
  if (motion.sweepDeg > 0 && list.length > 1 && list.every((frame) => frame.profile)) {
    const totals = [0];
    for (let i = 1; i < list.length; i++) totals.push(totals[i - 1] + estimateHorizontalShift(list[i - 1].profile, list[i].profile).shift);
    const total = totals.at(-1);
    const frameWidth = width || list[0].profile.length;
    if (Math.abs(total) >= frameWidth * MIN_TURN_WIDTHS) {
      direction = total > 0 ? 'right' : 'left';
      directionSource = 'frames';
      // A frame that slid back past the start (a wobble) stays at the start, never at a negative bearing.
      const progress = totals.map((t) => Math.max(0, Math.min(1, t / total)));
      progressOf = (_frame, i) => progress[i];
    }
  }
  const placed = list.map((frame, i) => {
    const progress = progressOf(frame, i);
    const turned = motion.sweepDeg * progress;
    const bearingDeg = motion.sweepDeg ? normDeg(direction === 'left' ? 360 - turned : turned) : 0;
    const { profile: _profile, ...rest } = frame;
    return { ...rest, progress, bearingDeg, label: lookAroundAngleLabel({ motion: motion.id, bearingDeg, progress }) };
  });
  return { frames: placed, direction, directionSource, requestedDirection: motion.direction };
}

/**
 * The suggested strip: the sharpest usable frame in each of `count` equal slices of the sweep, so the
 * suggestions cover every side instead of clustering where the turn was slowest. Clip order.
 */
export function pickLookAroundStrip(frames, { count = LOOK_AROUND_STRIP_SIZE, minSharpness = 0 } = {}) {
  const bins = new Map();
  for (const frame of Array.isArray(frames) ? frames : []) {
    if (!(frame.sharpness > minSharpness)) continue;
    const bin = Math.min(count - 1, Math.floor(Math.max(0, frame.progress) * count));
    const held = bins.get(bin);
    if (!held || frame.sharpness > held.sharpness) bins.set(bin, frame);
  }
  return [...bins.values()].sort((a, b) => a.atSec - b.atSec);
}

/**
 * The lineage an angle plate keeps in its media row's `library.angle`: the clip and moment it came
 * from, the main plate that clip was rendered from, and its bearing. Angles sharing a `clipId` share
 * one geometry. Returns null for anything malformed so a bad peer value is dropped, not stored.
 */
export function normalizeLookAroundAngle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const clipId = text(value.clipId, 80);
  const sourceMediaKey = text(value.sourceMediaKey, 512);
  const atSec = Number(value.atSec);
  if (!clipId || !sourceMediaKey || !Number.isFinite(atSec) || atSec < 0 || atSec > 3600) return null;
  const bearing = Number(value.bearingDeg);
  return {
    clipId, sourceMediaKey, atSec: Math.round(atSec * 1000) / 1000,
    bearingDeg: Number.isFinite(bearing) ? normDeg(bearing) : 0,
    ...(LOOK_AROUND_MOTIONS[value.motion] ? { motion: value.motion } : {}),
  };
}

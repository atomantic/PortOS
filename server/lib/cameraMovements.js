/**
 * Shared camera-movement vocabulary (#10589) — FableLoom's cut direction, the
 * Music Video storyboard's structured `camera` field, the four-part i2v camera
 * block, and the layered document template's camera rig all key off these ids.
 *
 * `value` ids are stable persisted identifiers (FableLoom scene nodes and Music
 * Video scenes store them); labels and prose may improve without a migration.
 *
 * Each move carries:
 *   - `family`  — the kind of motion (push-pull, rotate, lateral, …). Planning
 *                 rules key off it ("at most two consecutive shots per family").
 *   - `energy`  — calm / medium / high: which song energy the move suits.
 *   - `snap`    — a hit-point move that lands a downbeat or hook word.
 *   - `still`   — the camera body does not travel (a static frame on screen).
 *   - `movement` / `speed` / `framing` / `end` — the four parts of a camera
 *                 prompt, kept apart from the scene description.
 *   - `startFraming` / `endFraming` — shot size at the first and last frame,
 *                 one of CAMERA_FRAMINGS; the rig's unit test holds every path
 *                 to them.
 *   - `prompt`  — the one-line direction FableLoom's prompts and editor show.
 */

import { escapeRegExp } from './textUtils.js';

export const CAMERA_FAMILIES = Object.freeze([
  'static', 'push-pull', 'rotate', 'lateral', 'vertical', 'orbit', 'tracking', 'lens', 'roll', 'scale', 'time',
]);
export const CAMERA_ENERGIES = Object.freeze(['calm', 'medium', 'high']);
export const CAMERA_SPEEDS = Object.freeze(['slow', 'moderate', 'fast', 'snap']);
export const CAMERA_FRAMINGS = Object.freeze(['extreme-wide', 'wide', 'medium', 'close', 'extreme-close']);

const SPEED_TEXT = Object.freeze({
  slow: 'slow and steady for the whole shot',
  moderate: 'moderate, even pace',
  fast: 'fast and committed, easing into the end position',
  snap: 'a near-instant snap, then hold',
});
const FRAMING_TEXT = Object.freeze({
  'extreme-wide': 'an extreme wide shot',
  wide: 'a wide shot',
  medium: 'a medium shot',
  close: 'a close-up',
  'extreme-close': 'an extreme close-up',
});

// [value, label, family, energy, speed, startFraming, endFraming, movement, framing, end, prompt, flags]
const ROWS = [
  ['locked-off', 'Locked-off / static', 'static', 'calm', 'slow', 'medium', 'medium',
    'The camera stays completely still on a tripod; only the subject and the world move.',
    'Subject placed with deliberate negative space.',
    'Same frame as it began.',
    'Locked-off tripod shot; the camera remains completely still.', { still: true }],
  ['slow-dolly-in', 'Slow dolly in', 'push-pull', 'calm', 'slow', 'medium', 'close',
    'The camera body travels straight toward the subject on a smooth track.',
    'Subject centered, eye level.',
    'Settles closer, with the subject filling more of the frame.',
    'Camera slowly moves forward toward the subject.'],
  ['slow-dolly-out', 'Slow dolly out', 'push-pull', 'calm', 'slow', 'medium', 'wide',
    'The camera body backs straight away from the subject on a smooth track.',
    'Subject centered, eye level.',
    'Opens up to show the surroundings around the subject.',
    'Camera slowly moves backward away from the subject.'],
  ['fast-dolly-in', 'Fast dolly in', 'push-pull', 'high', 'fast', 'wide', 'close',
    'The camera charges toward the subject along a straight line.',
    'Subject small in the frame, centered.',
    'Arrives tight on the subject with urgency.',
    'Camera rapidly pushes toward the subject with urgent motion.'],
  ['dolly-zoom', 'Dolly zoom / vertigo', 'lens', 'medium', 'moderate', 'medium', 'medium',
    'The camera dollies forward while the lens widens, so the subject keeps its size while the background stretches away.',
    'Subject centered against a deep background.',
    'Subject the same size, background warped and distant.',
    'Camera dollies while zooming in the opposite direction, warping background scale.'],
  ['zoom-in', 'Optical zoom in', 'lens', 'calm', 'moderate', 'medium', 'close',
    'The camera stays put while the lens narrows onto the subject.',
    'Subject centered, flat perspective.',
    'Magnified on the subject with compressed depth.',
    'Stationary camera smoothly magnifies the subject with the lens.'],
  ['zoom-out', 'Optical zoom out', 'lens', 'calm', 'moderate', 'medium', 'wide',
    'The camera stays put while the lens widens away from the subject.',
    'Subject centered.',
    'Wide view with the subject small inside the setting.',
    'Stationary camera smoothly widens the field of view with the lens.'],
  ['crash-zoom', 'Crash zoom', 'lens', 'high', 'snap', 'medium', 'extreme-close',
    'The lens punches in on a key detail in a fraction of a second.',
    'Detail already near the center of frame.',
    'Slams to a tight detail and holds there.',
    'A sudden snap zoom punches into the key detail.', { snap: true }],
  ['macro-zoom', 'Extreme macro zoom', 'scale', 'medium', 'moderate', 'medium', 'extreme-close',
    'The camera closes in past normal focus distance into a macro world on the subject.',
    'Subject centered with a chosen detail at the center.',
    'Lands in extreme macro texture of that detail.',
    'The view transitions from the subject into an extreme macro detail.'],
  ['pan-left', 'Pan left', 'rotate', 'calm', 'moderate', 'medium', 'medium',
    'The camera pivots horizontally to the left from a fixed position.',
    'Subject on the right third.',
    'Comes to rest on what lay to the left.',
    'Camera pivots horizontally to the left from a fixed position.'],
  ['pan-right', 'Pan right', 'rotate', 'calm', 'moderate', 'medium', 'medium',
    'The camera pivots horizontally to the right from a fixed position.',
    'Subject on the left third.',
    'Comes to rest on what lay to the right.',
    'Camera pivots horizontally to the right from a fixed position.'],
  ['whip-pan', 'Whip pan', 'rotate', 'high', 'snap', 'medium', 'medium',
    'The camera whips sideways so fast the frame smears into motion blur.',
    'Subject sharp before the whip.',
    'Snaps onto a new subject and holds it sharp.',
    'Camera whips sideways with strong directional motion blur.', { snap: true }],
  ['tilt-up', 'Tilt up', 'rotate', 'calm', 'moderate', 'medium', 'medium',
    'The camera pivots upward from a fixed position.',
    'Lower part of the subject or the ground in frame.',
    'Rests on what rises above.',
    'Camera pivots vertically upward from a fixed position.'],
  ['tilt-down', 'Tilt down', 'rotate', 'calm', 'moderate', 'medium', 'medium',
    'The camera pivots downward from a fixed position.',
    'Sky or the top of the subject in frame.',
    'Rests on what lies below.',
    'Camera pivots vertically downward from a fixed position.'],
  ['truck-left', 'Truck left', 'lateral', 'calm', 'moderate', 'medium', 'medium',
    'The camera body slides sideways to the left, parallel to the subject.',
    'Subject in profile or square to the lens.',
    'Same distance, the background has shifted past.',
    'Camera travels laterally to the left on a parallel track.'],
  ['truck-right', 'Truck right', 'lateral', 'calm', 'moderate', 'medium', 'medium',
    'The camera body slides sideways to the right, parallel to the subject.',
    'Subject in profile or square to the lens.',
    'Same distance, the background has shifted past.',
    'Camera travels laterally to the right on a parallel track.'],
  ['pedestal-up', 'Pedestal up', 'vertical', 'calm', 'slow', 'medium', 'medium',
    'The camera body rises straight up without changing its angle.',
    'Subject at eye level.',
    'Higher vantage, same angle and distance.',
    'Camera rises vertically while keeping its angle and distance.'],
  ['pedestal-down', 'Pedestal down', 'vertical', 'calm', 'slow', 'medium', 'medium',
    'The camera body lowers straight down without changing its angle.',
    'Subject at eye level.',
    'Lower vantage, same angle and distance.',
    'Camera lowers vertically while keeping its angle and distance.'],
  ['crane-up', 'Crane up / high reveal', 'vertical', 'medium', 'slow', 'medium', 'wide',
    'The camera lifts up and back on a crane arm while keeping the subject in view.',
    'Subject at eye level.',
    'High angle looking down on the subject and its surroundings.',
    'Camera cranes upward into a high-angle reveal.'],
  ['crane-down', 'Crane down / landing', 'vertical', 'medium', 'slow', 'wide', 'medium',
    'The camera descends on a crane arm from high above toward the subject.',
    'High angle overview of the setting.',
    'Lands near eye level with the subject.',
    'Camera cranes down and settles near the subject.'],
  ['orbit-180', 'Orbit 180°', 'orbit', 'medium', 'moderate', 'medium', 'medium',
    'The camera circles halfway around the subject, keeping it centered.',
    'Subject centered, facing the lens.',
    'Sees the subject from the opposite side.',
    'Camera makes a half-circle around the subject.'],
  ['orbit-360', 'Orbit 360°', 'orbit', 'high', 'fast', 'medium', 'medium',
    'The camera makes a full circle around the subject, keeping it centered.',
    'Subject centered.',
    'Returns to the starting angle after a full revolution.',
    'Camera makes one complete circle around the subject.'],
  ['cinematic-arc', 'Slow cinematic arc', 'orbit', 'calm', 'slow', 'medium', 'medium',
    'The camera drifts along a shallow curve around the subject.',
    'Subject slightly off center.',
    'A gently changed angle on the same subject.',
    'Camera follows a slow, wide curved path around the subject.'],
  ['reveal-from-behind', 'Reveal from behind', 'lateral', 'medium', 'moderate', 'medium', 'medium',
    'The camera slides out from behind a foreground object to uncover the scene.',
    'Frame mostly blocked by a close foreground shape.',
    'The subject fully revealed and clear.',
    'Camera slides from behind a foreground object to reveal the scene.'],
  ['fly-through', 'Fly-through', 'push-pull', 'high', 'fast', 'wide', 'medium',
    'The camera flies forward through an opening and keeps going into the space beyond.',
    'An opening (window, gap, doorway) ahead.',
    'Inside the new space, closer to its subject.',
    'Camera passes through an opening and continues into the scene.'],
  ['following-shot', 'Following tracking shot', 'tracking', 'medium', 'moderate', 'medium', 'medium',
    'The camera follows behind the moving subject at its pace.',
    'Subject seen from behind, centered.',
    'Still trailing the subject at the same distance.',
    'Camera follows behind the moving subject at matching speed.'],
  ['leading-shot', 'Leading tracking shot', 'tracking', 'medium', 'moderate', 'medium', 'medium',
    'The camera moves backward ahead of the subject as it advances.',
    'Subject facing the lens, centered.',
    'Still leading the subject at the same distance.',
    'Camera moves backward ahead of the subject at matching speed.'],
  ['side-tracking', 'Side tracking shot', 'tracking', 'medium', 'moderate', 'medium', 'medium',
    'The camera travels alongside the moving subject.',
    'Subject in profile.',
    'Still level with the subject, the background streaming past.',
    'Camera travels parallel beside the moving subject.'],
  ['steadicam-follow', 'Steadicam follow', 'tracking', 'medium', 'moderate', 'medium', 'medium',
    'A stabilized camera glides with the subject through the space.',
    'Subject a few steps ahead.',
    'Still with the subject deeper in the space.',
    'Stabilized camera glides with the subject through the environment.'],
  ['handheld', 'Handheld documentary', 'tracking', 'medium', 'moderate', 'medium', 'medium',
    'The camera is held by hand: small drifts, corrections and breathing.',
    'Subject loosely centered.',
    'Near where it began, reframed by hand.',
    'Natural handheld drift and restrained shake create documentary immediacy.'],
  ['pov-walk', 'POV walk', 'tracking', 'medium', 'moderate', 'medium', 'medium',
    'The camera is the character\'s eyes, walking forward with a light head bob.',
    'Eye-level view down the path ahead.',
    'Further along the path.',
    'First-person camera advances with subtle human head-bob.'],
  ['worm-eye-track', "Worm's-eye tracking", 'tracking', 'medium', 'moderate', 'medium', 'medium',
    'The camera skims along the ground looking up while it tracks forward.',
    'Ground-level, subject looming above.',
    'Still low, further along.',
    'Ground-level camera tracks forward while looking up.'],
  ['drone-flyover', 'Drone flyover', 'tracking', 'medium', 'moderate', 'extreme-wide', 'extreme-wide',
    'An aerial camera flies forward high over the landscape.',
    'Landscape seen from high above.',
    'Further across the landscape at the same altitude.',
    'High aerial camera flies forward over the environment.'],
  ['drone-reveal', 'Drone rise and reveal', 'vertical', 'medium', 'slow', 'wide', 'extreme-wide',
    'An aerial camera climbs and tips down to unveil the wider scene.',
    'Low view of the near setting.',
    'High above, the whole scene laid out below.',
    'Aerial camera rises and tilts down to unveil the larger scene.'],
  ['drone-orbit', 'Large-scale drone orbit', 'orbit', 'medium', 'slow', 'extreme-wide', 'extreme-wide',
    'An aerial camera sweeps a broad circle around a landmark.',
    'Landmark at the center of a vast view.',
    'Same landmark from a new compass angle.',
    'Aerial camera sweeps in a broad circle around the landscape.'],
  ['drone-dive', 'FPV drone dive', 'vertical', 'high', 'fast', 'extreme-wide', 'medium',
    'A first-person drone drops steeply down toward the subject.',
    'High above the subject.',
    'Pulls out of the dive near the subject.',
    'Fast first-person aerial camera dives down a vertical structure.'],
  ['top-down-twist', "Top-down / God's-eye twist", 'roll', 'calm', 'slow', 'medium', 'medium',
    'The camera looks straight down and slowly rotates around its lens axis.',
    'Overhead view, subject centered.',
    'Same overhead view, rotated a quarter turn.',
    'Camera looks straight down while slowly rotating.'],
  ['dutch-roll', 'Dutch roll', 'roll', 'high', 'snap', 'medium', 'medium',
    'The camera rolls on its lens axis into a tilted, uneasy horizon.',
    'Level horizon, subject centered.',
    'Holds on a canted Dutch angle.',
    'Camera rolls on its lens axis into a disorienting Dutch angle.', { snap: true }],
  ['barrel-roll', 'Barrel roll', 'roll', 'high', 'fast', 'medium', 'medium',
    'The camera turns a full revolution on its lens axis while drifting forward.',
    'Subject centered.',
    'Level again, slightly closer.',
    'Camera rotates a full turn on its lens axis while moving forward.'],
  ['rack-focus', 'Rack focus', 'lens', 'calm', 'moderate', 'medium', 'medium',
    'The camera holds position while focus shifts between foreground and background.',
    'Two subjects at different depths.',
    'The second subject sharp, the first soft.',
    'Focus shifts decisively between foreground and background subjects; camera position stays fixed.'],
  ['focus-reveal', 'Reveal from blur', 'lens', 'calm', 'slow', 'medium', 'medium',
    'The camera holds position while the image resolves from total blur to sharp focus.',
    'Fully defocused frame.',
    'Crisp, fully resolved image.',
    'The shot begins fully defocused and gradually resolves to sharp focus.'],
  ['ots-drift', 'Over-the-shoulder drift', 'lateral', 'calm', 'slow', 'medium', 'medium',
    'The camera sits behind one shoulder and drifts a little sideways.',
    'Foreground shoulder soft on one side, subject beyond.',
    'Same over-the-shoulder view, slightly shifted.',
    'Camera holds an over-the-shoulder composition with a subtle lateral drift.'],
  ['push-past', 'Push past foreground', 'push-pull', 'medium', 'moderate', 'wide', 'medium',
    'The camera pushes forward past a close foreground element to uncover the subject.',
    'A foreground element close to the lens.',
    'Past the foreground, closer on the subject.',
    'Camera pushes past a close foreground element to uncover the subject.'],
  ['slider-parallax', 'Slider parallax', 'lateral', 'calm', 'slow', 'medium', 'medium',
    'A short sideways slider move while staying aimed at the subject, so layers separate.',
    'Foreground, subject and background layers.',
    'Same subject, the layers shifted against each other.',
    'A short lateral slider move creates controlled foreground-background parallax.'],
  ['body-mount', 'Body-mounted / SnorriCam', 'tracking', 'high', 'moderate', 'close', 'close',
    'The camera is rigged to the subject, so they stay fixed while the world swings around them.',
    'Subject\'s face or torso, rigidly centered.',
    'Subject unchanged in frame, the world moved behind them.',
    'Camera stays rigidly mounted to the moving subject while the world swings behind them.'],
  ['bullet-time', 'Bullet-time orbit', 'time', 'high', 'moderate', 'medium', 'medium',
    'Time nearly stops while the camera moves around the frozen moment.',
    'Subject mid-action.',
    'A new angle on the same frozen instant.',
    'Action nearly freezes while the camera moves around the moment.'],
  ['hyperlapse', 'Moving hyperlapse', 'time', 'medium', 'moderate', 'medium', 'medium',
    'The camera travels forward through accelerated time.',
    'A path or street ahead.',
    'Much further along, time compressed around the route.',
    'Camera advances through accelerated time with compressed environmental motion.'],
  // #10589 — scale and time moves for cosmic-scale music videos.
  ['infinite-zoom', 'Infinite zoom', 'scale', 'high', 'moderate', 'medium', 'extreme-close',
    'The camera dives straight into the center of frame, the subject giving way to a smaller world nested inside it.',
    'The entry point locked at the exact center.',
    'Deep inside the nested world, still dead center, ready to loop.',
    'Center-locked dive that keeps zooming into a nested world inside the subject.'],
  ['powers-of-ten', 'Powers-of-ten zoom out', 'scale', 'medium', 'slow', 'close', 'extreme-wide',
    'The camera pulls straight back from overhead in steady multiples, each step showing ten times more.',
    'Overhead view of the origin point, centered.',
    'Vast scale — city, planet or beyond — with the origin still at the center.',
    'Overhead pull-back by steady powers of ten with the origin locked at the center.'],
  ['locked-time-lapse', 'Locked time-lapse', 'time', 'calm', 'slow', 'medium', 'medium',
    'The camera stays locked off while hours pass in seconds.',
    'A composed view with something that changes over time (sky, crowd, light).',
    'Same frame, much later.',
    'Locked-off tripod time-lapse; light and motion race while the frame stays fixed.', { still: true }],
  ['tilt-shift-miniature', 'Tilt-shift miniature', 'lens', 'calm', 'slow', 'wide', 'wide',
    'A high-angle camera drifts slowly while a narrow band of focus makes the world look like a model.',
    'High angle over a busy scene, sharp band across the middle.',
    'Same toy-like view, drifted slightly.',
    'High-angle tilt-shift view with a narrow focus band that makes the scene look miniature.'],
  ['crash-zoom-out', 'Crash zoom out', 'lens', 'high', 'snap', 'extreme-close', 'wide',
    'The lens snaps backward from a tight detail to the whole scene in an instant.',
    'Tight on a detail.',
    'Holds on the wide view that contains it.',
    'A sudden snap zoom out from a tight detail to reveal the whole scene.', { snap: true }],
  ['chase-tracking', 'Chase / vehicle tracking', 'tracking', 'high', 'fast', 'medium', 'medium',
    'The camera races alongside or behind a fast-moving subject or vehicle, swaying with the road.',
    'Subject or vehicle centered, speed streaking past.',
    'Still matched to the subject at speed.',
    'Camera rides with a fast-moving subject or vehicle, matching its speed with road sway.'],
];

export const CAMERA_MOVEMENTS = Object.freeze(ROWS.map(([
  value, label, family, energy, speed, startFraming, endFraming, movement, framing, end, prompt, flags = {},
]) => Object.freeze({
  value, label, family, energy, speed, startFraming, endFraming, movement, framing, end, prompt,
  snap: flags.snap === true, still: flags.still === true,
})));

export const CAMERA_MOVEMENT_VALUES = Object.freeze(CAMERA_MOVEMENTS.map(({ value }) => value));
export const SNAP_CAMERA_MOVEMENTS = Object.freeze(CAMERA_MOVEMENTS.filter((move) => move.snap).map(({ value }) => value));

const BY_VALUE = new Map(CAMERA_MOVEMENTS.map((move) => [move.value, move]));

/** The catalog entry for a stable id, or null. */
export const getCameraMovement = (id) => (typeof id === 'string' && BY_VALUE.get(id)) || null;

/**
 * Canonicalize an id or label (case-insensitive) to its stable id; anything
 * else is returned trimmed so free-text direction survives (FableLoom stores
 * custom directions verbatim).
 */
export const normalizeCameraMovement = (raw) => {
  if (typeof raw !== 'string') return '';
  const candidate = raw.trim();
  const normalized = candidate.toLowerCase();
  const match = CAMERA_MOVEMENTS.find(({ value, label }) => (
    value.toLowerCase() === normalized || label.toLowerCase() === normalized
  ));
  return match?.value || candidate;
};

/** A catalog id for `raw`, or '' when it names no catalog move. */
export const cameraMovementId = (raw) => {
  const id = normalizeCameraMovement(raw);
  return BY_VALUE.has(id) ? id : '';
};

// Longest first so "slow dolly in" wins over "dolly zoom"-style partial overlaps.
const TEXT_MATCHERS = CAMERA_MOVEMENTS
  .flatMap((move) => [move.value, move.value.replace(/-/g, ' '), move.label.split(' / ')[0]]
    .map((needle) => ({ needle: needle.toLowerCase(), value: move.value })))
  .sort((a, b) => b.needle.length - a.needle.length)
  .map(({ needle, value }) => ({ value, pattern: new RegExp(`(?:^|[^a-z])${escapeRegExp(needle)}(?:$|[^a-z])`) }));
const STATIC_TEXT = /\b(?:static|lock(?:ed)?[- ]?off|tripod)\b/;

/**
 * Best-effort catalog id named somewhere inside free-text camera direction
 * (a storyboard's "Locked-off camera", "slow dolly in on the hands"), or ''.
 * Used only to report on prose; it never rewrites what a director typed.
 */
export const cameraMovementFromText = (text) => {
  if (typeof text !== 'string' || !text.trim()) return '';
  const exact = cameraMovementId(text);
  if (exact) return exact;
  const lower = text.toLowerCase();
  const hit = TEXT_MATCHERS.find(({ pattern }) => pattern.test(lower));
  if (hit) return hit.value;
  return STATIC_TEXT.test(lower) ? 'locked-off' : '';
};

/**
 * Compose the four-part camera prompt (Movement / Speed / Framing / End) for a
 * catalog move, kept separate from the scene description so an i2v model reads
 * the camera as its own instruction. `overrides` may set `speed` (a
 * CAMERA_SPEEDS value), `endFraming` (a CAMERA_FRAMINGS value), `onBeat`
 * (land the move on the downbeat) and `reason` (why a still camera is right).
 * Returns '' for an id outside the catalog. Callers go through shotCameraPrompt.
 */
function cameraMovementPrompt(id, overrides = {}) {
  const move = getCameraMovement(id);
  if (!move) return '';
  const speed = CAMERA_SPEEDS.includes(overrides.speed) ? overrides.speed : move.speed;
  const endFraming = CAMERA_FRAMINGS.includes(overrides.endFraming) ? overrides.endFraming : move.endFraming;
  const reason = typeof overrides.reason === 'string' && overrides.reason.trim() ? ` Reason: ${overrides.reason.trim()}` : '';
  const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return [
    `Camera movement: ${move.label} — ${move.movement}${reason}`,
    `Speed: ${capital(SPEED_TEXT[speed])}${overrides.onBeat ? '; land the move exactly on the downbeat' : ''}.`,
    `Framing: Opens on ${FRAMING_TEXT[move.startFraming]}. ${move.framing}`,
    `End: ${move.end} Ends on ${FRAMING_TEXT[endFraming]}.`,
  ].join('\n');
}

/** The four-part camera prompt for a structured shot camera (`{ move, speed, endFraming, onBeat, reason }`), or ''. */
export const shotCameraPrompt = (camera) => (camera && typeof camera === 'object'
  ? cameraMovementPrompt(camera.move, camera) : '');

/** One line per move for an LLM prompt: id (label) [family, energy, snap]: direction. */
export const cameraMovementCatalogForPrompt = ({ detail = false } = {}) => CAMERA_MOVEMENTS
  .map((move) => (detail
    ? `- ${move.value} (${move.label}) [${move.family}, ${move.energy}${move.snap ? ', snap' : ''}${move.still ? ', static' : ''}]: ${move.movement}`
    : `- ${move.value} (${move.label}): ${move.prompt}`))
  .join('\n');

/** A short human label for a structured shot camera ("Whip pan, snap, on the downbeat"), or ''. */
export function shotCameraLabel(camera) {
  const move = getCameraMovement(camera?.move);
  if (!move) return '';
  return [move.label, CAMERA_SPEEDS.includes(camera.speed) && camera.speed !== move.speed ? camera.speed : '',
    camera.onBeat ? 'on the downbeat' : '', camera.reason?.trim() ? `because ${camera.reason.trim()}` : '']
    .filter(Boolean).join(', ');
}

const PUSH_FAMILIES = new Set(['push-pull', 'lens', 'scale']);
/**
 * The closest of the composed (ffmpeg) render's three still moves — hold, push
 * or pan — for a structured shot camera, or null when it names no catalog move.
 * The layered document plays the full move through its camera rig instead.
 */
export function stillMoveForCamera(camera) {
  const move = getCameraMovement(camera?.move);
  if (!move) return null;
  return move.still ? 'hold' : PUSH_FAMILIES.has(move.family) ? 'push' : 'pan';
}

// Pure, deterministic helpers for CyberCity's photo mode (roadmap 3.3): cinematic camera
// presets, the camera-fly stepper, the "city postcard" stats overlay, and screenshot filename
// generation. No three.js / React imports so it's unit-testable (mirrors the other city
// helpers). The component reads these presets to fly the camera and composites the postcard
// caption from a live stats snapshot the page passes in.
import { smoothstep } from './easing';

// Cinematic camera presets. Each is a stable framing of the city — position + look-at target —
// the photo UI cycles through. Tuned against the default orbital view (camera at [0,25,45]
// looking at origin) and the ±60-unit landmark ring, so every preset keeps downtown and at
// least one landmark district in frame.
export const PHOTO_PRESETS = [
  { id: 'establishing', label: 'ESTABLISHING', position: [0, 28, 52], target: [0, 2, 0] },
  { id: 'downtown', label: 'DOWNTOWN', position: [0, 10, 26], target: [0, 4, 0] },
  { id: 'skyline', label: 'SKYLINE', position: [44, 6, 44], target: [-6, 8, -6] },
  { id: 'overhead', label: 'OVERHEAD', position: [0, 70, 0.01], target: [0, 0, 0] },
  { id: 'horizon', label: 'HORIZON', position: [0, 4, 60], target: [0, 10, -60] },
  // Low-angle is the most dramatic, close-in framing — a wider aperture pushes a shallower,
  // more cinematic falloff so the foreground subject pops against a soft background.
  { id: 'low-angle', label: 'LOW ANGLE', position: [-18, 2, 30], target: [0, 12, 0], dof: { aperture: 0.09 } },
];

export const DEFAULT_PRESET_ID = 'establishing';

// Resolve a preset by id, falling back to the default establishing shot for an unknown id so a
// stale persisted id can never strand the camera with no framing.
export function getPreset(id) {
  return PHOTO_PRESETS.find(p => p.id === id) || PHOTO_PRESETS.find(p => p.id === DEFAULT_PRESET_ID);
}

// Depth-of-field defaults for cinematic photo-mode shots (roadmap 3.3). `aperture` and `maxblur`
// shape the blur falloff for three's BokehPass; both are intentionally gentle so the effect reads
// as "cinematic" rather than "broken". A preset may override either via an optional `dof: { … }`
// field. The focal distance is NOT a default — it's derived per preset from the camera framing
// (see `presetFocusDistance`) so the subject the camera is pointed at always stays sharp without
// hand-tuning a separate focus number that could drift from the framing.
export const DOF_DEFAULTS = { aperture: 0.05, maxblur: 0.012 };

// Distance (world units) from a preset's camera position to its look-at target. This is the focal
// plane: BokehPass keeps geometry at this depth sharp and blurs nearer/farther geometry. Deriving
// it from the preset's own position→target keeps focus locked to whatever the shot frames. Pure
// (no three.js) so it stays unit-testable alongside the other helpers.
export function presetFocusDistance(preset) {
  if (!Array.isArray(preset?.position) || !Array.isArray(preset?.target)) return 1;
  const [px, py, pz] = preset.position;
  const [tx, ty, tz] = preset.target;
  const dx = px - tx;
  const dy = py - ty;
  const dz = pz - tz;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return Number.isFinite(dist) && dist > 0 ? dist : 1;
}

// Accept a per-preset override only when it's a positive finite number; otherwise fall back to the
// default. A negative/zero/NaN aperture or maxblur is meaningless to the bokeh shader (blur radius
// is non-negative), so a malformed hand-edited preset can't push a broken value into the pass.
const positiveOr = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);

// Resolve the BokehPass parameters for a preset: derived focal distance + (per-preset-overridable)
// aperture/maxblur. Used by CityDepthOfField to build and re-tune the pass when the preset changes.
export function getDofParams(presetId) {
  const preset = getPreset(presetId);
  const override = preset?.dof || {};
  return {
    focus: presetFocusDistance(preset),
    aperture: positiveOr(override.aperture, DOF_DEFAULTS.aperture),
    maxblur: positiveOr(override.maxblur, DOF_DEFAULTS.maxblur),
  };
}

// Step to the next/previous preset in the ring (wraps). Used by the ‹ › controls and arrow keys.
export function cyclePreset(currentId, direction = 1) {
  const idx = PHOTO_PRESETS.findIndex(p => p.id === currentId);
  const base = idx === -1 ? 0 : idx;
  const next = (base + direction + PHOTO_PRESETS.length) % PHOTO_PRESETS.length;
  return PHOTO_PRESETS[next].id;
}

// Photo mode runs the Canvas frameloop in "demand" mode (roadmap 3.6): the scene animates only
// while the camera is flying to a preset, then freezes for a clean, deliberate still. This pure
// stepper advances the fly progress by an elapsed delta and reports whether the loop still needs
// pumping. `FLY_DURATION` is the seconds the cinematic ease takes (slower than the exploration
// transition). `stepFly` returns the clamped next progress, the eased interpolation factor `t`,
// and `done` (true once settled) so the component can stop invalidating the demand loop.
export const FLY_DURATION = 1.1;

// Cap the per-step delta to a frame-sized maximum. In demand mode the loop sleeps while the scene
// is frozen, so the FIRST frame after a freeze (e.g. when the user cycles presets) carries a
// delta equal to the whole idle gap — often several seconds. Unclamped, that would complete the
// fly in a single step and the camera would snap instead of animating. Clamping keeps every fly
// smooth (~at least FLY_DURATION/MAX_FLY_DELTA frames) regardless of how long the scene was idle.
export const MAX_FLY_DELTA = 1 / 30; // seconds — one 30fps frame

export function stepFly(progress, deltaSeconds) {
  const rawDelta = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;
  const safeDelta = Math.min(rawDelta, MAX_FLY_DELTA);
  const next = Math.min(1, (Number.isFinite(progress) ? progress : 1) + safeDelta / FLY_DURATION);
  return { progress: next, t: smoothstep(next), done: next >= 1 };
}

// Build the short stat lines printed on a "city postcard". Pulls a handful of headline numbers
// from a stats snapshot the page already has (apps, agents, peers, level). Missing fields are
// omitted rather than rendered as "0/undefined", so a sparse install still prints a clean card.
export function buildPostcardStats(snapshot = {}) {
  const lines = [];
  const { online, total, agents, peers, level, streak } = snapshot;
  if (Number.isFinite(total)) lines.push(`${online ?? 0}/${total} SYSTEMS ONLINE`);
  if (Number.isFinite(agents) && agents > 0) lines.push(`${agents} AGENT${agents === 1 ? '' : 'S'} ACTIVE`);
  if (Number.isFinite(peers) && peers > 0) lines.push(`${peers} PEER${peers === 1 ? '' : 'S'} LINKED`);
  if (Number.isFinite(level)) lines.push(`LEVEL ${level}`);
  if (Number.isFinite(streak) && streak > 0) lines.push(`${streak}-DAY STREAK`);
  return lines;
}

// Pad a number to two digits without Date formatting (Date.now is unavailable in some contexts;
// the timestamp is always passed in from the caller).
const pad2 = (n) => String(n).padStart(2, '0');

// Build a stable, filesystem-safe screenshot filename from a Date. Format:
// `cybercity-YYYYMMDD-HHMMSS.png`. The Date is injected so the function is deterministic in
// tests and the caller controls the clock.
export function screenshotFilename(date = new Date()) {
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mm = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `cybercity-${y}${m}${d}-${hh}${mm}${ss}.png`;
}

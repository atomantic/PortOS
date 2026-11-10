/**
 * Handheld camera: the unsteady, walking, unprofessional operator a clip was
 * not shot with. The picture is zoomed in just enough that the margin it
 * gains can sway, jitter, bob with footsteps and roll without ever showing an
 * edge, so a smooth model render reads as someone holding the camera.
 *
 * ONE motion model serves both surfaces: the clip player previews it live as a
 * CSS transform (`handheldCssTransform`) and the baked take renders it with
 * ffmpeg (`handheldFfmpegFilter`), both from the same term list, so what plays
 * in the preview is what the new take holds. Every value is a pure function of
 * the clip time and the seed: the same settings always shake the same way, and
 * a new seed is a new take of the same operator.
 *
 * Pure and dependency-free: the client imports it directly.
 */

export const HANDHELD_SEED_MAX = 9999;

// Each control is 0..1. `shake` is the hand (slow sway, roll and tremor);
// `steps` is the operator walking (a bob on every footfall and a sway every
// two). Either alone is a valid take: a seated operator is shake only.
export const HANDHELD_CONTROLS = Object.freeze([
  { id: 'shake', label: 'Shake', def: 0.5, hint: 'How unsteady the hands are: slow sway and roll, plus a fine tremor.' },
  { id: 'steps', label: 'Footsteps', def: 0.4, hint: 'The operator walking: a bob on every step and a sway from foot to foot.' },
]);

export const HANDHELD_DEFAULTS = Object.freeze({ shake: 0.5, steps: 0.4, seed: 1 });

const clamp01 = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, Math.round(n * 100) / 100)) : fallback;
};

/** Bounded settings from any input; null when the input is not an object. */
export function normalizeHandheld(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const seed = Math.trunc(Number(input.seed));
  return {
    shake: clamp01(input.shake, HANDHELD_DEFAULTS.shake),
    steps: clamp01(input.steps, HANDHELD_DEFAULTS.steps),
    seed: Number.isFinite(seed) && seed >= 1 ? Math.min(HANDHELD_SEED_MAX, seed) : HANDHELD_DEFAULTS.seed,
  };
}

/** True when the settings move nothing. */
export const isHandheldStill = (settings) => !settings || (settings.shake <= 0 && settings.steps <= 0);

// Deterministic [0, 1) stream for a seed (mulberry32).
function seededRandom(seed) {
  let a = (Math.trunc(seed) * 0x9e3779b1) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Amplitudes at full strength. x and y are fractions of the frame width and
// height, r is degrees of roll. Sway sits under 1 Hz (the arms and body),
// tremor at 2.5–6 Hz (the hands), steps at a strolling ~1.8 steps a second.
const SWAY = [
  ['x', 0.009, 0.11], ['x', 0.005, 0.27], ['x', 0.003, 0.53],
  ['y', 0.007, 0.09], ['y', 0.004, 0.31], ['y', 0.0025, 0.61],
  ['r', 0.55, 0.13], ['r', 0.3, 0.41],
];
const TREMOR = [['x', 0.0012, 3.1], ['x', 0.0008, 5.3], ['y', 0.0012, 2.7], ['y', 0.0008, 4.9], ['r', 0.07, 3.7]];
const STEP_RATE = 1.8;

/**
 * The motion as a list of terms, each `{ axis, amp, freq, phase, kind }`:
 * `sin` terms are amp·sin(2π·freq·t + phase); a `bob` is a footfall
 * amp·(|sin(π·freq·t + phase)| − 2/π), one dip per step around zero.
 */
export function handheldTerms(input) {
  const settings = normalizeHandheld(input);
  if (isHandheldStill(settings)) return [];
  const random = seededRandom(settings.seed);
  const terms = [];
  const add = (list, scale) => {
    for (const [axis, amp, freq] of list) {
      // Each draw is taken even when the scale is 0, so the shake keeps its
      // character while the steps slider moves (and the reverse).
      const jitter = 0.85 + 0.3 * random();
      const phase = random() * Math.PI * 2;
      const sign = random() < 0.5 ? -1 : 1;
      if (scale > 0) terms.push({ axis, amp: amp * scale * sign, freq: freq * jitter, phase, kind: 'sin' });
    }
  };
  add(SWAY, settings.shake);
  add(TREMOR, settings.shake);
  const stepRate = STEP_RATE * (0.9 + 0.2 * random());
  const stepPhase = random() * Math.PI;
  if (settings.steps > 0) {
    terms.push({ axis: 'y', amp: 0.009 * settings.steps, freq: stepRate, phase: stepPhase, kind: 'bob' });
    // A sway from foot to foot: one full cycle every two steps.
    terms.push({ axis: 'x', amp: 0.0045 * settings.steps, freq: stepRate / 2, phase: stepPhase, kind: 'sin' });
    terms.push({ axis: 'r', amp: 0.35 * settings.steps, freq: stepRate / 2, phase: stepPhase, kind: 'sin' });
  }
  return terms;
}

const BOB_MEAN = 2 / Math.PI;
const termValue = (term, t) => (term.kind === 'bob'
  ? term.amp * (Math.abs(Math.sin(Math.PI * term.freq * t + term.phase)) - BOB_MEAN)
  : term.amp * Math.sin(2 * Math.PI * term.freq * t + term.phase));

const peak = (terms, axis) => terms.filter((term) => term.axis === axis)
  .reduce((sum, term) => sum + Math.abs(term.amp) * (term.kind === 'bob' ? 1 - BOB_MEAN : 1), 0);

/**
 * The zoom that keeps the frame covered at the motion's worst case: the
 * output window, offset by the largest sway and turned by the largest roll,
 * must stay inside the zoomed picture. `aspect` is width / height.
 */
export function handheldZoom(terms, aspect = 16 / 9) {
  if (!terms.length) return 1;
  const theta = (peak(terms, 'r') * Math.PI) / 180;
  const a = 0.5 + peak(terms, 'x');
  const b = (0.5 + peak(terms, 'y')) / aspect;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  // In units of the frame width: the window's half extents a × b, rotated, against 0.5 × 0.5/aspect.
  const zx = (a * cos + b * sin) / 0.5;
  const zy = (a * sin + b * cos) / (0.5 / aspect);
  return Math.round(Math.max(zx, zy) * 1.004 * 10000) / 10000;
}

/** Offset (fractions of the frame) and roll (degrees) at clip time `t` seconds. */
export function handheldOffset(terms, t) {
  const out = { x: 0, y: 0, r: 0 };
  for (const term of terms) out[term.axis] += termValue(term, t);
  return out;
}

/**
 * The CSS transform that previews the motion on an element the size of the
 * frame (with `overflow: hidden` on its box): zoom, roll, then the window's
 * offset as the picture moving the other way. Null when nothing moves.
 */
export function handheldCssTransform(terms, t, zoom) {
  if (!terms.length) return null;
  const { x, y, r } = handheldOffset(terms, t);
  const n = (value) => Number(value.toFixed(4));
  return `translate(${n(-x * 100)}%, ${n(-y * 100)}%) rotate(${n(r)}deg) scale(${n(zoom)})`;
}

const exprNumber = (value) => {
  const text = Number(value.toFixed(6)).toString();
  return value < 0 ? `(${text})` : text;
};

function axisExpr(terms, axis, scale = 1) {
  const parts = terms.filter((term) => term.axis === axis).map((term) => {
    const amp = exprNumber(term.amp * scale);
    return term.kind === 'bob'
      ? `${amp}*(abs(sin(PI*${exprNumber(term.freq)}*t+${exprNumber(term.phase)}))-${exprNumber(BOB_MEAN)})`
      : `${amp}*sin(2*PI*${exprNumber(term.freq)}*t+${exprNumber(term.phase)})`;
  });
  return parts.length ? parts.join('+') : '0';
}

/**
 * The ffmpeg video filter for a `width`×`height` clip: scale up by the zoom,
 * roll, and crop the original size back out at the moving offset. Same terms,
 * same clip time, so it matches the preview. Null when nothing moves.
 */
export function handheldFfmpegFilter(input, { width, height } = {}) {
  const terms = handheldTerms(input);
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!terms.length || !(w >= 2) || !(h >= 2)) return null;
  const zoom = handheldZoom(terms, w / h);
  const even = (n) => Math.max(2, Math.ceil(n / 2) * 2);
  const zw = even(w * zoom);
  const zh = even(h * zoom);
  const roll = axisExpr(terms, 'r', Math.PI / 180);
  // ffmpeg's crop moves the window right by +x, so the picture shifts left: the CSS preview's translate(-x).
  return [
    `scale=${zw}:${zh}:flags=bicubic`,
    `rotate=a='${roll}':c=black:bilinear=1`,
    `crop=${w}:${h}:x='(iw-ow)/2+${w}*(${axisExpr(terms, 'x')})':y='(ih-oh)/2+${h}*(${axisExpr(terms, 'y')})'`,
  ].join(',');
}

/** A stable seed for an id (a shot's sceneId), so every shot shakes its own way and the same way every time. */
export function handheldSeedFor(id) {
  let h = 0x811c9dc5;
  for (const ch of String(id || '')) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return 1 + (h % HANDHELD_SEED_MAX);
}

/**
 * A shot's handheld motion as the layered document draws it: the template
 * additions `handheld` (shake) and `handheldSteps` (footsteps), seeded by the
 * shot's id. `{ zoom, terms }` with each term `[axis, amp, freq, phase, bob]`
 * (bob 1 for a footfall), the compact form PortOS writes into the document
 * data; null when nothing moves.
 */
export function documentHandheld(effects, sceneId, aspect = 16 / 9) {
  const terms = handheldTerms({ shake: effects?.handheld ?? 0, steps: effects?.handheldSteps ?? 0, seed: handheldSeedFor(sceneId) });
  if (!terms.length) return null;
  const n = (value) => Number(value.toFixed(6));
  return {
    zoom: handheldZoom(terms, aspect),
    terms: terms.map((term) => [term.axis, n(term.amp), n(term.freq), n(term.phase), term.kind === 'bob' ? 1 : 0]),
  };
}

/**
 * A document camera view (`{ scale, x, y, rotation }`, offsets in frame
 * widths/heights, rotation in radians) with the handheld motion on top at shot
 * time `lt` seconds: the window's offset moves the picture the other way, the
 * roll adds, and the scale grows by the motion's zoom (or more, if the camera
 * move and the shake together need it) so no edge shows. The layered engine
 * repeats this as `handheldView`; musicVideoDocumentCamera.test.js pins the two.
 */
export function applyDocumentHandheld(view, motion, lt, aspect = 16 / 9) {
  if (!view || !motion?.terms?.length) return view;
  let x = 0; let y = 0; let r = 0;
  for (const [axis, amp, freq, phase, bob] of motion.terms) {
    const v = bob ? amp * (Math.abs(Math.sin(Math.PI * freq * lt + phase)) - 2 / Math.PI) : amp * Math.sin(2 * Math.PI * freq * lt + phase);
    if (axis === 'x') x += v; else if (axis === 'y') y += v; else r += v;
  }
  const nx = view.x - x; const ny = view.y - y; const rotation = view.rotation + (r * Math.PI) / 180;
  const c = Math.abs(Math.cos(rotation)); const s = Math.abs(Math.sin(rotation));
  const sx = 1 + 2 * Math.abs(nx); const sy = 1 + 2 * Math.abs(ny);
  const cover = Math.max(sx * c + (sy * s) / aspect, sy * c + sx * s * aspect);
  return { scale: Math.max(view.scale * motion.zoom, cover), x: nx, y: ny, rotation };
}

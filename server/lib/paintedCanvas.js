/**
 * Painted-spectrogram canvas — wave sketch `version: 2` (#8464).
 *
 * The model paints sound onto a stereo time × log-frequency canvas with one
 * brush. A stroke is a `path` of keyframes `{t, hz, a}`; between keyframes
 * pitch moves on the log axis and amplitude moves linearly. Optional brush
 * properties:
 *
 *   - `overtones` — relative levels of the partials at 2×, 3×… the stroke's
 *                   pitch. Set on the stroke (a default) or on any keyframe
 *                   (from that keyframe on), so a stroke's color can change
 *                   along its length.
 *   - `width`     — Hz > 0 makes the stroke band-passed noise of that
 *                   bandwidth centred on its pitch.
 *   - `pan`       — -1 (left) … 1 (right), equal-power.
 *
 * Nothing else exists: reverb, chorus, voices and drums are whatever the model
 * paints. Long pieces carry `sections` (the passages they were painted in) and
 * an optional tempo grid (`bpm`/`beatsPerBar`).
 *
 * `normalizePaintedCanvas` is the ONE validator — lenient (clamps what it can,
 * drops what it can't, null when no stroke survives) and idempotent.
 * `synthesizePaintedCanvas` renders a normalized canvas to stereo PCM using
 * only IEEE-exact arithmetic (+ − × ÷ √, floor): sines come from a table built
 * by polynomial, log-pitch uses series log2/exp2, and noise is seeded, so the
 * server WAV and the browser preview are the same samples on any JS engine.
 * Render work is bounded by `WORK_MAX_PARTIAL_SEC` (stroke-seconds × partials).
 *
 * Pure and dependency-free: imported by the client (WaveformPanel) and the
 * server (musicWaveform.js) through lib/waveSketch.js.
 */

export const PAINTED_CANVAS_VERSION = 2;
export const PAINTED_CANVAS_SAMPLE_RATE = 44100;

export const PAINTED_CANVAS_LIMITS = Object.freeze({
  DURATION_MIN_SEC: 1,
  DURATION_MAX_SEC: 600,
  HZ_MIN: 20,
  HZ_MAX: 16000,
  STROKES_MAX: 4000,
  KEYFRAMES_PER_STROKE_MAX: 256,
  KEYFRAMES_MAX: 40000,
  OVERTONES_MAX: 16,
  WIDTH_MIN_HZ: 10,
  WIDTH_MAX_HZ: 16000,
  // Render work: Σ over strokes of (length in seconds × partials), where a
  // tonal stroke has 1 + its overtone count partials and a noise stroke costs
  // NOISE_STROKE_COST. At 44.1 kHz the cap is ~1 G partial-samples — a few
  // seconds of render; a dense 3-minute painting uses roughly a third of it.
  WORK_MAX_PARTIAL_SEC: 24000,
  NOISE_STROKE_COST: 3,
  SECTIONS_MAX: 40,
  BPM_MIN: 20,
  BPM_MAX: 300,
  BEATS_PER_BAR_MAX: 16,
  TITLE_MAX: 120,
  NAME_MAX: 24,
});

const L = PAINTED_CANVAS_LIMITS;
// The mix is output at half the summed amplitude, then scaled down (never up)
// only when it would still clip.
export const PAINTED_CANVAS_MASTER_GAIN = 0.5;
const CLIP_CEILING = 0.98;
export const PAINTED_CANVAS_DECLICK_SEC = 0.003;
const BLOCK = 64;
const NYQUIST_GUARD = 0.49; // cycles per sample above which a partial is silent

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Keep stored numbers short — the painting is sent back to the model on revision.
const round = (n, places = 4) => Math.round(n * 10 ** places) / 10 ** places;
const cleanName = (value) => (typeof value === 'string' ? value.trim().slice(0, L.NAME_MAX) : '');

// ---------------------------------------------------------------------------
// Deterministic math — only correctly-rounded IEEE operations, so every JS
// engine produces identical samples (Math.sin/pow/log are implementation-
// defined and differ in the last bits between engines).

const TWO_PI = 6.283185307179586;
const HALF_PI = 1.5707963267948966;
const LN2 = 0.6931471805599453;

/** sin(x) for x ∈ [-π/2, π/2] by Taylor series (error < 1e-15 there). */
function polySin(x) {
  const x2 = x * x;
  let term = x;
  let sum = x;
  for (let n = 1; n < 12; n += 1) {
    term = (-term * x2) / ((2 * n) * (2 * n + 1));
    sum += term;
  }
  return sum;
}

/** sin(2π·turns) for any finite `turns`, by reduction to [-π/2, π/2]. */
function detSinTurns(turns) {
  let f = turns - Math.floor(turns); // [0, 1)
  if (f > 0.5) f -= 1; // (-0.5, 0.5]
  let x = f * TWO_PI; // (-π, π]
  if (x > HALF_PI) x = Math.PI - x;
  else if (x < -HALF_PI) x = -Math.PI - x;
  return polySin(x);
}

const SINE_TABLE_SIZE = 4096;
const SINE_TABLE = (() => {
  const table = new Float64Array(SINE_TABLE_SIZE + 1);
  for (let i = 0; i <= SINE_TABLE_SIZE; i += 1) table[i] = detSinTurns(i / SINE_TABLE_SIZE);
  return table;
})();

/** log2(x) for x > 0: exact power-of-two split plus an atanh series. */
function detLog2(x) {
  let m = x;
  let e = 0;
  while (m >= 2) { m /= 2; e += 1; }
  while (m < 1) { m *= 2; e -= 1; }
  const s = (m - 1) / (m + 1); // [0, 1/3)
  const s2 = s * s;
  let term = s;
  let sum = 0;
  for (let k = 1; k < 40; k += 2) {
    sum += term / k;
    term *= s2;
  }
  return e + (2 * sum) / LN2;
}

/** 2^y: exact integer part plus a Taylor series for the fraction. */
function detExp2(y) {
  const n = Math.floor(y);
  const z = (y - n) * LN2; // [0, ln2)
  let term = 1;
  let sum = 1;
  for (let k = 1; k < 20; k += 1) {
    term = (term * z) / k;
    sum += term;
  }
  let scale = 1;
  if (n > 0) for (let i = 0; i < n; i += 1) scale *= 2;
  else for (let i = 0; i < -n; i += 1) scale /= 2;
  return sum * scale;
}

// mulberry32 — tiny deterministic PRNG so noise renders identically everywhere.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Validation

function normalizeOvertones(raw) {
  if (!Array.isArray(raw)) return null;
  const levels = raw.slice(0, L.OVERTONES_MAX).map((n) => (isNum(n) ? round(clamp(n, 0, 1)) : 0));
  while (levels.length && levels[levels.length - 1] === 0) levels.pop();
  return levels;
}

function resolveKeyframeHz(raw) {
  if (!isNum(raw)) return null;
  return raw >= L.HZ_MIN ? round(Math.min(raw, L.HZ_MAX), 3) : null;
}

/** Keyframes in time order: finite t/hz, strictly increasing t, ≥ 2 of them. */
function normalizePath(raw, durationSec, isNoise) {
  if (!Array.isArray(raw)) return null;
  const path = [];
  for (const k of raw.slice(0, L.KEYFRAMES_PER_STROKE_MAX * 2)) {
    if (path.length >= L.KEYFRAMES_PER_STROKE_MAX) break;
    if (!isObj(k) || !isNum(k.t)) continue;
    const hz = resolveKeyframeHz(k.hz);
    if (hz == null) continue;
    const t = round(clamp(k.t, 0, durationSec));
    if (path.length && t <= path[path.length - 1].t) continue;
    const frame = { t, hz, a: round(isNum(k.a) ? clamp(k.a, 0, 1) : 0) };
    const overtones = isNoise ? null : normalizeOvertones(k.overtones);
    if (overtones) frame.overtones = overtones;
    path.push(frame);
  }
  return path.length >= 2 ? path : null;
}

/** Highest partial count the stroke ever reaches (1 = fundamental only). */
function partialCount(stroke) {
  let most = stroke.overtones?.length ?? 0;
  for (const k of stroke.path) if (k.overtones) most = Math.max(most, k.overtones.length);
  return 1 + most;
}

/** Render work of one normalized stroke, in partial-seconds. */
function strokeWork(stroke) {
  const seconds = stroke.path[stroke.path.length - 1].t - stroke.path[0].t;
  return seconds * (stroke.width ? L.NOISE_STROKE_COST : partialCount(stroke));
}

function normalizeStroke(raw, durationSec) {
  if (!isObj(raw)) return null;
  const width = isNum(raw.width) && raw.width > 0 ? round(clamp(raw.width, L.WIDTH_MIN_HZ, L.WIDTH_MAX_HZ), 2) : 0;
  const path = normalizePath(raw.path, durationSec, width > 0);
  if (!path) return null;
  const stroke = {};
  const name = cleanName(raw.name);
  if (name) stroke.name = name;
  const pan = isNum(raw.pan) ? round(clamp(raw.pan, -1, 1), 3) : 0;
  if (pan) stroke.pan = pan;
  if (width) stroke.width = width;
  const overtones = width ? null : normalizeOvertones(raw.overtones);
  if (overtones?.length) stroke.overtones = overtones;
  stroke.path = path;
  return stroke;
}

function normalizeSections(raw, durationSec) {
  if (!Array.isArray(raw)) return [];
  const sections = [];
  for (const s of raw.slice(0, L.SECTIONS_MAX * 2)) {
    if (sections.length >= L.SECTIONS_MAX) break;
    if (!isObj(s) || !isNum(s.start) || !isNum(s.end)) continue;
    const start = round(clamp(s.start, 0, durationSec), 3);
    const end = round(clamp(s.end, 0, durationSec), 3);
    const prevEnd = sections.length ? sections[sections.length - 1].end : 0;
    if (!(end > start) || start < prevEnd) continue;
    const section = { start, end };
    const name = cleanName(s.name);
    if (name) section.name = name;
    sections.push(section);
  }
  return sections;
}

/**
 * Validate + canonicalize a painted canvas (an LLM reply, a stored sketch, or a
 * client round-trip). `limits` narrows the stroke/keyframe/work budgets — the
 * painting service uses it to give each passage its share. Returns the
 * normalized canvas, or null when no stroke survives.
 */
export function normalizePaintedCanvas(raw, { durationSec: fixedDuration, limits = {} } = {}) {
  if (!isObj(raw)) return null;
  const rawStrokes = Array.isArray(raw.strokes) ? raw.strokes.slice(0, L.STROKES_MAX * 2) : [];
  let durationSec = fixedDuration;
  if (!isNum(durationSec)) {
    // An absent/invalid duration is derived from the painting itself.
    const lastT = rawStrokes.reduce((end, s) => (Array.isArray(s?.path)
      ? s.path.slice(0, L.KEYFRAMES_PER_STROKE_MAX).reduce((e, k) => (isNum(k?.t) ? Math.max(e, k.t) : e), end)
      : end), 0);
    durationSec = isNum(raw.durationSec) ? raw.durationSec : lastT;
  }
  durationSec = round(clamp(durationSec, L.DURATION_MIN_SEC, L.DURATION_MAX_SEC), 3);

  let strokeBudget = Math.min(L.STROKES_MAX, limits.strokes ?? L.STROKES_MAX);
  let keyframeBudget = Math.min(L.KEYFRAMES_MAX, limits.keyframes ?? L.KEYFRAMES_MAX);
  let workBudget = Math.min(L.WORK_MAX_PARTIAL_SEC, limits.work ?? L.WORK_MAX_PARTIAL_SEC);
  const strokes = [];
  for (const rawStroke of rawStrokes) {
    if (strokeBudget <= 0) break;
    const stroke = normalizeStroke(rawStroke, durationSec);
    if (!stroke) continue;
    const work = strokeWork(stroke);
    // Over a budget → dropped in the order returned (later strokes go first).
    if (stroke.path.length > keyframeBudget || work > workBudget) continue;
    strokes.push(stroke);
    strokeBudget -= 1;
    keyframeBudget -= stroke.path.length;
    workBudget -= work;
  }
  if (!strokes.length) return null;
  // Stable onset order (the budget pass above already ran in reply order).
  strokes.sort((a, b) => a.path[0].t - b.path[0].t);

  const canvas = { version: PAINTED_CANVAS_VERSION, title: '', durationSec };
  if (typeof raw.title === 'string') canvas.title = raw.title.trim().slice(0, L.TITLE_MAX);
  if (isNum(raw.bpm)) canvas.bpm = round(clamp(raw.bpm, L.BPM_MIN, L.BPM_MAX), 2);
  if (canvas.bpm && isNum(raw.beatsPerBar)) canvas.beatsPerBar = clamp(Math.round(raw.beatsPerBar), 1, L.BEATS_PER_BAR_MAX);
  const sections = normalizeSections(raw.sections, durationSec);
  if (sections.length) canvas.sections = sections;
  canvas.strokes = strokes;
  return canvas;
}

/** Totals used by the UI and logs. */
export function paintedCanvasStats(canvas) {
  let keyframes = 0;
  let work = 0;
  let noise = 0;
  for (const s of canvas.strokes) {
    keyframes += s.path.length;
    work += strokeWork(s);
    if (s.width) noise += 1;
  }
  return { strokes: canvas.strokes.length, keyframes, noise, work: round(work, 2) };
}

// ---------------------------------------------------------------------------
// Rendering

/** Each keyframe's effective overtone levels (a keyframe inherits the last set). */
function resolvedOvertones(stroke) {
  let current = stroke.overtones ?? [];
  return stroke.path.map((k) => {
    if (k.overtones) current = k.overtones;
    return current;
  });
}

/**
 * A cursor over one stroke's keyframes. `at(t)` must be called with
 * non-decreasing t and fills `state` = { hz, amp: [partial levels × a] }.
 */
function strokeCursor(stroke, partials) {
  const { path } = stroke;
  const overtones = resolvedOvertones(stroke);
  const start = path[0].t;
  const end = path[path.length - 1].t;
  const declick = Math.min(PAINTED_CANVAS_DECLICK_SEC, (end - start) / 2);
  let seg = 0;
  let segLog = null;
  const state = { hz: path[0].hz, amp: new Float64Array(partials) };
  const at = (t) => {
    while (seg < path.length - 2 && t > path[seg + 1].t) { seg += 1; segLog = null; }
    const k0 = path[seg];
    const k1 = path[seg + 1];
    const u = clamp((t - k0.t) / (k1.t - k0.t), 0, 1);
    if (k0.hz === k1.hz) state.hz = k0.hz;
    else {
      segLog ??= detLog2(k1.hz / k0.hz);
      state.hz = k0.hz * detExp2(u * segLog);
    }
    const edge = Math.min(1, (t - start) / declick, (end - t) / declick);
    const level = (k0.a + (k1.a - k0.a) * u) * Math.max(0, edge);
    state.amp[0] = level;
    const o0 = overtones[seg];
    const o1 = overtones[seg + 1];
    for (let p = 1; p < partials; p += 1) {
      const r0 = o0[p - 1] ?? 0;
      const r1 = o1[p - 1] ?? 0;
      state.amp[p] = level * (r0 + (r1 - r0) * u);
    }
    return state;
  };
  return { start, end, at };
}

function tonalStrokeInto(stroke, buf, fromSample, sampleRate) {
  const partials = partialCount(stroke);
  const cursor = strokeCursor(stroke, partials);
  const phases = new Float64Array(partials);
  const s0 = Math.max(fromSample, Math.ceil(cursor.start * sampleRate));
  const s1 = Math.min(fromSample + buf.length, Math.floor(cursor.end * sampleRate));
  const ampA = new Float64Array(partials);
  for (let b = s0; b < s1; b += BLOCK) {
    const e = Math.min(s1, b + BLOCK);
    const n = e - b;
    let st = cursor.at(b / sampleRate);
    const hzA = st.hz;
    ampA.set(st.amp);
    st = cursor.at(e / sampleRate);
    const hzB = st.hz;
    for (let p = 0; p < partials; p += 1) {
      const incA = (hzA * (p + 1)) / sampleRate;
      const incB = (hzB * (p + 1)) / sampleRate;
      const a0 = incA < NYQUIST_GUARD ? ampA[p] : 0;
      const a1 = incB < NYQUIST_GUARD ? st.amp[p] : 0;
      if (a0 === 0 && a1 === 0) {
        const advanced = phases[p] + ((incA + incB) / 2) * n;
        phases[p] = advanced - Math.floor(advanced);
        continue;
      }
      const dInc = (incB - incA) / n;
      const dAmp = (a1 - a0) / n;
      let phase = phases[p];
      let inc = incA;
      let amp = a0;
      for (let i = 0, s = b - fromSample; i < n; i += 1, s += 1) {
        phase += inc;
        if (phase >= 1) phase -= 1; // inc < 0.5, so one wrap suffices
        const x = phase * SINE_TABLE_SIZE;
        const j = Math.floor(x);
        buf[s] += (SINE_TABLE[j] + (SINE_TABLE[j + 1] - SINE_TABLE[j]) * (x - j)) * amp;
        inc += dInc;
        amp += dAmp;
      }
      phases[p] = phase;
    }
  }
}

function noiseStrokeInto(stroke, buf, fromSample, sampleRate, seed) {
  const cursor = strokeCursor(stroke, 1);
  const random = seededRandom(seed);
  const nyquist = sampleRate / 2;
  const s0 = Math.max(fromSample, Math.ceil(cursor.start * sampleRate));
  const s1 = Math.min(fromSample + buf.length, Math.floor(cursor.end * sampleRate));
  // Unit-RMS-ish band: white noise (RMS 1/√3) through a 0 dB-peak band-pass of
  // equivalent noise bandwidth ≈ π/2 × width keeps ≈ π·width/fs of its power;
  // scale so a band of amplitude a is about as loud as a sine of amplitude a.
  const bandwidth = Math.min(stroke.width, nyquist);
  const gain = Math.sqrt((3 * sampleRate) / (2 * Math.PI * bandwidth));
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let b = s0; b < s1; b += BLOCK) {
    const e = Math.min(s1, b + BLOCK);
    const n = e - b;
    const a0 = cursor.at(b / sampleRate).amp[0];
    const st = cursor.at(e / sampleRate);
    const a1 = st.amp[0];
    // RBJ band-pass (constant 0 dB peak), retuned once per block.
    const centre = Math.min(st.hz, nyquist * 0.95);
    const q = clamp(centre / bandwidth, 0.05, 200);
    const w = centre / sampleRate; // turns per sample
    const sinW = detSinTurns(w);
    const cosW = detSinTurns(w + 0.25);
    const alpha = sinW / (2 * q);
    const norm = 1 / (1 + alpha);
    const b0 = alpha * norm;
    const fa1 = -2 * cosW * norm;
    const fa2 = (1 - alpha) * norm;
    const dAmp = (a1 - a0) / n;
    let amp = a0;
    for (let i = 0, s = b - fromSample; i < n; i += 1, s += 1) {
      const x0 = random() * 2 - 1;
      const y0 = b0 * x0 - b0 * x2 - fa1 * y1 - fa2 * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      buf[s] += y0 * gain * amp;
      amp += dAmp;
    }
  }
}

/** Equal-power pan gains for pan ∈ [-1, 1]. */
function panGains(pan = 0) {
  const turns = (pan + 1) / 8; // θ = (pan + 1)·π/4
  return [detSinTurns(turns + 0.25), detSinTurns(turns)];
}

/**
 * Render a NORMALIZED canvas to stereo PCM: `[left, right]` Float32Arrays in
 * [-1, 1]. Deterministic across engines (see the module comment).
 */
export function synthesizePaintedCanvas(canvas, { sampleRate = PAINTED_CANVAS_SAMPLE_RATE } = {}) {
  const total = Math.max(1, Math.round(canvas.durationSec * sampleRate));
  const left = new Float64Array(total);
  const right = new Float64Array(total);
  canvas.strokes.forEach((stroke, index) => {
    const from = Math.max(0, Math.ceil(stroke.path[0].t * sampleRate));
    const to = Math.min(total, Math.floor(stroke.path[stroke.path.length - 1].t * sampleRate) + 1);
    if (to <= from) return;
    const buf = new Float64Array(to - from);
    if (stroke.width) noiseStrokeInto(stroke, buf, from, sampleRate, (index + 1) * 100003);
    else tonalStrokeInto(stroke, buf, from, sampleRate);
    const [gl, gr] = panGains(stroke.pan);
    for (let i = 0; i < buf.length; i += 1) {
      left[from + i] += buf[i] * gl;
      right[from + i] += buf[i] * gr;
    }
  });

  let peak = 0;
  for (let s = 0; s < total; s += 1) {
    peak = Math.max(peak, Math.abs(left[s]), Math.abs(right[s]));
  }
  // Scale down (never up) so a dense painting can't clip — deterministic,
  // unlike a compressor, so preview and render stay identical.
  const scale = PAINTED_CANVAS_MASTER_GAIN * (peak * PAINTED_CANVAS_MASTER_GAIN > CLIP_CEILING ? CLIP_CEILING / (peak * PAINTED_CANVAS_MASTER_GAIN) : 1);
  const outL = new Float32Array(total);
  const outR = new Float32Array(total);
  for (let s = 0; s < total; s += 1) {
    outL[s] = left[s] * scale;
    outR[s] = right[s] * scale;
  }
  return [outL, outR];
}

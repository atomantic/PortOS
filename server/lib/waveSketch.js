/**
 * Wave sketch contract — music an LLM *draws* instead of scores.
 *
 * Rather than naming instruments or writing Tone.js/Strudel code, the model
 * draws the sound itself:
 *
 *   - `shapes`  — single-cycle waveforms, each a polyline of 4–256 amplitude
 *                 points in [-1, 1]. Looping one at a pitch turns the drawing
 *                 into a timbre (a drawn wavetable).
 *   - `voices`  — lanes that play one drawn shape (or `noise`) as timed
 *                 strokes: onset/length in seconds, a pitch, an optional glide,
 *                 an optional morph into a second drawn shape, and an optional
 *                 drawn amplitude envelope.
 *   - `contour` — an optional drawn loudness curve over the whole piece.
 *
 * `normalizeWaveSketch` is the ONE validator (lenient: clamps what it can,
 * drops what it can't, null when nothing playable survives) and is idempotent,
 * so a normalized sketch round-trips through the client unchanged.
 * `synthesizeWaveSketch` turns a normalized sketch into mono PCM
 * deterministically (noise is seeded per stroke), so the browser preview and
 * the server-rendered WAV are the same samples.
 *
 * Pure and dependency-free: imported by the client (MusicDesigner's drawn
 * waveform engine) as well as server/services/musicWaveform.js.
 */

import { pitchToMidi, midiToFreq } from './pitchMath.js';

export const WAVE_SKETCH_VERSION = 1;
export const WAVE_SKETCH_SAMPLE_RATE = 44100;
export const WAVE_SKETCH_NOISE = 'noise';

export const WAVE_SKETCH_LIMITS = Object.freeze({
  DURATION_MIN_SEC: 1,
  DURATION_MAX_SEC: 60,
  SHAPES_MAX: 12,
  SHAPE_POINTS_MIN: 4,
  SHAPE_POINTS_MAX: 256,
  VOICES_MAX: 8,
  NOTES_PER_VOICE_MAX: 512,
  NOTES_MAX: 1536,
  // Aggregate voiced time — the per-sample synth loop runs once per voiced
  // sample, so this (not the duration) bounds the render work. 8 voices fully
  // voiced for the longest piece.
  NOTE_SECONDS_MAX: 480,
  ENV_POINTS_MIN: 2,
  ENV_POINTS_MAX: 32,
  CONTOUR_POINTS_MAX: 256,
  NOTE_MIN_SEC: 0.005,
  HZ_MIN: 20,
  HZ_MAX: 8000,
  // Noise strokes read `hz` as a sample-and-hold rate, which may run faster
  // than any tonal pitch (crisp hats) — up to Nyquist.
  NOISE_HZ_MAX: WAVE_SKETCH_SAMPLE_RATE / 2,
  TITLE_MAX: 120,
  NAME_MAX: 24,
});

const L = WAVE_SKETCH_LIMITS;
const NAME_RE = new RegExp(`^[A-Za-z0-9_-]{1,${L.NAME_MAX}}$`);
const MASTER_GAIN = 0.5;
const CLIP_CEILING = 0.98;
const DEFAULT_GAIN = 0.6;
const DEFAULT_VELOCITY = 0.8;
const DEFAULT_ATTACK_SEC = 0.005;
const DEFAULT_RELEASE_SEC = 0.04;
const DECLICK_SEC = 0.002;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
// Keep stored numbers short — the sketch is sent back to the LLM on revision.
const round = (n, places = 4) => Math.round(n * 10 ** places) / 10 ** places;

/** A drawn polyline of `min`..`max` finite points, clamped to [lo, hi], or null. */
function normalizePoints(raw, { min, max, lo, hi }) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.points) ? raw.points : null;
  if (!list) return null;
  // Slice BEFORE scanning so an oversized array costs O(cap), not O(length).
  const points = list.slice(0, max).filter(isNum).map((n) => round(clamp(n, lo, hi)));
  return points.length >= min ? points : null;
}

/** Hz for a stroke pitch: a number of Hz, or a scientific-pitch string ("C4"). */
function resolveHz(value, maxHz) {
  const hz = isNum(value) ? value : midiToFreq(pitchToMidi(value));
  return isNum(hz) && hz >= L.HZ_MIN ? round(Math.min(hz, maxHz), 3) : null;
}

function normalizeNote(raw, { durationSec, isNoise, shapeNames }) {
  if (!raw || typeof raw !== 'object' || !isNum(raw.t) || !isNum(raw.d)) return null;
  const t = round(clamp(raw.t, 0, durationSec));
  const d = round(Math.min(raw.d, durationSec - t));
  if (!(d >= L.NOTE_MIN_SEC)) return null;
  const maxHz = isNoise ? L.NOISE_HZ_MAX : L.HZ_MAX;
  // `hz` wins over `pitch` so a normalized note (which carries both) is stable.
  const hz = resolveHz(raw.hz ?? raw.pitch, maxHz);
  // A tonal stroke needs a pitch; a noise stroke without one is white noise.
  if (hz == null && !isNoise) return null;
  const note = { t, d, hz, v: round(isNum(raw.v) ? clamp(raw.v, 0, 1) : DEFAULT_VELOCITY) };
  if (typeof raw.pitch === 'string' && pitchToMidi(raw.pitch) != null) note.pitch = raw.pitch.trim();
  const toHz = hz == null ? null : resolveHz(raw.toHz ?? raw.glideTo, maxHz);
  if (toHz != null && toHz !== hz) note.toHz = toHz;
  if (!isNoise && typeof raw.morphTo === 'string' && shapeNames.has(raw.morphTo)) note.morphTo = raw.morphTo;
  const env = normalizePoints(raw.env, { min: L.ENV_POINTS_MIN, max: L.ENV_POINTS_MAX, lo: 0, hi: 1 });
  if (env) note.env = env;
  return note;
}

/**
 * Validate + canonicalize an LLM (or client round-tripped) wave sketch.
 * Returns the normalized sketch, or null when nothing playable survives.
 */
export function normalizeWaveSketch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const shapes = {};
  const rawShapes = raw.shapes && typeof raw.shapes === 'object' && !Array.isArray(raw.shapes) ? raw.shapes : {};
  let shapeBudget = L.SHAPES_MAX * 4; // bounded scan of a hostile key count
  for (const name in rawShapes) {
    if (!Object.hasOwn(rawShapes, name)) continue;
    if (Object.keys(shapes).length >= L.SHAPES_MAX || (shapeBudget -= 1) < 0) break;
    const points = rawShapes[name];
    if (!NAME_RE.test(name) || name === WAVE_SKETCH_NOISE) continue;
    const normalized = normalizePoints(points, { min: L.SHAPE_POINTS_MIN, max: L.SHAPE_POINTS_MAX, lo: -1, hi: 1 });
    if (normalized) shapes[name] = normalized;
  }
  const shapeNames = new Set(Object.keys(shapes));

  const rawVoices = Array.isArray(raw.voices) ? raw.voices.slice(0, L.VOICES_MAX) : [];
  // An absent/invalid duration is derived from the strokes themselves.
  const lastEnd = rawVoices.flatMap((v) => (Array.isArray(v?.notes) ? v.notes.slice(0, L.NOTES_PER_VOICE_MAX) : []))
    .reduce((end, n) => (isNum(n?.t) && isNum(n?.d) ? Math.max(end, n.t + n.d) : end), 0);
  const durationSec = round(clamp(isNum(raw.durationSec) ? raw.durationSec : lastEnd, L.DURATION_MIN_SEC, L.DURATION_MAX_SEC), 3);

  let noteBudget = L.NOTES_MAX;
  let secondsBudget = L.NOTE_SECONDS_MAX;
  const voices = [];
  for (const [index, rawVoice] of rawVoices.entries()) {
    const shape = rawVoice?.shape;
    const isNoise = shape === WAVE_SKETCH_NOISE;
    if (!isNoise && !shapeNames.has(shape)) continue;
    const notes = [];
    for (const rawNote of (Array.isArray(rawVoice.notes) ? rawVoice.notes.slice(0, L.NOTES_PER_VOICE_MAX * 2) : [])) {
      if (notes.length >= L.NOTES_PER_VOICE_MAX || noteBudget <= 0) break;
      const note = normalizeNote(rawNote, { durationSec, isNoise, shapeNames });
      if (!note || note.d > secondsBudget) continue;
      notes.push(note);
      noteBudget -= 1;
      secondsBudget -= note.d;
    }
    if (!notes.length) continue;
    const name = typeof rawVoice.name === 'string' && rawVoice.name.trim()
      ? rawVoice.name.trim().slice(0, L.NAME_MAX)
      : `voice${index + 1}`;
    voices.push({
      name,
      shape,
      gain: round(isNum(rawVoice.gain) ? clamp(rawVoice.gain, 0, 1) : DEFAULT_GAIN),
      notes: notes.sort((a, b) => a.t - b.t),
    });
  }
  if (!voices.length) return null;

  const sketch = { version: WAVE_SKETCH_VERSION, title: '', durationSec, shapes, voices };
  if (typeof raw.title === 'string') sketch.title = raw.title.trim().slice(0, L.TITLE_MAX);
  // Only the shapes a voice actually plays (or morphs into) are kept, so the
  // drawings shown to the user are exactly the ones they hear.
  const used = new Set(voices.flatMap((v) => [v.shape, ...v.notes.map((n) => n.morphTo)]));
  for (const name of Object.keys(shapes)) if (!used.has(name)) delete shapes[name];
  const contour = normalizePoints(raw.contour, { min: 2, max: L.CONTOUR_POINTS_MAX, lo: 0, hi: 1 });
  if (contour) sketch.contour = contour;
  return sketch;
}

/** Linear interpolation across evenly spaced points at progress u ∈ [0, 1]. */
function samplePolyline(points, u) {
  const x = clamp(u, 0, 1) * (points.length - 1);
  const i = Math.floor(x);
  if (i >= points.length - 1) return points[points.length - 1];
  return points[i] + (points[i + 1] - points[i]) * (x - i);
}

// One drawn cycle as a looping wavetable, DC-centred so a lopsided drawing
// can't push the mix off zero.
function buildTable(points) {
  const mean = points.reduce((sum, p) => sum + p, 0) / points.length;
  return Float32Array.from(points, (p) => p - mean);
}

// Cyclic read: phase ∈ [0, 1) wraps from the last point back to the first.
function readTable(table, phase) {
  const x = phase * table.length;
  const i = Math.floor(x);
  const j = i + 1 === table.length ? 0 : i + 1;
  return table[i] + (table[j] - table[i]) * (x - i);
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

// Amplitude at progress u of a note: its drawn envelope (declicked at both
// ends) or the default quick attack/release. `releaseSec` is per-note, hoisted
// out of the per-sample loop.
function envelopeAt(note, u, elapsedSec, releaseSec) {
  const remainingSec = note.d - elapsedSec;
  if (note.env) {
    const declick = Math.min(1, elapsedSec / DECLICK_SEC, remainingSec / DECLICK_SEC);
    return samplePolyline(note.env, u) * Math.max(0, declick);
  }
  return Math.max(0, Math.min(1, elapsedSec / DEFAULT_ATTACK_SEC, remainingSec / releaseSec));
}

/**
 * Render a NORMALIZED sketch to mono PCM (Float32Array in [-1, 1]).
 * Deterministic: the same sketch always yields the same samples.
 */
export function synthesizeWaveSketch(sketch, { sampleRate = WAVE_SKETCH_SAMPLE_RATE } = {}) {
  const total = Math.max(1, Math.round(sketch.durationSec * sampleRate));
  const out = new Float32Array(total);
  const tables = Object.fromEntries(Object.entries(sketch.shapes).map(([name, points]) => [name, buildTable(points)]));

  sketch.voices.forEach((voice, voiceIndex) => {
    const isNoise = voice.shape === WAVE_SKETCH_NOISE;
    const table = tables[voice.shape];
    voice.notes.forEach((note, noteIndex) => {
      const start = Math.floor(note.t * sampleRate);
      const length = Math.max(1, Math.round(note.d * sampleRate));
      const end = Math.min(total, start + length);
      const fromHz = note.hz;
      // Exponential glide (equal cents per second — a musical slide), applied
      // as a constant per-sample multiplier rather than a pow() per sample.
      const glideStep = note.toHz ? (note.toHz / fromHz) ** (1 / length) : 1;
      const releaseSec = Math.min(DEFAULT_RELEASE_SEC, note.d / 3);
      const morph = note.morphTo ? tables[note.morphTo] : null;
      const random = isNoise ? seededRandom((voiceIndex + 1) * 100003 + noteIndex) : null;
      const level = voice.gain * note.v;
      let phase = 0;
      let hz = fromHz;
      let held = random ? random() * 2 - 1 : 0;
      for (let s = start; s < end; s += 1, hz = hz == null ? null : hz * glideStep) {
        const i = s - start;
        const u = i / length;
        let sample;
        if (isNoise) {
          if (hz == null) {
            sample = random() * 2 - 1;
          } else {
            phase += hz / sampleRate;
            if (phase >= 1) { phase -= Math.floor(phase); held = random() * 2 - 1; }
            sample = held;
          }
        } else {
          phase += hz / sampleRate;
          phase -= Math.floor(phase);
          sample = readTable(table, phase);
          if (morph) sample += (readTable(morph, phase) - sample) * u;
        }
        out[s] += sample * level * envelopeAt(note, u, i / sampleRate, releaseSec);
      }
    });
  });

  let peak = 0;
  for (let s = 0; s < total; s += 1) {
    const contour = sketch.contour ? samplePolyline(sketch.contour, s / total) : 1;
    out[s] *= MASTER_GAIN * contour;
    peak = Math.max(peak, Math.abs(out[s]));
  }
  // Scale down (never up) so a dense drawing can't clip — deterministic,
  // unlike a compressor, so preview and render stay identical.
  if (peak > CLIP_CEILING) {
    const scale = CLIP_CEILING / peak;
    for (let s = 0; s < total; s += 1) out[s] *= scale;
  }
  return out;
}

/**
 * Downsample PCM into `columns` [min, max] pairs for drawing the rendered
 * waveform. Each column covers an equal slice of the buffer.
 */
export function pcmPeaks(pcm, columns) {
  const count = Math.max(1, Math.floor(columns));
  const peaks = [];
  for (let c = 0; c < count; c += 1) {
    const from = Math.floor((c / count) * pcm.length);
    const to = Math.max(from + 1, Math.floor(((c + 1) / count) * pcm.length));
    let min = 0;
    let max = 0;
    for (let s = from; s < to && s < pcm.length; s += 1) {
      if (pcm[s] < min) min = pcm[s];
      if (pcm[s] > max) max = pcm[s];
    }
    peaks.push([min, max]);
  }
  return peaks;
}

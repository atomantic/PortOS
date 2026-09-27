/**
 * Beat grid measurement for library music tracks (#8958).
 *
 * Launch videos that use an existing Music-library track only had the
 * filename — nothing measured the track's real tempo, so cuts drifted
 * against the music instead of landing on it. This decodes a track with
 * ffmpeg (already a hard dependency for rendering) and runs a pure-Node DSP
 * pipeline: spectral-flux onset strength, autocorrelation tempo estimation,
 * phase-aligned beat placement, 4/4 downbeat picking, and onset "hit"
 * peak-picking for one-off transients (fills, hi-hats) a quantized beat grid
 * doesn't capture. No Python, no ML model download — this runs anywhere the
 * rest of the media stack already does.
 *
 * `getBeatGrid` is the entry point most callers want: it resolves an
 * absolute audio file path to `{ bpm, beats, downbeats, hits }`, cached in
 * memory per (path, mtime) so a route handler or a CoS-run prep step can call
 * it repeatedly without re-decoding the same track.
 *
 * This module intentionally does not import `server/services/musicVideo/
 * audioAnalysis.js`, which solves an adjacent problem (tempo + section map
 * for the Music Video feature) with a structurally similar pipeline —
 * `server/lib/` cannot depend on `server/services/` (see `layering.test.js`).
 * The DSP core here is deliberately smaller in scope: no section
 * segmentation, no waveform summary, no manual-tempo override — just the
 * beat/downbeat/hit grid a launch-video render needs.
 */

import { spawn } from './childProcess.js';
import { findFfmpeg } from './ffmpeg.js';
import { safeChildProcessOptions } from './processEnv.js';
import { stat } from 'node:fs/promises';

// Fixed analysis sample rate. 22.05kHz keeps the 40Hz-8kHz band used for
// onset work while halving the sample count against 44.1kHz. Mono — beat
// structure is shared across channels.
export const BEAT_GRID_SAMPLE_RATE = 22050;

// Cap how much of a track ffmpeg decodes (issue #8973). Buffering unbounded
// decoded f32 PCM in memory scales with track length — a 20+ minute ambient
// bed or DJ mix can push a single decode into the hundreds of MB, doubling
// briefly at the Buffer.concat in decodeAudioToPcm. Tempo/beat estimation
// doesn't need the whole track: five minutes gives autocorrelation dozens of
// bars to lock onto, far more than the TEMPO_WINDOW_SEC-scale windows other
// tempo estimators use. Passing `-t` lets ffmpeg itself truncate the decode
// instead of PortOS buffering (and then discarding) the rest of the stream.
export const MAX_ANALYSIS_SEC = 300;

// Frame hop for the onset envelope: ~43 frames/sec at 22.05kHz, giving
// sub-1-BPM tempo resolution and ~23ms beat-placement granularity.
export const ONSET_HOP = 512;

// Tempo search window (issue #8958: "estimate tempo by autocorrelation
// (60-200 BPM)"). A log-normal preference centered at PREFERRED_BPM
// disambiguates octave errors (a 90 BPM track's autocorrelation peaks at 45,
// 90, 180... equally; the preference weight favors the one closest to a
// "natural" dance tempo).
const MIN_BPM = 60;
const MAX_BPM = 200;
const PREFERRED_BPM = 120;
const TEMPO_PREF_SIGMA = 0.9; // in octaves

// Minimum normalized autocorrelation peak to accept a tempo. Below this the
// "peak" is just the strongest lag of structureless audio (silence, noise) —
// reporting a confident BPM there is worse than reporting none.
const TEMPO_PEAK_MIN = 0.3;

const FFT_SIZE = 1024;

// Fractional-lag step (frames) for the tempo autocorrelation scan. Integer-lag
// autocorrelation smears a true period that lands between two integer lags
// across both (the classic half-tempo octave error); interpolating at
// 0.25-frame resolution recovers the true peak and keeps the BPM estimate
// precise enough that a beat grid held over many bars doesn't visibly drift.
const TEMPO_LAG_STEP = 0.25;

// Onset "hit" peak-picking: a local maximum must exceed the envelope's mean
// by this many standard deviations, and hits must be at least this far apart
// so a single broad transient isn't reported as several.
const HIT_THRESHOLD_SIGMA = 1.0;
const HIT_MIN_GAP_SEC = 0.08;

const hannCache = new Map();
function hannWindow(len) {
  let w = hannCache.get(len);
  if (w) return w;
  w = new Float32Array(len);
  for (let i = 0; i < len; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)));
  hannCache.set(len, w);
  return w;
}

const fftPlanCache = new Map();
function fftPlan(size) {
  let plan = fftPlanCache.get(size);
  if (plan) return plan;
  const reverse = new Uint32Array(size);
  const bits = Math.log2(size);
  for (let i = 0; i < size; i++) {
    let x = i;
    let r = 0;
    for (let bit = 0; bit < bits; bit++) { r = (r << 1) | (x & 1); x >>= 1; }
    reverse[i] = r;
  }
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    const angle = (-2 * Math.PI * i) / size;
    cos[i] = Math.cos(angle);
    sin[i] = Math.sin(angle);
  }
  plan = { reverse, cos, sin };
  fftPlanCache.set(size, plan);
  return plan;
}

// In-place iterative radix-2 FFT (Cooley-Tukey, decimation-in-time).
function fftInPlace(real, imaginary, plan) {
  const n = real.length;
  for (let i = 0; i < n; i++) {
    const j = plan.reverse[i];
    if (j <= i) continue;
    [real[i], real[j]] = [real[j], real[i]];
    [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2;
    const twiddleStep = n / size;
    for (let start = 0; start < n; start += size) {
      for (let offset = 0; offset < half; offset++) {
        const twiddle = offset * twiddleStep;
        const even = start + offset;
        const odd = even + half;
        const oddReal = real[odd] * plan.cos[twiddle] - imaginary[odd] * plan.sin[twiddle];
        const oddImaginary = real[odd] * plan.sin[twiddle] + imaginary[odd] * plan.cos[twiddle];
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
      }
    }
  }
}

/**
 * Per-frame onset-strength envelope from spectral flux: positive change
 * across FFT bands, so a guitar strum or a harmonic attack registers even
 * when overall loudness is steady. A rolling local mean is subtracted so a
 * broadband noise floor doesn't read as a beat.
 *
 * @param {Float32Array} samples mono PCM
 * @param {number} sampleRate
 * @param {number} hop
 * @returns {{ onset: Float32Array, fps: number, frameCount: number }}
 */
function onsetEnvelope(samples, sampleRate, hop) {
  const fftSize = FFT_SIZE;
  const frameCount = Math.max(0, Math.floor((samples.length - fftSize) / hop) + 1);
  const rawFlux = new Float32Array(frameCount);
  const win = hannWindow(fftSize);
  const plan = fftPlan(fftSize);
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  const previous = new Float64Array(fftSize / 2);
  const minBin = Math.max(1, Math.floor((40 * fftSize) / sampleRate));
  const maxBin = Math.min(fftSize / 2 - 1, Math.ceil((8000 * fftSize) / sampleRate));
  for (let f = 0; f < frameCount; f++) {
    const base = f * hop;
    for (let i = 0; i < fftSize; i++) {
      real[i] = samples[base + i] * win[i];
      imaginary[i] = 0;
    }
    fftInPlace(real, imaginary, plan);
    let flux = 0;
    for (let bin = minBin; bin <= maxBin; bin++) {
      const magnitude = Math.log1p(Math.sqrt(real[bin] * real[bin] + imaginary[bin] * imaginary[bin]));
      const rise = magnitude - previous[bin];
      if (rise > 0) flux += rise;
      previous[bin] = magnitude;
    }
    rawFlux[f] = flux / (maxBin - minBin + 1);
  }

  // Subtract a rolling ~0.75s local mean so a real attack (rising above its
  // neighborhood) survives while a stationary floor is suppressed.
  const onset = new Float32Array(frameCount);
  const fps = sampleRate / hop;
  const radius = Math.max(1, Math.round((0.75 * fps) / 2));
  let rolling = 0;
  let left = 0;
  let right = 0;
  for (let f = 0; f < frameCount; f++) {
    while (right < frameCount && right <= f + radius) { rolling += rawFlux[right]; right += 1; }
    while (left < f - radius) { rolling -= rawFlux[left]; left += 1; }
    const localMean = rolling / Math.max(1, right - left);
    onset[f] = Math.max(0, rawFlux[f] - localMean);
  }
  return { onset, fps, frameCount };
}

/**
 * Estimate tempo (BPM) via tempo-weighted, sub-frame autocorrelation of the
 * onset envelope. Returns `{ bpm: null, confidence: null }` when the
 * envelope carries no usable periodicity (silence, or an autocorrelation
 * peak below the significance floor).
 */
function estimateTempo(onset, fps) {
  const n = onset.length;
  if (n < 4) return { bpm: null, confidence: null };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += onset[i];
  mean /= n;
  const o = new Float32Array(n);
  let variance = 0;
  for (let i = 0; i < n; i++) { o[i] = onset[i] - mean; variance += o[i] * o[i]; }
  if (variance <= 1e-9) return { bpm: null, confidence: null };

  const acFrac = (lag) => {
    const lo = Math.floor(lag);
    const frac = lag - lo;
    let sum = 0;
    for (let i = 0; i + lo + 1 < n; i++) {
      sum += o[i] * (o[i + lo] * (1 - frac) + o[i + lo + 1] * frac);
    }
    return sum;
  };

  const minLag = Math.max(1, (60 * fps) / MAX_BPM);
  const maxLag = Math.min(n - 2, (60 * fps) / MIN_BPM);
  let bestLag = -1;
  let bestScore = -Infinity;
  let bestAc = 0;
  for (let lag = minLag; lag <= maxLag; lag += TEMPO_LAG_STEP) {
    const ac = acFrac(lag);
    const bpm = (60 * fps) / lag;
    const octaves = Math.log2(bpm / PREFERRED_BPM);
    const weight = Math.exp(-0.5 * (octaves / TEMPO_PREF_SIGMA) ** 2);
    const score = ac * weight;
    if (score > bestScore) { bestScore = score; bestLag = lag; bestAc = ac; }
  }
  if (bestLag < 0 || bestScore <= 0) return { bpm: null, confidence: null };

  const confidence = Math.max(0, Math.min(1, bestAc / variance));
  if (confidence < TEMPO_PEAK_MIN) return { bpm: null, confidence };
  return { bpm: (60 * fps) / bestLag, confidence };
}

/**
 * Fit the beat phase: slide a pulse train at the estimated period across the
 * onset envelope and keep the integer-frame offset whose pulses sum the most
 * onset strength. Returns beat times in seconds.
 */
function fitBeats(onset, fps, bpm, durationSec) {
  const periodFrames = (60 * fps) / bpm;
  let bestOffset = 0;
  let bestSum = -Infinity;
  const maxOffset = Math.max(1, Math.ceil(periodFrames));
  for (let off = 0; off < maxOffset; off++) {
    let sum = 0;
    for (let pos = off; pos < onset.length; pos += periodFrames) sum += onset[Math.round(pos)] || 0;
    if (sum > bestSum) { bestSum = sum; bestOffset = off; }
  }
  const beats = [];
  for (let pos = bestOffset; pos < onset.length; pos += periodFrames) {
    const t = pos / fps;
    if (t <= durationSec) beats.push(Number(t.toFixed(3)));
  }
  return beats;
}

/**
 * Pick downbeats assuming 4/4: of the four candidate beat phases, choose the
 * one whose beats carry the most onset strength.
 */
function pickDownbeats(beats, onset, fps) {
  if (beats.length === 0) return [];
  const beatsPerBar = 4;
  let bestPhase = 0;
  let bestSum = -Infinity;
  for (let phase = 0; phase < beatsPerBar; phase++) {
    let sum = 0;
    for (let i = phase; i < beats.length; i += beatsPerBar) sum += onset[Math.round(beats[i] * fps)] || 0;
    if (sum > bestSum) { bestSum = sum; bestPhase = phase; }
  }
  const downbeats = [];
  for (let i = bestPhase; i < beats.length; i += beatsPerBar) downbeats.push(beats[i]);
  return downbeats;
}

/**
 * Peak-pick individual onset transients ("hits") for UI sound placement —
 * fills, hi-hats, and other one-off accents a quantized beat grid doesn't
 * carry. A frame qualifies as a local maximum above `mean + sigma*stdDev`;
 * qualifying peaks closer together than `HIT_MIN_GAP_SEC` collapse to the
 * stronger one so a single broad transient isn't reported twice.
 */
function pickHits(onset, fps, durationSec) {
  const n = onset.length;
  if (n < 3) return [];
  let mean = 0;
  for (let i = 0; i < n; i++) mean += onset[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (onset[i] - mean) ** 2;
  const stdDev = Math.sqrt(variance / n);
  const threshold = mean + HIT_THRESHOLD_SIGMA * stdDev;

  const candidates = [];
  for (let i = 1; i < n - 1; i++) {
    if (onset[i] >= threshold && onset[i] >= onset[i - 1] && onset[i] > onset[i + 1]) {
      candidates.push({ t: i / fps, strength: onset[i] });
    }
  }

  const minGap = HIT_MIN_GAP_SEC;
  const hits = [];
  for (const candidate of candidates) {
    const last = hits[hits.length - 1];
    if (last && candidate.t - last.t < minGap) {
      if (candidate.strength > last.strength) hits[hits.length - 1] = candidate;
      continue;
    }
    hits.push(candidate);
  }
  return hits.map((h) => Number(h.t.toFixed(3))).filter((t) => t <= durationSec);
}

/**
 * Pure DSP core: analyze mono PCM and return the beat-grid shape.
 * Deterministic and ffmpeg-free, so it is unit-tested directly against a
 * synthetic click track (mirroring `audioAnalysis.js#analyzePcm`'s rationale).
 * No production caller needs raw-PCM access today — every real caller goes
 * through `getBeatGrid`, which resolves a file — so this stays behind the
 * `__`-prefixed test-seam convention (see e.g. `ffmpeg.js#__resetSetparamsProbe`)
 * rather than a public export the tree-wide dead-export guard would flag as
 * unreachable from production code.
 *
 * @param {Float32Array} samples mono PCM
 * @param {number} sampleRate
 * @param {{ hop?: number }} [opts]
 * @returns {{ bpm: number|null, beats: number[], downbeats: number[], hits: number[],
 *   durationSec: number, tempoConfidence: number|null }}
 */
export function __analyzeBeatGridPcm(samples, sampleRate, { hop = ONSET_HOP } = {}) {
  const durationSec = samples?.length ? Number((samples.length / sampleRate).toFixed(3)) : 0;
  if (!samples || samples.length < hop * 4) {
    return { bpm: null, beats: [], downbeats: [], hits: [], durationSec, tempoConfidence: null };
  }
  const { onset, fps } = onsetEnvelope(samples, sampleRate, hop);
  const { bpm, confidence } = estimateTempo(onset, fps);
  const roundedBpm = bpm == null ? null : Number(bpm.toFixed(2));
  const beats = roundedBpm == null ? [] : fitBeats(onset, fps, bpm, durationSec);
  const downbeats = roundedBpm == null ? [] : pickDownbeats(beats, onset, fps);
  const hits = pickHits(onset, fps, durationSec);
  return {
    bpm: roundedBpm,
    beats,
    downbeats,
    hits,
    durationSec,
    tempoConfidence: confidence == null ? null : Number(confidence.toFixed(3)),
  };
}

/**
 * Decode an audio file to mono Float32Array PCM at BEAT_GRID_SAMPLE_RATE via
 * ffmpeg. Returns `null` when ffmpeg is unavailable or the decode fails —
 * callers treat that as "couldn't measure a beat grid" rather than throwing.
 *
 * Decodes at most MAX_ANALYSIS_SEC seconds of the source (see its doc
 * comment) — a track longer than the cap gets its beat grid measured from
 * that leading window only.
 *
 * @param {string} audioPath absolute path to the source audio
 * @param {{ signal?: AbortSignal, maxDurationSec?: number }} [opts]
 *   `maxDurationSec` overrides MAX_ANALYSIS_SEC — a test-only seam so the
 *   truncation path can be exercised against a short fixture rather than a
 *   real multi-minute file; real callers should not pass it. Clamped to
 *   MAX_ANALYSIS_SEC — it can only shrink the decode window, never grow it,
 *   so it can't be used to defeat the memory bound.
 * @returns {Promise<{ samples: Float32Array, sampleRate: number } | null>}
 */
export async function decodeAudioToPcm(audioPath, { signal, maxDurationSec = MAX_ANALYSIS_SEC } = {}) {
  if (typeof audioPath !== 'string' || !audioPath) return null;
  if (signal?.aborted) return null;
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return null;
  if (signal?.aborted) return null;

  const boundedDurationSec = Number.isFinite(maxDurationSec) && maxDurationSec > 0
    ? Math.min(maxDurationSec, MAX_ANALYSIS_SEC)
    : MAX_ANALYSIS_SEC;

  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-i', audioPath,
      '-t', String(boundedDurationSec),
      '-ac', '1',
      '-ar', String(BEAT_GRID_SAMPLE_RATE),
      '-f', 'f32le',
      '-acodec', 'pcm_f32le',
      'pipe:1',
    ];
    const proc = spawn(ffmpeg, args, safeChildProcessOptions({ stdio: ['ignore', 'pipe', 'ignore'] }));
    const chunks = [];
    let onAbort = null;
    if (signal) {
      onAbort = () => proc.kill('SIGTERM');
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => { if (signal && onAbort) signal.removeEventListener('abort', onAbort); };

    proc.stdout.on('data', (c) => chunks.push(c));
    proc.on('error', () => { cleanup(); resolve(null); });
    proc.on('close', (code, sig) => {
      cleanup();
      if (sig || code !== 0 || chunks.length === 0) { resolve(null); return; }
      const buf = Buffer.concat(chunks);
      const floats = Math.floor(buf.length / 4);
      if (floats === 0) { resolve(null); return; }
      const samples = buf.byteOffset % 4 === 0
        ? new Float32Array(buf.buffer, buf.byteOffset, floats)
        : new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + floats * 4));
      resolve({ samples, sampleRate: BEAT_GRID_SAMPLE_RATE });
    });
  });
}

/**
 * Decode `audioPath` via ffmpeg and run the DSP analysis. Returns `null` when
 * the file can't be decoded (ffmpeg missing, unsupported/corrupt input). Not
 * exported — `getBeatGrid` is the caching entry point every real caller
 * (routes) uses; this stays a private step between it and the decode.
 *
 * @param {string} audioPath absolute path to the source audio
 * @param {{ signal?: AbortSignal }} [opts]
 */
async function analyzeBeatGridFile(audioPath, { signal } = {}) {
  const decoded = await decodeAudioToPcm(audioPath, { signal });
  if (!decoded) return null;
  return __analyzeBeatGridPcm(decoded.samples, decoded.sampleRate);
}

// In-memory cache keyed by absolute path, invalidated on mtime change — a
// re-uploaded or re-rendered library track under the same filename gets
// re-measured instead of serving a stale grid. Process-lifetime only: this is
// a decode-avoidance cache, not persisted state, so a server restart simply
// re-measures on next request.
const beatGridCache = new Map();

// Re-entrancy guard: two overlapping requests for the SAME unmeasured track
// (e.g. the launch-video form re-submitted quickly, or two runs that pick the
// same library track) would otherwise each spawn their own ffmpeg decode and
// run the DSP independently. Tracks the in-flight analysis promise per
// (path, mtime) — not path alone — so a track overwritten WHILE a measurement
// is running starts its own fresh analysis instead of a second caller
// receiving a grid for bytes that are no longer on disk.
const beatGridInFlight = new Map();
const inFlightKey = (audioPath, mtimeMs) => `${audioPath}\u0000${mtimeMs}`;

/**
 * Resolve the beat grid for an absolute audio file path, cached in memory per
 * (path, mtime). Returns `{ bpm, beats, downbeats, hits }` — `bpm` and its
 * dependents are `null`/`[]` when no confident tempo could be measured — or
 * `null` when the file is missing or can't be decoded.
 *
 * @param {string} audioPath absolute path to the source audio
 * @param {{ signal?: AbortSignal }} [opts]
 */
export async function getBeatGrid(audioPath, { signal } = {}) {
  if (typeof audioPath !== 'string' || !audioPath) return null;
  const stats = await stat(audioPath).catch(() => null);
  if (!stats) return null;
  const cached = beatGridCache.get(audioPath);
  if (cached && cached.mtimeMs === stats.mtimeMs) return cached.result;

  const key = inFlightKey(audioPath, stats.mtimeMs);
  const inFlight = beatGridInFlight.get(key);
  if (inFlight) return inFlight;

  const analysis = (async () => {
    const analyzed = await analyzeBeatGridFile(audioPath, { signal });
    if (!analyzed) return null;
    const result = { bpm: analyzed.bpm, beats: analyzed.beats, downbeats: analyzed.downbeats, hits: analyzed.hits };
    beatGridCache.set(audioPath, { mtimeMs: stats.mtimeMs, result });
    return result;
  })();
  beatGridInFlight.set(key, analysis);
  try {
    return await analysis;
  } finally {
    beatGridInFlight.delete(key);
  }
}

// Test seam — clears the in-memory cache between cases.
export const __clearBeatGridCache = () => { beatGridCache.clear(); beatGridInFlight.clear(); };

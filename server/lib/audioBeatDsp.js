/**
 * Shared beat/tempo DSP core (#9424).
 *
 * The ffmpeg-decode + pure-JS spectral-flux pipeline that both the Music Video
 * analyzer (`services/musicVideo/audioAnalysis.js`) and the launch-video beat
 * grid (`lib/beatGrid.js`) build on: Hann/FFT helpers, `decodeAudioToPcm`,
 * `onsetEnvelope`, windowed-fallback `estimateTempo`, `fitBeats` and
 * `pickDownbeats`. It lives in `server/lib/` so both callers import one copy
 * instead of forking it (a fork had already drifted — only one side had the
 * windowed tempo fallback). Callers keep their own concerns: sections,
 * waveform, features and manual tempo in audioAnalysis; hit peak-picking and
 * the per-file cache in beatGrid.
 */

import { spawn } from './childProcess.js';
import { findFfmpeg } from './ffmpeg.js';
import { safeChildProcessOptions } from './processEnv.js';

// Fixed analysis sample rate. 22.05kHz retains the 40Hz–8kHz spectral bands
// used for onset work and halves the sample count vs 44.1kHz. Mono — beat
// structure is shared across channels.
export const ANALYSIS_SAMPLE_RATE = 22050;

// Cap how much of a track ffmpeg decodes (issue #8973). decodeAudioToPcm
// buffers the whole decoded f32 PCM stream in memory before this module runs
// tempo/section analysis on it — unbounded, a 20+ minute track can push a
// single decode into the hundreds of MB, doubling briefly at the
// Buffer.concat below. Tempo/section analysis doesn't need the full track:
// TEMPO_WINDOW_SEC-scale windows already assume a fraction of it is enough,
// and five minutes gives the section segmentation (MAX_SECTIONS sections,
// MIN_SECTION_SEC apart) far more material than it uses. Passing `-t` lets
// ffmpeg truncate the decode itself instead of PortOS buffering (and then
// discarding) the rest of the stream.
export const MAX_ANALYSIS_SEC = 300;

// Hard wall-clock cap on one ffmpeg decode. Without it a wedged ffmpeg (bad
// container, pipe backpressure) never settles and pins callers forever.
export const AUDIO_DECODE_TIMEOUT_MS = 60_000;

// Frame hop for the onset envelope. 512 samples @ 22.05kHz → ~43 frames/sec,
// which gives ~1 BPM tempo resolution across the musical range and ~23ms beat
// placement granularity — both well within what beat-snapping needs.
export const ONSET_HOP = 512;

// Tempo search window. Most music sits here; clamping the search keeps the
// autocorrelation from latching onto sub-bass rumble (very low BPM) or
// per-note flutter (very high BPM). Half/double-time octave errors inside this
// range are handled by the tempo-preference weighting below.
const MIN_BPM = 70;
const MAX_BPM = 180;
// Log-normal tempo preference centered here disambiguates octave errors (60 vs
// 120 vs 240) — the classic Davies/Plumbley bias toward a "natural" tempo.
const PREFERRED_BPM = 120;
const TEMPO_PREF_SIGMA = 0.9; // in octaves

// Minimum normalized autocorrelation peak (`ac[lag] / ac[0]`) to accept a
// tempo. Below this the "peak" is just the strongest lag of essentially
// structureless audio (white noise, near-silence) — reporting a confident BPM
// there is worse than reporting none. Clean periodic input sits well above it
// (click tracks measure 0.4–0.9); white noise measures ~0.23.
const TEMPO_PEAK_MIN = 0.3;
// A song-wide autocorrelation can be diluted by a long rubato/ambient intro
// even when the body of the song has a stable pulse. Scan overlapping musical
// windows as a fallback and require two agreeing windows before accepting their
// tempo, so one coincidental noise peak cannot invent a beat grid.
const TEMPO_WINDOW_SEC = 30;
const TEMPO_WINDOW_STEP_SEC = 15;
const TEMPO_WINDOW_AGREEMENT = 0.04;
export const FFT_SIZE = 1024;

// Hann window cached per length. Windowing each analysis frame before measuring
// energy suppresses the spectral-leakage ripple a steady tone otherwise beats
// against the frame grid — without it, a sustained pure tone produces a periodic
// onset envelope and a confident-but-bogus tempo. Broadband transients (the
// actual beats) survive windowing, so click/percussion detection is unaffected.
const hannCache = new Map();
export const hannWindow = (len) => {
  let w = hannCache.get(len);
  if (w) return w;
  w = new Float32Array(len);
  for (let i = 0; i < len; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)));
  hannCache.set(len, w);
  return w;
};

const fftPlanCache = new Map();
export const fftPlan = (size) => {
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
};

export function fftInPlace(real, imaginary, plan) {
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
 * Decode an audio file to a mono Float32Array at ANALYSIS_SAMPLE_RATE via
 * ffmpeg. Returns `{ samples, sampleRate }` on success, or `null` when ffmpeg
 * is unavailable or the decode fails — callers treat `null` as "couldn't
 * analyze" rather than throwing (this runs outside the request lifecycle when
 * driven by the render queue).
 *
 * Decodes at most MAX_ANALYSIS_SEC seconds of the source (see its doc
 * comment) — a track longer than the cap gets tempo/section data from that
 * leading window only.
 *
 * @param {string} audioPath absolute path to the source audio
 * @param {{ signal?: AbortSignal, maxDurationSec?: number }} [opts]
 *   `maxDurationSec` overrides MAX_ANALYSIS_SEC — a test-only seam so the
 *   truncation path can be exercised against a short fixture rather than a
 *   real multi-minute file; real callers should not pass it. Clamped to
 *   MAX_ANALYSIS_SEC — it can only shrink the decode window, never grow it,
 *   so it can't be used to defeat the memory bound. `timeoutMs` overrides
 *   AUDIO_DECODE_TIMEOUT_MS (test seam); on expiry ffmpeg is killed and the
 *   result is `null`.
 * @returns {Promise<{ samples: Float32Array, sampleRate: number } | null>}
 */
export async function decodeAudioToPcm(audioPath, { signal, maxDurationSec = MAX_ANALYSIS_SEC, timeoutMs = AUDIO_DECODE_TIMEOUT_MS } = {}) {
  if (typeof audioPath !== 'string' || !audioPath) return null;
  // A listener added to an already-aborted signal never fires, so without this
  // guard a pre-cancelled request (plausible off the request lifecycle, under a
  // render queue) would still spawn ffmpeg and decode the whole track.
  if (signal?.aborted) return null;
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return null;
  // Re-check: the signal may have aborted while findFfmpeg() was awaiting, so
  // the listener below would again attach to an already-aborted signal.
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
      '-ar', String(ANALYSIS_SAMPLE_RATE),
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
    const watchdog = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    const cleanup = () => {
      clearTimeout(watchdog);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };

    proc.stdout.on('data', (c) => chunks.push(c));
    proc.on('error', () => { cleanup(); resolve(null); });
    proc.on('close', (code, sig) => {
      cleanup();
      if (sig || code !== 0 || chunks.length === 0) { resolve(null); return; }
      const buf = Buffer.concat(chunks);
      // Float32Array view over the decoded bytes. Guard the byte length down to
      // a multiple of 4 so a truncated final chunk can't throw on construction.
      const floats = Math.floor(buf.length / 4);
      if (floats === 0) { resolve(null); return; }
      // A view is O(1) (no per-sample copy), but Float32Array requires the byte
      // offset to be 4-aligned. Buffer.concat returns an unpooled buffer
      // (offset 0) for the multi-KB PCM we get here, so the view path is the
      // normal case; fall back to a copied slice if a pooled buffer ever lands
      // on a non-aligned offset.
      const samples = buf.byteOffset % 4 === 0
        ? new Float32Array(buf.buffer, buf.byteOffset, floats)
        : new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + floats * 4));
      resolve({ samples, sampleRate: ANALYSIS_SAMPLE_RATE });
    });
  });
}

/**
 * Compute a per-frame onset-strength envelope from spectral flux. Unlike a
 * single loudness difference, positive changes across FFT bands capture guitar
 * strums and harmonic attacks even when the song's overall volume is steady.
 * A local adaptive floor suppresses broadband noise and room tone. Raw RMS
 * energy is returned alongside it for section segmentation and the waveform.
 */
export function onsetEnvelope(samples, sampleRate, hop = ONSET_HOP) {
  const fftSize = FFT_SIZE;
  const frameCount = Math.max(0, Math.floor((samples.length - fftSize) / hop) + 1);
  const energy = new Float32Array(frameCount);
  const rawFlux = new Float32Array(frameCount);
  const win = hannWindow(fftSize);
  const plan = fftPlan(fftSize);
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  const previous = new Float64Array(fftSize / 2);
  const minBin = Math.max(1, Math.floor((40 * fftSize) / sampleRate));
  const maxBin = Math.min(fftSize / 2 - 1, Math.ceil((8000 * fftSize) / sampleRate));
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    const base = f * hop;
    for (let i = 0; i < fftSize; i++) {
      const sample = samples[base + i];
      sum += sample * sample;
      real[i] = sample * win[i];
      imaginary[i] = 0;
    }
    energy[f] = Math.sqrt(sum / fftSize);
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

  // Subtract a rolling ~0.75s local mean. A real note/percussion attack rises
  // above its neighborhood; stationary noise fluctuates around the floor.
  const onset = new Float32Array(frameCount);
  const radius = Math.max(1, Math.round((0.75 * sampleRate) / hop / 2));
  let rolling = 0;
  let left = 0;
  let right = 0;
  for (let f = 0; f < frameCount; f++) {
    while (right < frameCount && right <= f + radius) { rolling += rawFlux[right]; right += 1; }
    while (left < f - radius) { rolling -= rawFlux[left]; left += 1; }
    const localMean = rolling / Math.max(1, right - left);
    onset[f] = Math.max(0, rawFlux[f] - localMean);
  }
  return { onset, energy, fps: sampleRate / hop, frameCount };
}

// Fractional-lag step (frames) for the tempo autocorrelation scan. Scanning the
// period continuously instead of at integer lags is what makes the estimate
// robust: a true beat period of, say, 18.46 frames lands between integer lags,
// so integer-lag autocorrelation smears its peak across lags 18 and 19 (each
// weakened) while the sharper half-tempo lag wins — the classic half-tempo
// octave error. Interpolating at 0.25-frame resolution recovers the full
// fundamental peak, so both the significance gate and the octave fold judge it
// fairly.
const TEMPO_LAG_STEP = 0.25;

/**
 * Estimate tempo (BPM) and the beat period (in fractional frames) by
 * tempo-weighted, sub-frame autocorrelation of the onset envelope. The envelope
 * is zero-meaned first so the silence floor between hits doesn't bias the
 * correlation toward a DC peak. Returns `{ bpm: null, lag: null }` when the
 * envelope carries no usable periodicity (silence, or structureless input whose
 * strongest peak is below the significance floor).
 */
function estimateTempoCandidate(onset, fps) {
  const n = onset.length;
  if (n < 4) return null;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += onset[i];
  mean /= n;
  const o = new Float32Array(n);
  let variance = 0;
  for (let i = 0; i < n; i++) { o[i] = onset[i] - mean; variance += o[i] * o[i]; }
  if (variance <= 1e-9) return null;

  // Autocorrelation at a fractional lag via linear interpolation of the shifted
  // envelope. `variance` is the zero-lag value (ac(0) = sum of squares).
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
  if (bestLag < 0 || bestScore <= 0) return null;

  // NOTE — octave (half/double-tempo) ambiguity is intentionally NOT resolved
  // here. Autocorrelation peaks at every multiple of the true period, so the
  // estimate is only reliable UP TO an octave: a 140 BPM track may report 70,
  // and a phase-aligned-comb tie-break (tried) cannot separate the two for many
  // signals (a half-period grid captures comparable onset energy), while the
  // tempo-preference weight alone mis-picks other octaves. Robust octave
  // selection is a deliberate open question for a later phase (see #1760
  // "beat-snap semantics") — beat snapping still works off this grid, just at a
  // possibly-doubled/halved density. The detected period is the
  // highest-weighted autocorrelation peak in [MIN_BPM, MAX_BPM].
  const bpm = (60 * fps) / bestLag;
  return { bpm, lag: bestLag, confidence: bestAc / variance };
}

const temposAgree = (a, b) => {
  const octaveDistance = Math.abs(Math.log2(a / b));
  return Math.abs(octaveDistance - Math.round(octaveDistance)) <= Math.log2(1 + TEMPO_WINDOW_AGREEMENT);
};

const foldTempoNear = (bpm, anchor) => {
  let folded = bpm;
  while (folded * 2 <= MAX_BPM && Math.abs(Math.log2((folded * 2) / anchor)) < Math.abs(Math.log2(folded / anchor))) folded *= 2;
  while (folded / 2 >= MIN_BPM && Math.abs(Math.log2((folded / 2) / anchor)) < Math.abs(Math.log2(folded / anchor))) folded /= 2;
  return folded;
};

export function estimateTempo(onset, fps) {
  const full = estimateTempoCandidate(onset, fps);
  if (full && full.confidence >= TEMPO_PEAK_MIN) {
    return {
      ...full,
      source: 'full',
      window: { startSec: 0, endSec: onset.length / fps },
    };
  }

  const windowFrames = Math.round(TEMPO_WINDOW_SEC * fps);
  const stepFrames = Math.round(TEMPO_WINDOW_STEP_SEC * fps);
  if (onset.length < windowFrames) return { bpm: null, lag: null, confidence: full?.confidence ?? null, source: null, window: null };

  const candidates = [];
  for (let start = 0; start + windowFrames <= onset.length; start += stepFrames) {
    const candidate = estimateTempoCandidate(onset.slice(start, start + windowFrames), fps);
    if (candidate?.confidence >= TEMPO_PEAK_MIN) {
      candidates.push({
        ...candidate,
        startSec: start / fps,
        endSec: (start + windowFrames) / fps,
      });
    }
  }

  const clusters = candidates.map((anchor) => candidates.filter((candidate) => temposAgree(anchor.bpm, candidate.bpm)));
  const cluster = clusters
    .filter((group) => group.length >= 2)
    .sort((a, b) => (
      b.reduce((sum, candidate) => sum + candidate.confidence, 0)
      - a.reduce((sum, candidate) => sum + candidate.confidence, 0)
    ))[0];
  if (!cluster) return { bpm: null, lag: null, confidence: full?.confidence ?? null, source: null, window: null };

  const strongest = cluster.slice().sort((a, b) => b.confidence - a.confidence)[0];
  const weight = cluster.reduce((sum, candidate) => sum + candidate.confidence, 0);
  const bpm = cluster.reduce(
    (sum, candidate) => sum + foldTempoNear(candidate.bpm, strongest.bpm) * candidate.confidence,
    0,
  ) / weight;
  return {
    bpm,
    lag: (60 * fps) / bpm,
    confidence: strongest.confidence,
    source: 'windowed',
    window: { startSec: strongest.startSec, endSec: strongest.endSec },
  };
}

/**
 * Fit the beat phase: slide a pulse train of the given period across the onset
 * envelope and pick the offset whose pulses sum the most onset strength.
 * Returns the beat times (seconds) for the whole track.
 */
export function fitBeats(onset, fps, bpm, durationSec) {
  const periodFrames = (60 * fps) / bpm;
  let bestOffset = 0;
  let bestSum = -Infinity;
  const maxOffset = Math.ceil(periodFrames);
  for (let off = 0; off < maxOffset; off++) {
    let sum = 0;
    for (let pos = off; pos < onset.length; pos += periodFrames) {
      sum += onset[Math.round(pos)] || 0;
    }
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
 * one whose beats carry the most onset strength (downbeats are typically the
 * loudest). Returns the subset of `beats` on that phase.
 */
export function pickDownbeats(beats, onset, fps) {
  if (beats.length === 0) return [];
  const beatsPerBar = 4;
  let bestPhase = 0;
  let bestSum = -Infinity;
  for (let phase = 0; phase < beatsPerBar; phase++) {
    let sum = 0;
    for (let i = phase; i < beats.length; i += beatsPerBar) {
      sum += onset[Math.round(beats[i] * fps)] || 0;
    }
    if (sum > bestSum) { bestSum = sum; bestPhase = phase; }
  }
  const downbeats = [];
  for (let i = bestPhase; i < beats.length; i += beatsPerBar) downbeats.push(beats[i]);
  return downbeats;
}


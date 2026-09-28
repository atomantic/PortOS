/**
 * Music Video — offline audio analysis (issue #1760, Phase 0 spike).
 *
 * Extracts a usable BPM + beat grid + downbeats + coarse section map from an
 * audio file, fully offline, using ONLY ffmpeg (already a hard dependency) plus
 * a pure-JS DSP core. No Python, no ML model download, no network — so it runs
 * in CI and on every install the same way the rest of the media stack does.
 *
 * This is the de-risking spike for the Music Video production mode: it proves
 * the ffmpeg-only DSP path is viable before any project model / scene board /
 * beat-snapped render is built on top of it. The returned shape is the
 * `audioAnalysis` field of the future `musicVideoProject` record.
 *
 * Pipeline:
 *   1. ffmpeg decodes the track to mono f32 PCM at a fixed analysis rate.
 *   2. A spectral-flux onset envelope captures percussion and harmonic attacks.
 *   3. Tempo is estimated by tempo-weighted autocorrelation of the envelope.
 *   4. The beat phase is fit by sliding a pulse train against the envelope.
 *   5. Downbeats are picked as the strongest of the four 4/4 beat phases.
 *   6. Coarse sections come from energy-novelty segmentation.
 *
 * The DSP core (`analyzePcm`) is pure and deterministic — it takes a
 * Float32Array and returns the analysis, so it is unit-tested directly against
 * a synthetic click track without spawning ffmpeg. `analyzeAudioFile` is the
 * thin ffmpeg-decode wrapper around it.
 */

import { spawn } from '../../lib/childProcess.js';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';

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

// Section segmentation: windows for the coarse energy profile, the minimum
// musical span we will call a "section", and a cap so a noisy track doesn't
// shatter into dozens of micro-sections.
const SECTION_WINDOW_SEC = 0.5;
const MIN_SECTION_SEC = 8;
const MAX_SECTIONS = 8;

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
const WAVEFORM_POINTS = 512;
const FFT_SIZE = 1024;

// Hann window cached per length. Windowing each analysis frame before measuring
// energy suppresses the spectral-leakage ripple a steady tone otherwise beats
// against the frame grid — without it, a sustained pure tone produces a periodic
// onset envelope and a confident-but-bogus tempo. Broadband transients (the
// actual beats) survive windowing, so click/percussion detection is unaffected.
const hannCache = new Map();
const hannWindow = (len) => {
  let w = hannCache.get(len);
  if (w) return w;
  w = new Float32Array(len);
  for (let i = 0; i < len; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)));
  hannCache.set(len, w);
  return w;
};

const fftPlanCache = new Map();
const fftPlan = (size) => {
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
 *   so it can't be used to defeat the memory bound.
 * @returns {Promise<{ samples: Float32Array, sampleRate: number } | null>}
 */
export async function decodeAudioToPcm(audioPath, { signal, maxDurationSec = MAX_ANALYSIS_SEC } = {}) {
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
    const cleanup = () => { if (signal && onAbort) signal.removeEventListener('abort', onAbort); };

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
function onsetEnvelope(samples, sampleRate, hop = ONSET_HOP) {
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

function estimateTempo(onset, fps) {
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
function fitBeats(onset, fps, bpm, durationSec) {
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
function pickDownbeats(beats, onset, fps) {
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

/**
 * Coarse section map from energy novelty. Builds a windowed energy profile,
 * finds the largest jumps (novelty peaks) as candidate boundaries, enforces a
 * minimum section length and a section cap, then emits contiguous, generically
 * labeled sections spanning the whole track. Intentionally coarse — a spike
 * sanity guide for the autonomous planner, not a trained structure detector.
 */
function segmentSections(energy, fps, durationSec) {
  if (durationSec <= 0) return [];
  // A lone section carries the full (normalized) energy by definition.
  const single = [{ label: 'Section 1', startSec: 0, endSec: Number(durationSec.toFixed(3)), energy: 1 }];
  if (durationSec < MIN_SECTION_SEC * 2) return single;

  const winFrames = Math.max(1, Math.round(SECTION_WINDOW_SEC * fps));
  const winCount = Math.floor(energy.length / winFrames);
  if (winCount < 4) return single;
  const profile = new Float32Array(winCount);
  for (let w = 0; w < winCount; w++) {
    let sum = 0;
    for (let i = 0; i < winFrames; i++) sum += energy[w * winFrames + i] || 0;
    profile[w] = sum / winFrames;
  }
  // Novelty = |smoothed change| in the energy profile.
  const novelty = new Float32Array(winCount);
  for (let w = 1; w < winCount; w++) novelty[w] = Math.abs(profile[w] - profile[w - 1]);

  // A boundary must reflect a real energy change, not just be the highest of an
  // essentially-flat profile. Without this floor, silence / sustained drones /
  // an even click track (all near-zero novelty) still get carved into the
  // maximum evenly-spaced sections purely as a spacing artifact. Require the
  // jump to clear a small fraction of the track's mean window energy; flat
  // input then has no qualifying boundary and falls through to one section.
  let meanProfile = 0;
  for (let w = 0; w < winCount; w++) meanProfile += profile[w];
  meanProfile /= winCount;
  const noveltyFloor = Math.max(1e-9, meanProfile * 0.05);

  const minWin = Math.max(1, Math.round(MIN_SECTION_SEC / SECTION_WINDOW_SEC));
  // Rank candidate boundaries by novelty, greedily accept those that clear the
  // floor and respect the minimum-section spacing, up to MAX_SECTIONS - 1
  // internal boundaries.
  const ranked = Array.from({ length: winCount }, (_, w) => w)
    .filter((w) => w >= minWin && w <= winCount - minWin && novelty[w] >= noveltyFloor)
    .sort((a, b) => novelty[b] - novelty[a]);
  const boundaries = [];
  for (const w of ranked) {
    if (boundaries.length >= MAX_SECTIONS - 1) break;
    if (boundaries.every((b) => Math.abs(b - w) >= minWin)) boundaries.push(w);
  }
  boundaries.sort((a, b) => a - b);

  const cutTimes = boundaries.map((w) => (w * winFrames) / fps);
  const edges = [0, ...cutTimes, durationSec];

  // Per-section loudness: the mean windowed energy over each section's span,
  // normalized to the loudest section (0..1). This drives the energy-weighted
  // auto-arranger (#1915) — louder sections earn more, shorter scene cuts. It is
  // an ADDITIVE field on the section shape; older cached analyses simply omit it
  // and the arranger falls back to an even spread.
  const winSec = winFrames / fps;
  const sectionMeans = [];
  for (let i = 0; i < edges.length - 1; i++) {
    let sum = 0;
    let n = 0;
    for (let w = 0; w < winCount; w++) {
      const tw = w * winSec; // window start time
      if (tw >= edges[i] && tw < edges[i + 1]) { sum += profile[w]; n += 1; }
    }
    sectionMeans.push(n > 0 ? sum / n : 0);
  }
  const maxMean = Math.max(0, ...sectionMeans);

  const sections = [];
  for (let i = 0; i < edges.length - 1; i++) {
    sections.push({
      label: `Section ${i + 1}`,
      startSec: Number(edges[i].toFixed(3)),
      endSec: Number(edges[i + 1].toFixed(3)),
      energy: maxMean > 0 ? Number((sectionMeans[i] / maxMean).toFixed(3)) : 1,
    });
  }
  return sections;
}

// Persist a small normalized loudness envelope so the timeline can show the
// musical evidence behind its sections and beats without shipping raw PCM.
// Mean RMS energy per bin keeps song-shape dynamics visible; normalization to
// the 95th percentile prevents one transient from flattening the whole display.
function summarizeWaveform(energy, targetPoints = WAVEFORM_POINTS) {
  if (!energy?.length) return [];
  const count = Math.min(targetPoints, energy.length);
  const bins = new Array(count);
  for (let bin = 0; bin < count; bin++) {
    const start = Math.floor((bin * energy.length) / count);
    const end = Math.max(start + 1, Math.floor(((bin + 1) * energy.length) / count));
    let sum = 0;
    for (let i = start; i < end; i++) sum += energy[i] || 0;
    bins[bin] = sum / (end - start);
  }
  const ranked = bins.slice().sort((a, b) => a - b);
  const reference = ranked[Math.min(ranked.length - 1, Math.floor(ranked.length * 0.95))] || 0;
  if (reference <= 1e-9) return bins.map(() => 0);
  return bins.map((value) => Number(Math.min(1, value / reference).toFixed(3)));
}

// The too-short guard + onset-envelope + section-segmentation pass is shared
// by the auto-detector (analyzePcm) and the manual-tempo builder below — both
// need the same section map, differing only in how bpm/beats are derived from
// it. Returns `onset: null` for the too-short case so callers that need onset
// (only analyzePcm does) can branch on it without re-checking sample length.
function deriveSections(samples, sampleRate, hop) {
  const durationSec = samples?.length ? samples.length / sampleRate : 0;
  if (!samples || samples.length < hop * 4) {
    return {
      sections: segmentSections(new Float32Array(0), 1, durationSec),
      waveform: [],
      onset: null,
      fps: null,
    };
  }
  const { onset, energy, fps } = onsetEnvelope(samples, sampleRate, hop);
  const sections = segmentSections(energy, fps, durationSec);
  return { sections, waveform: summarizeWaveform(energy), onset, fps };
}

// --- Song feature track (#9073) ----------------------------------------------
//
// Per-band loudness envelopes plus per-band onset times, so a code-rendered
// scene can swell with the bass or flash on a snare-ish hit at any time `t`
// without analysing audio live (live analysis is neither deterministic nor
// available in an offline render). Computed once from the same decoded PCM.
//
// Bands are fixed FFT-bin splits, not stem separation: "low" is kick/bass-ish,
// "mid" is snare/body-ish and "high" is hat/air-ish.

// Persisted audioAnalysis shape version. A cached analysis without `version`
// predates the feature track (implicitly 1) and reads as "features not analyzed".
export const ANALYSIS_VERSION = 2;

export const FEATURE_ENVELOPE_FPS = 30;
export const FEATURE_BANDS = Object.freeze({
  low: [40, 250],
  mid: [250, 2000],
  high: [2000, 10000],
});
const FEATURE_ONSET_HOP = 256; // ~11.6ms: finer than the 30fps envelope so onset times stay tight
const FEATURE_CEILING_PERCENTILE = 0.95;
const ONSET_SMOOTH_SEC = 0.5; // rolling-mean floor subtracted from band flux
const ONSET_PEAK_RADIUS_SEC = 0.04; // a pick must be the local maximum within this span
const ONSET_MIN_GAP_SEC = 0.08;
const ONSET_STD_FACTOR = 1.5;
const ONSET_MAX_RELATIVE_FLOOR = 0.2; // ignore picks under this fraction of the band's strongest flux
const ONSET_ABS_FLOOR = 0.02; // mean log-magnitude rise per bin; below this is numerical noise

const bandBins = (sampleRate) => Object.entries(FEATURE_BANDS).map(([name, [loHz, hiHz]]) => ({
  name,
  lo: Math.max(1, Math.ceil((loHz * FFT_SIZE) / sampleRate)),
  hi: Math.min(FFT_SIZE / 2 - 1, Math.floor((hiHz * FFT_SIZE) / sampleRate)),
}));

/**
 * Windowed STFT reduced to per-band values. Frames are centred on `f * hop`
 * (out-of-range samples read as silence) so frame f describes time f*hop/rate.
 * Returns per frame: `rms` (time-domain), per-band amplitude, and per-band
 * spectral flux (mean positive rise of log-magnitude across the band's bins).
 */
function bandFrames(samples, sampleRate, hop) {
  const frameCount = Math.floor(samples.length / hop) + 1;
  const bands = bandBins(sampleRate);
  const rms = new Float32Array(frameCount);
  const amp = Object.fromEntries(bands.map(({ name }) => [name, new Float32Array(frameCount)]));
  const flux = Object.fromEntries(bands.map(({ name }) => [name, new Float32Array(frameCount)]));
  const win = hannWindow(FFT_SIZE);
  const plan = fftPlan(FFT_SIZE);
  const real = new Float64Array(FFT_SIZE);
  const imaginary = new Float64Array(FFT_SIZE);
  const previous = new Float64Array(FFT_SIZE / 2);
  const half = FFT_SIZE / 2;
  for (let f = 0; f < frameCount; f++) {
    const base = f * hop - half;
    let sum = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = base + i;
      const sample = idx >= 0 && idx < samples.length ? samples[idx] : 0;
      sum += sample * sample;
      real[i] = sample * win[i];
      imaginary[i] = 0;
    }
    rms[f] = Math.sqrt(sum / FFT_SIZE);
    fftInPlace(real, imaginary, plan);
    for (const { name, lo, hi } of bands) {
      let power = 0;
      let rise = 0;
      for (let bin = lo; bin <= hi; bin++) {
        const magnitude = Math.sqrt(real[bin] * real[bin] + imaginary[bin] * imaginary[bin]);
        power += magnitude * magnitude;
        const logMag = Math.log1p(magnitude);
        const delta = logMag - previous[bin];
        if (delta > 0) rise += delta;
        previous[bin] = logMag;
      }
      const count = hi - lo + 1;
      amp[name][f] = Math.sqrt(power / count) / FFT_SIZE;
      flux[name][f] = rise / count;
    }
  }
  return { rms, amp, flux };
}

// Scale to 0..1 against a percentile ceiling (one loud peak must not flatten
// everything else). A silent series stays all zeros.
function normalizeToPercentile(values) {
  const ranked = Float32Array.from(values).sort();
  const ceiling = ranked.length ? ranked[Math.min(ranked.length - 1, Math.floor(ranked.length * FEATURE_CEILING_PERCENTILE))] : 0;
  return Array.from(values, (v) => (ceiling <= 1e-9 ? 0 : Number(Math.min(1, v / ceiling).toFixed(3))));
}

// Peak-pick one band's flux into onset times (seconds).
function pickBandOnsets(fluxSeries, hopSec) {
  const n = fluxSeries.length;
  if (n < 3) return [];
  // Subtract a rolling mean so sustained/noisy passages don't read as attacks.
  const radius = Math.max(1, Math.round(ONSET_SMOOTH_SEC / hopSec / 2));
  const onset = new Float32Array(n);
  let rolling = 0;
  let left = 0;
  let right = 0;
  for (let f = 0; f < n; f++) {
    while (right < n && right <= f + radius) { rolling += fluxSeries[right]; right += 1; }
    while (left < f - radius) { rolling -= fluxSeries[left]; left += 1; }
    onset[f] = Math.max(0, fluxSeries[f] - rolling / Math.max(1, right - left));
  }
  let mean = 0;
  let max = 0;
  for (let f = 0; f < n; f++) { mean += onset[f]; if (onset[f] > max) max = onset[f]; }
  mean /= n;
  let variance = 0;
  for (let f = 0; f < n; f++) variance += (onset[f] - mean) ** 2;
  const threshold = Math.max(ONSET_ABS_FLOOR, ONSET_MAX_RELATIVE_FLOOR * max, mean + ONSET_STD_FACTOR * Math.sqrt(variance / n));
  const peakRadius = Math.max(1, Math.round(ONSET_PEAK_RADIUS_SEC / hopSec));
  const minGap = Math.max(1, Math.round(ONSET_MIN_GAP_SEC / hopSec));
  const picks = [];
  for (let f = 0; f < n; f++) {
    const value = onset[f];
    if (value < threshold) continue;
    let isPeak = true;
    for (let k = Math.max(0, f - peakRadius); k <= Math.min(n - 1, f + peakRadius); k++) {
      // Strictly greater to the left, >= to the right: a plateau yields one pick.
      if (k < f ? onset[k] >= value : onset[k] > value) { isPeak = false; break; }
    }
    if (!isPeak) continue;
    const last = picks[picks.length - 1];
    if (last != null && f - last < minGap) {
      if (value > onset[last]) picks[picks.length - 1] = f;
      continue;
    }
    picks.push(f);
  }
  return picks.map((f) => Number((f * hopSec).toFixed(3)));
}

/**
 * Pure DSP: per-band loudness envelopes (~30fps grid, 0..1 per song with a
 * 95th-percentile ceiling) and per-band onset times. Returns `null` when the
 * audio is too short to analyse — never empty arrays, so "not analysed" and
 * "analysed, silent" cannot be confused. `envelopes.fps` is the exact frame
 * rate (sampleRate / integer hop); frame i is centred on i / fps seconds.
 *
 * @param {Float32Array} samples mono PCM
 * @param {number} sampleRate
 * @param {{ truncatedAtSec?: number|null }} [opts] set when the decode was cut short
 */
function computeSongFeatures(samples, sampleRate, { truncatedAtSec = null } = {}) {
  if (!samples || samples.length < FFT_SIZE) return null;
  const envHop = Math.round(sampleRate / FEATURE_ENVELOPE_FPS);
  const env = bandFrames(samples, sampleRate, envHop);
  const flux = bandFrames(samples, sampleRate, FEATURE_ONSET_HOP).flux;
  const onsetHopSec = FEATURE_ONSET_HOP / sampleRate;
  return {
    envelopes: {
      fps: Number((sampleRate / envHop).toFixed(4)),
      rms: normalizeToPercentile(env.rms),
      low: normalizeToPercentile(env.amp.low),
      mid: normalizeToPercentile(env.amp.mid),
      high: normalizeToPercentile(env.amp.high),
    },
    onsets: {
      low: pickBandOnsets(flux.low, onsetHopSec),
      mid: pickBandOnsets(flux.mid, onsetHopSec),
      high: pickBandOnsets(flux.high, onsetHopSec),
    },
    truncatedAtSec: truncatedAtSec == null ? null : Number(truncatedAtSec.toFixed(3)),
  };
}


/**
 * Pure DSP core: analyze a mono PCM buffer and return the `audioAnalysis`
 * shape. Deterministic and ffmpeg-free, so it is unit-tested directly.
 *
 * @param {Float32Array} samples mono PCM
 * @param {number} sampleRate
 * @param {{ hop?: number, truncatedAtSec?: number|null }} [opts]
 * @returns {{ version: number, features: object|null, bpm: number|null, beats: number[], downbeats: number[], waveform: number[],
 *   sections: Array<{label:string,startSec:number,endSec:number,energy:number}>,
 *   durationSec: number }}
 */
export function analyzePcm(samples, sampleRate, { hop = ONSET_HOP, truncatedAtSec = null } = {}) {
  const durationSec = samples?.length ? samples.length / sampleRate : 0;
  const roundedDuration = Number(durationSec.toFixed(3));
  const { sections, waveform, onset, fps } = deriveSections(samples, sampleRate, hop);
  if (!onset) {
    return {
      version: ANALYSIS_VERSION,
      features: null,
      bpm: null,
      beats: [],
      downbeats: [],
      waveform,
      sections,
      durationSec: roundedDuration,
      tempoSource: null,
      tempoConfidence: null,
      tempoWindow: null,
    };
  }

  const { bpm, source, confidence, window } = estimateTempo(onset, fps);
  const roundedBpm = bpm == null ? null : Number(bpm.toFixed(2));
  const beats = roundedBpm == null ? [] : fitBeats(onset, fps, bpm, durationSec);
  const downbeats = roundedBpm == null ? [] : pickDownbeats(beats, onset, fps);
  return {
    version: ANALYSIS_VERSION,
    features: computeSongFeatures(samples, sampleRate, { truncatedAtSec }),
    bpm: roundedBpm,
    beats,
    downbeats,
    waveform,
    sections,
    durationSec: roundedDuration,
    tempoSource: source,
    tempoConfidence: confidence == null ? null : Number(Math.max(0, Math.min(1, confidence)).toFixed(3)),
    tempoWindow: window
      ? { startSec: Number(window.startSec.toFixed(3)), endSec: Number(Math.min(durationSec, window.endSec).toFixed(3)) }
      : null,
  };
}

// The decode is capped at MAX_ANALYSIS_SEC. A buffer that filled the cap may
// have been cut off (a track of exactly that length is indistinguishable), so
// the feature track says how far it covers instead of pretending to be complete.
const truncatedAtSecFor = ({ samples, sampleRate }) => {
  const durationSec = samples.length / sampleRate;
  return durationSec >= MAX_ANALYSIS_SEC - 0.1 ? durationSec : null;
};

/**
 * Decode `audioPath` via ffmpeg and run the DSP analysis. Returns the
 * `audioAnalysis` shape, or `null` when the file can't be decoded (ffmpeg
 * missing, unsupported/corrupt input). Callers cache the result on the project.
 *
 * @param {string} audioPath absolute path to the source audio
 * @param {{ signal?: AbortSignal }} [opts]
 */
export async function analyzeAudioFile(audioPath, { signal } = {}) {
  const decoded = await decodeAudioToPcm(audioPath, { signal });
  if (!decoded) return null;
  return analyzePcm(decoded.samples, decoded.sampleRate, { truncatedAtSec: truncatedAtSecFor(decoded) });
}

// Manual-tempo fallback (see `estimateTempo`'s TEMPO_PEAK_MIN/MIN_BPM/MAX_BPM
// comments above for why bpm can come back null): lets a director supply a
// known BPM + first-downbeat offset by ear instead, producing the same shape
// the auto path does so every beat-grid consumer (BeatTimeline, auto-arrange,
// beatSnapClips) works off it identically.
function manualBeatTimes(bpm, offsetSec, durationSec) {
  const period = 60 / bpm;
  const beats = [];
  for (let t = offsetSec; t <= durationSec; t += period) beats.push(Number(t.toFixed(3)));
  return beats;
}

const manualDownbeats = (beats) => beats.filter((_, i) => i % 4 === 0);

/**
 * Build the manual-tempo `audioAnalysis` shape from an already-cached prior
 * analysis's `sections`/`durationSec` — pure arithmetic, no decode. The UI
 * only offers manual entry after a prior `/analyze` call has cached those
 * fields (even when it found no bpm, `analyzePcm` still returns them), so this
 * is the common path; it avoids re-decoding + re-segmenting audio the server
 * already has a section map for.
 *
 * @param {{ sections: Array, durationSec: number }} cached prior audioAnalysis
 * @param {{ bpm: number, offsetSec?: number }} tempo
 */
export function buildManualAnalysisFromCached({ sections, durationSec, waveform = [], features = null }, { bpm, offsetSec = 0 }) {
  const beats = manualBeatTimes(bpm, offsetSec, durationSec);
  return {
    // A prior analysis without a feature track stays "not analyzed" (null).
    version: ANALYSIS_VERSION,
    features,
    bpm: Number(bpm.toFixed(2)),
    beats,
    downbeats: manualDownbeats(beats),
    waveform,
    sections,
    durationSec,
    tempoSource: 'manual',
    tempoConfidence: null,
    tempoWindow: null,
  };
}

/**
 * Build the manual-tempo `audioAnalysis` shape from raw PCM (no cached prior
 * analysis to reuse) — `beats` are an even grid from `offsetSec` at the given
 * BPM; `downbeats` assume 4/4 starting on the first beat; sections still come
 * from real energy-novelty segmentation via the shared `deriveSections` pass.
 *
 * @param {Float32Array} samples mono PCM
 * @param {number} sampleRate
 * @param {{ bpm: number, offsetSec?: number, hop?: number }} opts
 */
export function buildManualAnalysis(samples, sampleRate, { bpm, offsetSec = 0, hop = ONSET_HOP, truncatedAtSec = null }) {
  const durationSec = samples?.length ? samples.length / sampleRate : 0;
  const roundedDuration = Number(durationSec.toFixed(3));
  const beats = manualBeatTimes(bpm, offsetSec, durationSec);
  const { sections, waveform } = deriveSections(samples, sampleRate, hop);
  return {
    version: ANALYSIS_VERSION,
    features: computeSongFeatures(samples, sampleRate, { truncatedAtSec }),
    bpm: Number(bpm.toFixed(2)),
    beats,
    downbeats: manualDownbeats(beats),
    waveform,
    sections,
    durationSec: roundedDuration,
    tempoSource: 'manual',
    tempoConfidence: null,
    tempoWindow: null,
  };
}

/**
 * Decode `audioPath` via ffmpeg and build the manual-tempo analysis. Returns
 * `null` under the same conditions as `analyzeAudioFile` (decode failure).
 * Callers that already have a cached prior analysis should prefer
 * `buildManualAnalysisFromCached` to skip the decode entirely.
 *
 * @param {string} audioPath absolute path to the source audio
 * @param {{ bpm: number, offsetSec?: number }} tempo
 * @param {{ signal?: AbortSignal }} [opts]
 */
export async function analyzeAudioFileManual(audioPath, { bpm, offsetSec = 0 }, { signal } = {}) {
  const decoded = await decodeAudioToPcm(audioPath, { signal });
  if (!decoded) return null;
  return buildManualAnalysis(decoded.samples, decoded.sampleRate, { bpm, offsetSec, truncatedAtSec: truncatedAtSecFor(decoded) });
}

// --- Section → beat-grid snapping (#4664) -----------------------------------
//
// `segmentSections` above cuts on energy-novelty WINDOW edges
// (`SECTION_WINDOW_SEC` multiples) — it never consults the beat grid the same
// analysis produces. The autonomous planner used to stamp `beatAligned: true`
// on those spans anyway, which `render.js#beatSnapClips` reads as "the director
// already snapped this, honor it exactly" — so the claim actively suppressed
// the live snap that would have fixed the cut. `snapSectionsToGrid` makes the
// flag earn itself: snap the section edges to the grid here, and report per
// section whether that section's own edges actually landed on it.

// Snap tolerance as a fraction of one beat period. Half a beat is the natural
// bound: no time can sit further than half a period from SOME beat, so a
// planned cut lands on the grid for essentially any edge (only one sitting
// exactly on the midpoint between two beats is ambiguous, and is left alone).
// Being tempo-relative is the point — ~0.43s at 70 BPM, ~0.17s at 180 BPM. A
// fixed constant (render.js uses 0.12s for its trim-only snap) would silently
// stop snapping at fast tempos and over-shoot at slow ones.
const SNAP_TOLERANCE_BEAT_FRACTION = 0.5;
// Used only when the grid is too sparse to measure a period (a single beat).
const SNAP_FALLBACK_TOLERANCE_SEC = 0.12;
// A snap is refused rather than squeezing a section below this. Real sections
// arrive at MIN_SECTION_SEC or longer and edges move by well under a beat, so
// this is a guard for hand-built/legacy analyses, not a normal path.
const MIN_SNAPPED_SECTION_SEC = 1;
// Two times closer than this are the same landmark — also the slack for calling
// an UNMOVED edge "already on the grid".
const GRID_EPS = 0.005;

const round3 = (t) => Number(t.toFixed(3));

/** Ascending, finite, non-negative times only. */
function sortedGrid(times) {
  return (Array.isArray(times) ? times : [])
    .filter((t) => typeof t === 'number' && Number.isFinite(t) && t >= 0)
    .sort((a, b) => a - b);
}

/** Median gap between consecutive grid times, or null when unmeasurable. */
function medianInterval(times) {
  if (times.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return median > 0 ? median : null;
}

/** Nearest grid time to `target`, or null when the nearest is beyond tolerance. */
function nearestWithin(grid, target, toleranceSec) {
  let best = null;
  let bestDist = Infinity;
  for (const t of grid) {
    const dist = Math.abs(t - target);
    if (dist < bestDist) { bestDist = dist; best = t; }
  }
  return best != null && bestDist <= toleranceSec ? best : null;
}

/**
 * Tempo-relative snap tolerance. Prefers the beat period; a downbeats-only
 * grid implies 4/4 bars, so its period is quartered back to a beat.
 */
function deriveTolerance(beatGrid, downbeatGrid) {
  const barPeriod = medianInterval(downbeatGrid);
  const beatPeriod = medianInterval(beatGrid) ?? (barPeriod == null ? null : barPeriod / 4);
  return beatPeriod == null
    ? SNAP_FALLBACK_TOLERANCE_SEC
    : beatPeriod * SNAP_TOLERANCE_BEAT_FRACTION;
}

/**
 * Pure: snap a contiguous section map's INTERNAL boundaries onto the analyzed
 * beat grid, and report which sections ended up genuinely aligned.
 *
 * Rules:
 * - Each internal boundary prefers the nearest **downbeat** within tolerance,
 *   falls back to the nearest **beat**, and stays put when neither qualifies.
 * - Boundaries are SHARED: moving section i's end moves section i+1's start, so
 *   the timeline stays contiguous and gap-free. A non-contiguous input (a gap
 *   between two sections — possible in a hand-built/legacy analysis) leaves that
 *   boundary alone rather than inventing a shared edge.
 * - The first start and the final end are ANCHORS and never move: they are the
 *   track's own edges, where no cut happens.
 * - A snap that would push either neighbouring section below `minSceneSec`, or
 *   that would reorder boundaries, is refused — the edge stays put.
 *
 * `beatAligned[i]` is true only when BOTH of section i's own edges sit on the
 * grid (snapped there, or already there) — anchors count, since there is no cut
 * to align. An edge that could not snap therefore reports false, handing that
 * span back to `beatSnapClips`'s live snapping instead of freezing a cut that
 * ignored the grid. A track with NO grid at all is the one exception, and is
 * explained inline below.
 *
 * @param {Array<{startSec:number,endSec:number}>} sections contiguous, ascending
 * @param {{ downbeats?: number[], beats?: number[], toleranceSec?: number, minSceneSec?: number }} [opts]
 * @returns {{ sections: Array<object>, beatAligned: boolean[] }}
 */
export function snapSectionsToGrid(sections, {
  downbeats = [], beats = [], toleranceSec = null, minSceneSec = MIN_SNAPPED_SECTION_SEC,
} = {}) {
  const out = (Array.isArray(sections) ? sections : []).map((s) => ({ ...s }));
  const beatGrid = sortedGrid(beats);
  const downbeatGrid = sortedGrid(downbeats);
  // No grid at all — `analyzePcm` found no usable tempo. Nothing to snap to,
  // and nothing being suppressed either: `beatSnapClips` has no beats to
  // live-snap against, so refusing the flag here would not hand the span back
  // for correction, it would simply DISCARD the planned timeline and render each
  // scene at its raw source-clip length (a 6s clip standing in for a 20s
  // section). The flag's render contract is "an authored span, do not re-derive
  // it", and with no grid there is nothing to re-derive from — so the planned
  // spans stay honored. The dishonesty this helper exists to fix is claiming
  // alignment while a grid EXISTS that the span never consulted.
  if (out.length === 0 || (beatGrid.length === 0 && downbeatGrid.length === 0)) {
    return { sections: out, beatAligned: out.map(() => true) };
  }

  const tolerance = typeof toleranceSec === 'number' && Number.isFinite(toleranceSec) && toleranceSec >= 0
    ? toleranceSec
    : deriveTolerance(beatGrid, downbeatGrid);
  const onGrid = (t) => nearestWithin(downbeatGrid, t, GRID_EPS) != null
    || nearestWithin(beatGrid, t, GRID_EPS) != null;

  // Candidate target for every internal boundary, computed up front so the
  // left-to-right application can bound each snap by where its RIGHT neighbour
  // could still move to (its candidate, or its original position — whichever is
  // further left). Without that bound, two snaps could converge and starve the
  // section between them.
  const original = out.map((s) => s.endSec);
  const shared = out.map((s, i) => i > 0 && Math.abs(s.startSec - out[i - 1].endSec) <= GRID_EPS);
  const candidates = out.map((_, i) => {
    if (i === 0 || !shared[i]) return null;
    const edge = out[i - 1].endSec;
    return nearestWithin(downbeatGrid, edge, tolerance) ?? nearestWithin(beatGrid, edge, tolerance);
  });

  const alignedStart = out.map(() => false);
  const alignedEnd = out.map(() => false);
  // Track anchors: the video starts when the song starts and ends when it ends.
  alignedStart[0] = true;
  alignedEnd[out.length - 1] = true;

  for (let i = 1; i < out.length; i++) {
    if (!shared[i]) {
      alignedEnd[i - 1] = onGrid(out[i - 1].endSec);
      alignedStart[i] = onGrid(out[i].startSec);
      continue;
    }
    const target = candidates[i];
    const prev = out[i - 1].startSec; // already finalized by an earlier pass
    const nextBound = i + 1 < out.length
      ? Math.min(original[i], candidates[i + 1] ?? original[i])
      : out[i].endSec; // final end is an anchor
    // A strictly-positive floor is what refuses a REORDERING snap as well as a
    // too-short one: a caller passing minSceneSec: 0 must still not be able to
    // collapse or invert a section.
    const floor = Math.max(GRID_EPS, minSceneSec);
    const accepted = target != null
      && target - prev >= floor
      && nextBound - target >= floor;
    if (accepted) {
      const snapped = round3(target);
      out[i - 1].endSec = snapped;
      out[i].startSec = snapped;
      alignedEnd[i - 1] = true;
      alignedStart[i] = true;
    } else {
      const aligned = onGrid(out[i - 1].endSec);
      alignedEnd[i - 1] = aligned;
      alignedStart[i] = aligned;
    }
  }

  return { sections: out, beatAligned: out.map((_, i) => alignedStart[i] && alignedEnd[i]) };
}

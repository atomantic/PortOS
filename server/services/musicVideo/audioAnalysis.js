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
 *   2. An onset-strength envelope (half-wave-rectified energy flux) is framed.
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

import { spawn } from 'child_process';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { safeChildProcessEnv } from '../../lib/processEnv.js';

// Fixed analysis sample rate. 22.05kHz is plenty for tempo/onset work (we care
// about energy flux, not high-frequency fidelity) and halves the sample count
// vs 44.1kHz. Mono — beat structure is shared across channels.
export const ANALYSIS_SAMPLE_RATE = 22050;

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

/**
 * Decode an audio file to a mono Float32Array at ANALYSIS_SAMPLE_RATE via
 * ffmpeg. Returns `{ samples, sampleRate }` on success, or `null` when ffmpeg
 * is unavailable or the decode fails — callers treat `null` as "couldn't
 * analyze" rather than throwing (this runs outside the request lifecycle when
 * driven by the render queue).
 *
 * @param {string} audioPath absolute path to the source audio
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ samples: Float32Array, sampleRate: number } | null>}
 */
export async function decodeAudioToPcm(audioPath, { signal } = {}) {
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

  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-i', audioPath,
      '-ac', '1',
      '-ar', String(ANALYSIS_SAMPLE_RATE),
      '-f', 'f32le',
      '-acodec', 'pcm_f32le',
      'pipe:1',
    ];
    const proc = spawn(ffmpeg, args, { env: safeChildProcessEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
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
 * Compute a per-frame onset-strength envelope: half-wave-rectified positive
 * change in short-time energy. Energy rises sharply at note/percussion onsets,
 * so its rectified first difference peaks on the beat. Returns the envelope
 * plus the raw per-frame energy (reused for section segmentation) and the
 * frame rate.
 */
function onsetEnvelope(samples, sampleRate, hop = ONSET_HOP) {
  const frameCount = Math.floor(samples.length / hop);
  const energy = new Float32Array(frameCount);
  const win = hannWindow(hop);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    const base = f * hop;
    for (let i = 0; i < hop; i++) { const s = samples[base + i] * win[i]; sum += s * s; }
    energy[f] = Math.sqrt(sum / hop);
  }
  const onset = new Float32Array(frameCount);
  for (let f = 1; f < frameCount; f++) {
    const d = energy[f] - energy[f - 1];
    onset[f] = d > 0 ? d : 0;
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
function estimateTempo(onset, fps) {
  const n = onset.length;
  if (n < 4) return { bpm: null, lag: null };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += onset[i];
  mean /= n;
  const o = new Float32Array(n);
  let variance = 0;
  for (let i = 0; i < n; i++) { o[i] = onset[i] - mean; variance += o[i] * o[i]; }
  if (variance <= 1e-9) return { bpm: null, lag: null };

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
  if (bestLag < 0 || bestScore <= 0) return { bpm: null, lag: null };

  // Significance gate. Structureless input (white noise) still has a strongest
  // lag, but it sits far below a real periodicity — emit `null` rather than a
  // confident bogus tempo + beat grid.
  if (bestAc / variance < TEMPO_PEAK_MIN) return { bpm: null, lag: null };

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
  return { bpm, lag: bestLag };
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

/**
 * Pure DSP core: analyze a mono PCM buffer and return the `audioAnalysis`
 * shape. Deterministic and ffmpeg-free, so it is unit-tested directly.
 *
 * @param {Float32Array} samples mono PCM
 * @param {number} sampleRate
 * @param {{ hop?: number }} [opts]
 * @returns {{ bpm: number|null, beats: number[], downbeats: number[],
 *   sections: Array<{label:string,startSec:number,endSec:number,energy:number}>,
 *   durationSec: number }}
 */
export function analyzePcm(samples, sampleRate, { hop = ONSET_HOP } = {}) {
  const durationSec = samples?.length ? samples.length / sampleRate : 0;
  const roundedDuration = Number(durationSec.toFixed(3));

  // Too short to analyze: still report a single section spanning the track.
  if (!samples || samples.length < hop * 4) {
    return { bpm: null, beats: [], downbeats: [], sections: segmentSections(new Float32Array(0), 1, durationSec), durationSec: roundedDuration };
  }

  const { onset, energy, fps } = onsetEnvelope(samples, sampleRate, hop);
  const { bpm } = estimateTempo(onset, fps);
  const sections = segmentSections(energy, fps, durationSec);
  const roundedBpm = bpm == null ? null : Number(bpm.toFixed(2));
  const beats = roundedBpm == null ? [] : fitBeats(onset, fps, bpm, durationSec);
  const downbeats = roundedBpm == null ? [] : pickDownbeats(beats, onset, fps);
  return { bpm: roundedBpm, beats, downbeats, sections, durationSec: roundedDuration };
}

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
  return analyzePcm(decoded.samples, decoded.sampleRate);
}

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

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return null;

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
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    const base = f * hop;
    for (let i = 0; i < hop; i++) { const s = samples[base + i]; sum += s * s; }
    energy[f] = Math.sqrt(sum / hop);
  }
  const onset = new Float32Array(frameCount);
  for (let f = 1; f < frameCount; f++) {
    const d = energy[f] - energy[f - 1];
    onset[f] = d > 0 ? d : 0;
  }
  return { onset, energy, fps: sampleRate / hop, frameCount };
}

/**
 * Estimate tempo (BPM) and the integer lag (in frames) by tempo-weighted
 * autocorrelation of the onset envelope. The envelope is zero-meaned first so
 * the silence floor between hits doesn't bias the correlation toward a DC peak.
 * Returns `{ bpm: null, lag: null }` when the envelope carries no usable
 * periodicity (e.g. silence).
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

  const minLag = Math.max(1, Math.floor((60 * fps) / MAX_BPM));
  const maxLag = Math.min(n - 1, Math.ceil((60 * fps) / MIN_BPM));
  // Single autocorrelation pass: compute each lag's correlation once into `ac`
  // (indexed by lag) so the parabolic step below is array lookups, not three
  // more O(n) recomputations.
  const acLag = (lag) => {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += o[i] * o[i + lag];
    return sum;
  };
  const ac = new Float64Array(maxLag + 1);
  let bestLag = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    ac[lag] = acLag(lag);
    const bpm = (60 * fps) / lag;
    const octaves = Math.log2(bpm / PREFERRED_BPM);
    const weight = Math.exp(-0.5 * (octaves / TEMPO_PREF_SIGMA) ** 2);
    const score = ac[lag] * weight;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  if (bestLag < 0 || bestScore <= 0) return { bpm: null, lag: null };

  // Parabolic interpolation around the integer-lag peak for sub-frame tempo
  // precision (raw integer lags quantize BPM coarsely at high tempo). Reuse the
  // stored autocorrelation; only the rare boundary neighbor needs a fresh pass.
  const acAt = (lag) => {
    if (lag < 1 || lag >= n) return 0;
    return lag >= minLag && lag <= maxLag ? ac[lag] : acLag(lag);
  };
  const ym = acAt(bestLag - 1);
  const y0 = ac[bestLag];
  const yp = acAt(bestLag + 1);
  const denom = ym - 2 * y0 + yp;
  let refinedLag = bestLag;
  if (denom !== 0) refinedLag = bestLag + clamp(0.5 * (ym - yp) / denom, -0.5, 0.5);

  const bpm = (60 * fps) / refinedLag;
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
  const single = [{ label: 'Section 1', startSec: 0, endSec: Number(durationSec.toFixed(3)) }];
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

  const minWin = Math.max(1, Math.round(MIN_SECTION_SEC / SECTION_WINDOW_SEC));
  // Rank candidate boundaries by novelty, greedily accept those that respect
  // the minimum-section spacing, up to MAX_SECTIONS - 1 internal boundaries.
  const ranked = Array.from({ length: winCount }, (_, w) => w)
    .filter((w) => w >= minWin && w <= winCount - minWin)
    .sort((a, b) => novelty[b] - novelty[a]);
  const boundaries = [];
  for (const w of ranked) {
    if (boundaries.length >= MAX_SECTIONS - 1) break;
    if (boundaries.every((b) => Math.abs(b - w) >= minWin)) boundaries.push(w);
  }
  boundaries.sort((a, b) => a - b);

  const cutTimes = boundaries.map((w) => (w * winFrames) / fps);
  const edges = [0, ...cutTimes, durationSec];
  const sections = [];
  for (let i = 0; i < edges.length - 1; i++) {
    sections.push({
      label: `Section ${i + 1}`,
      startSec: Number(edges[i].toFixed(3)),
      endSec: Number(edges[i + 1].toFixed(3)),
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
 *   sections: Array<{label:string,startSec:number,endSec:number}>,
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

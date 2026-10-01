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
 * The DSP core (decode, onset envelope, tempo, beat/downbeat fitting) is
 * shared with the Music Video analyzer via `./audioBeatDsp.js` (#9424); this
 * module adds the hit peak-picking and the per-file cache.
 */

import { stat } from 'node:fs/promises';
import {
  ANALYSIS_SAMPLE_RATE,
  ONSET_HOP,
  decodeAudioToPcm,
  onsetEnvelope,
  estimateTempo,
  fitBeats,
  pickDownbeats,
} from './audioBeatDsp.js';

// Kept for existing importers; the shared pipeline owns the value.
export const BEAT_GRID_SAMPLE_RATE = ANALYSIS_SAMPLE_RATE;
export { decodeAudioToPcm };

// Onset "hit" peak-picking: a local maximum must exceed the envelope's mean
// by this many standard deviations, and hits must be at least this far apart
// so a single broad transient isn't reported as several.
const HIT_THRESHOLD_SIGMA = 1.0;
const HIT_MIN_GAP_SEC = 0.08;

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

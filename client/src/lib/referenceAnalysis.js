// Reference-audio analysis (#2106) — pure helpers behind the Rounds
// "analyze a reference's attached audio" view. Three concerns, all
// side-effect-free and unit-tested (no Web Audio here — callers hand us the
// decoded Float32 samples):
//
//   1. extractPitchTrack — offline f0 extraction over decoded PCM: frame the
//      samples, run `detectFrequency` (the shared McLeod/NSDF core the live
//      tuner uses) per frame, and emit the same `[{ tMs, hz, clarity }]` track
//      shape `singToScore` consumes. Runs much faster than realtime because
//      it never waits on an analyser loop.
//   2. proposeSegmentScore — the solo-segment pipeline: extract a track from a
//      labeled time range, transcribe it through `transcribePitchTrack`
//      (segment → quantize to the round's tempo grid → key-aware spelling),
//      and wrap the body in a score header so it renders/plays standalone.
//   3. diffScoreBars — the review-side comparison: per-bar pitch-class
//      sequences of a proposed part vs the stored `scorePart`, so the UI can
//      highlight exactly which bars disagree before the user applies anything.
//
// Pure local DSP — zero LLM calls (the AI Provider Usage Policy applies to the
// feature this backs; nothing here touches a provider).

import { detectFrequency } from './pitchDetect.js';
import { transcribePitchTrack, DEFAULT_CLARITY_THRESHOLD } from './singToScore.js';
import { parseScore } from './scoreNotation.js';

// === Offline pitch extraction ==========================================

// Analysis window per frame. 2048 samples spans ≥2 periods of the lowest
// searched pitch at both common rates (16 kHz mic captures, 44.1/48 kHz file
// uploads), matching the live tuner's analyser fftSize.
export const DEFAULT_FRAME_SIZE = 2048;
// Hop between frames, in ms — ~25 ms (~40 tracks/sec) resolves note onsets
// well below singToScore's 70 ms minimum-note floor without paying for the
// O(frame·lag) NSDF on every sample.
export const DEFAULT_HOP_MS = 25;

/**
 * Extract a pitch track from decoded mono PCM — the offline counterpart of the
 * live `createPitchTracker`, producing the exact frame shape `singToScore`
 * consumes. Unclear/silent frames are kept (hz: null) so rests survive into
 * segmentation.
 *
 * @param {Float32Array|number[]} samples — mono PCM (one AudioBuffer channel).
 * @param {number} sampleRate — samples per second of `samples`.
 * @param {object} [opts]
 * @param {number} [opts.startMs=0] — analyze from this offset.
 * @param {number} [opts.endMs] — analyze up to this offset (default: the end).
 * @param {number} [opts.frameSize] — analysis window in samples.
 * @param {number} [opts.hopMs] — hop between frames in ms.
 * @param {number} [opts.minHz=70] / [opts.maxHz=1200] — vocal search band
 *   (the live tracker's defaults).
 * @returns {Array<{tMs:number, hz:number|null, clarity:number}>} — `tMs` is
 *   relative to `startMs`, so a segment's track starts at 0.
 */
export const extractPitchTrack = (samples, sampleRate, opts = {}) => {
  const {
    startMs = 0,
    endMs = null,
    frameSize = DEFAULT_FRAME_SIZE,
    hopMs = DEFAULT_HOP_MS,
    minHz = 70,
    maxHz = 1200,
  } = opts;
  const total = samples?.length || 0;
  if (!total || !Number.isFinite(sampleRate) || sampleRate <= 0) return [];

  const startSample = Math.max(0, Math.floor((startMs / 1000) * sampleRate));
  const endSample = endMs != null
    ? Math.min(total, Math.ceil((endMs / 1000) * sampleRate))
    : total;
  const hop = Math.max(1, Math.round((hopMs / 1000) * sampleRate));

  const track = [];
  for (let pos = startSample; pos + frameSize <= endSample; pos += hop) {
    const frame = samples.subarray
      ? samples.subarray(pos, pos + frameSize)
      : samples.slice(pos, pos + frameSize);
    const res = detectFrequency(frame, { sampleRate, minHz, maxHz });
    track.push({
      tMs: Math.round(((pos - startSample) / sampleRate) * 1000),
      hz: res ? res.hz : null,
      clarity: res ? res.clarity : 0,
    });
  }
  return track;
};

// === Score-text assembly ================================================

/**
 * Wrap a transcribed measure body in a lead-sheet header (key/tempo/time) so
 * the proposed part renders and plays standalone through ScoreSheet /
 * parseScore, matching the header shape the stored scoreParts carry. Returns
 * '' when there's no body (nothing was sung in the segment).
 */
export const buildScoreText = ({ key, tempo, beatsPerBar = 4, beatValue = 4, body } = {}) => {
  if (!body) return '';
  const lines = [];
  if (key) lines.push(`key: ${key}`);
  if (Number.isFinite(tempo) && tempo > 0) lines.push(`tempo: ${tempo}`);
  if (beatsPerBar !== 4 || beatValue !== 4) lines.push(`time: ${beatsPerBar}/${beatValue}`);
  lines.push('', body);
  return lines.join('\n').trimStart();
};

// Reference audio (a phone speaker re-recorded through a mic, or a screen
// recording's compressed track) is noisier than a direct vocal take, so the
// solo-segment pipeline defaults to a slightly laxer clarity gate than the
// live sing-to-score threshold — strict enough to reject hiss, loose enough
// that a clean sung note through a speaker still registers.
export const REFERENCE_CLARITY_THRESHOLD = 0.75;

/**
 * Solo-segment extraction (#2106 Stage 3): pitch-track a labeled time range of
 * decoded reference audio and transcribe it into a proposed lead-sheet score
 * on the round's tempo/key grid. Pure DSP — no LLM.
 *
 * @param {Float32Array} samples — mono PCM of the WHOLE reference audio.
 * @param {number} sampleRate
 * @param {object} opts
 * @param {number} opts.startMs / {number} opts.endMs — the segment bounds.
 * @param {number} [opts.bpm] — the round's tempo (quantization grid).
 * @param {string} [opts.key] — the round's key (enharmonic spelling + header).
 * @param {number} [opts.beatsPerBar=4] / [opts.beatValue=4]
 * @param {number} [opts.clarityThreshold] — override the reference gate.
 * @returns {{ track: Array, body: string, text: string }} — the raw pitch
 *   track (for debugging/inspection), the bare measure body, and the
 *   header-wrapped score text ready for ScoreSheet / scoreParts.
 */
export const proposeSegmentScore = (samples, sampleRate, opts = {}) => {
  const {
    startMs = 0, endMs = null, bpm, key,
    beatsPerBar = 4, beatValue = 4,
    clarityThreshold = REFERENCE_CLARITY_THRESHOLD,
  } = opts;
  const track = extractPitchTrack(samples, sampleRate, { startMs, endMs });
  const body = transcribePitchTrack(track, {
    bpm, key, beatsPerBar, beatValue,
    segmentOpts: { clarityThreshold: clarityThreshold ?? DEFAULT_CLARITY_THRESHOLD },
  });
  return { track, body, text: buildScoreText({ key, tempo: bpm, beatsPerBar, beatValue, body }) };
};

// === Stacked-mix extraction (spectral diff, #2121) ======================
//
// Layered TikTok builds often never expose a new voice ALONE — it enters over
// a mix that already carries the earlier layers. The solo pipeline above can't
// touch those. This section extracts the NEW voice from the stacked segment by
// spectral subtraction: average the magnitude spectrum of a "backing" window
// taken just BEFORE the voice enters (the layers already present), subtract
// that static profile from each frame of the "after" window, and run
// frequency-domain f0 estimation on the residual — which is dominated by the
// newly-added harmonic series. The resulting `[{ tMs, hz, clarity }]` track
// feeds the exact same `transcribePitchTrack` half `proposeSegmentScore` uses.
//
// Still pure local DSP — a hand-rolled radix-2 FFT (PortOS keeps its audio
// stack library-free, same rationale as `pitchDetect.js`'s NSDF core) and a
// weighted harmonic-sum pitch estimator. Zero LLM calls.

// Spectral analysis window. A power of two is required by the radix-2 FFT; 2048
// spans ≥2 periods of the lowest searched pitch at both common rates and gives
// ~7–21 Hz bins (16–48 kHz) — coarse alone, but the harmonic-sum estimator
// interpolates between bins over a fine candidate grid, so effective f0
// resolution is far finer than the bin spacing.
export const DEFAULT_FFT_SIZE = 2048;

// Spectral subtraction can only estimate the backing profile; residual hiss and
// reverb tails leave the extracted voice noisier than a clean solo take, so the
// stacked pipeline defaults to a laxer clarity gate than the solo threshold.
export const STACKED_CLARITY_THRESHOLD = 0.55;

// In-place iterative radix-2 Cooley–Tukey FFT over parallel real/imag arrays
// (length must be a power of two). Decimation-in-time with an initial
// bit-reversal permutation — the textbook form, kept tiny and dependency-free.
const fftInPlace = (re, im) => {
  const n = re.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  // Butterflies, doubling the transform length each stage.
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let start = 0; start < n; start += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len >> 1; k++) {
        const i0 = start + k;
        const i1 = i0 + (len >> 1);
        const tRe = re[i1] * curRe - im[i1] * curIm;
        const tIm = re[i1] * curIm + im[i1] * curRe;
        re[i1] = re[i0] - tRe;
        im[i1] = im[i0] - tIm;
        re[i0] += tRe;
        im[i0] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
};

/**
 * Hann-windowed magnitude spectrum of a real frame. Returns the first
 * `fftSize/2` magnitude bins (bin b ↔ b·sampleRate/fftSize Hz). The window
 * tapers frame edges so a note that doesn't align to the frame boundary
 * doesn't smear energy across the whole spectrum. Returns null if the frame is
 * too short for the requested (power-of-two) size.
 *
 * @param {Float32Array|number[]} frame — real PCM samples (length ≥ fftSize).
 * @param {object} [opts]
 * @param {number} [opts.fftSize] — power-of-two transform length.
 * @returns {Float32Array|null} — `fftSize/2` magnitudes, or null.
 */
export const magnitudeSpectrum = (frame, { fftSize = DEFAULT_FFT_SIZE } = {}) => {
  const size = frame?.length || 0;
  if (size < fftSize || fftSize < 2 || (fftSize & (fftSize - 1)) !== 0) return null;
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    // Hann window: 0.5·(1 − cos(2πi/(N−1))).
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
    re[i] = frame[i] * w;
  }
  fftInPlace(re, im);
  const half = fftSize >> 1;
  const mag = new Float32Array(half);
  for (let b = 0; b < half; b++) mag[b] = Math.hypot(re[b], im[b]);
  return mag;
};

/**
 * Average Hann-windowed magnitude spectrum across the frames of a time window —
 * the static "backing" profile for spectral subtraction. Slides `fftSize`-wide
 * frames by `hopMs` over [startMs, endMs) and means the per-frame magnitudes.
 *
 * @returns {Float32Array|null} — mean magnitude bins, or null when the window
 *   holds no full frame (too short to analyze — the caller degrades to no
 *   subtraction rather than crashing).
 */
export const averageMagnitudeSpectrum = (samples, sampleRate, opts = {}) => {
  const {
    startMs = 0, endMs = null,
    fftSize = DEFAULT_FFT_SIZE, hopMs = DEFAULT_HOP_MS,
  } = opts;
  const total = samples?.length || 0;
  if (!total || !Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  const startSample = Math.max(0, Math.floor((startMs / 1000) * sampleRate));
  const endSample = endMs != null
    ? Math.min(total, Math.ceil((endMs / 1000) * sampleRate))
    : total;
  const hop = Math.max(1, Math.round((hopMs / 1000) * sampleRate));

  const half = fftSize >> 1;
  const sum = new Float64Array(half);
  let frames = 0;
  for (let pos = startSample; pos + fftSize <= endSample; pos += hop) {
    const frame = samples.subarray
      ? samples.subarray(pos, pos + fftSize)
      : samples.slice(pos, pos + fftSize);
    const mag = magnitudeSpectrum(frame, { fftSize });
    if (!mag) continue;
    for (let b = 0; b < half; b++) sum[b] += mag[b];
    frames += 1;
  }
  if (!frames) return null;
  const avg = new Float32Array(half);
  for (let b = 0; b < half; b++) avg[b] = sum[b] / frames;
  return avg;
};

// Linear-interpolated magnitude at an arbitrary frequency (bins are discrete;
// a candidate f0 and its harmonics rarely land on a bin center). Out-of-range
// frequencies read as 0.
const interpMagAt = (mag, hz, sampleRate, fftSize) => {
  const bin = (hz * fftSize) / sampleRate;
  if (bin < 0 || bin >= mag.length - 1) return 0;
  const lo = Math.floor(bin);
  const frac = bin - lo;
  return mag[lo] * (1 - frac) + mag[lo + 1] * frac;
};

// Median of a Float32Array/number list (copy-sorted; small arrays here).
const medianOf = (values) => {
  if (!values.length) return 0;
  const sorted = Array.prototype.slice.call(values).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Estimate the fundamental frequency of a magnitude spectrum by weighted
 * harmonic sum. For each candidate f0 on a ~5-cent grid across [minHz, maxHz]
 * we sum interpolated magnitudes at its harmonics k·f0 (k = 1…H, below
 * Nyquist) weighted by 1/k. The 1/k weighting favors the TRUE fundamental over
 * its octave errors: f0/2 misses the strong first harmonic (its k=1 term lands
 * on empty spectrum) and 2·f0 drops the fundamental term entirely, so both
 * score below the real f0 — the frequency-domain analogue of the NSDF core's
 * first-strong-peak trick. `clarity` is the residual prominence of the winning
 * candidate over the grid's median score, in [0, 1]: a clean harmonic series
 * towers over a mostly-empty grid (→ 1); broadband noise scores flat (→ 0).
 *
 * @returns {{ hz:number, clarity:number }|null} — null for an empty/flat
 *   spectrum with no candidate carrying energy.
 */
export const estimateSpectralF0 = (mag, sampleRate, fftSize, opts = {}) => {
  const { minHz = 70, maxHz = 1200, maxHarmonics = 8 } = opts;
  if (!mag?.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  const nyquist = sampleRate / 2;
  const hiHz = Math.min(maxHz, nyquist);
  if (minHz <= 0 || hiHz <= minHz) return null;

  // ~5-cent candidate spacing (2^(5/1200)) — finer than a semitone by 20×,
  // far below the note-onset resolution the transcription grid needs.
  const step = Math.pow(2, 5 / 1200);
  const scores = [];
  let best = null;
  for (let f = minHz; f <= hiHz; f *= step) {
    let s = 0;
    for (let k = 1; k <= maxHarmonics; k++) {
      const hk = k * f;
      if (hk >= nyquist) break;
      s += interpMagAt(mag, hk, sampleRate, fftSize) / k;
    }
    scores.push(s);
    if (!best || s > best.score) best = { hz: f, score: s };
  }
  if (!best || best.score <= 0) return null;
  const floor = medianOf(scores);
  const clarity = Math.max(0, Math.min(1, 1 - floor / best.score));
  return { hz: best.hz, clarity };
};

/**
 * Extract a pitch track for a NEW voice that enters over a stacked mix (#2121).
 * Builds a backing magnitude profile from [bgStartMs, bgEndMs) — a slice just
 * before the voice enters, carrying only the earlier layers — then, per frame
 * of the [startMs, endMs) "after" window, subtracts that profile
 * (over-subtraction factor `overSubtract`, rectified at 0) and runs
 * `estimateSpectralF0` on the residual. Emits the same segment-relative
 * `[{ tMs, hz, clarity }]` shape as `extractPitchTrack`, so it drops straight
 * into `transcribePitchTrack`. With no usable backing window it degrades to
 * plain spectral f0 on the mix (no subtraction) rather than failing.
 *
 * @param {Float32Array} samples — mono PCM of the WHOLE reference audio.
 * @param {number} sampleRate
 * @param {object} opts
 * @param {number} opts.startMs / {number} opts.endMs — the stacked segment.
 * @param {number} [opts.bgStartMs] / {number} [opts.bgEndMs] — backing window.
 * @param {number} [opts.overSubtract=1] — spectral-subtraction strength.
 * @param {number} [opts.fftSize] / {number} [opts.hopMs] / {number} [opts.minHz] / {number} [opts.maxHz]
 * @returns {Array<{tMs:number, hz:number|null, clarity:number}>}
 */
export const extractSpectralDiffTrack = (samples, sampleRate, opts = {}) => {
  const {
    startMs = 0, endMs = null,
    bgStartMs = null, bgEndMs = null,
    fftSize = DEFAULT_FFT_SIZE, hopMs = DEFAULT_HOP_MS,
    minHz = 70, maxHz = 1200, overSubtract = 1,
  } = opts;
  const total = samples?.length || 0;
  if (!total || !Number.isFinite(sampleRate) || sampleRate <= 0) return [];

  // Backing profile from the pre-entrance window (null → no subtraction).
  const backing = (bgStartMs != null && bgEndMs != null && bgEndMs > bgStartMs)
    ? averageMagnitudeSpectrum(samples, sampleRate, { startMs: bgStartMs, endMs: bgEndMs, fftSize, hopMs })
    : null;

  const startSample = Math.max(0, Math.floor((startMs / 1000) * sampleRate));
  const endSample = endMs != null
    ? Math.min(total, Math.ceil((endMs / 1000) * sampleRate))
    : total;
  const hop = Math.max(1, Math.round((hopMs / 1000) * sampleRate));
  const half = fftSize >> 1;

  const track = [];
  for (let pos = startSample; pos + fftSize <= endSample; pos += hop) {
    const frame = samples.subarray
      ? samples.subarray(pos, pos + fftSize)
      : samples.slice(pos, pos + fftSize);
    const mag = magnitudeSpectrum(frame, { fftSize });
    const tMs = Math.round(((pos - startSample) / sampleRate) * 1000);
    if (!mag) { track.push({ tMs, hz: null, clarity: 0 }); continue; }
    // Spectral subtraction: rectify (max 0) so removed bins can't go negative.
    if (backing) {
      for (let b = 0; b < half; b++) {
        const r = mag[b] - overSubtract * backing[b];
        mag[b] = r > 0 ? r : 0;
      }
    }
    const res = estimateSpectralF0(mag, sampleRate, fftSize, { minHz, maxHz });
    track.push({ tMs, hz: res ? res.hz : null, clarity: res ? res.clarity : 0 });
  }
  return track;
};

/**
 * Stacked-mix counterpart of `proposeSegmentScore` (#2121): pitch-track the new
 * voice out of a stacked segment via spectral diff, then transcribe it onto the
 * round's tempo/key grid. Pure DSP — no LLM.
 *
 * @param {Float32Array} samples — mono PCM of the WHOLE reference audio.
 * @param {number} sampleRate
 * @param {object} opts — the `extractSpectralDiffTrack` bounds plus
 *   `bpm`/`key`/`beatsPerBar`/`beatValue` (quantization + spelling) and an
 *   optional `clarityThreshold` override.
 * @returns {{ track: Array, body: string, text: string }}
 */
export const proposeStackedSegmentScore = (samples, sampleRate, opts = {}) => {
  const {
    startMs = 0, endMs = null, bgStartMs = null, bgEndMs = null,
    bpm, key, beatsPerBar = 4, beatValue = 4,
    overSubtract = 1,
    clarityThreshold = STACKED_CLARITY_THRESHOLD,
  } = opts;
  const track = extractSpectralDiffTrack(samples, sampleRate, {
    startMs, endMs, bgStartMs, bgEndMs, overSubtract,
  });
  const body = transcribePitchTrack(track, {
    bpm, key, beatsPerBar, beatValue,
    segmentOpts: { clarityThreshold: clarityThreshold ?? DEFAULT_CLARITY_THRESHOLD },
  });
  return { track, body, text: buildScoreText({ key, tempo: bpm, beatsPerBar, beatValue, body }) };
};

// === Proposed-vs-existing bar diff ======================================

// Note letter → pitch class (semitones above C), and accidental → shift.
// Mirrors pitchDetect's tables (kept local — they aren't exported there).
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACCIDENTAL_SHIFT = { '': 0, n: 0, '#': 1, '##': 2, b: -1, bb: -2 };

// Display names for pitch classes (sharp spelling — labels only; the score
// text itself is already spelled from the key signature).
export const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Pitch class (0–11) of a parsed note's pitch, or null when unmappable.
const notePitchClass = (pitch) => {
  const base = LETTER_PC[pitch?.letter];
  const shift = ACCIDENTAL_SHIFT[pitch?.accidental || ''];
  if (base == null || shift == null) return null;
  return ((base + shift) % 12 + 12) % 12;
};

/**
 * Per-bar pitch-class sequences of a score — one array of pitch classes
 * (rests skipped, octaves collapsed) per measure. The octave collapse is
 * deliberate: a reference singer and the stored part may sit an octave apart
 * while still being "the same part".
 */
export const barPitchClasses = (scoreText) =>
  parseScore(scoreText).measures.map((m) =>
    m.notes.filter((n) => !n.rest).map((n) => notePitchClass(n.pitch)).filter((pc) => pc != null));

/**
 * Compare a proposed part against an existing scorePart, bar by bar (#2106
 * Stage 4). A bar matches when both scores have that measure AND the ordered
 * pitch-class sequences agree (rhythm differences within a bar don't flag —
 * the review staffs make those visible; the highlight is for wrong NOTES).
 *
 * @returns {Array<{bar:number, proposed:number[]|null, existing:number[]|null, match:boolean}>}
 *   — one row per bar of the longer score; a side missing that bar is null
 *   (and the bar can't match).
 */
export const diffScoreBars = (proposedText, existingText) => {
  const a = barPitchClasses(proposedText);
  const b = barPitchClasses(existingText);
  const bars = Math.max(a.length, b.length);
  const out = [];
  for (let i = 0; i < bars; i++) {
    const proposed = i < a.length ? a[i] : null;
    const existing = i < b.length ? b[i] : null;
    const match = proposed != null && existing != null
      && proposed.length === existing.length
      && proposed.every((pc, j) => pc === existing[j]);
    out.push({ bar: i + 1, proposed, existing, match });
  }
  return out;
};

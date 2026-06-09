// PortOS vocal pitch detection — a tiny, dependency-free DSP core for the song
// system's tuner / color-match / sing-to-score features. We estimate the
// fundamental frequency of a sung frame ourselves (autocorrelation, McLeod's
// normalized-square-difference flavor) rather than pulling in a DSP package, for
// the same reason `scoreNotation.js` hand-rolls notation: PortOS's audio stack
// stays library-free. This module is the single source of truth for the
// frequency↔note mapping every higher feature shares.
//
// The note model is deliberately the SAME diatonic `step` math the sheet-music
// renderer uses (`diatonicStep` is imported from scoreNotation.js, not
// re-derived) so a detected note lands on exactly the staff line/space the
// renderer would draw — that pixel-for-pixel alignment is what makes the
// color-match overlay line up with the score.
//
// Keep this module pure where it can be: the estimator and the two mappers are
// side-effect-free and unit-tested; only `createPitchTracker` touches Web Audio
// and a rAF loop, and it owns its own teardown.

import { diatonicStep } from './scoreNotation.js';

// === Note ↔ semitone tables ============================================

// Sharp spelling of each chromatic pitch class (0 = C). Matches the renderer's
// preference; enharmonic flat spelling (from the key signature) is a later
// concern for sing-to-score, not the raw detector.
const CHROMATIC = [
  { letter: 'C', accidental: '' }, { letter: 'C', accidental: '#' },
  { letter: 'D', accidental: '' }, { letter: 'D', accidental: '#' },
  { letter: 'E', accidental: '' },
  { letter: 'F', accidental: '' }, { letter: 'F', accidental: '#' },
  { letter: 'G', accidental: '' }, { letter: 'G', accidental: '#' },
  { letter: 'A', accidental: '' }, { letter: 'A', accidental: '#' },
  { letter: 'B', accidental: '' },
];

// Diatonic letter → its pitch class (semitones above C). The inverse direction
// of CHROMATIC, used to turn a notated note back into a frequency.
const LETTER_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Accidental glyph → chromatic shift in semitones. Mirrors the accidental set
// `parsePitch` produces ('', '#', '##', 'b', 'bb', 'n').
const ACCIDENTAL_SHIFT = { '': 0, n: 0, '#': 1, '##': 2, b: -1, bb: -2 };

// === Frequency ↔ note mapping ==========================================

// Convert a frequency (Hz) to the nearest equal-tempered note plus how far the
// pitch sits from that note's center, in cents. `a4` is the reference pitch
// (concert A, default 440) — a parameter now so an alternate tuning is a config
// change, not a refactor. Returns `{ letter, accidental, octave, step, cents }`
// where `step` is the diatonic staff position (C4 = 0) the renderer draws, and
// `cents` ∈ [-50, +50] with the conventional sign: **sharp is positive**.
export const frequencyToNote = (hz, { a4 = 440 } = {}) => {
  if (!Number.isFinite(hz) || hz <= 0) return null;
  // MIDI-style continuous pitch: 69 = A4. log2 turns the ratio into octaves,
  // ×12 into semitones. Rounding to the nearest integer picks the note; the
  // fractional remainder is the detune.
  const midiFloat = 69 + 12 * Math.log2(hz / a4);
  const midi = Math.round(midiFloat);
  const cents = Math.round((midiFloat - midi) * 100); // sharp → positive
  const octave = Math.floor(midi / 12) - 1;           // MIDI 60 = C4
  const semitone = ((midi % 12) + 12) % 12;
  const { letter, accidental } = CHROMATIC[semitone];
  return { letter, accidental, octave, step: diatonicStep(letter, octave), cents };
};

// Inverse of `frequencyToNote`: the exact frequency of a notated note (the
// `{ letter, accidental, octave }` shape `parsePitch` / `frequencyToNote`
// produce). Used by color-match to compute each target note's frequency. Cents
// are intentionally ignored — this returns the note's ideal center pitch.
// Returns null for anything that isn't a recognizable note.
export const noteToFrequency = (note, { a4 = 440 } = {}) => {
  if (!note) return null;
  const base = LETTER_SEMITONE[String(note.letter || '').toUpperCase()];
  const shift = ACCIDENTAL_SHIFT[note.accidental || ''];
  if (base == null || shift == null || !Number.isFinite(note.octave)) return null;
  const midi = (note.octave + 1) * 12 + base + shift; // (octave+1)*12: C4 → 60
  return a4 * Math.pow(2, (midi - 69) / 12);
};

// === Tuning quality (cents → bucket) ===================================

// Cents-deviation thresholds the tuner UI colors by. Within ±IN_TUNE_CENTS the
// note is "in tune" (green); within ±CLOSE_CENTS it's "close" (yellow);
// anything wider is "off" (red). Exported so the thresholds are a single shared
// constant the UI and its tests agree on, not magic numbers in a component.
export const IN_TUNE_CENTS = 5;
export const CLOSE_CENTS = 20;

// Classify a cents deviation into a tuning-quality bucket for the tuner readout.
// Pure + side-effect-free (no colors here — the component maps `level` to a
// `--port-*` token) so the thresholds are unit-testable. `label` carries the
// sharp/flat direction so the UI doesn't re-derive the sign. A non-finite cents
// (no pitch detected) returns the neutral `none` bucket.
export const tuningQuality = (cents) => {
  if (!Number.isFinite(cents)) return { level: 'none', label: '—' };
  const abs = Math.abs(cents);
  if (abs <= IN_TUNE_CENTS) return { level: 'in-tune', label: 'In tune' };
  if (abs <= CLOSE_CENTS) return { level: 'close', label: cents > 0 ? 'A little sharp' : 'A little flat' };
  return { level: 'off', label: cents > 0 ? 'Sharp' : 'Flat' };
};

// === Fundamental-frequency estimation ==================================

// Estimate the fundamental frequency of a Float32 PCM frame via the McLeod
// Pitch Method: a normalized square-difference function (NSDF) plus
// first-tall-peak picking. The NSDF is bounded to [-1, 1] — a clean periodic
// signal peaks near 1 at its period, while noise stays near 0 — so its peak
// height doubles as a **clarity** (confidence) score that rejects noise and
// silence. Returns `{ hz, clarity }`, or null for silence / no clear pitch.
//
// `sampleRate` is required to convert lag → Hz; the rest bound the search to a
// vocal range and set the silence / clarity gates (the silence gate reuses the
// per-frame energy intuition behind `audioRecorder.js`'s peak warning).
export const detectFrequency = (frame, opts = {}) => {
  const {
    sampleRate = 44100,
    minHz = 55,
    maxHz = 1600,
    rmsFloor = 0.01,
    clarityFloor = 0.5,
  } = opts;
  const size = frame?.length || 0;
  if (size < 2) return null;

  // Silence gate: a frame quieter than the floor carries no pitch worth
  // reporting (a dead/near-silent mic), so bail before the O(N·lag) NSDF.
  let rms = 0;
  for (let i = 0; i < size; i++) rms += frame[i] * frame[i];
  rms = Math.sqrt(rms / size);
  if (rms < rmsFloor) return null;

  // Search lags spanning [maxHz, minHz]. A lag (period in samples) of τ maps to
  // sampleRate/τ Hz, so a higher frequency is a shorter lag.
  const maxLag = Math.min(size - 1, Math.floor(sampleRate / minHz));
  const minLag = Math.max(1, Math.floor(sampleRate / maxHz));
  if (maxLag <= minLag) return null;

  // NSDF[τ] = 2·Σ x[j]x[j+τ] / Σ (x[j]² + x[j+τ]²). The shrinking window
  // (j+τ < size) tapers long lags slightly, which is fine — we only need the
  // first strong peak, not absolute amplitudes.
  const nsdf = new Float32Array(maxLag + 1);
  for (let tau = minLag; tau <= maxLag; tau++) {
    let acf = 0;
    let denom = 0;
    for (let j = 0; j + tau < size; j++) {
      acf += frame[j] * frame[j + tau];
      denom += frame[j] * frame[j] + frame[j + tau] * frame[j + tau];
    }
    nsdf[tau] = denom > 0 ? (2 * acf) / denom : 0;
  }

  // Key-maximum picking: the highest point of each positive hump. We skip any
  // positive plateau at the very start (the tail of the τ=0 central lobe) so a
  // sub-period correlation can't masquerade as the fundamental, then take the
  // max within each subsequent hump.
  const peaks = [];
  let tau = minLag;
  while (tau <= maxLag && nsdf[tau] > 0) tau++; // descend out of the central lobe
  while (tau <= maxLag) {
    if (nsdf[tau] > 0) {
      let best = tau;
      while (tau <= maxLag && nsdf[tau] > 0) {
        if (nsdf[tau] > nsdf[best]) best = tau;
        tau++;
      }
      peaks.push(best);
    } else {
      tau++;
    }
  }
  if (!peaks.length) return null;

  // Clarity is the tallest hump. Below the floor we treat the frame as noise.
  let globalMax = 0;
  for (const p of peaks) if (nsdf[p] > globalMax) globalMax = nsdf[p];
  if (globalMax < clarityFloor) return null;

  // Pick the FIRST hump that reaches 90% of the tallest, not the global max —
  // this is the MPM trick that keeps an octave-down sub-harmonic (which can be
  // marginally taller) from winning over the true fundamental.
  const chosen = peaks.find((p) => nsdf[p] >= 0.9 * globalMax);
  if (chosen == null) return null;

  // Parabolic interpolation around the chosen lag for sub-sample period
  // precision — without it the pitch quantizes to integer-lag steps, which is
  // tens of cents of error at higher frequencies.
  const x0 = chosen > 0 ? nsdf[chosen - 1] : nsdf[chosen];
  const x1 = nsdf[chosen];
  const x2 = chosen < maxLag ? nsdf[chosen + 1] : nsdf[chosen];
  const curve = x0 - 2 * x1 + x2;
  const shift = curve !== 0 ? (0.5 * (x0 - x2)) / curve : 0;
  const period = chosen + shift;
  if (period <= 0) return null;

  return { hz: sampleRate / period, clarity: globalMax };
};

// === Live tracker ======================================================

// Median of a short numeric array (odd or even length). Used to smooth the
// per-frame pitch — the median kills the lone octave-jump outliers that raw
// frame-by-frame vocal detection produces, where a mean would smear them in.
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Drive a live pitch readout off a Web Audio `AnalyserNode`. Pulls time-domain
// frames on a rAF (or interval) loop, runs `detectFrequency`, smooths the result
// (median window to drop octave jumps, then an EMA to settle the needle), and
// emits `{ hz, note, cents, clarity }` through `onUpdate`. While the frame is
// silent / unclear it emits nulls so the UI can show "no pitch" rather than
// freezing on the last note.
//
// Returns `{ stop }`. `stop()` cancels the loop — call it on stop/unmount so no
// rAF or timer dangles (the deferred-work teardown rule in CLAUDE.md). The loop
// body is wrapped so a throw inside an animation-frame callback (which has no
// Express `next(err)` to bubble to) can't crash the tab.
export const createPitchTracker = (analyser, opts = {}) => {
  const {
    onUpdate,
    a4 = 440,
    minHz = 70,
    maxHz = 1200,
    clarityThreshold = 0.9,
    medianWindow = 5,
    emaAlpha = 0.25,
    intervalMs = null, // when set, use setInterval instead of requestAnimationFrame
  } = opts;

  const sampleRate = analyser?.context?.sampleRate || 44100;
  const frame = new Float32Array(analyser?.fftSize || 2048);
  const recent = []; // recent clear-frame Hz for the median window
  let emaHz = null;
  let running = true;
  let rafId = null;
  let timerId = null;

  const schedule = () => {
    if (!running) return;
    if (intervalMs != null) timerId = setTimeout(tick, intervalMs);
    else if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(tick);
    else timerId = setTimeout(tick, 1000 / 60);
  };

  const tick = () => {
    if (!running) return;
    try {
      analyser.getFloatTimeDomainData(frame);
      const res = detectFrequency(frame, { sampleRate, minHz, maxHz });
      if (res && res.clarity >= clarityThreshold) {
        recent.push(res.hz);
        if (recent.length > medianWindow) recent.shift();
        const med = median(recent);
        emaHz = emaHz == null ? med : emaAlpha * med + (1 - emaAlpha) * emaHz;
        const note = frequencyToNote(emaHz, { a4 });
        onUpdate?.({ hz: emaHz, note, cents: note?.cents ?? null, clarity: res.clarity });
      } else {
        // Lost the pitch — reset the smoother so a new note doesn't ramp in from
        // the stale one, and report the gap.
        recent.length = 0;
        emaHz = null;
        onUpdate?.({ hz: null, note: null, cents: null, clarity: res?.clarity ?? 0 });
      }
    } catch (err) {
      console.error(`❌ pitch tracker frame failed: ${err.message}`);
    }
    schedule();
  };

  schedule();

  return {
    stop: () => {
      running = false;
      if (rafId != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      if (timerId != null) clearTimeout(timerId);
      rafId = null;
      timerId = null;
    },
  };
};

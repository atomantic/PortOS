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
// emits `{ hz, note, cents, clarity, held }` through `onUpdate`.
//
// Raw frame-by-frame vocal detection is jittery — vibrato, consonants, and
// breath dips routinely drop NSDF clarity below a strict gate for a frame or two
// while the note itself is perfectly steady. Without smoothing the readout
// strobes: the label flickers, the needle lurches, and the display blanks
// mid-note. Four knobs tame that, all configurable so the raw behavior stays
// available to callers (sing-to-score, color-match) that want every frame:
//
//  - **Acquire/hold hysteresis** (`acquireClarity` / `holdClarity`). We require a
//    strong frame (≥ `acquireClarity`) to START believing a pitch, but only a
//    weaker one (≥ `holdClarity`) to KEEP believing it — so a mid-note clarity
//    dip still feeds the smoother instead of tearing it down. Below `holdClarity`
//    a frame counts as "unclear".
//  - **Release window** (`releaseMs` / `releaseFrames`). A short run of unclear
//    frames keeps emitting the last smoothed reading (flagged `held: true`) rather
//    than blanking on the first bad frame; only once the window elapses do we emit
//    nulls and reset the smoother (so a new note doesn't ramp from the stale EMA).
//  - **Sticky note label** (`stickyCents`). The note label stays put until the
//    smoothed pitch drifts more than ±`stickyCents` from that note's center —
//    singing ~50¢ between C and C♯ no longer flaps the label C↔C♯. Cents are
//    reported relative to the held note (so they pass through ±50 continuously
//    instead of snapping sign); a clean semitone step blows past the band and
//    re-derives within a few frames.
//  - **Emit throttle** (`updateHz`). Cap the callback rate (e.g. the tuner's
//    ~12Hz) so integer-cents redraws don't read as vibration; a material change
//    (note flip, held⇄live) still emits immediately. `null` = emit every frame.
//
// Back-compat: a legacy `clarityThreshold` is honored as the `acquireClarity`
// fallback.
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
    clarityThreshold,                     // legacy single-threshold → acquireClarity fallback
    acquireClarity = clarityThreshold ?? 0.9,
    holdClarity = 0.6,
    medianWindow = 5,
    emaAlpha = 0.25,
    stickyCents = 60,
    releaseMs = 250,
    releaseFrames = null,                 // wins over releaseMs when given (frame-exact)
    updateHz = null,                      // emit throttle in Hz; null = every frame
    intervalMs = null,                    // when set, use setTimeout instead of requestAnimationFrame
  } = opts;

  const sampleRate = analyser?.context?.sampleRate || 44100;
  const frame = new Float32Array(analyser?.fftSize || 2048);

  // Resolve the release window into a frame count. A frame is `intervalMs` (when
  // the loop is timer-driven) or ~16.7 ms (rAF at 60fps); `releaseFrames` wins
  // when given so tests can pin an exact count independent of the loop rate.
  const frameMs = intervalMs != null ? intervalMs : 1000 / 60;
  const holdFrames = releaseFrames != null
    ? Math.max(0, releaseFrames)
    : Math.max(0, Math.round(releaseMs / frameMs));
  const minEmitMs = updateHz != null && updateHz > 0 ? 1000 / updateHz : 0;

  const recent = [];      // recent clear-frame Hz for the median window
  let emaHz = null;       // smoothed pitch
  let acquired = false;   // do we currently hold a believed pitch?
  let unclearRun = 0;     // consecutive unclear frames since the last clear one
  let stickyNote = null;  // the note label we're holding across the ±stickyCents band
  let lastEmitted = null; // last reading handed to onUpdate (throttle bookkeeping)
  let lastEmitMs = null;
  let running = true;
  let rafId = null;
  let timerId = null;

  const clockMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  // Note identity for throttle material-change detection (a null note is '∅').
  const noteId = (note) => (note ? `${note.letter}${note.accidental}${note.octave}` : '∅');

  // Pick the note label for a smoothed pitch, keeping the current label sticky
  // until the pitch drifts more than ±stickyCents from that note's center. A
  // clean semitone step (100¢) blows past the band and re-derives.
  const resolveNote = (hz) => {
    const fresh = frequencyToNote(hz, { a4 });
    if (!fresh) return stickyNote;
    if (!stickyNote) { stickyNote = fresh; return stickyNote; }
    const centerHz = noteToFrequency(stickyNote, { a4 });
    const drift = centerHz ? Math.abs(1200 * Math.log2(hz / centerHz)) : Infinity;
    if (drift > stickyCents) stickyNote = fresh;
    return stickyNote;
  };

  // Cents of `hz` relative to a HELD note's center (may exceed ±50 while sticky).
  const centsFromHeld = (hz, note) => {
    const centerHz = noteToFrequency(note, { a4 });
    return centerHz ? Math.round(1200 * Math.log2(hz / centerHz)) : null;
  };

  const emit = (reading) => {
    // Throttle: within a note, emit at most `updateHz`/sec; a material change
    // (note flip, held⇄live) always emits so the UI never lags a real transition.
    // `updateHz == null` (minEmitMs 0) disables the throttle — every frame emits.
    if (minEmitMs > 0 && lastEmitted) {
      const material = noteId(reading.note) !== noteId(lastEmitted.note) || reading.held !== lastEmitted.held;
      if (!material && lastEmitMs != null && clockMs() - lastEmitMs < minEmitMs) return;
    }
    lastEmitted = reading;
    lastEmitMs = clockMs();
    onUpdate?.(reading);
  };

  const emitLive = (hz, clarity, held) => {
    const note = resolveNote(hz);
    emit({ hz, note, cents: note ? centsFromHeld(hz, note) : null, clarity, held });
  };

  const reset = () => {
    recent.length = 0;
    emaHz = null;
    acquired = false;
    unclearRun = 0;
    stickyNote = null;
  };

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
      const clarity = res?.clarity ?? 0;
      // Acquire high, hold low: once we believe a pitch a frame merely above the
      // hold floor still updates the smoother; only from silence do we require the
      // stricter acquire floor.
      const clear = !!res && clarity >= (acquired ? holdClarity : acquireClarity);

      if (clear) {
        acquired = true;
        unclearRun = 0;
        recent.push(res.hz);
        if (recent.length > medianWindow) recent.shift();
        const med = median(recent);
        emaHz = emaHz == null ? med : emaAlpha * med + (1 - emaAlpha) * emaHz;
        emitLive(emaHz, clarity, false);
      } else if (acquired && unclearRun < holdFrames && emaHz != null) {
        // Brief dropout (consonant, breath, vibrato dip) — keep showing the last
        // stable reading for up to the release window instead of blanking.
        unclearRun += 1;
        emitLive(emaHz, clarity, true);
      } else {
        // Truly lost the pitch — reset so a new note doesn't ramp in from the
        // stale EMA, and report the gap.
        reset();
        emit({ hz: null, note: null, cents: null, clarity, held: false });
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

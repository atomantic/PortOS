// Sing-to-score transcription — turn a sung pitch track into PortOS lead-sheet
// notation. The pipeline is three pure stages, each independently unit-tested:
//
//   1. segmentPitchTrack — group a continuous `[{ tMs, hz, clarity }]` track
//      into discrete note/rest segments (onset = pitch change or energy return,
//      rest = a run of unclear/silent frames). Note pitch = median Hz over the
//      stable span, which kills the per-frame octave jitter raw vocal detection
//      produces.
//   2. quantizeSegments — snap each segment's onset and duration to the
//      metronome grid at the song `tempo` (nearest whole/half/quarter/eighth/
//      sixteenth), turning a wobbly human take into clean notation.
//   3. segmentsToScoreDsl — spell each note enharmonically from the key
//      signature and emit the exact lead-sheet text the editor edits, so the
//      user can review it and round-trips cleanly back through `parseScore`.
//
// `transcribePitchTrack` runs all three. Dependency-free: it reuses
// `frequencyToNote` from `pitchDetect.js` (the shared frequency↔note mapping)
// and the key tables / duration model from `scoreNotation.js` — no new DSP or
// notation library.

import { frequencyToNote } from './pitchDetect.js';
import { DURATIONS, durationBeats, keySignature } from './scoreNotation.js';

// === Tunables ==========================================================

// A frame whose clarity is below this is treated as silence/noise → a rest
// (matches the tuner's confidence gate; vocals settle well above this).
export const DEFAULT_CLARITY_THRESHOLD = 0.9;
// A new segment starts when the detected pitch jumps more than this many
// semitones from the running segment — below it we treat the wobble as the same
// sung note (vibrato / scoops don't split a note).
const NOTE_SPLIT_SEMITONES = 0.6;
// Drop a pitched segment shorter than this — a stray clear frame between rests
// is detection noise, not a sung note.
const MIN_NOTE_MS = 70;
// Drop a rest shorter than this — a momentary clarity dip mid-note (a breath
// catch) shouldn't punch a rest into a held note.
const MIN_REST_MS = 90;

// Duration codes the quantizer snaps to, longest → shortest. We deliberately
// stop at sixteenth (`s`): finer grids (32nds) over-fit human timing jitter.
const QUANTIZE_CODES = ['w', 'h', 'q', 'e', 's'];

// === Stage 1: segment the pitch track ==================================

// Median of a numeric array (the robust center of a segment's frequencies —
// immune to the lone octave-jump outliers a mean would smear in).
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Semitone distance between two frequencies (|Δ| in equal-tempered semitones).
const semitoneGap = (a, b) => Math.abs(12 * Math.log2(a / b));

// True for a frame that carries a usable pitch (clear enough + a positive Hz).
const isPitched = (f, clarityThreshold) =>
  f && Number.isFinite(f.hz) && f.hz > 0 && (f.clarity ?? 1) >= clarityThreshold;

/**
 * Group a pitch track into discrete note + rest segments.
 *
 * @param {Array<{tMs:number, hz:number, clarity?:number}>} track — time-ordered
 *   frames. Frames below the clarity threshold (or with no/zero hz) read as
 *   silence and accumulate into rests.
 * @param {object} [opts]
 * @param {number} [opts.clarityThreshold]
 * @param {number} [opts.minNoteMs] — pitched segments shorter than this are dropped.
 * @param {number} [opts.minRestMs] — rests shorter than this are dropped (the
 *   surrounding note absorbs the gap).
 * @returns {Array<{rest:boolean, startMs:number, endMs:number, hz?:number}>} —
 *   ordered segments; a note carries its median `hz`, a rest carries only timing.
 */
export const segmentPitchTrack = (track, opts = {}) => {
  const {
    clarityThreshold = DEFAULT_CLARITY_THRESHOLD,
    minNoteMs = MIN_NOTE_MS,
    minRestMs = MIN_REST_MS,
  } = opts;
  const frames = Array.isArray(track) ? track.filter((f) => f && Number.isFinite(f.tMs)) : [];
  if (frames.length < 2) return [];

  // Raw runs: alternating pitched-note runs (carrying their frequencies) and
  // rest runs, with no merging/dropping yet.
  const runs = [];
  let cur = null; // { rest, startMs, endMs, hzList }
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const pitched = isPitched(f, clarityThreshold);
    if (pitched) {
      const runMedian = cur && !cur.rest && cur.hzList.length ? median(cur.hzList) : null;
      // Split into a new note when there's no open note, the open run is a rest,
      // or the pitch moved more than the split threshold from the run's center.
      const split = !cur || cur.rest || (runMedian != null && semitoneGap(f.hz, runMedian) > NOTE_SPLIT_SEMITONES);
      if (split) {
        cur = { rest: false, startMs: f.tMs, endMs: f.tMs, hzList: [f.hz] };
        runs.push(cur);
      } else {
        cur.hzList.push(f.hz);
        cur.endMs = f.tMs;
      }
    } else if (cur && cur.rest) {
      cur.endMs = f.tMs;
    } else {
      cur = { rest: true, startMs: f.tMs, endMs: f.tMs, hzList: null };
      runs.push(cur);
    }
  }

  // Extend each run's end to the next run's start so adjacent segments are
  // contiguous (a frame timestamp marks an onset, not a span — the gap to the
  // next onset is this segment's true duration).
  for (let i = 0; i < runs.length - 1; i++) runs[i].endMs = runs[i + 1].startMs;

  // Collapse: finalize note frequencies, drop sub-threshold notes (noise) and
  // sub-threshold rests (breath catches), merging a dropped segment into the
  // surrounding note where possible.
  const segments = [];
  for (const run of runs) {
    const durMs = run.endMs - run.startMs;
    if (run.rest) {
      if (durMs < minRestMs) {
        // Too short to be a rest — absorb into the preceding note if one exists.
        const prev = segments[segments.length - 1];
        if (prev && !prev.rest) prev.endMs = run.endMs;
        continue;
      }
      segments.push({ rest: true, startMs: run.startMs, endMs: run.endMs });
    } else {
      if (durMs < minNoteMs) continue; // stray clear frame — not a sung note
      segments.push({ rest: false, startMs: run.startMs, endMs: run.endMs, hz: median(run.hzList) });
    }
  }
  return segments;
};

// === Stage 2: quantize to the beat grid ================================

// Snap a beat-length to the nearest grid duration, returning the duration code
// (and how many such units, for callers that want it). We pick the code whose
// beat value is closest to the target; ties prefer the longer note.
const nearestDurationCode = (beats) => {
  let best = null;
  let bestErr = Infinity;
  for (const code of QUANTIZE_CODES) {
    const err = Math.abs(DURATIONS[code].beats - beats);
    if (err < bestErr - 1e-9) { bestErr = err; best = code; }
  }
  return best;
};

/**
 * Quantize note/rest segments to the metronome grid at a given tempo. Each
 * segment's *duration in ms* converts to quarter-note beats (`ms / msPerQuarter`,
 * where BPM is the conventional quarter-notes-per-minute — the same convention
 * `metronome.js` / `scorePlayback.js` use), then snaps to the nearest grid
 * duration. Onsets are implicitly snapped because durations are: consecutive
 * quantized durations lay the notes back on the grid.
 *
 * `beatValue` (the time-signature denominator) does NOT affect this conversion —
 * `DURATIONS` and BPM are both expressed in quarter-note units — but it's
 * accepted for call-site symmetry with the rest of the pipeline.
 *
 * @param {Array} segments — output of `segmentPitchTrack`.
 * @param {object} opts
 * @param {number} opts.bpm — beats per minute (the song tempo; quarter = 1 beat).
 * @returns {Array<{rest:boolean, hz?:number, code:string, dots:number, beats:number}>}
 *   — each segment with a snapped duration (`beats` in quarter-note units);
 *   zero-length snaps are dropped.
 */
export const quantizeSegments = (segments, { bpm } = {}) => {
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const msPerQuarter = 60000 / safeBpm;
  const out = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    const durMs = (seg.endMs ?? 0) - (seg.startMs ?? 0);
    if (durMs <= 0) continue;
    const quarterBeats = durMs / msPerQuarter;
    const code = nearestDurationCode(quarterBeats);
    if (!code) continue;
    const snappedBeats = durationBeats(code, 0);
    out.push({ rest: !!seg.rest, hz: seg.hz, code, dots: 0, beats: snappedBeats });
  }
  return out;
};

// === Stage 3: emit lead-sheet DSL ======================================

// Pitch-class → flat spelling, for keys that carry flats. The sharp spelling is
// `frequencyToNote`'s default; here we only need the alternate names for the
// black keys (1,3,6,8,10).
const FLAT_SPELLING = {
  1: { letter: 'D', accidental: 'b' },
  3: { letter: 'E', accidental: 'b' },
  6: { letter: 'G', accidental: 'b' },
  8: { letter: 'A', accidental: 'b' },
  10: { letter: 'B', accidental: 'b' },
};

// Choose the enharmonic spelling for a detected note given the key signature.
// In a flat key we respell accidental notes with flats (a black key sung in Eb
// should read Ab, not G#); sharp keys and C keep the detector's sharp default.
// We adjust the octave for the flat respelling so the *pitch* is unchanged
// (e.g. C#5 → Db5 stays the same sounding note; only the name changes — same
// octave because Db and C# share octave boundaries above C).
const spellNote = (note, keySig) => {
  if (!note) return null;
  if (keySig?.type !== 'flat' || !note.accidental) return note;
  // Recover the pitch class from the detector's sharp spelling.
  const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const pc = (LETTER_PC[note.letter] + (note.accidental === '#' ? 1 : 0) + 12) % 12;
  const flat = FLAT_SPELLING[pc];
  if (!flat) return note;
  return { ...note, letter: flat.letter, accidental: flat.accidental };
};

// One quantized segment → a single lead-sheet token (e.g. "E4q" or "rq").
const segmentToToken = (seg, keySig) => {
  const dur = seg.code + '.'.repeat(seg.dots || 0);
  if (seg.rest) return `r${dur}`;
  const note = spellNote(frequencyToNote(seg.hz), keySig);
  if (!note) return `r${dur}`; // unspellable → fall back to a rest so timing holds
  return `${note.letter}${note.accidental}${note.octave}${dur}`;
};

/**
 * Render quantized segments to lead-sheet body text, grouped into measures by
 * the time signature so the output parses into clean bars.
 *
 * @param {Array} quantized — output of `quantizeSegments`.
 * @param {object} [opts]
 * @param {object} [opts.keySig] — a `keySignature()` descriptor for enharmonic
 *   spelling; defaults to C (no accidentals).
 * @param {number} [opts.beatsPerBar=4] — time-signature numerator (bar length in beats).
 * @param {number} [opts.beatValue=4] — time-signature denominator.
 * @returns {string} — the measure body (`| ... | ... |`), empty string when no notes.
 */
export const segmentsToScoreDsl = (quantized, { keySig, beatsPerBar = 4, beatValue = 4 } = {}) => {
  let segs = Array.isArray(quantized) ? quantized : [];
  // Trim leading/trailing rests — silence before the first sung note and after
  // the last carries no musical meaning (and an all-rest track is "nothing sung").
  let lo = 0;
  let hi = segs.length;
  while (lo < hi && segs[lo].rest) lo++;
  while (hi > lo && segs[hi - 1].rest) hi--;
  segs = segs.slice(lo, hi);
  if (!segs.length) return '';
  const sig = keySig || keySignature('C');
  // A bar holds `beatsPerBar` beats *of the denominator unit*; our `beats` are in
  // quarter units, so the bar capacity in quarter-beats is beatsPerBar*(4/beatValue).
  const barCapacity = beatsPerBar * (4 / beatValue);
  const measures = [];
  let bar = [];
  let acc = 0;
  for (const seg of segs) {
    bar.push(segmentToToken(seg, sig));
    acc += seg.beats;
    // Close the bar once it's full (within a sixteenth's slack so float drift
    // doesn't strand a bar a hair under capacity).
    if (acc >= barCapacity - 1e-6) {
      measures.push(bar.join(' '));
      bar = [];
      acc = 0;
    }
  }
  if (bar.length) measures.push(bar.join(' '));
  return measures.length ? `| ${measures.join(' | ')} |` : '';
};

/**
 * Full sing-to-score pipeline: pitch track → measure-grouped lead-sheet body.
 * Convenience wrapper over the three stages; the UI calls this and shows the
 * result in the editor preview.
 *
 * @param {Array} track — `[{ tMs, hz, clarity }]` frames.
 * @param {object} opts
 * @param {number} opts.bpm — song tempo.
 * @param {string|object} [opts.key] — key name ("Eb") or a `keySignature()`
 *   descriptor, for enharmonic spelling.
 * @param {number} [opts.beatsPerBar=4]
 * @param {number} [opts.beatValue=4]
 * @param {object} [opts.segmentOpts] — passed through to `segmentPitchTrack`.
 * @returns {string} — lead-sheet measure body (empty when nothing was sung).
 */
export const transcribePitchTrack = (track, opts = {}) => {
  const { bpm, key, beatsPerBar = 4, beatValue = 4, segmentOpts } = opts;
  const segments = segmentPitchTrack(track, segmentOpts);
  const quantized = quantizeSegments(segments, { bpm });
  const keySig = key && typeof key === 'object' ? key : keySignature(key || 'C');
  return segmentsToScoreDsl(quantized, { keySig, beatsPerBar, beatValue });
};

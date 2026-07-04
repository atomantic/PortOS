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

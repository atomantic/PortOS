// Color-match — the grading core for the song system's "sing-to-the-score"
// training mode. It walks the notated melody in tempo and judges how well a
// singer hit each note, so the <ScoreSheet> can paint each notehead green
// (in tune), yellow (close), or red (off / missed).
//
// This module is deliberately PURE (no React, no Web Audio): it builds the
// note timeline from a parsed score + tempo, classifies a detected pitch
// against a target note, and aggregates a per-take accuracy summary. The hook
// (`useColorMatch`) owns the metronome clock + pitch tracker and feeds grades
// in here; the renderer only consumes the resulting `noteColors` array. Keeping
// the math here is what makes the grading unit-testable without a microphone.
//
// Timing mirrors `scorePlayback.buildSchedule` exactly (same global note index,
// same `(60/bpm)·(beatValue/4)` quarter-beat duration) so a color-match cursor
// lines up note-for-note with both the rendered staff and the reference-tone
// playhead. The note→frequency mapping comes from `pitchDetect` — the shared
// note↔frequency source of truth the tuner and detector also use — so a target
// note and a detected note are compared on one tuning reference.

import { noteToFrequency } from './pitchDetect.js';

// Grade levels — the same three buckets the tuner uses (`pitchDetect.tuningQuality`),
// plus `missed` (no clear pitch detected while the note was active). Exported so
// the renderer and tests share one vocabulary instead of magic strings. `pending`
// is the pre-grade state (note not yet sung) and carries no color.
export const GRADE = {
  IN_TUNE: 'in-tune',
  CLOSE: 'close',
  OFF: 'off',
  MISSED: 'missed',
  PENDING: 'pending',
};

// Cents-deviation thresholds for grading a sung note against its target. Wider
// than the live tuner's (`pitchDetect.IN_TUNE_CENTS` = 5) because a sustained
// sung note wobbles — a singer holding within ±25¢ is hitting the note for
// training purposes, and ±50¢ (a quartertone) is the "close but flat/sharp"
// band before it reads as the wrong note entirely.
export const MATCH_IN_TUNE_CENTS = 25;
export const MATCH_CLOSE_CENTS = 50;

// Cents between two frequencies: 1200·log2(f/target). Positive = the sung pitch
// is sharp of the target. Returns null when either frequency is missing.
export const centsBetween = (hz, targetHz) => {
  if (!Number.isFinite(hz) || hz <= 0 || !Number.isFinite(targetHz) || targetHz <= 0) return null;
  return 1200 * Math.log2(hz / targetHz);
};

// Classify a detected frequency against a target note's frequency into a GRADE.
// Folds octave errors onto the nearest octave first (`% 1200` distance) so a
// singer an octave low still grades on pitch-class accuracy — common for vocal
// ranges that don't reach the written octave. A null/absent detected pitch is
// `MISSED`. Pure + side-effect-free so the thresholds are unit-testable.
export const gradeNote = (hz, targetHz) => {
  const rawCents = centsBetween(hz, targetHz);
  if (rawCents == null) return GRADE.MISSED;
  // Fold onto [-600, 600] so an octave (or N octaves) off collapses to its
  // pitch-class deviation — singing C3 against a written C5 is "in tune".
  let cents = ((rawCents % 1200) + 1200) % 1200;
  if (cents > 600) cents -= 1200;
  const abs = Math.abs(cents);
  if (abs <= MATCH_IN_TUNE_CENTS) return GRADE.IN_TUNE;
  if (abs <= MATCH_CLOSE_CENTS) return GRADE.CLOSE;
  return GRADE.OFF;
};

// Build the color-match timeline from a parsed score (parseScore output) + tempo.
// Walks the score in the SAME order scorePlayback.buildSchedule does, assigning
// each NON-rest note a global note index (matching the renderer's flatten order),
// a target frequency, and an onset/offset window in milliseconds. Rests advance
// the clock but produce no timeline entry — the singer isn't graded on silence.
//
// `beatValue` from the time signature makes a quarter-beat last
// (60000/bpm)·(beatValue/4) ms, so 4/4 reads quarter=bpm and 6/8 reads
// eighth=bpm — the same interpretation as scorePlayback.
//
// Returns `{ notes, totalMs, msPerQuarter, bpm }` where each note is
// `{ index, targetHz, startMs, endMs, durBeats }`. `index` is the GLOBAL note
// index (rests included in the count) so it indexes the renderer's notehead
// array directly. `bpm` is the resolved tempo (override → score.tempo → 90) so
// the metronome and the timeline share one clock.
export const buildColorMatchTimeline = (score, { bpm, a4 = 440 } = {}) => {
  const beatValue = score?.time?.beatValue || 4;
  const tempo = Number.isFinite(bpm) && bpm > 0
    ? bpm
    : (Number.isFinite(score?.tempo) && score.tempo > 0 ? score.tempo : 90);
  const msPerQuarter = (60000 / tempo) * (beatValue / 4);

  const notes = [];
  let beat = 0;
  let index = 0;
  for (const measure of score?.measures || []) {
    for (const note of measure?.notes || []) {
      const durBeats = note.duration?.beats || 0;
      if (!note.rest) {
        notes.push({
          index,
          targetHz: noteToFrequency(note.pitch, { a4 }),
          startMs: beat * msPerQuarter,
          endMs: (beat + durBeats) * msPerQuarter,
          durBeats,
        });
      }
      beat += durBeats;
      index += 1;
    }
  }
  return { notes, totalMs: beat * msPerQuarter, msPerQuarter, bpm: tempo };
};

// Find the timeline note active at elapsed time `tMs` (its window contains tMs),
// or null in a rest / past the end. The timeline is ordered, so a small linear
// scan from a hint index keeps this cheap inside a rAF loop without re-scanning
// from 0 each frame. `fromIdx` is a lower bound the caller can advance.
export const noteAtTime = (timeline, tMs, fromIdx = 0) => {
  const notes = timeline?.notes || [];
  for (let i = Math.max(0, fromIdx); i < notes.length; i += 1) {
    const n = notes[i];
    if (tMs < n.startMs) return null;          // in a gap/rest before this note
    if (tMs < n.endMs) return { note: n, idx: i };
  }
  return null;
};

// Flatten a grade map/array into the ordered list of GRADED grades. PENDING
// (un-sung) notes are dropped so a stopped-early take isn't penalized for notes
// it never reached. A map is walked in ASCENDING note-index order so the result
// lines up note-for-note with the score (the renderer's global note index); an
// array is taken in its given order. Shared by `summarizeAccuracy` so the
// `perNote` it persists and the counts it derives come from one ordered pass.
const orderedGrades = (grades) => {
  if (Array.isArray(grades)) return grades.filter((g) => g && g !== GRADE.PENDING);
  return Object.entries(grades || {})
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, g]) => g)
    .filter((g) => g && g !== GRADE.PENDING);
};

// Aggregate per-note grades into a take summary for training mode. `grades` is a
// map (or array) of noteIndex → GRADE for the notes that were walked. Counts a
// note "in tune" only for GRADE.IN_TUNE; `percentInTune` is over the GRADED
// notes (PENDING/un-sung notes are excluded so a stopped-early take isn't
// penalized for notes it never reached). Returns counts per bucket, the
// percentage, AND `perNote` — the ordered grade list the persisted-take shape
// stores (mirrors server `sanitizeAccuracy`, so a saved take round-trips its
// grading). All derived — no side effects.
export const summarizeAccuracy = (grades) => {
  const perNote = orderedGrades(grades);
  const counts = { 'in-tune': 0, close: 0, off: 0, missed: 0 };
  for (const g of perNote) if (g in counts) counts[g] += 1;
  const graded = perNote.length;
  const percentInTune = graded > 0 ? Math.round((counts['in-tune'] / graded) * 100) : 0;
  return { graded, counts, percentInTune, perNote };
};

// Reconstruct a noteIndex → GRADE map from a take's persisted `perNote` list and
// its timeline, WITHOUT re-grading audio. `perNote` (from summarizeAccuracy) is
// the graded notes in ascending global-note-index order, rests excluded and
// un-reached notes absent — exactly the order `buildColorMatchTimeline` walks its
// notes — so the i-th persisted grade belongs to the i-th timeline note. Used to
// repaint the staff from a saved take on song open so the grading is read from
// disk, not recomputed from the mic (#1092). Returns an empty map for an empty
// list (a take with no graded notes paints no colors).
export const gradesFromPerNote = (timeline, perNote = []) => {
  const notes = timeline?.notes || [];
  const map = {};
  const n = Math.min(notes.length, perNote.length);
  for (let i = 0; i < n; i += 1) map[notes[i].index] = perNote[i];
  return map;
};

import { describe, it, expect } from 'vitest';
import { parseScore } from './scoreNotation.js';
import { noteToFrequency } from './pitchDetect.js';
import {
  buildColorMatchTimeline,
  noteAtTime,
  gradeNote,
  centsBetween,
  summarizeAccuracy,
  gradesFromPerNote,
  GRADE,
  MATCH_IN_TUNE_CENTS,
  MATCH_CLOSE_CENTS,
} from './colorMatch.js';

// A short, known score: four quarter notes in 4/4 at 120 BPM. At 120 BPM a
// quarter beat is 500 ms, so onsets land at 0/500/1000/1500 ms and the take is
// 2000 ms long.
const FOUR_QUARTERS = ['time: 4/4', 'tempo: 120', '| C4q D4q E4q F4q |'].join('\n');

describe('buildColorMatchTimeline', () => {
  it('converts note durations to onset/offset windows in ms at the score tempo', () => {
    const tl = buildColorMatchTimeline(parseScore(FOUR_QUARTERS));
    expect(tl.bpm).toBe(120);
    expect(tl.msPerQuarter).toBe(500);
    expect(tl.totalMs).toBe(2000);
    expect(tl.notes.map((n) => [n.startMs, n.endMs])).toEqual([
      [0, 500], [500, 1000], [1000, 1500], [1500, 2000],
    ]);
  });

  it('honors a bpm override over the score tempo', () => {
    const tl = buildColorMatchTimeline(parseScore(FOUR_QUARTERS), { bpm: 60 });
    expect(tl.bpm).toBe(60);
    expect(tl.msPerQuarter).toBe(1000); // half the speed → double the ms
    expect(tl.totalMs).toBe(4000);
  });

  it('honors the time-signature denominator (6/8 → eighth = bpm)', () => {
    // 6/8 at 120 BPM: a quarter-beat lasts (60000/120)·(8/4) = 1000 ms.
    const tl = buildColorMatchTimeline(parseScore('time: 6/8\ntempo: 120\n| C4q |'));
    expect(tl.msPerQuarter).toBe(1000);
  });

  it('skips rests but keeps the GLOBAL note index so it lines up with the renderer', () => {
    // index 0 = C4q, index 1 = rq (rest, no timeline entry), index 2 = D4q.
    const tl = buildColorMatchTimeline(parseScore('time: 4/4\ntempo: 120\n| C4q rq D4q |'));
    expect(tl.notes.map((n) => n.index)).toEqual([0, 2]);
    // The rest still advanced the clock, so D4 starts at 1000 ms (2 quarters in).
    expect(tl.notes[1].startMs).toBe(1000);
  });

  it('assigns each note its target frequency', () => {
    const tl = buildColorMatchTimeline(parseScore(FOUR_QUARTERS));
    const c4 = noteToFrequency({ letter: 'C', accidental: '', octave: 4 });
    expect(tl.notes[0].targetHz).toBeCloseTo(c4, 5);
  });
});

describe('centsBetween', () => {
  it('is 0 at unison, +100 a semitone up, −100 a semitone down', () => {
    expect(centsBetween(440, 440)).toBeCloseTo(0, 5);
    expect(centsBetween(440 * Math.pow(2, 1 / 12), 440)).toBeCloseTo(100, 2);
    expect(centsBetween(440 / Math.pow(2, 1 / 12), 440)).toBeCloseTo(-100, 2);
  });

  it('returns null for missing/invalid frequencies', () => {
    expect(centsBetween(null, 440)).toBeNull();
    expect(centsBetween(440, 0)).toBeNull();
    expect(centsBetween(NaN, 440)).toBeNull();
  });
});

describe('gradeNote', () => {
  const target = 440; // A4

  it('grades dead-on as in-tune', () => {
    expect(gradeNote(440, target)).toBe(GRADE.IN_TUNE);
  });

  it('grades just inside the in-tune threshold as in-tune', () => {
    const hz = target * Math.pow(2, (MATCH_IN_TUNE_CENTS - 1) / 1200);
    expect(gradeNote(hz, target)).toBe(GRADE.IN_TUNE);
  });

  it('grades between the in-tune and close thresholds as close', () => {
    const hz = target * Math.pow(2, ((MATCH_IN_TUNE_CENTS + MATCH_CLOSE_CENTS) / 2) / 1200);
    expect(gradeNote(hz, target)).toBe(GRADE.CLOSE);
  });

  it('grades well past the close threshold as off', () => {
    const hz = target * Math.pow(2, (MATCH_CLOSE_CENTS + 80) / 1200);
    expect(gradeNote(hz, target)).toBe(GRADE.OFF);
  });

  it('grades a missing detected pitch as missed', () => {
    expect(gradeNote(null, target)).toBe(GRADE.MISSED);
  });

  it('folds octave errors onto the nearest octave (singing an octave low still in tune)', () => {
    expect(gradeNote(target / 2, target)).toBe(GRADE.IN_TUNE);   // one octave down
    expect(gradeNote(target * 2, target)).toBe(GRADE.IN_TUNE);   // one octave up
    expect(gradeNote(target / 4, target)).toBe(GRADE.IN_TUNE);   // two octaves down
  });
});

describe('noteAtTime', () => {
  const tl = buildColorMatchTimeline(parseScore(FOUR_QUARTERS));

  it('finds the note whose window contains the time', () => {
    expect(noteAtTime(tl, 250)?.note.index).toBe(0);
    expect(noteAtTime(tl, 700)?.note.index).toBe(1);
    expect(noteAtTime(tl, 1999)?.note.index).toBe(3);
  });

  it('returns null past the end of the timeline', () => {
    expect(noteAtTime(tl, 2500)).toBeNull();
  });

  it('returns null in a rest gap before a note (cursor hint respected)', () => {
    const gapTl = buildColorMatchTimeline(parseScore('time: 4/4\ntempo: 120\n| C4q rq D4q |'));
    // 700 ms is inside the rest (500–1000) — no note active.
    expect(noteAtTime(gapTl, 700)).toBeNull();
  });

  it('respects the fromIdx lower-bound hint', () => {
    // Starting the scan past note 0 won't re-find an earlier note.
    expect(noteAtTime(tl, 250, 1)).toBeNull();
  });
});

describe('summarizeAccuracy', () => {
  it('computes percent in tune over graded notes, excluding pending', () => {
    const grades = { 0: GRADE.IN_TUNE, 1: GRADE.IN_TUNE, 2: GRADE.CLOSE, 3: GRADE.OFF };
    const s = summarizeAccuracy(grades);
    expect(s.graded).toBe(4);
    expect(s.counts).toEqual({ 'in-tune': 2, close: 1, off: 1, missed: 0 });
    expect(s.percentInTune).toBe(50);
  });

  it('excludes pending (un-sung) notes from the denominator', () => {
    const grades = { 0: GRADE.IN_TUNE, 1: GRADE.PENDING, 2: GRADE.PENDING };
    const s = summarizeAccuracy(grades);
    expect(s.graded).toBe(1);
    expect(s.percentInTune).toBe(100);
  });

  it('accepts an array of grades too', () => {
    const s = summarizeAccuracy([GRADE.IN_TUNE, GRADE.OFF]);
    expect(s.graded).toBe(2);
    expect(s.percentInTune).toBe(50);
  });

  it('returns 0% with no graded notes (avoids divide-by-zero)', () => {
    expect(summarizeAccuracy({}).percentInTune).toBe(0);
    expect(summarizeAccuracy([]).percentInTune).toBe(0);
  });

  // Release review finding: a note the singer WALKED PAST but never produced a
  // usable pitch for must be recorded as MISSED (not absent) so it counts
  // against the take. useColorMatch.stop() fills these before summarizing; here
  // we pin the lib contract that MISSED is in the denominator (unlike PENDING).
  it('counts MISSED notes in the denominator (a skipped note lowers the score)', () => {
    const grades = { 0: GRADE.IN_TUNE, 1: GRADE.MISSED, 2: GRADE.MISSED, 3: GRADE.IN_TUNE };
    const s = summarizeAccuracy(grades);
    expect(s.graded).toBe(4);
    expect(s.counts.missed).toBe(2);
    expect(s.percentInTune).toBe(50);
  });

  it('an all-MISSED take scores 0% over every walked note', () => {
    const grades = { 0: GRADE.MISSED, 1: GRADE.MISSED, 2: GRADE.MISSED };
    const s = summarizeAccuracy(grades);
    expect(s.graded).toBe(3);
    expect(s.percentInTune).toBe(0);
  });

  // #1092: the summary now carries `perNote` — the ordered grade list the
  // persisted take stores (mirrors server sanitizeAccuracy). It must be in
  // ASCENDING note-index order so a saved take lines up with the score, and
  // exclude PENDING (un-sung) notes just like the counts do.
  it('emits perNote in ascending note-index order, excluding pending', () => {
    // Deliberately out of insertion order to prove the sort, with a PENDING hole.
    const grades = { 2: GRADE.OFF, 0: GRADE.IN_TUNE, 3: GRADE.PENDING, 1: GRADE.CLOSE };
    const s = summarizeAccuracy(grades);
    expect(s.perNote).toEqual([GRADE.IN_TUNE, GRADE.CLOSE, GRADE.OFF]);
    expect(s.graded).toBe(3);
  });

  it('perNote preserves an array input order verbatim', () => {
    expect(summarizeAccuracy([GRADE.OFF, GRADE.IN_TUNE]).perNote).toEqual([GRADE.OFF, GRADE.IN_TUNE]);
  });

  it('emits an empty perNote for a take with no graded notes', () => {
    expect(summarizeAccuracy({}).perNote).toEqual([]);
  });
});

describe('gradesFromPerNote', () => {
  // The persisted-take round trip: a saved `perNote` list repaints onto the
  // staff by mapping each grade to the timeline note at the same ordinal — rests
  // are excluded from both the timeline notes and perNote, so they align.
  const tl = buildColorMatchTimeline(parseScore('time: 4/4\ntempo: 120\n| C4q rq D4q E4q |'));

  it('maps each saved grade to the timeline note at the same ordinal (rests skipped)', () => {
    // Timeline notes are at global indices 0, 2, 3 (index 1 is the rest).
    const map = gradesFromPerNote(tl, [GRADE.IN_TUNE, GRADE.CLOSE, GRADE.OFF]);
    expect(map).toEqual({ 0: GRADE.IN_TUNE, 2: GRADE.CLOSE, 3: GRADE.OFF });
  });

  it('round-trips with summarizeAccuracy.perNote', () => {
    const graded = { 0: GRADE.IN_TUNE, 2: GRADE.MISSED, 3: GRADE.OFF };
    const { perNote } = summarizeAccuracy(graded);
    expect(gradesFromPerNote(tl, perNote)).toEqual(graded);
  });

  it('tolerates a perNote shorter or longer than the timeline', () => {
    expect(gradesFromPerNote(tl, [GRADE.IN_TUNE])).toEqual({ 0: GRADE.IN_TUNE });
    // Extra grades past the last timeline note are ignored (no index to bind to).
    const over = gradesFromPerNote(tl, [GRADE.IN_TUNE, GRADE.OFF, GRADE.OFF, GRADE.CLOSE, GRADE.OFF]);
    expect(over).toEqual({ 0: GRADE.IN_TUNE, 2: GRADE.OFF, 3: GRADE.OFF });
  });

  it('returns an empty map for an empty perNote', () => {
    expect(gradesFromPerNote(tl, [])).toEqual({});
    expect(gradesFromPerNote(tl)).toEqual({});
  });
});

import { describe, expect, it } from 'vitest';
import { GRADE } from './colorMatch.js';
import { noteToFrequency } from './pitchDetect.js';
import { parseScore } from './scoreNotation.js';
import { alignSingToVerify } from './singToVerify.js';

const hz = (pitch) => noteToFrequency(pitch);
const frame = (tMs, pitch, clarity = 0.98) => ({ tMs, hz: hz(pitch), clarity });
const score = parseScore('key: C\ntime: 4/4\ntempo: 120\n| C4q D4q E4q F4q |');

describe('alignSingToVerify', () => {
  it('aligns an exact match and an off-by-a-semitone pitch to written windows', () => {
    const rows = alignSingToVerify(score, [
      frame(100, { letter: 'C', octave: 4 }),
      frame(600, { letter: 'D', accidental: '#', octave: 4 }),
    ], { captureEndMs: 1000 });
    expect(rows[0]).toMatchObject({
      index: 0,
      written: { letter: 'C', accidental: '', octave: 4 },
      sung: { letter: 'C', accidental: '', octave: 4 },
      grade: GRADE.IN_TUNE,
      accepted: false,
    });
    expect(rows[1].grade).toBe(GRADE.OFF);
    expect(rows[1].cents).toBeCloseTo(100, 1);
    expect(rows[2].grade).toBe(GRADE.PENDING);
  });

  it('keeps octave differences as corrections instead of folding them', () => {
    const rows = alignSingToVerify(score, [
      frame(100, { letter: 'C', octave: 5 }),
    ], { captureEndMs: 500 });
    expect(rows[0].sung).toMatchObject({ letter: 'C', octave: 5 });
    expect(rows[0].cents).toBeCloseTo(1200, 1);
    expect(rows[0].grade).toBe(GRADE.OFF);
  });

  it('grades a reached silent window missed and leaves later notes pending', () => {
    const rows = alignSingToVerify(score, [
      { tMs: 100, hz: null, clarity: 0.1 },
    ], { captureEndMs: 500 });
    expect(rows[0].grade).toBe(GRADE.MISSED);
    expect(rows[1].grade).toBe(GRADE.PENDING);
  });

  it('offsets capture time to the selected start bar', () => {
    const twoBars = parseScore('time: 2/4\ntempo: 120\n| C4q D4q |\n| E4q F4q |');
    const rows = alignSingToVerify(twoBars, [
      frame(100, { letter: 'E', octave: 4 }),
    ], { startBar: 2, captureEndMs: 500 });
    expect(rows.map((row) => row.index)).toEqual([2, 3]);
    expect(rows[0].grade).toBe(GRADE.IN_TUNE);
  });

  it('keeps leading rests in the selected bar on the capture clock', () => {
    const withRest = parseScore('time: 2/4\ntempo: 120\n| C4h |\n| rq E4q |');
    const rows = alignSingToVerify(withRest, [
      frame(600, { letter: 'E', octave: 4 }),
    ], { startBar: 2, captureEndMs: 1000 });
    expect(rows[0].index).toBe(2);
    expect(rows[0].grade).toBe(GRADE.IN_TUNE);
  });

  it('marks notes after an early stop pending', () => {
    const rows = alignSingToVerify(score, [
      frame(100, { letter: 'C', octave: 4 }),
    ], { captureEndMs: 600 });
    expect(rows[0].grade).toBe(GRADE.IN_TUNE);
    expect(rows[1].grade).toBe(GRADE.MISSED);
    expect(rows[2].grade).toBe(GRADE.PENDING);
    expect(rows[3].grade).toBe(GRADE.PENDING);
  });
});
// @vitest-environment node

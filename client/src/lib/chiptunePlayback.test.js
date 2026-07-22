// Pure-schedule tests for the chiptune preview (#2911). Only the Web-Audio-free
// exports are exercised (buildChiptuneSchedule / parseChiptunePitch); the
// timing semantics here MUST agree with server/lib/chiptuneScore.test.js —
// the two flatteners are mirrors of the same contract.
import { describe, expect, it } from 'vitest';
import { buildChiptuneSchedule, parseChiptunePitch } from './chiptunePlayback.js';

const score = () => ({
  version: 1,
  bpm: 120,
  stepsPerBeat: 4,
  beatsPerBar: 4,
  channels: [
    { id: 'pulse1', wave: 'square', duty: 0.25, gain: 0.5 },
    { id: 'noise', wave: 'noise', gain: 0.3 },
  ],
  patterns: {
    A: {
      bars: 1,
      notes: {
        pulse1: [{ step: 0, pitch: 'C5', len: 4, vel: 0.9 }],
        noise: [{ step: 8, pitch: 'snare', len: 1 }],
      },
    },
  },
  order: ['A', 'A'],
});

describe('parseChiptunePitch', () => {
  it('parses scientific pitch strings to MIDI', () => {
    expect(parseChiptunePitch('C4')).toBe(60);
    expect(parseChiptunePitch('A4')).toBe(69);
    expect(parseChiptunePitch('F#3')).toBe(54);
    expect(parseChiptunePitch('Bb2')).toBe(46);
    expect(parseChiptunePitch('snare')).toBeNull();
    expect(parseChiptunePitch('')).toBeNull();
  });
});

describe('buildChiptuneSchedule', () => {
  it('mirrors the server flatten: step-exact timing, back-to-back order', () => {
    const { events, stepSec, totalSec } = buildChiptuneSchedule(score());
    expect(stepSec).toBeCloseTo(0.125);
    expect(totalSec).toBeCloseTo(4); // 2 × 16 steps × 0.125s
    const tones = events.filter((e) => e.freq);
    expect(tones.map((e) => e.startSec)).toEqual([0, 2]);
    expect(tones[0].durSec).toBeCloseTo(0.5);
    expect(tones[0].duty).toBe(0.25);
    const drums = events.filter((e) => e.noise);
    expect(drums.map((e) => e.noise)).toEqual(['snare', 'snare']);
    expect(drums[0].startSec).toBeCloseTo(1);
  });

  it('drops out-of-pattern notes, clamps overhang, skips unresolvable pitches', () => {
    const s = score();
    s.patterns.A.notes.pulse1 = [
      { step: 20, pitch: 'C5', len: 2 },   // past the 16-step pattern → dropped
      { step: 14, pitch: 'D5', len: 8 },   // overhang → clamped to 2 steps
      { step: 2, pitch: 'xyz', len: 2 },   // unparseable → dropped
    ];
    s.patterns.A.notes.noise = [{ step: 0, pitch: 'C2', len: 1 }]; // not a preset → dropped
    const { events } = buildChiptuneSchedule(s);
    expect(events.filter((e) => e.noise)).toHaveLength(0);
    const tones = events.filter((e) => e.freq);
    expect(tones).toHaveLength(2); // the clamped D5, once per order entry
    expect(tones[0].durSec).toBeCloseTo(0.25);
  });

  it('degrades to an empty schedule on a missing/garbage score', () => {
    expect(buildChiptuneSchedule(null).events).toEqual([]);
    expect(buildChiptuneSchedule({}).events).toEqual([]);
    expect(buildChiptuneSchedule({ channels: [], order: [] }).totalSec).toBe(0);
  });
});

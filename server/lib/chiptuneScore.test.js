import { describe, expect, it } from 'vitest';
import {
  chiptuneScoreSchema, sanitizeChiptuneScore, pitchToMidi, midiToFreq,
  buildScoreEvents, scoreDurationSec, scoreTotalSteps, CHIPTUNE_LIMITS,
} from './chiptuneScore.js';

// A minimal valid score: 1 bar of 4/4 at 120 BPM, 4 steps/beat → 16 steps,
// stepSec = 60/(120·4) = 0.125s, loop = 2s.
const validScore = () => ({
  version: 1,
  title: 'Test loop',
  bpm: 120,
  stepsPerBeat: 4,
  beatsPerBar: 4,
  channels: [
    { id: 'pulse1', wave: 'square', duty: 0.5, gain: 0.5 },
    { id: 'triangle', wave: 'triangle', gain: 0.6 },
    { id: 'noise', wave: 'noise', gain: 0.3 },
  ],
  patterns: {
    A: {
      bars: 1,
      notes: {
        pulse1: [{ step: 0, pitch: 'C5', len: 4, vel: 0.8 }, { step: 8, pitch: 'E5', len: 4 }],
        triangle: [{ step: 0, pitch: 'C3', len: 16 }],
        noise: [{ step: 0, pitch: 'kick', len: 1 }, { step: 8, pitch: 'snare', len: 1 }],
      },
    },
  },
  order: ['A'],
});

describe('chiptuneScoreSchema', () => {
  it('accepts a valid score', () => {
    expect(chiptuneScoreSchema.safeParse(validScore()).success).toBe(true);
  });

  it('rejects an order entry referencing an unknown pattern', () => {
    const score = validScore();
    score.order = ['A', 'B'];
    expect(chiptuneScoreSchema.safeParse(score).success).toBe(false);
  });

  it('rejects prototype-chain order entries that are not own pattern keys', () => {
    for (const name of ['toString', 'constructor']) {
      const score = validScore();
      score.order = [name];
      expect(chiptuneScoreSchema.safeParse(score).success).toBe(false);
    }
  });

  it('rejects notes on an undeclared channel', () => {
    const score = validScore();
    score.patterns.A.notes.pulse2 = [{ step: 0, pitch: 'G4', len: 2 }];
    expect(chiptuneScoreSchema.safeParse(score).success).toBe(false);
  });

  it('binds each channel id to its fixed waveform', () => {
    const score = validScore();
    score.channels[0].wave = 'noise'; // pulse1 must be square
    expect(chiptuneScoreSchema.safeParse(score).success).toBe(false);
    const score2 = validScore();
    score2.channels[2].wave = 'square'; // noise must be noise
    expect(chiptuneScoreSchema.safeParse(score2).success).toBe(false);
  });

  it('rejects a score whose aggregate voiced time exceeds the note-seconds cap', () => {
    // 60 BPM, 1 step/beat → 1s steps; one 4-step bar per pattern. 30 order
    // entries × 4 steps = 120s loop (under 180s), but 512 full-pattern notes
    // per channel push voiced time to 512×4×30 steps ≫ 720s.
    const score = validScore();
    score.bpm = 60;
    score.stepsPerBeat = 1;
    score.patterns.A.notes.pulse1 = Array.from({ length: 512 }, () => ({ step: 0, pitch: 'C5', len: 4 }));
    score.order = Array(30).fill('A');
    const r = chiptuneScoreSchema.safeParse(score);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error.issues)).toContain('too much voiced audio');
  });

  it('rejects duplicate channel ids', () => {
    const score = validScore();
    score.channels.push({ id: 'pulse1', wave: 'square' });
    expect(chiptuneScoreSchema.safeParse(score).success).toBe(false);
  });

  it('accepts a long-but-bounded loop and rejects one past the caps', () => {
    const score = validScore();
    score.bpm = 240; // stepSec 0.0625 — keeps a long order under the duration cap
    score.patterns.A.bars = 16; // 256 steps per order entry
    score.order = Array(11).fill('A'); // 2816 steps ≈ 176s — inside both caps
    expect(chiptuneScoreSchema.safeParse(score).success).toBe(true);
    score.order = Array(CHIPTUNE_LIMITS.ORDER_MAX).fill('A'); // 8192 steps / 512s — past both
    expect(chiptuneScoreSchema.safeParse(score).success).toBe(false);
  });

  it('rejects a schema-valid-shape score whose loop exceeds the duration cap', () => {
    // 40 BPM at 1 step/beat = 1.5s/step: 16 bars × 4 steps/bar × 3 order
    // entries = 192 steps = 288s — well under the step cap but over 180s.
    const score = validScore();
    score.bpm = 40;
    score.stepsPerBeat = 1;
    score.patterns.A.bars = 16;
    score.order = ['A', 'A', 'A'];
    const r = chiptuneScoreSchema.safeParse(score);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error.issues)).toContain('loop is too long');
  });

  it('rejects a wrong version and non-integer steps', () => {
    expect(chiptuneScoreSchema.safeParse({ ...validScore(), version: 2 }).success).toBe(false);
    const score = validScore();
    score.patterns.A.notes.pulse1[0].step = 1.5;
    expect(chiptuneScoreSchema.safeParse(score).success).toBe(false);
  });
});

describe('sanitizeChiptuneScore', () => {
  it('returns the canonical score for valid input and null otherwise', () => {
    expect(sanitizeChiptuneScore(validScore())).toMatchObject({ bpm: 120 });
    expect(sanitizeChiptuneScore(null)).toBeNull();
    expect(sanitizeChiptuneScore('nope')).toBeNull();
    expect(sanitizeChiptuneScore({ version: 1 })).toBeNull();
  });
});

describe('pitch math', () => {
  it('parses scientific pitch to MIDI', () => {
    expect(pitchToMidi('C4')).toBe(60);
    expect(pitchToMidi('A4')).toBe(69);
    expect(pitchToMidi('F#3')).toBe(54);
    expect(pitchToMidi('Bb2')).toBe(46);
    expect(pitchToMidi('kick')).toBeNull();
    expect(pitchToMidi('')).toBeNull();
  });

  it('converts MIDI to frequency (A4 = 440)', () => {
    expect(midiToFreq(69)).toBeCloseTo(440);
    expect(midiToFreq(57)).toBeCloseTo(220);
    expect(midiToFreq(null)).toBeNull();
  });
});

describe('buildScoreEvents', () => {
  it('lays patterns back to back with step-exact timing', () => {
    const score = validScore();
    score.order = ['A', 'A'];
    const { events, stepSec, totalSteps, totalSec } = buildScoreEvents(score);
    expect(stepSec).toBeCloseTo(0.125);
    expect(totalSteps).toBe(32);
    expect(totalSec).toBeCloseTo(4);
    // The second loop of the melody starts one pattern (2s) after the first.
    const c5s = events.filter((e) => e.channelId === 'pulse1' && Math.abs(e.freq - midiToFreq(72)) < 1e-6);
    expect(c5s.map((e) => e.startSec)).toEqual([0, 2]);
    expect(c5s[0].durSec).toBeCloseTo(0.5);
  });

  it('drops out-of-pattern notes and clamps overhang to the pattern end', () => {
    const score = validScore();
    score.patterns.A.notes.pulse1 = [
      { step: 20, pitch: 'C5', len: 2 },  // starts past the 16-step pattern → dropped
      { step: 14, pitch: 'D5', len: 8 },  // overhangs → clamped to 2 steps
    ];
    const { events } = buildScoreEvents(score);
    const pulse = events.filter((e) => e.channelId === 'pulse1');
    expect(pulse).toHaveLength(1);
    expect(pulse[0].durSec).toBeCloseTo(2 * 0.125);
  });

  it('drops unparseable tonal pitches and unknown noise presets, keeps the rest', () => {
    const score = validScore();
    score.patterns.A.notes.pulse1 = [{ step: 0, pitch: 'H9x', len: 2 }, { step: 4, pitch: 'G4', len: 2 }];
    score.patterns.A.notes.noise = [{ step: 0, pitch: 'C2', len: 1 }, { step: 2, pitch: 'hat', len: 1 }];
    const { events } = buildScoreEvents(score);
    expect(events.filter((e) => e.channelId === 'pulse1')).toHaveLength(1);
    const noise = events.filter((e) => e.channelId === 'noise');
    expect(noise).toHaveLength(1);
    expect(noise[0].noise).toBe('hat');
  });

  it('scoreDurationSec / scoreTotalSteps agree with the event flatten', () => {
    const score = validScore();
    score.order = ['A', 'A', 'A'];
    expect(scoreTotalSteps(score)).toBe(48);
    expect(scoreDurationSec(score)).toBeCloseTo(6);
    expect(buildScoreEvents(score).totalSec).toBeCloseTo(scoreDurationSec(score));
  });
});

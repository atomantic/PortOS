import { describe, it, expect } from 'vitest';
import {
  COGNITIVE_DRILL_TYPES,
  STROOP_COLORS,
  generateNBack,
  generateDigitSpan,
  generateStroop,
  generateCognitiveDrill,
  scoreCognitiveDrill,
} from './meatspacePostCognitive.js';

describe('cognitive drill generators', () => {
  it('n-back respects n/length clamps and never places a target in the lead-in', () => {
    const drill = generateNBack({ n: 2, length: 24 });
    expect(drill.type).toBe('n-back');
    expect(drill.config.n).toBe(2);
    expect(drill.sequence).toHaveLength(24);
    expect(drill.targets.slice(0, 2)).toEqual([false, false]);
    // targets mirror the actual n-back relationship
    drill.sequence.forEach((letter, i) => {
      if (i < 2) return;
      const isMatch = letter === drill.sequence[i - 2];
      expect(drill.targets[i]).toBe(isMatch);
    });
  });

  it('n-back clamps out-of-range n and length', () => {
    const drill = generateNBack({ n: 9, length: 1 });
    expect(drill.config.n).toBeLessThanOrEqual(3);
    expect(drill.config.n).toBeGreaterThanOrEqual(1);
    expect(drill.sequence.length).toBeGreaterThanOrEqual(drill.config.n + 5);
  });

  it('digit-span builds one sequence per length from start to max', () => {
    const drill = generateDigitSpan({ direction: 'backward', startLength: 3, maxLength: 6 });
    expect(drill.type).toBe('digit-span');
    expect(drill.config.direction).toBe('backward');
    expect(drill.sequences.map(s => s.length)).toEqual([3, 4, 5, 6]);
    for (const s of drill.sequences) {
      expect(s.digits).toHaveLength(s.length);
      for (const d of s.digits) expect(d).toBeGreaterThanOrEqual(0), expect(d).toBeLessThanOrEqual(9);
    }
  });

  it('digit-span never yields an empty drill when maxLength is unset and startLength is at its ceiling', () => {
    // Regression: clampInt used to return maxLength's fallback (8) un-clamped, so
    // startLength=9 + no maxLength gave maxLength 8 < 9 → zero sequences → instant score 0.
    const drill = generateDigitSpan({ startLength: 9 });
    expect(drill.sequences.length).toBeGreaterThanOrEqual(1);
    expect(drill.sequences[0].length).toBe(9);
  });

  it('stroop produces the requested trial count with a valid ink answer', () => {
    const drill = generateStroop({ count: 12 });
    expect(drill.type).toBe('stroop');
    expect(drill.trials).toHaveLength(12);
    const names = STROOP_COLORS.map(c => c.name);
    for (const t of drill.trials) {
      expect(names).toContain(t.word);
      expect(names).toContain(t.inkColor);
      expect(t.congruent).toBe(t.word === t.inkColor);
    }
    expect(drill.options.map(o => o.name).sort()).toEqual([...names].sort());
  });

  it('generateCognitiveDrill dispatches by type and returns null for unknown', () => {
    expect(generateCognitiveDrill('n-back').type).toBe('n-back');
    expect(generateCognitiveDrill('digit-span').type).toBe('digit-span');
    expect(generateCognitiveDrill('stroop').type).toBe('stroop');
    expect(generateCognitiveDrill('nope')).toBeNull();
  });

  it('exposes exactly the three shipped cognitive types', () => {
    expect(COGNITIVE_DRILL_TYPES).toEqual(['n-back', 'digit-span', 'stroop']);
  });
});

describe('cognitive drill scorers (recompute the answer key, never trust client)', () => {
  it('n-back scores a perfect run near the top and rewards no wrong presses', () => {
    // Deterministic sequence: A B A B A → with n=2, positions 2,3,4 are all targets.
    const drillData = { type: 'n-back', config: { n: 2, stimulusMs: 2000 }, sequence: ['A', 'B', 'A', 'B', 'A'] };
    const questions = [
      { index: 2, answered: 'match', responseMs: 400 },
      { index: 3, answered: 'match', responseMs: 400 },
      { index: 4, answered: 'match', responseMs: 400 },
    ];
    const { score, questions: scored } = scoreCognitiveDrill('n-back', drillData, questions);
    expect(scored.every(q => q.correct)).toBe(true);
    // Score is the shared 80% accuracy + 20% speed blend: perfect accuracy floors
    // it at 80, and a 400ms avg response against the 2000ms stimulus window adds
    // 0.2 × (1 − 400/2000) × 100 = 16 → 96. (100 is only reached at instantaneous
    // response, so it's an aspirational ceiling, like a golf score.)
    expect(score).toBe(96);
  });

  it('n-back marks a false-positive press wrong even if client claims correct', () => {
    const drillData = { type: 'n-back', config: { n: 2 }, sequence: ['A', 'B', 'C', 'D'] };
    // index 2 (C) is NOT a match of index 0 (A); pressing "match" is wrong.
    const { score, questions } = scoreCognitiveDrill('n-back', drillData, [
      { index: 2, answered: 'match', correct: true, responseMs: 300 },
      { index: 3, answered: null, responseMs: 0 },
    ]);
    expect(questions[0].correct).toBe(false); // client's correct:true ignored
    expect(questions[1].correct).toBe(true); // correctly withheld
    expect(score).toBeLessThan(100);
  });

  it('digit-span expects the reversed sequence for the backward variant', () => {
    const drillData = {
      type: 'digit-span',
      config: { direction: 'backward', maxLength: 4 },
      sequences: [{ digits: [1, 2, 3], length: 3 }, { digits: [4, 5, 6, 7], length: 4 }],
    };
    const { questions } = scoreCognitiveDrill('digit-span', drillData, [
      { index: 0, answered: '321', responseMs: 2000 }, // correct reverse
      { index: 1, answered: '4567', responseMs: 2000 }, // forward → wrong for backward
    ]);
    expect(questions[0].correct).toBe(true);
    expect(questions[0].expected).toBe('321');
    expect(questions[1].correct).toBe(false);
    expect(questions[1].expected).toBe('7654');
  });

  it('stroop grades against the ink color, not the word', () => {
    const drillData = {
      type: 'stroop',
      trials: [
        { word: 'red', inkColor: 'blue', inkHex: '#3b82f6' },
        { word: 'green', inkColor: 'green', inkHex: '#22c55e' },
      ],
    };
    const { questions } = scoreCognitiveDrill('stroop', drillData, [
      { index: 0, answered: 'blue', responseMs: 500 }, // ink=blue → correct
      { index: 1, answered: 'green', responseMs: 500 },
    ]);
    expect(questions[0].correct).toBe(true);
    expect(questions[1].correct).toBe(true);
  });

  it('unknown type yields a zero score and passes questions through', () => {
    const result = scoreCognitiveDrill('mystery', {}, [{ index: 0 }]);
    expect(result.score).toBe(0);
    expect(result.questions).toHaveLength(1);
  });
});

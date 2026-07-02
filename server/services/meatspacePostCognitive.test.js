import { describe, it, expect } from 'vitest';
import {
  COGNITIVE_DRILL_TYPES,
  STROOP_COLORS,
  generateNBack,
  generateDigitSpan,
  generateStroop,
  generateSchulteTable,
  generateMentalRotation,
  generateReactionTime,
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
    expect(generateCognitiveDrill('schulte-table').type).toBe('schulte-table');
    expect(generateCognitiveDrill('mental-rotation').type).toBe('mental-rotation');
    expect(generateCognitiveDrill('reaction-time').type).toBe('reaction-time');
    expect(generateCognitiveDrill('nope')).toBeNull();
  });

  it('exposes exactly the six shipped cognitive types', () => {
    expect(COGNITIVE_DRILL_TYPES).toEqual(['n-back', 'digit-span', 'stroop', 'schulte-table', 'mental-rotation', 'reaction-time']);
  });

  it('schulte-table shuffles 1..size*size into every cell exactly once', () => {
    const drill = generateSchulteTable({ size: 4 });
    expect(drill.type).toBe('schulte-table');
    expect(drill.config.size).toBe(4);
    expect(drill.cells).toHaveLength(16);
    expect([...drill.cells].sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });

  it('schulte-table clamps out-of-range size', () => {
    const drill = generateSchulteTable({ size: 100 });
    expect(drill.config.size).toBeLessThanOrEqual(7);
    const drill2 = generateSchulteTable({ size: 0 });
    expect(drill2.config.size).toBeGreaterThanOrEqual(3);
  });

  it('mental-rotation produces 4 options per trial with a valid correctIndex', () => {
    const drill = generateMentalRotation({ count: 6 });
    expect(drill.type).toBe('mental-rotation');
    expect(drill.trials).toHaveLength(6);
    for (const trial of drill.trials) {
      expect(trial.options).toHaveLength(4);
      expect(trial.correctIndex).toBeGreaterThanOrEqual(0);
      expect(trial.correctIndex).toBeLessThan(4);
      expect(Array.isArray(trial.target)).toBe(true);
      // Every option's cell count matches the base shape's (rotation/mirroring
      // preserve cell count) — a cheap sanity check that nothing was corrupted.
      for (const opt of trial.options) expect(opt.length).toBe(trial.target.length);
    }
  });

  it('reaction-time defaults to simple mode with no per-trial target', () => {
    const drill = generateReactionTime({ count: 5 });
    expect(drill.type).toBe('reaction-time');
    expect(drill.config.mode).toBe('simple');
    expect(drill.trials).toHaveLength(5);
    for (const trial of drill.trials) {
      expect(trial.target).toBeUndefined();
      expect(trial.delayMs).toBeGreaterThanOrEqual(drill.config.minDelayMs);
      expect(trial.delayMs).toBeLessThanOrEqual(drill.config.maxDelayMs);
    }
  });

  it('reaction-time choice mode assigns a target index within range', () => {
    const drill = generateReactionTime({ mode: 'choice', count: 8, choices: 4 });
    expect(drill.config.mode).toBe('choice');
    expect(drill.config.choices).toBe(4);
    for (const trial of drill.trials) {
      expect(trial.target).toBeGreaterThanOrEqual(0);
      expect(trial.target).toBeLessThan(4);
    }
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

  it('schulte-table grades each "find the next number" step by expected position', () => {
    const drillData = { type: 'schulte-table', config: { size: 3 } };
    const { score, questions } = scoreCognitiveDrill('schulte-table', drillData, [
      { index: 0, answered: 1, responseMs: 500 }, // correct: expects 1
      { index: 1, answered: 3, responseMs: 500 }, // wrong: expects 2
    ]);
    expect(questions[0].correct).toBe(true);
    expect(questions[1].correct).toBe(false);
    expect(questions[1].expected).toBe(2);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });

  it('mental-rotation recomputes the answer from trials[index].correctIndex, not client claims', () => {
    const drillData = {
      type: 'mental-rotation',
      trials: [
        { shape: 'F', correctIndex: 2 },
        { shape: 'L', correctIndex: 0 },
      ],
    };
    const { questions } = scoreCognitiveDrill('mental-rotation', drillData, [
      { index: 0, answered: 2, correct: false, responseMs: 3000 }, // client lied "false"; actually correct
      { index: 1, answered: 1, correct: true, responseMs: 3000 }, // client lied "true"; actually wrong
    ]);
    expect(questions[0].correct).toBe(true);
    expect(questions[1].correct).toBe(false);
  });

  it('reaction-time simple mode marks a false start wrong even with a fast responseMs', () => {
    const drillData = { type: 'reaction-time', config: { mode: 'simple' }, trials: [{ delayMs: 1000 }, { delayMs: 1000 }] };
    const { questions, score } = scoreCognitiveDrill('reaction-time', drillData, [
      { index: 0, answered: 'react', responseMs: 220, falseStart: false },
      { index: 1, answered: null, responseMs: 0, falseStart: true, correct: true }, // client lied "true"
    ]);
    expect(questions[0].correct).toBe(true);
    expect(questions[1].correct).toBe(false);
    expect(score).toBeGreaterThan(0);
  });

  it('reaction-time choice mode requires the answered index to match the trial target', () => {
    const drillData = { type: 'reaction-time', config: { mode: 'choice', choices: 3 }, trials: [{ delayMs: 800, target: 1 }] };
    const { questions } = scoreCognitiveDrill('reaction-time', drillData, [
      { index: 0, answered: 1, responseMs: 400 },
    ]);
    expect(questions[0].correct).toBe(true);
    expect(questions[0].expected).toBe('1');

    const wrong = scoreCognitiveDrill('reaction-time', drillData, [
      { index: 0, answered: 0, responseMs: 400 },
    ]);
    expect(wrong.questions[0].correct).toBe(false);
  });
});

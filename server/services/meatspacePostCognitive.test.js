import { describe, it, expect } from 'vitest';
import {
  COGNITIVE_DRILL_TYPES,
  STROOP_COLORS,
  ROTATION_SHAPES,
  generateNBack,
  generateDigitSpan,
  generateStroop,
  generateSchulteTable,
  generateMentalRotation,
  generateReactionTime,
  generateCognitiveDrill,
  scoreCognitiveDrill,
  rotateCells,
  mirrorCells,
  cellsKey,
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

  it('ROTATION_SHAPES chirality invariant: every rotation is distinct, every mirrored-rotation is distinct, and no rotation ever equals a mirrored-rotation', () => {
    // This is the invariant generateMentalRotation's distractor-fill loop relies
    // on: without it, a base shape could silently yield fewer than 3 distinct
    // mirrored distractors (an infinite-guard exhaustion) or a "distractor" that
    // is secretly a true rotation of the reference shape (a broken drill).
    for (const [shapeName, baseCells] of Object.entries(ROTATION_SHAPES)) {
      const rotationKeys = [0, 1, 2, 3].map(steps => cellsKey(rotateCells(baseCells, steps)));
      const mirrorKeys = [0, 1, 2, 3].map(steps => cellsKey(mirrorCells(rotateCells(baseCells, steps))));

      expect(new Set(rotationKeys).size, `${shapeName}: all 4 rotations must be distinct`).toBe(4);
      expect(new Set(mirrorKeys).size, `${shapeName}: all 4 mirrored-rotations must be distinct`).toBe(4);
      for (const mirrorK of mirrorKeys) {
        expect(rotationKeys, `${shapeName}: a mirrored-rotation must never equal any rotation`).not.toContain(mirrorK);
      }
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
  it('n-back scores a perfect run at 100 via signal-detection (all targets hit, no false alarms)', () => {
    // Deterministic sequence: A B A B A → with n=2, positions 2,3,4 are all targets.
    const drillData = { type: 'n-back', config: { n: 2, stimulusMs: 2000 }, sequence: ['A', 'B', 'A', 'B', 'A'] };
    const questions = [
      { index: 2, answered: 'match', responseMs: 400 },
      { index: 3, answered: 'match', responseMs: 400 },
      { index: 4, answered: 'match', responseMs: 400 },
    ];
    const { score, accuracy, hits, misses, falseAlarms, correctRejections, questions: scored } =
      scoreCognitiveDrill('n-back', drillData, questions);
    expect(scored.every(q => q.correct)).toBe(true);
    // Balanced accuracy — all 3 targets hit (hitRate 1), no non-targets to falsely
    // alarm on — is 1.0 → 100. Speed no longer folds into the n-back score.
    expect(score).toBe(100);
    expect(accuracy).toBe(1);
    expect({ hits, misses, falseAlarms, correctRejections }).toEqual({ hits: 3, misses: 0, falseAlarms: 0, correctRejections: 0 });
  });

  it('n-back marks a false-positive press wrong even if client claims correct', () => {
    const drillData = { type: 'n-back', config: { n: 2 }, sequence: ['A', 'B', 'C', 'D'] };
    // index 2 (C) is NOT a match of index 0 (A); pressing "match" is wrong.
    const { score, falseAlarms, correctRejections, questions } = scoreCognitiveDrill('n-back', drillData, [
      { index: 2, answered: 'match', correct: true, responseMs: 300 },
      { index: 3, answered: null, responseMs: 0 },
    ]);
    expect(questions[0].correct).toBe(false); // client's correct:true ignored
    expect(questions[1].correct).toBe(true); // correctly withheld
    // Only non-targets present: one false alarm + one correct rejection →
    // correct-rejection rate 0.5 → score 50.
    expect(falseAlarms).toBe(1);
    expect(correctRejections).toBe(1);
    expect(score).toBe(50);
  });

  it('n-back: never responding scores ~50 (chance), not ~70 — the do-nothing exploit is closed', () => {
    // A B A B A with n=2 → indices 2,3,4 are targets; a full-length sequence would
    // also carry non-targets, so include one. Sequence A B A C A: idx2=A(target),
    // idx3=C(non-target), idx4=A(target).
    const drillData = { type: 'n-back', config: { n: 2 }, sequence: ['A', 'B', 'A', 'C', 'A'] };
    const questions = [
      { index: 2, answered: null, responseMs: 0 },
      { index: 3, answered: null, responseMs: 0 },
      { index: 4, answered: null, responseMs: 0 },
    ];
    const { score, hits, misses, falseAlarms, correctRejections } = scoreCognitiveDrill('n-back', drillData, questions);
    // 2 targets missed (hitRate 0), 1 non-target correctly rejected (CR rate 1) →
    // balanced 0.5 → 50. (Old raw-accuracy scoring would have paid ~67 here.)
    expect({ hits, misses, falseAlarms, correctRejections }).toEqual({ hits: 0, misses: 2, falseAlarms: 0, correctRejections: 1 });
    expect(score).toBe(50);
  });

  it('n-back: always pressing is equally penalised for false alarms (~50)', () => {
    const drillData = { type: 'n-back', config: { n: 2 }, sequence: ['A', 'B', 'A', 'C', 'A'] };
    const questions = [
      { index: 2, answered: 'match', responseMs: 300 },
      { index: 3, answered: 'match', responseMs: 300 },
      { index: 4, answered: 'match', responseMs: 300 },
    ];
    const { score, hits, misses, falseAlarms, correctRejections } = scoreCognitiveDrill('n-back', drillData, questions);
    // 2 targets hit (hitRate 1), 1 non-target false-alarmed (CR rate 0) →
    // balanced 0.5 → 50.
    expect({ hits, misses, falseAlarms, correctRejections }).toEqual({ hits: 2, misses: 0, falseAlarms: 1, correctRejections: 0 });
    expect(score).toBe(50);
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
    const { questions, score, medianMs, bestMs } = scoreCognitiveDrill('reaction-time', drillData, [
      { index: 0, answered: 'react', responseMs: 220, falseStart: false },
      { index: 1, answered: null, responseMs: 0, falseStart: true, correct: true }, // client lied "true"
    ]);
    expect(questions[0].correct).toBe(true);
    expect(questions[1].correct).toBe(false);
    // The false-start trial is invalidated — only the 220ms press drives the score.
    expect(medianMs).toBe(220);
    expect(bestMs).toBe(220);
    expect(score).toBeGreaterThan(0);
  });

  it('reaction-time score is latency-driven: faster median beats slower median', () => {
    const drillData = { type: 'reaction-time', config: { mode: 'simple' }, trials: [{ delayMs: 800 }, { delayMs: 800 }, { delayMs: 800 }] };
    const fast = scoreCognitiveDrill('reaction-time', drillData, [
      { index: 0, answered: 'react', responseMs: 200 },
      { index: 1, answered: 'react', responseMs: 240 },
      { index: 2, answered: 'react', responseMs: 260 },
    ]);
    const slow = scoreCognitiveDrill('reaction-time', drillData, [
      { index: 0, answered: 'react', responseMs: 500 },
      { index: 1, answered: 'react', responseMs: 520 },
      { index: 2, answered: 'react', responseMs: 540 },
    ]);
    expect(fast.medianMs).toBe(240);
    expect(slow.medianMs).toBe(520);
    expect(fast.score).toBeGreaterThan(slow.score);
    // simple-mode reference curve: 200ms→100, 600ms→0. Median 240 → round(100*(600-240)/400)=90.
    expect(fast.score).toBe(90);
  });

  it('reaction-time scores 0 when every trial is a false start (no valid latency)', () => {
    const drillData = { type: 'reaction-time', config: { mode: 'simple' }, trials: [{ delayMs: 500 }, { delayMs: 500 }] };
    const { score, medianMs, bestMs } = scoreCognitiveDrill('reaction-time', drillData, [
      { index: 0, answered: null, responseMs: 0, falseStart: true },
      { index: 1, answered: null, responseMs: 0, falseStart: true },
    ]);
    expect(medianMs).toBe(null);
    expect(bestMs).toBe(null);
    expect(score).toBe(0);
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

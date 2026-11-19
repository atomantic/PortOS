import { describe, it, expect } from 'vitest';
import {
  STROOP_COLORS,
  ROTATION_SHAPES,
  generateNBack,
  generateDigitSpan,
  generateStroop,
  generateSchulteTable,
  generateMentalRotation,
  generateReactionTime,
  generateTaskSwitching,
  generateGoNoGo,
  generateFlanker,
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
    const drill = generateStroop({ count: 12, incongruentPct: 75 });
    expect(drill.type).toBe('stroop');
    expect(drill.trials).toHaveLength(12);
    const names = STROOP_COLORS.map(c => c.name);
    for (const t of drill.trials) {
      expect(names).toContain(t.word);
      expect(names).toContain(t.inkColor);
      expect(t.congruent).toBe(t.word === t.inkColor);
    }
    expect(drill.trials.filter(t => !t.congruent)).toHaveLength(9);
    expect(drill.config.incongruentPct).toBe(75);
    expect(drill.options.map(o => o.name).sort()).toEqual([...names].sort());
  });

  it('generateCognitiveDrill dispatches by type and returns null for unknown', () => {
    expect(generateCognitiveDrill('n-back').type).toBe('n-back');
    expect(generateCognitiveDrill('digit-span').type).toBe('digit-span');
    expect(generateCognitiveDrill('stroop').type).toBe('stroop');
    expect(generateCognitiveDrill('schulte-table').type).toBe('schulte-table');
    expect(generateCognitiveDrill('mental-rotation').type).toBe('mental-rotation');
    expect(generateCognitiveDrill('reaction-time').type).toBe('reaction-time');
    expect(generateCognitiveDrill('task-switching').type).toBe('task-switching');
    expect(generateCognitiveDrill('go-no-go').type).toBe('go-no-go');
    expect(generateCognitiveDrill('flanker').type).toBe('flanker');
    expect(generateCognitiveDrill('nope')).toBeNull();
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

  it('mental-rotation applies transformation range and option-count difficulty', () => {
    const introductory = generateMentalRotation({ count: 6, rotationComplexity: 1, optionCount: 2 });
    expect(introductory.config).toMatchObject({ rotationComplexity: 1, optionCount: 2 });
    expect(introductory.trials.every(trial => trial.rotationSteps === 1)).toBe(true);
    expect(introductory.trials.every(trial => trial.options.length === 2)).toBe(true);

    const advanced = generateMentalRotation({ count: 6, rotationComplexity: 3, optionCount: 4 });
    expect(advanced.config).toMatchObject({ rotationComplexity: 3, optionCount: 4 });
    expect(advanced.trials.every(trial => trial.rotationSteps >= 1 && trial.rotationSteps <= 3)).toBe(true);
    expect(advanced.trials.every(trial => trial.options.length === 4)).toBe(true);
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

  it('executive-control generators reproduce the same trials from the same seed', () => {
    for (const generate of [generateTaskSwitching, generateGoNoGo, generateFlanker]) {
      const first = generate({ seed: 'example-seed', count: 12 });
      const second = generate({ seed: 'example-seed', count: 12 });
      expect(second).toEqual(first);
      expect(generate({ seed: 'different-seed', count: 12 }).trials).not.toEqual(first.trials);
    }
  });

  it('task switching applies rule-count, switch-rate, cue, conflict, and deadline levers', () => {
    const drill = generateTaskSwitching({ seed: 'switch', count: 10, ruleCount: 3, switchRatePct: 50, cueStimulusIntervalMs: 400, incongruentPct: 60, responseDeadlineMs: 1200 });
    expect(drill.config).toMatchObject({ ruleCount: 3, switchRatePct: 50, cueStimulusIntervalMs: 400, incongruentPct: 60, responseDeadlineMs: 1200 });
    expect(drill.rules).toHaveLength(3);
    expect(drill.trials.filter(trial => trial.switched)).toHaveLength(5);
    expect(drill.trials.filter(trial => trial.incongruent)).toHaveLength(6);
  });

  it('go/no-go applies no-go frequency, stimulus duration, lure similarity, and deadline levers', () => {
    const drill = generateGoNoGo({ seed: 'inhibit', count: 20, noGoPct: 35, stimulusMs: 350, lureSimilarity: 'high', responseDeadlineMs: 900 });
    expect(drill.config).toMatchObject({ noGoPct: 35, stimulusMs: 350, lureSimilarity: 'high', responseDeadlineMs: 900 });
    expect(drill.trials.filter(trial => trial.kind === 'no-go')).toHaveLength(7);
    expect(new Set(drill.trials.map(trial => trial.symbol))).toEqual(new Set(['●', '◉']));
  });

  it('flanker applies congruency, distance, strength, and deadline levers', () => {
    const drill = generateFlanker({ seed: 'flank', count: 20, congruentPct: 40, flankerDistance: 1, flankerStrength: 3, responseDeadlineMs: 1000 });
    expect(drill.config).toMatchObject({ congruentPct: 40, flankerDistance: 1, flankerStrength: 3, responseDeadlineMs: 1000 });
    expect(drill.trials.filter(trial => trial.congruent)).toHaveLength(8);
    expect(drill.trials.filter(trial => !trial.congruent).every(trial => trial.target !== trial.flanker)).toBe(true);
  });
});

describe('cognitive drill scorers (recompute the answer key, never trust client)', () => {
  it('n-back scores a perfect run at 100 via signal-detection (all targets hit, no false alarms)', () => {
    // Deterministic mixed sequence: A B A C A → with n=2, positions 2 and 4 are
    // targets, 3 is a non-target — both signal classes present.
    const drillData = { type: 'n-back', config: { n: 2, stimulusMs: 2000 }, sequence: ['A', 'B', 'A', 'C', 'A'] };
    const questions = [
      { index: 2, answered: 'match', responseMs: 400 },
      { index: 3, answered: null, responseMs: 0 },
      { index: 4, answered: 'match', responseMs: 400 },
    ];
    const { score, accuracy, hits, misses, falseAlarms, correctRejections, questions: scored } =
      scoreCognitiveDrill('n-back', drillData, questions);
    expect(scored.every(q => q.correct)).toBe(true);
    // Balanced accuracy — both targets hit (hitRate 1) and the non-target
    // correctly rejected (CR rate 1) — is 1.0 → 100. Speed no longer folds in.
    expect(score).toBe(100);
    expect(accuracy).toBe(1);
    expect({ hits, misses, falseAlarms, correctRejections }).toEqual({ hits: 2, misses: 0, falseAlarms: 0, correctRejections: 1 });
  });

  it('n-back: a single-class run caps at 75 — a missing SDT class counts as chance, not a free pass', () => {
    // Legacy/stored all-non-target sequence (A B C D E, n=2 → no position matches
    // 2 back): never pressing is a perfect correct-rejection rate, but with no
    // targets ever presented the missing hit rate counts as 0.5 → (1+0.5)/2 = 75.
    const drillData = { type: 'n-back', config: { n: 2 }, sequence: ['A', 'B', 'C', 'D', 'E'] };
    const { score, accuracy } = scoreCognitiveDrill('n-back', drillData, [
      { index: 2, answered: null, responseMs: 0 },
      { index: 3, answered: null, responseMs: 0 },
      { index: 4, answered: null, responseMs: 0 },
    ]);
    expect(accuracy).toBe(0.75);
    expect(score).toBe(75);
    // All-target sequence, all hits: same cap from the other side.
    const allTargets = { type: 'n-back', config: { n: 2 }, sequence: ['A', 'B', 'A', 'B', 'A'] };
    const perfectPresses = scoreCognitiveDrill('n-back', allTargets, [
      { index: 2, answered: 'match', responseMs: 300 },
      { index: 3, answered: 'match', responseMs: 300 },
      { index: 4, answered: 'match', responseMs: 300 },
    ]);
    expect(perfectPresses.score).toBe(75);
  });

  it('generateNBack always yields BOTH signal classes among decision positions', () => {
    // The SDT scorer needs at least one target and one non-target or the score
    // caps at 75 — the generator guarantees both even at the shortest lengths.
    for (let run = 0; run < 50; run++) {
      const drill = generateCognitiveDrill('n-back', { n: 2, length: 7 });
      const decisions = drill.targets.slice(drill.config.n);
      expect(decisions.some(Boolean)).toBe(true);
      expect(decisions.some(t => !t)).toBe(true);
      // The targets mirror stays derived from the sequence (never hand-patched).
      drill.targets.forEach((t, i) => {
        const expected = i >= drill.config.n && drill.sequence[i] === drill.sequence[i - drill.config.n];
        expect(t).toBe(expected);
      });
    }
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

  it('schulte-table preserves wrong taps in order and cannot score a completed error run as perfect', () => {
    const drillData = { type: 'schulte-table', config: { size: 2 }, cells: [3, 1, 4, 2] };
    const result = scoreCognitiveDrill('schulte-table', drillData, [
      { index: 99, expected: 99, answered: 1, correct: false, responseMs: 400 },
      { index: 99, expected: 99, answered: 4, correct: true, responseMs: 200 }, // wrong; target stays 2
      { index: 0, expected: 1, answered: 2, correct: true, responseMs: 700 },
      { answered: 3, correct: true, responseMs: 500 },
      { answered: 4, correct: true, responseMs: 450 },
    ]);
    expect(result.questions.map(q => [q.expected, q.answered, q.correct])).toEqual([
      [1, 1, true],
      [2, 4, false],
      [2, 2, true],
      [3, 3, true],
      [4, 4, true],
    ]);
    expect(result).toMatchObject({ completion: 1, accuracy: 0.8, errorCount: 1, attemptCount: 5 });
    expect(result.score).toBeLessThan(100);
  });

  it('schulte-table repeated wrong inputs stay errors and incomplete runs stay incomplete', () => {
    const drillData = { type: 'schulte-table', config: { size: 3 }, cells: [1, 2, 3, 4, 5, 6, 7, 8, 9] };
    const result = scoreCognitiveDrill('schulte-table', drillData, [
      { answered: 2, responseMs: 100 },
      { answered: 2, responseMs: 200 },
      { answered: 1, responseMs: 300 },
      { answered: 2, responseMs: 400 },
    ]);
    expect(result.questions.map(q => q.expected)).toEqual([1, 1, 1, 2]);
    expect(result.errorCount).toBe(2);
    expect(result.answeredCount).toBe(2);
    expect(result.completion).toBeCloseTo(2 / 9);
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

  it('mental-rotation recomputes new drill answers from shape + rotation, not stored correctIndex', () => {
    const base = ROTATION_SHAPES.L;
    const correct = rotateCells(base, 1);
    const distractor = mirrorCells(base);
    const drillData = {
      type: 'mental-rotation',
      trials: [{ shape: 'L', rotationSteps: 1, correctIndex: 1, options: [correct, distractor] }],
    };
    const result = scoreCognitiveDrill('mental-rotation', drillData, [
      { index: 0, answered: 0, correct: false, responseMs: 3000 },
    ]);
    expect(result.questions[0]).toMatchObject({ expected: 0, answered: 0, correct: true });
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
    // simple-mode reference curve: 200ms→100, 600ms→0. Median 240, all trials
    // valid (validRate 1) → round(100*(600-240)/400)=90.
    expect(fast.score).toBe(90);
  });

  it('reaction-time: one lucky valid press among false starts cannot score 100 (valid-rate scaling)', () => {
    const drillData = { type: 'reaction-time', config: { mode: 'simple' }, trials: Array.from({ length: 4 }, () => ({ delayMs: 500 })) };
    const { score, medianMs, accuracy } = scoreCognitiveDrill('reaction-time', drillData, [
      { index: 0, answered: 'react', responseMs: 200 }, // perfect latency
      { index: 1, answered: null, responseMs: 0, falseStart: true },
      { index: 2, answered: null, responseMs: 0, falseStart: true },
      { index: 3, answered: null, responseMs: 0, falseStart: true },
    ]);
    // Latency component is perfect (200ms → 100) but only 1 of 4 trials is valid →
    // 100 × 0.25 = 25. The separated medianMs metric stays pure (200).
    expect(medianMs).toBe(200);
    expect(score).toBe(25);
    // accuracy (valid over pressed) is 1 — false starts fold into the headline
    // score and completion, not into the answered-only accuracy.
    expect(accuracy).toBe(1);
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

  it('task switching regenerates the seeded answer key and records switch cost + omissions', () => {
    const drillData = generateTaskSwitching({ seed: 'score-switch', count: 8, switchRatePct: 50, incongruentPct: 50 });
    const answers = drillData.trials.map((trial, index) => {
      const values = { color: ['blue', 'orange'], shape: ['circle', 'triangle'], fill: ['solid', 'outline'] }[trial.rule];
      const expected = values.indexOf(trial.stimulus[trial.rule]) === 0 ? 'left' : 'right';
      return { index, answered: expected, correct: false, responseMs: trial.switched ? 800 : 400 };
    });
    // Stored trial data is advisory; scoring reconstructs it from config.seed.
    drillData.trials = drillData.trials.map(() => ({ rule: 'color', stimulus: { color: 'orange' } }));
    const result = scoreCognitiveDrill('task-switching', drillData, answers);
    expect(result.score).toBeGreaterThan(80);
    expect(result.accuracy).toBe(1);
    expect(result.switchCostMs).toBe(400);
    expect(result.switchAccuracy).toBe(1);
    expect(result.repeatAccuracy).toBe(1);
    expect(result.omissions).toBe(0);
    expect(result.latencyDistributionMs).toHaveLength(8);
  });

  it('go/no-go records false alarms, omissions, balanced accuracy, and latency distribution', () => {
    const drillData = generateGoNoGo({ seed: 'score-inhibit', count: 10, noGoPct: 30 });
    const perfect = drillData.trials.map((trial, index) => ({ index, answered: trial.kind === 'go' ? 'go' : null, responseMs: trial.kind === 'go' ? 350 : 0 }));
    const result = scoreCognitiveDrill('go-no-go', drillData, perfect);
    expect(result).toMatchObject({ score: 100, accuracy: 1, falseAlarms: 0, omissions: 0, commissionErrors: 0 });
    expect(result.correctRejections).toBe(3);
    expect(result.latencyDistributionMs).toHaveLength(7);

    const alwaysPress = scoreCognitiveDrill('go-no-go', drillData, drillData.trials.map((_, index) => ({ index, answered: 'go', correct: true, responseMs: 250 })));
    expect(alwaysPress.falseAlarms).toBe(3);
    expect(alwaysPress.commissionErrors).toBe(3);
    expect(alwaysPress.falseAlarmRate).toBe(1);
    expect(alwaysPress.score).toBe(50);
  });

  it('flanker regenerates targets and records congruency cost + interference accuracy', () => {
    const drillData = generateFlanker({ seed: 'score-flank', count: 10, congruentPct: 50 });
    const answers = drillData.trials.map((trial, index) => ({ index, answered: trial.target, correct: false, responseMs: trial.congruent ? 300 : 700 }));
    drillData.trials = drillData.trials.map(() => ({ target: 'left', flanker: 'left', congruent: true }));
    const result = scoreCognitiveDrill('flanker', drillData, answers);
    expect(result.accuracy).toBe(1);
    expect(result.congruencyCostMs).toBe(400);
    expect(result.congruentAccuracy).toBe(1);
    expect(result.incongruentAccuracy).toBe(1);
    expect(result.omissions).toBe(0);
  });

  it('keeps an early exit distinct from timed omissions', () => {
    const drillData = generateFlanker({ seed: 'partial-flank', count: 8, congruentPct: 50 });
    const answers = drillData.trials.slice(0, 3).map((trial, index) => ({
      index,
      answered: index === 2 ? null : trial.target,
      responseMs: index === 2 ? drillData.config.responseDeadlineMs : 300,
    }));
    const result = scoreCognitiveDrill('flanker', drillData, answers);
    expect(result.totalCount).toBe(8);
    expect(result.completion).toBe(3 / 8);
    expect(result.omissions).toBe(1);
    expect(result.questions.slice(3).every(question => !question.attempted)).toBe(true);
  });
});

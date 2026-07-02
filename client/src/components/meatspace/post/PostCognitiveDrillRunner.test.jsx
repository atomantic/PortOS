import { describe, it, expect } from 'vitest';
import {
  localAccuracyScore,
  buildCognitiveResult,
  buildNBackQuestions,
  scoreDigitSpanRecall,
  scoreStroopTrial,
} from './PostCognitiveDrillRunner';

// Result-assembly tests for PostCognitiveDrillRunner's `finish()` builders.
// The server rescores each drill deterministically from `drillData`/`questions`
// (server/services/meatspacePostCognitive.js), so the `index`/`answered`/
// `responseMs` shape these functions produce is load-bearing — a regression
// here (n-back off-by-one, digit-span reversed-answer comparison, stroop
// ink-vs-word grading) would pass silently in the interactive UI.

describe('localAccuracyScore', () => {
  it('returns 0 for an empty question list', () => {
    expect(localAccuracyScore([])).toBe(0);
  });

  it('rounds the percentage of correct answers', () => {
    expect(localAccuracyScore([{ correct: true }, { correct: true }, { correct: false }])).toBe(67);
  });

  it('returns 100 when every question is correct', () => {
    expect(localAccuracyScore([{ correct: true }, { correct: true }])).toBe(100);
  });
});

describe('buildCognitiveResult', () => {
  it('assembles the full onComplete payload shape', () => {
    const drill = { type: 'n-back', config: { n: 2 }, sequence: ['A', 'B'] };
    const questions = [{ correct: true }, { correct: false }];
    const result = buildCognitiveResult({ type: 'n-back', drill, questions, totalMs: 4200 });
    expect(result).toEqual({
      module: 'cognitive',
      type: 'n-back',
      config: { n: 2 },
      drillData: drill,
      questions,
      score: 50,
      totalMs: 4200,
    });
  });
});

describe('buildNBackQuestions', () => {
  const seq = ['A', 'B', 'A', 'C', 'B'];
  const n = 2;

  it('excludes the first n letters — no target is defined before position n', () => {
    const answers = seq.map(() => ({ answered: null, responseMs: 0 }));
    const questions = buildNBackQuestions(seq, n, answers);
    expect(questions).toHaveLength(seq.length - n);
    expect(questions.map(q => q.index)).toEqual([2, 3, 4]);
  });

  it('includes the boundary position i === n (off-by-one guard)', () => {
    const answers = seq.map(() => ({ answered: null, responseMs: 0 }));
    const questions = buildNBackQuestions(seq, n, answers);
    // Position n=2 (seq[2]='A') IS a valid decision point (compares against seq[0]='A').
    expect(questions[0].index).toBe(2);
    expect(questions[0].prompt).toBe('A');
  });

  it('marks a true target correctly answered "match" as correct', () => {
    // i=2: seq[2]='A' === seq[0]='A' -> isTarget=true. Answered 'match' -> correct.
    const answers = seq.map(() => ({ answered: null, responseMs: 0 }));
    answers[2] = { answered: 'match', responseMs: 300 };
    const questions = buildNBackQuestions(seq, n, answers);
    const q = questions.find(q => q.index === 2);
    expect(q.correct).toBe(true);
    expect(q.answered).toBe('match');
    expect(q.responseMs).toBe(300);
  });

  it('marks a true target left unanswered as incorrect', () => {
    // i=2 is a target; no press recorded.
    const answers = seq.map(() => ({ answered: null, responseMs: 0 }));
    const questions = buildNBackQuestions(seq, n, answers);
    const q = questions.find(q => q.index === 2);
    expect(q.correct).toBe(false);
    expect(q.answered).toBeNull();
  });

  it('marks a false-alarm press (non-target answered "match") as incorrect', () => {
    // i=3: seq[3]='C' !== seq[1]='B' -> isTarget=false. Pressed match anyway -> incorrect.
    const answers = seq.map(() => ({ answered: null, responseMs: 0 }));
    answers[3] = { answered: 'match', responseMs: 250 };
    const questions = buildNBackQuestions(seq, n, answers);
    const q = questions.find(q => q.index === 3);
    expect(q.correct).toBe(false);
  });

  it('marks a correct rejection (non-target left unanswered) as correct', () => {
    // i=4: seq[4]='B' === seq[2]='A'? no -> isTarget=false. No press -> correct rejection.
    const answers = seq.map(() => ({ answered: null, responseMs: 0 }));
    const questions = buildNBackQuestions(seq, n, answers);
    const q = questions.find(q => q.index === 4);
    expect(q.correct).toBe(true);
  });
});

describe('scoreDigitSpanRecall', () => {
  it('scores a forward recall correct when digits match in shown order', () => {
    const { question, expected } = scoreDigitSpanRecall({
      digits: [1, 2, 3],
      direction: 'forward',
      index: 0,
      answeredStr: '123',
      responseMs: 1500,
    });
    expect(expected).toBe('123');
    expect(question).toEqual({
      prompt: '3-digit (forward)',
      index: 0,
      answered: '123',
      correct: true,
      responseMs: 1500,
      length: 3,
    });
  });

  it('scores a backward recall correct only when digits are reversed', () => {
    const { question, expected } = scoreDigitSpanRecall({
      digits: [1, 2, 3],
      direction: 'backward',
      index: 0,
      answeredStr: '321',
      responseMs: 900,
    });
    expect(expected).toBe('321');
    expect(question.correct).toBe(true);
  });

  it('scores a backward recall submitted in forward order as incorrect', () => {
    // Guards the exact bug class named in the issue: comparing against the
    // wrong ordering for backward digit-span.
    const { question } = scoreDigitSpanRecall({
      digits: [1, 2, 3],
      direction: 'backward',
      index: 0,
      answeredStr: '123',
      responseMs: 900,
    });
    expect(question.correct).toBe(false);
  });

  it('treats an empty answer as unanswered (null), not empty-string-correct', () => {
    const { question } = scoreDigitSpanRecall({
      digits: [4, 5],
      direction: 'forward',
      index: 1,
      answeredStr: '',
      responseMs: 0,
    });
    expect(question.answered).toBeNull();
    expect(question.correct).toBe(false);
  });

  it('strips non-digit characters before comparing', () => {
    const { question } = scoreDigitSpanRecall({
      digits: [7, 8, 9],
      direction: 'forward',
      index: 0,
      answeredStr: '7-8-9',
      responseMs: 500,
    });
    expect(question.answered).toBe('789');
    expect(question.correct).toBe(true);
  });
});

describe('scoreStroopTrial', () => {
  it('grades correct when the picked color matches the INK color, not the word', () => {
    // Classic Stroop conflict: word says "RED" but ink is rendered blue.
    const trial = { word: 'RED', inkColor: 'blue' };
    const question = scoreStroopTrial({ trial, index: 0, colorName: 'blue', responseMs: 800 });
    expect(question).toEqual({
      prompt: 'RED',
      index: 0,
      answered: 'blue',
      correct: true,
      responseMs: 800,
    });
  });

  it('grades incorrect when the picked color matches the word text instead of the ink', () => {
    // Guards the exact bug class named in the issue: accidentally grading
    // against the word rather than the ink color.
    const trial = { word: 'RED', inkColor: 'blue' };
    const question = scoreStroopTrial({ trial, index: 0, colorName: 'red', responseMs: 800 });
    expect(question.correct).toBe(false);
  });

  it('grades correct on a congruent trial where word and ink agree', () => {
    const trial = { word: 'GREEN', inkColor: 'green' };
    const question = scoreStroopTrial({ trial, index: 2, colorName: 'green', responseMs: 400 });
    expect(question.correct).toBe(true);
  });
});

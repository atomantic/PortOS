import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import PostCognitiveDrillRunner, {
  localAccuracyScore,
  buildCognitiveResult,
  buildNBackQuestions,
  scoreDigitSpanRecall,
  scoreStroopTrial,
  scoreMentalRotationTrial,
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
  it('assembles the full onComplete payload shape (stroop keeps raw accuracy)', () => {
    const drill = { type: 'stroop', config: { count: 2 }, trials: [] };
    const questions = [{ correct: true }, { correct: false }];
    const result = buildCognitiveResult({ type: 'stroop', drill, questions, totalMs: 4200 });
    expect(result).toEqual({
      module: 'cognitive',
      type: 'stroop',
      config: { count: 2 },
      drillData: drill,
      questions,
      score: 50,
      totalMs: 4200,
    });
  });

  it('n-back pre-save score mirrors the server SDT balanced accuracy (issue #2094)', () => {
    // A B A C A with n=2 → indices 2,4 are targets, 3 is a non-target.
    const drill = { type: 'n-back', config: { n: 2 }, sequence: ['A', 'B', 'A', 'C', 'A'] };
    // Never pressing: hitRate 0, correct-rejection rate 1 → balanced 50, not ~67.
    const silent = [
      { index: 2, answered: null, correct: false, responseMs: 0 },
      { index: 3, answered: null, correct: true, responseMs: 0 },
      { index: 4, answered: null, correct: false, responseMs: 0 },
    ];
    expect(buildCognitiveResult({ type: 'n-back', drill, questions: silent, totalMs: 1 }).score).toBe(50);
    // Perfect run → 100.
    const perfect = [
      { index: 2, answered: 'match', correct: true, responseMs: 300 },
      { index: 3, answered: null, correct: true, responseMs: 0 },
      { index: 4, answered: 'match', correct: true, responseMs: 300 },
    ];
    expect(buildCognitiveResult({ type: 'n-back', drill, questions: perfect, totalMs: 1 }).score).toBe(100);
  });

  it('reaction-time pre-save score mirrors the server latency scoring (issue #2094)', () => {
    const drill = { type: 'reaction-time', config: { mode: 'simple' }, trials: [] };
    // All valid at 240ms median → round(100*(600-240)/400) = 90 (matches server).
    const clean = [
      { correct: true, falseStart: false, responseMs: 200 },
      { correct: true, falseStart: false, responseMs: 240 },
      { correct: true, falseStart: false, responseMs: 260 },
    ];
    expect(buildCognitiveResult({ type: 'reaction-time', drill, questions: clean, totalMs: 1 }).score).toBe(90);
    // One perfect press among 3 false starts → 100 × 1/4 = 25 (valid-rate scaling).
    const sloppy = [
      { correct: true, falseStart: false, responseMs: 200 },
      { correct: false, falseStart: true, responseMs: 0 },
      { correct: false, falseStart: true, responseMs: 0 },
      { correct: false, falseStart: true, responseMs: 0 },
    ];
    expect(buildCognitiveResult({ type: 'reaction-time', drill, questions: sloppy, totalMs: 1 }).score).toBe(25);
    // A clean-but-very-slow run no longer shows a pre-save 100.
    const slow = [{ correct: true, falseStart: false, responseMs: 580 }];
    expect(buildCognitiveResult({ type: 'reaction-time', drill, questions: slow, totalMs: 1 }).score).toBe(5);
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

describe('scoreMentalRotationTrial', () => {
  it('grades correct when the picked option is the rotated (non-mirrored) match', () => {
    const trial = { shape: 'L', correctIndex: 1 };
    const question = scoreMentalRotationTrial({ trial, index: 0, optionIndex: 1, responseMs: 650 });
    expect(question).toEqual({
      prompt: 'shape L',
      index: 0,
      answered: 1,
      correct: true,
      responseMs: 650,
    });
  });

  it('grades incorrect when the picked option is a distractor/mirror', () => {
    const trial = { shape: 'L', correctIndex: 1 };
    const question = scoreMentalRotationTrial({ trial, index: 0, optionIndex: 0, responseMs: 650 });
    expect(question.correct).toBe(false);
  });
});

// Regression coverage for the reaction-time runner's timer/re-entrancy guards
// (dual armTimeoutRef/advanceTimeoutRef + advancingRef). These are documented
// in-code as deliberate race-condition mitigations but had no test coverage:
// a future edit that collapses the two timer refs back into one, or drops
// the advancingRef guard, would silently reintroduce a stale setPhase('go')
// leak or a double-recorded trial.

function makeSimpleDrill({ count = 1, delayMs = 1000 } = {}) {
  return {
    type: 'reaction-time',
    config: { mode: 'simple', count, minDelayMs: delayMs, maxDelayMs: delayMs, choices: 1 },
    trials: Array.from({ length: count }, () => ({ delayMs })),
  };
}

describe('ReactionTimeRunner race-condition guards', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels the reveal timer on a false start so it cannot leak a stale GO into a later trial', () => {
    const onComplete = vi.fn();
    const drill = makeSimpleDrill({ count: 1, delayMs: 1000 });
    render(
      <PostCognitiveDrillRunner
        drill={drill}
        drillIndex={0}
        drillCount={1}
        onComplete={onComplete}
        isTraining={false}
      />,
    );

    // Respond before the stimulus is revealed — a false start.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /wait for the signal/i }));
    });
    expect(screen.getByText('Too soon!')).toBeInTheDocument();

    // The non-training advance delay is 500ms; this is the only trial, so it
    // finishes (calls onComplete) rather than arming a new trial.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    const result = onComplete.mock.calls[0][0];
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]).toMatchObject({ falseStart: true, correct: false, answered: null });

    // Advance past the ORIGINAL 1000ms reveal delay. If the reveal timer had
    // not been cancelled on the false start, its stale callback would fire
    // here and flip phase back to 'go' (rendering the GO! button) even
    // though the drill already completed.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByRole('button', { name: 'GO!' })).not.toBeInTheDocument();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('does not double-record a response when GO is clicked twice in rapid succession', () => {
    const onComplete = vi.fn();
    const drill = makeSimpleDrill({ count: 1, delayMs: 100 });
    render(
      <PostCognitiveDrillRunner
        drill={drill}
        drillIndex={0}
        drillCount={1}
        onComplete={onComplete}
        isTraining={false}
      />,
    );

    // Let the stimulus reveal (phase -> 'go').
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const goButton = screen.getByRole('button', { name: 'GO!' });

    // Fire two clicks back-to-back within the same synchronous block, before
    // React re-renders in response to the first. The advancingRef guard
    // (checked synchronously, not via state) must reject the second.
    act(() => {
      fireEvent.click(goButton);
      fireEvent.click(goButton);
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0].questions).toHaveLength(1);
  });

  it('ignores a keydown response once the result phase has already recorded an answer', () => {
    const onComplete = vi.fn();
    const drill = makeSimpleDrill({ count: 1, delayMs: 100 });
    render(
      <PostCognitiveDrillRunner
        drill={drill}
        drillIndex={0}
        drillCount={1}
        onComplete={onComplete}
        isTraining={false}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });
    const goButton = screen.getByRole('button', { name: 'GO!' });

    act(() => {
      fireEvent.click(goButton);
      // A keyboard response racing in immediately after the click, before
      // the 'result' phase has rendered, must not record a second answer.
      fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0].questions).toHaveLength(1);
  });
});

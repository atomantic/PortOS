import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { installVoiceHotkeySpy } from '../../../test/voiceHotkeySpy';
import PostCognitiveDrillRunner, {
  localAccuracyScore,
  localSchulteMetrics,
  buildCognitiveResult,
  buildNBackQuestions,
  scoreDigitSpanRecall,
  scoreStroopTrial,
  scoreMentalRotationTrial,
  scoreSchulteClick,
  scoreTaskSwitchTrial,
  scoreGoNoGoTrial,
  scoreFlankerTrial,
  localTaskSwitchMetrics,
  localGoNoGoMetrics,
  localFlankerMetrics,
} from './PostCognitiveDrillRunner';
// The how-to card itself is covered by CognitiveDrillTutorial.test.jsx; the
// runner suite reaches for it only to drive (and assert) its first-run gate.
import { hasSeenDrillTutorial, markDrillTutorialSeen, buildNBackExample } from './CognitiveDrillTutorial';

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

  it('schulte pre-save metrics include wrong clicks and completion', () => {
    const drill = { type: 'schulte-table', config: { size: 2 }, cells: [2, 1] };
    const questions = [
      scoreSchulteClick({ target: 1, value: 2, responseMs: 100 }),
      scoreSchulteClick({ target: 1, value: 1, responseMs: 400 }),
      scoreSchulteClick({ target: 2, value: 2, responseMs: 500 }),
    ];
    const result = buildCognitiveResult({ type: 'schulte-table', drill, questions, totalMs: 1000 });
    expect(result).toMatchObject({
      accuracy: 2 / 3,
      completion: 1,
      answeredCount: 2,
      totalCount: 2,
      attemptCount: 3,
      errorCount: 1,
    });
    expect(result.score).toBeLessThan(100);
    expect(localSchulteMetrics(drill, questions).score).toBe(result.score);
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
      expected: '123',
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
      expected: 'blue',
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
      expected: 1,
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

describe('scoreSchulteClick', () => {
  it('records the selected value against the current target without hiding an error', () => {
    expect(scoreSchulteClick({ target: 3, value: 7, responseMs: 850 })).toEqual({
      prompt: '3',
      index: 2,
      expected: 3,
      answered: 7,
      correct: false,
      responseMs: 850,
    });
  });
});

describe('executive-control result builders', () => {
  it('task switching grades by the active rule and records switch cost', () => {
    const repeat = scoreTaskSwitchTrial({
      trial: { rule: 'color', stimulus: { color: 'blue', shape: 'triangle' }, switched: false, incongruent: true },
      index: 0,
      answer: 'left',
      responseMs: 300,
    });
    const switched = scoreTaskSwitchTrial({
      trial: { rule: 'shape', stimulus: { color: 'blue', shape: 'triangle' }, switched: true, incongruent: true },
      index: 1,
      answer: 'right',
      responseMs: 700,
    });
    expect(repeat.correct).toBe(true);
    expect(switched.correct).toBe(true);
    expect(localTaskSwitchMetrics([repeat, switched])).toMatchObject({
      accuracy: 1,
      switchCostMs: 400,
      switchAccuracy: 1,
      repeatAccuracy: 1,
      omissions: 0,
    });
  });

  it('go/no-go distinguishes omissions from false alarms', () => {
    const hit = scoreGoNoGoTrial({ trial: { kind: 'go', symbol: '●' }, index: 0, pressed: true, responseMs: 250 });
    const omission = scoreGoNoGoTrial({ trial: { kind: 'go', symbol: '●' }, index: 1, pressed: false, responseMs: 1000 });
    const falseAlarm = scoreGoNoGoTrial({ trial: { kind: 'no-go', symbol: '■' }, index: 2, pressed: true, responseMs: 200 });
    const rejection = scoreGoNoGoTrial({ trial: { kind: 'no-go', symbol: '■' }, index: 3, pressed: false, responseMs: 1000 });
    expect(localGoNoGoMetrics([hit, omission, falseAlarm, rejection])).toMatchObject({
      accuracy: 0.5,
      hits: 1,
      omissions: 1,
      falseAlarms: 1,
      commissionErrors: 1,
      correctRejections: 1,
      falseAlarmRate: 0.5,
    });
  });

  it('flanker grades the center arrow and records congruency cost', () => {
    const congruent = scoreFlankerTrial({ trial: { target: 'left', flanker: 'left', congruent: true }, index: 0, answer: 'left', responseMs: 300 });
    const incongruent = scoreFlankerTrial({ trial: { target: 'right', flanker: 'left', congruent: false }, index: 1, answer: 'right', responseMs: 650 });
    expect(localFlankerMetrics([congruent, incongruent])).toMatchObject({ accuracy: 1, congruencyCostMs: 350, congruentAccuracy: 1, incongruentAccuracy: 1 });
  });

  it('buildCognitiveResult carries task-specific measures into the unified result', () => {
    const questions = [
      scoreFlankerTrial({ trial: { target: 'left', flanker: 'left', congruent: true }, index: 0, answer: 'left', responseMs: 300 }),
      scoreFlankerTrial({ trial: { target: 'right', flanker: 'left', congruent: false }, index: 1, answer: 'right', responseMs: 600 }),
    ];
    const result = buildCognitiveResult({ type: 'flanker', drill: { type: 'flanker', config: {} }, questions, totalMs: 900 });
    expect(result).toMatchObject({ module: 'cognitive', type: 'flanker', accuracy: 1, congruencyCostMs: 300, totalMs: 900 });
    expect(result.latencyDistributionMs).toEqual([300, 600]);
  });

  it('keeps a partial executive result completion-aware', () => {
    const question = scoreFlankerTrial({
      trial: { target: 'left', flanker: 'right', congruent: false },
      index: 0,
      answer: 'left',
      responseMs: 300,
    });
    const result = buildCognitiveResult({
      type: 'flanker',
      drill: { type: 'flanker', config: { responseDeadlineMs: 1500 }, trials: Array.from({ length: 4 }, () => ({})) },
      questions: [question],
      totalMs: 300,
    });
    expect(result).toMatchObject({ accuracy: 1, completion: 0.25, totalCount: 4 });
    expect(result.score).toBeLessThan(25);
  });
});

describe('SchulteTableRunner error recording', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    markDrillTutorialSeen('schulte-table');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists a wrong tap before the successful sequence and does not advance its target', () => {
    const onComplete = vi.fn();
    const drill = { type: 'schulte-table', config: { size: 2 }, cells: [2, 1] };
    render(
      <PostCognitiveDrillRunner
        drill={drill}
        drillIndex={0}
        drillCount={1}
        onComplete={onComplete}
        isTraining={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '2' }));
    expect(screen.getByText('Find:').parentElement).toHaveTextContent('1');
    fireEvent.click(screen.getByRole('button', { name: '1' }));
    expect(screen.getByText('Find:').parentElement).toHaveTextContent('2');
    fireEvent.click(screen.getByRole('button', { name: '2' }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    const result = onComplete.mock.calls[0][0];
    expect(result.questions.map(q => [q.expected, q.answered, q.correct])).toEqual([
      [1, 2, false],
      [1, 1, true],
      [2, 2, true],
    ]);
    expect(result.errorCount).toBe(1);
  });
});

describe('NBackRunner stimulus timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    markDrillTutorialSeen('n-back');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists a missed target when its stimulus window expires without a press', () => {
    const onComplete = vi.fn();
    const drill = {
      type: 'n-back',
      config: { n: 1, stimulusMs: 1000 },
      sequence: ['A', 'A', 'B'],
    };
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
      vi.advanceTimersByTime(3800); // 800ms pre-roll + all three stimulus windows
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0].questions).toEqual([
      expect.objectContaining({ index: 1, expected: 'match', answered: null, correct: false }),
      expect.objectContaining({ index: 2, expected: 'no-match', answered: null, correct: true }),
    ]);
  });
});

describe('DigitSpanRunner recall focus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    markDrillTutorialSeen('digit-span');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The recall input appears on its own timer (after the digits finish
  // flashing), not from a user action — so nothing else would land focus on
  // it. A user who has just watched the sequence and looked up to type
  // shouldn't have to click the field first.
  it('auto-focuses the recall input once the digit sequence finishes flashing', () => {
    const drill = {
      type: 'digit-span',
      config: { direction: 'forward', showMs: 400 },
      sequences: [{ digits: [7], length: 1 }],
    };
    render(
      <PostCognitiveDrillRunner
        drill={drill}
        drillIndex={0}
        drillCount={1}
        onComplete={vi.fn()}
        isTraining={false}
      />,
    );

    expect(screen.queryByRole('textbox', { name: 'Your answer' })).not.toBeInTheDocument();

    // 600ms pre-roll + 400ms shown + 200ms gap before the recall phase arms.
    act(() => {
      vi.advanceTimersByTime(1200);
    });

    const input = screen.getByRole('textbox', { name: 'Your answer' });
    expect(input).toHaveFocus();
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
    // These tests exercise the runner directly, so skip the first-run tutorial
    // gate (which would otherwise hold the runner behind a how-to card).
    markDrillTutorialSeen('reaction-time');
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

// First-run tutorial gate: the timed cognitive drills flash a stimulus the
// instant they mount, so the first encounter of each type is held behind a
// how-to card and the runner (and its timers) only start on "Start drill".
describe('first-run tutorial gate', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  const drill = makeSimpleDrill({ count: 1, delayMs: 1000 });

  it('shows the how-to card on the first encounter and does not mount the runner', () => {
    render(
      <PostCognitiveDrillRunner drill={drill} drillIndex={0} drillCount={1} onComplete={vi.fn()} isTraining={false} />,
    );
    expect(screen.getByRole('button', { name: /start drill/i })).toBeInTheDocument();
    // Runner is held — its "Wait…" button is absent until Start is tapped.
    expect(screen.queryByRole('button', { name: /wait for the signal/i })).not.toBeInTheDocument();
    expect(hasSeenDrillTutorial('reaction-time')).toBe(false);
  });

  it('mounts the runner and marks the type seen after tapping Start', () => {
    render(
      <PostCognitiveDrillRunner drill={drill} drillIndex={0} drillCount={1} onComplete={vi.fn()} isTraining={false} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /start drill/i }));
    expect(screen.getByRole('button', { name: /wait for the signal/i })).toBeInTheDocument();
    expect(hasSeenDrillTutorial('reaction-time')).toBe(true);
  });

  it('skips the card on later encounters of an already-seen type', () => {
    markDrillTutorialSeen('reaction-time');
    render(
      <PostCognitiveDrillRunner drill={drill} drillIndex={0} drillCount={1} onComplete={vi.fn()} isTraining={false} />,
    );
    expect(screen.queryByRole('button', { name: /start drill/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /wait for the signal/i })).toBeInTheDocument();
  });
});

describe('executive-control runners', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    markDrillTutorialSeen('task-switching');
    markDrillTutorialSeen('go-no-go');
    markDrillTutorialSeen('flanker');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('task switching supports keyboard answers, visible instructions, and accessible live state', () => {
    const onComplete = vi.fn();
    render(<PostCognitiveDrillRunner
      drill={{
        type: 'task-switching',
        config: { cueStimulusIntervalMs: 100, responseDeadlineMs: 1000 },
        rules: [{ id: 'color', values: ['blue', 'orange'] }, { id: 'shape', values: ['circle', 'triangle'] }],
        trials: [{ rule: 'color', stimulus: { color: 'blue', shape: 'triangle' }, switched: false, incongruent: true }],
      }}
      drillIndex={0}
      drillCount={1}
      onComplete={onComplete}
      isTraining={false}
    />);
    expect(screen.getByText(/cued rule/i)).toBeInTheDocument();
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    act(() => vi.advanceTimersByTime(100));
    expect(screen.getByLabelText('blue triangle')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    act(() => vi.advanceTimersByTime(250));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({ type: 'task-switching', accuracy: 1, omissions: 0 });
  });

  it('go/no-go supports touch, advances withheld trials at the deadline, and records errors separately', () => {
    const onComplete = vi.fn();
    render(<PostCognitiveDrillRunner
      drill={{
        type: 'go-no-go',
        config: { stimulusMs: 100, responseDeadlineMs: 500 },
        trials: [{ kind: 'go', symbol: '●', tone: 'green' }, { kind: 'no-go', symbol: '■', tone: 'red' }],
      }}
      drillIndex={0}
      drillCount={1}
      onComplete={onComplete}
      isTraining={false}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'filled circle' }));
    act(() => vi.advanceTimersByTime(251));
    expect(screen.getByRole('button', { name: 'filled square' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(501));
    act(() => vi.advanceTimersByTime(251));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({ hits: 1, correctRejections: 1, falseAlarms: 0, omissions: 0, accuracy: 1 });
  });

  it('flanker supports touch controls and ignores the distractor direction', () => {
    const onComplete = vi.fn();
    render(<PostCognitiveDrillRunner
      drill={{ type: 'flanker', config: { responseDeadlineMs: 800, flankerDistance: 1, flankerStrength: 3 }, trials: [{ target: 'right', flanker: 'left', congruent: false }] }}
      drillIndex={0}
      drillCount={1}
      onComplete={onComplete}
      isTraining={false}
    />);
    fireEvent.click(screen.getByRole('button', { name: /right/i }));
    act(() => vi.advanceTimersByTime(250));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({ type: 'flanker', accuracy: 1, incongruentAccuracy: 1 });
  });

  it('cleans timers on early exit and can restart the same drill cleanly on resume', () => {
    const drill = { type: 'go-no-go', config: { stimulusMs: 200, responseDeadlineMs: 800 }, trials: [{ kind: 'go', symbol: '●', tone: 'green' }] };
    const abandoned = vi.fn();
    const first = render(<PostCognitiveDrillRunner drill={drill} drillIndex={0} drillCount={1} onComplete={abandoned} isTraining={false} />);
    first.unmount();
    act(() => vi.advanceTimersByTime(2000));
    expect(abandoned).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    const resumed = vi.fn();
    render(<PostCognitiveDrillRunner drill={drill} drillIndex={0} drillCount={1} onComplete={resumed} isTraining={false} />);
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    act(() => vi.advanceTimersByTime(250));
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(resumed.mock.calls[0][0].questions).toHaveLength(1);
  });
});

describe('n-back tutorial card', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it('renders the worked example stream with the match called out', () => {
    const drill = { type: 'n-back', config: { n: 2, stimulusMs: 1000 }, sequence: ['A', 'B', 'A'] };
    render(
      <PostCognitiveDrillRunner drill={drill} drillIndex={0} drillCount={1} onComplete={vi.fn()} isTraining={false} />,
    );
    const { sequence } = buildNBackExample(2);
    expect(screen.getByText(/example — 2-back/i)).toBeInTheDocument();
    expect(screen.getByText('Match!')).toBeInTheDocument();
    expect(screen.getByText('2 steps back')).toBeInTheDocument();
    // Every example letter is on screen, in order.
    const strip = within(screen.getByRole('list', { name: /example letter stream/i }));
    const chips = strip.getAllByRole('listitem').map(li => li.textContent);
    expect(chips.map(text => text[0])).toEqual(sequence);
  });
});

// The voice widget binds a GLOBAL push-to-talk hotkey that defaults to Space —
// the same key these drills use to respond. Each Space-driven runner claims the
// key in the capture phase so the mic never opens mid-drill. Stand in for the
// widget with a bubble-phase window listener and assert it stays silent.
describe('Space-driven drills do not leak the key to the global voice hotkey', () => {
  const voiceHotkey = installVoiceHotkeySpy();

  beforeEach(() => {
    vi.useFakeTimers();
    markDrillTutorialSeen('n-back');
    markDrillTutorialSeen('go-no-go');
    markDrillTutorialSeen('reaction-time');
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it('n-back swallows Space and still records the match', () => {
    const onComplete = vi.fn();
    const drill = { type: 'n-back', config: { n: 1, stimulusMs: 1000 }, sequence: ['A', 'A'] };
    render(
      <PostCognitiveDrillRunner drill={drill} drillIndex={0} drillCount={1} onComplete={onComplete} isTraining={false} />,
    );
    act(() => { vi.advanceTimersByTime(1900); }); // 800ms pre-roll + into the 2nd stimulus
    act(() => { fireEvent.keyDown(document.body, { code: 'Space', key: ' ' }); });
    act(() => { vi.advanceTimersByTime(1000); });

    expect(voiceHotkey()).not.toHaveBeenCalled();
    expect(onComplete.mock.calls[0][0].questions).toEqual([
      expect.objectContaining({ index: 1, answered: 'match', correct: true }),
    ]);
  });

  it('go-no-go swallows Space and still records the go press', () => {
    const onComplete = vi.fn();
    const drill = {
      type: 'go-no-go',
      config: { stimulusMs: 200, responseDeadlineMs: 800 },
      trials: [{ kind: 'go', symbol: '●', tone: 'green' }],
    };
    render(
      <PostCognitiveDrillRunner drill={drill} drillIndex={0} drillCount={1} onComplete={onComplete} isTraining={false} />,
    );
    act(() => { fireEvent.keyDown(document.body, { code: 'Space', key: ' ' }); });
    act(() => { vi.advanceTimersByTime(250); });

    expect(voiceHotkey()).not.toHaveBeenCalled();
    expect(onComplete.mock.calls[0][0].questions).toHaveLength(1);
  });

  it('simple reaction-time swallows Space and still records the response', () => {
    const onComplete = vi.fn();
    const drill = makeSimpleDrill({ count: 1, delayMs: 100 });
    render(
      <PostCognitiveDrillRunner drill={drill} drillIndex={0} drillCount={1} onComplete={onComplete} isTraining={false} />,
    );
    act(() => { vi.advanceTimersByTime(100); });
    act(() => { fireEvent.keyDown(document.body, { code: 'Space', key: ' ' }); });
    act(() => { vi.advanceTimersByTime(500); });

    expect(voiceHotkey()).not.toHaveBeenCalled();
    expect(onComplete.mock.calls[0][0].questions).toHaveLength(1);
  });

  it('reaction-time keeps claiming Space through the between-trials result phase', () => {
    const onComplete = vi.fn();
    const drill = makeSimpleDrill({ count: 2, delayMs: 100 });
    render(
      <PostCognitiveDrillRunner drill={drill} drillIndex={0} drillCount={2} onComplete={onComplete} isTraining={false} />,
    );
    act(() => { vi.advanceTimersByTime(100); });
    act(() => { fireEvent.keyDown(document.body, { code: 'Space', key: ' ' }); }); // records trial 1
    // Now in the 500ms result phase: a second press must NOT record anything,
    // and must NOT reach the voice hotkey either.
    act(() => { fireEvent.keyDown(document.body, { code: 'Space', key: ' ' }); });
    expect(voiceHotkey()).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(600); });
    act(() => { fireEvent.keyDown(document.body, { code: 'Space', key: ' ' }); });
    act(() => { vi.advanceTimersByTime(600); });
    expect(voiceHotkey()).not.toHaveBeenCalled();
    expect(onComplete.mock.calls[0][0].questions).toHaveLength(2);
  });

  // Space on a focused button belongs to the browser (#4748), so a mouse click
  // that parked focus on the on-screen response button would take the drill's
  // key over — and native activation fires on keyUP, inflating a scored
  // reaction time. The runner therefore refuses pointer focus for every button
  // on the surface. jsdom doesn't implement click-to-focus, so the cancelled
  // mousedown (which is what suppresses the focus in a real browser) is the
  // observable here.
  it('refuses pointer focus on the on-screen Match button, so Space stays the scored path', () => {
    const drill = { type: 'n-back', config: { n: 1, stimulusMs: 1000 }, sequence: ['A', 'A'] };
    render(
      <PostCognitiveDrillRunner drill={drill} drillIndex={0} drillCount={1} onComplete={vi.fn()} isTraining={false} />,
    );
    act(() => { vi.advanceTimersByTime(1900); }); // into the 2nd stimulus, so Match is enabled
    const match = screen.getByRole('button', { name: 'Match' });
    expect(match).toBeEnabled();

    // fireEvent returns false when the event was canceled.
    expect(fireEvent.mouseDown(match)).toBe(false);
  });

  it('lets an unrelated key through — this is not a blanket keyboard trap', () => {
    const drill = { type: 'n-back', config: { n: 1, stimulusMs: 1000 }, sequence: ['A', 'A'] };
    render(
      <PostCognitiveDrillRunner drill={drill} drillIndex={0} drillCount={1} onComplete={vi.fn()} isTraining={false} />,
    );
    act(() => { fireEvent.keyDown(document.body, { code: 'KeyJ', key: 'j' }); });
    expect(voiceHotkey()).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../services/api', () => ({
  generatePostDrill: vi.fn(),
  submitPostSession: vi.fn(),
  scorePostLlmDrill: vi.fn(),
  submitTrainingRun: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { generatePostDrill, submitPostSession, scorePostLlmDrill, submitTrainingRun } from '../services/api';
import { usePostSession } from './usePostSession';

describe('usePostSession — Applied Numeracy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('restores a seeded unit drill and keeps equivalent-unit feedback correct', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'applied-numeracy',
      config: { seed: 4443, difficulty: 2, family: 'unit' },
      questions: [{
        prompt: 'Convert 1500 m to km.', expected: 1.5, answerDisplay: '1.5 km', unit: 'km',
        unitOptions: { m: 1, km: 1000 }, unitAliases: { kilometer: 'km', kilometers: 'km' },
        method: 'Divide meters by 1000 to get kilometers.',
      }],
    });

    const first = renderHook(() => usePostSession());
    await act(async () => {
      await first.result.current.startSession([{ type: 'applied-numeracy', config: {}, timeLimitSec: 60 }]);
    });
    first.unmount();

    const second = renderHook(() => usePostSession());
    expect(second.result.current.currentDrill?.config.seed).toBe(4443);
    act(() => { second.result.current.submitAnswer('1500 m'); });

    const task = second.result.current.drillResults[0];
    expect(task.config).toMatchObject({ seed: 4443, difficulty: 2, family: 'unit' });
    expect(task.questions[0]).toMatchObject({ correct: true, expected: '1.5 km', method: 'Divide meters by 1000 to get kilometers.' });
  });

  it('records unanswered applied-numeracy questions when the timer expires', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'applied-numeracy', config: { seed: 44, difficulty: 1 },
      questions: [
        { prompt: 'Convert 2 km to m.', expected: 2000, answerDisplay: '2000 m' },
        { prompt: 'Convert 3 l to ml.', expected: 3000, answerDisplay: '3000 ml' },
      ],
    });

    const { result } = renderHook(() => usePostSession());
    await act(async () => {
      await result.current.startSession([{ type: 'applied-numeracy', config: {}, timeLimitSec: 60 }]);
    });
    act(() => { result.current.timeExpired(); });

    expect(result.current.drillResults[0].questions).toEqual(expect.arrayContaining([
      expect.objectContaining({ answered: null, correct: false, expected: '2000 m' }),
      expect.objectContaining({ answered: null, correct: false, expected: '3000 ml' }),
    ]));
  });
});

// Covers issue #2010: a memory drill completed inside a POST session must
// carry its memoryItemId through to the submitted task (so the server can
// advance that item's spaced-repetition schedule) and use the `memory`
// module — not the `mental-math` module every drill result used to be
// tagged with regardless of type.

describe('usePostSession — memory drill task shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('carries memoryItemId and module="memory" through to the drill result for a memory-sequence drill', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'memory-sequence',
      memoryItemId: 'song-1',
      memoryItemTitle: 'Test Song',
      config: {},
      questions: [
        { prompt: 'line one', promptLabel: 'What comes next?', expected: 'line two', chunkId: null },
      ],
    });

    const { result } = renderHook(() => usePostSession());

    await act(async () => {
      await result.current.startSession([{ type: 'memory-sequence', config: {}, timeLimitSec: 60 }]);
    });

    act(() => {
      result.current.submitAnswer('line two');
    });

    expect(result.current.drillResults).toHaveLength(1);
    const task = result.current.drillResults[0];
    expect(task.type).toBe('memory-sequence');
    expect(task.module).toBe('memory');
    expect(task.memoryItemId).toBe('song-1');
  });

  it('does not attach memoryItemId to a math drill result, and keeps module="mental-math"', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'doubling-chain',
      config: { startValue: 2, steps: 1 },
      questions: [{ prompt: '2 x 2', expected: 4 }],
    });

    const { result } = renderHook(() => usePostSession());

    await act(async () => {
      await result.current.startSession([{ type: 'doubling-chain', config: {}, timeLimitSec: 60 }]);
    });

    act(() => {
      result.current.submitAnswer('4');
    });

    expect(result.current.drillResults).toHaveLength(1);
    const task = result.current.drillResults[0];
    expect(task.type).toBe('doubling-chain');
    expect(task.module).toBe('mental-math');
    expect(task.memoryItemId).toBeUndefined();
  });

  it('omits memoryItemId on a memory drill result when the generated drill carried none', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'memory-element-flash',
      // No memoryItemId — shouldn't happen for a real generateMemoryDrill()
      // response, but the hook must not synthesize one.
      config: {},
      questions: [{ prompt: 'H', promptLabel: 'Element name?', expected: 'Hydrogen', element: 'H' }],
    });

    const { result } = renderHook(() => usePostSession());

    await act(async () => {
      await result.current.startSession([{ type: 'memory-element-flash', config: {}, timeLimitSec: 60 }]);
    });

    act(() => {
      result.current.submitAnswer('Hydrogen');
    });

    const task = result.current.drillResults[0];
    expect(task.module).toBe('memory');
    expect(task.memoryItemId).toBeUndefined();
  });

  it('passes memoryItemId through saveSession into the submitted payload', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'memory-sequence',
      memoryItemId: 'song-1',
      config: {},
      questions: [{ prompt: 'line one', expected: 'line two', chunkId: null }],
    });
    submitPostSession.mockResolvedValue({ id: 'session-1', score: 100 });

    const { result } = renderHook(() => usePostSession());

    await act(async () => {
      await result.current.startSession([{ type: 'memory-sequence', config: {}, timeLimitSec: 60 }]);
    });
    act(() => {
      result.current.submitAnswer('line two');
    });
    await act(async () => {
      await result.current.saveSession({});
    });

    expect(submitPostSession).toHaveBeenCalledTimes(1);
    const payload = submitPostSession.mock.calls[0][0];
    expect(payload.tasks).toHaveLength(1);
    expect(payload.tasks[0].memoryItemId).toBe('song-1');
  });
});

// Covers issue #2016: a memory-sequence/memory-element-flash question's
// chunkId/element must survive into the submitted answer so the server can
// merge chunk/element mastery (mergeMasteryFromSession), not just advance the
// SR schedule. Deferred out of #2010 because the answer-building in
// submitAnswer used to strip the question down to a fixed field set.

describe('usePostSession — memory drill chunk/element attribution (#2016)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves chunkId onto the answer for a memory-sequence question', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'memory-sequence',
      memoryItemId: 'song-1',
      config: {},
      questions: [
        { prompt: 'line one', promptLabel: 'What comes next?', expected: 'line two', chunkId: 'verse-1' },
      ],
    });

    const { result } = renderHook(() => usePostSession());

    await act(async () => {
      await result.current.startSession([{ type: 'memory-sequence', config: {}, timeLimitSec: 60 }]);
    });
    act(() => {
      result.current.submitAnswer('line two');
    });

    const task = result.current.drillResults[0];
    expect(task.questions[0].chunkId).toBe('verse-1');
    expect(task.questions[0].element).toBeUndefined();
  });

  it('preserves element onto the answer for a memory-element-flash question', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'memory-element-flash',
      memoryItemId: 'elements-song',
      config: {},
      questions: [{ prompt: 'H', promptLabel: 'Element name?', expected: 'Hydrogen', element: 'H' }],
    });

    const { result } = renderHook(() => usePostSession());

    await act(async () => {
      await result.current.startSession([{ type: 'memory-element-flash', config: {}, timeLimitSec: 60 }]);
    });
    act(() => {
      result.current.submitAnswer('Hydrogen');
    });

    const task = result.current.drillResults[0];
    expect(task.questions[0].element).toBe('H');
    expect(task.questions[0].chunkId).toBeUndefined();
  });

  it('does not attach chunkId/element to a math drill answer', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'doubling-chain',
      config: { startValue: 2, steps: 1 },
      questions: [{ prompt: '2 x 2', expected: 4 }],
    });

    const { result } = renderHook(() => usePostSession());

    await act(async () => {
      await result.current.startSession([{ type: 'doubling-chain', config: {}, timeLimitSec: 60 }]);
    });
    act(() => {
      result.current.submitAnswer('4');
    });

    const task = result.current.drillResults[0];
    expect(task.questions[0].chunkId).toBeUndefined();
    expect(task.questions[0].element).toBeUndefined();
  });

  it('omits chunkId when a question carries a null chunkId (no matching chunk found)', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'memory-sequence',
      memoryItemId: 'song-1',
      config: {},
      questions: [{ prompt: 'line one', expected: 'line two', chunkId: null }],
    });

    const { result } = renderHook(() => usePostSession());

    await act(async () => {
      await result.current.startSession([{ type: 'memory-sequence', config: {}, timeLimitSec: 60 }]);
    });
    act(() => {
      result.current.submitAnswer('line two');
    });

    const task = result.current.drillResults[0];
    expect(task.questions[0]).not.toHaveProperty('chunkId');
  });

  it('preserves chunkId on a timed-out (skipped) question via timeExpired', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'memory-sequence',
      memoryItemId: 'song-1',
      config: {},
      questions: [
        { prompt: 'line one', expected: 'line two', chunkId: 'verse-1' },
        { prompt: 'line two', expected: 'line three', chunkId: 'verse-1' },
      ],
    });

    const { result } = renderHook(() => usePostSession());

    await act(async () => {
      await result.current.startSession([{ type: 'memory-sequence', config: {}, timeLimitSec: 60 }]);
    });
    // Time expires before any answer is submitted — both questions become
    // unanswered/incorrect but should still carry chunkId for mastery merge.
    act(() => {
      result.current.timeExpired();
    });

    const task = result.current.drillResults[0];
    expect(task.questions).toHaveLength(2);
    expect(task.questions[0].chunkId).toBe('verse-1');
    expect(task.questions[1].chunkId).toBe('verse-1');
    expect(task.questions[0].correct).toBe(false);
  });
});

// Covers issue #2116: generateFillBlank questions carry acceptable answers as
// `answers[]` OBJECTS ({ index, word, element }), not scalar strings.
// submitAnswer's fill-blank branch used to compare via `String(a)` on each
// object, which always stringifies to "[object Object]" — so a fill-blank
// answer could never be marked correct no matter what the user typed. It must
// now compare against each acceptable answer's `.word`.
describe('usePostSession — memory-fill-blank scoring (issue #2099/#2116)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function fillBlankDrill(answers) {
    return {
      type: 'memory-fill-blank',
      memoryItemId: 'song-1',
      config: {},
      questions: [{
        prompt: 'The ____ fox',
        fullText: 'The quick fox',
        expected: answers[0]?.word ?? null,
        answers,
        chunkId: 'verse-1',
      }],
    };
  }

  it('marks a single-blank answer correct and preserves its index', async () => {
    generatePostDrill.mockResolvedValue(
      fillBlankDrill([{ index: 1, word: 'quick', element: null }])
    );

    const { result } = renderHook(() => usePostSession());
    await act(async () => {
      await result.current.startSession([{ type: 'memory-fill-blank', config: {}, timeLimitSec: 60 }]);
    });
    act(() => {
      result.current.submitAnswer('quick');
    });

    const task = result.current.drillResults[0];
    expect(task.questions[0].correct).toBe(true);
    expect(task.questions[0].answered).toEqual([
      { index: 1, value: 'quick', expected: 'quick', correct: true },
    ]);
    expect(task.module).toBe('memory');
    expect(task.memoryItemId).toBe('song-1');
  });

  it('scores every generated blank instead of treating one matching word as full credit', async () => {
    generatePostDrill.mockResolvedValue(
      fillBlankDrill([
        { index: 1, word: 'quick', element: null },
        { index: 2, word: 'fox', element: null },
      ])
    );

    const { result } = renderHook(() => usePostSession());
    await act(async () => {
      await result.current.startSession([{ type: 'memory-fill-blank', config: {}, timeLimitSec: 60 }]);
    });
    act(() => {
      result.current.submitAnswer([{ index: 2, value: '  FOX  ' }]);
    });

    const question = result.current.drillResults[0].questions[0];
    expect(question.correct).toBe(false);
    expect(question.answered).toEqual([
      { index: 1, value: null, expected: 'quick', correct: false },
      { index: 2, value: 'FOX', expected: 'fox', correct: true },
    ]);
  });

  it('marks a fill-blank answer incorrect when it matches none of the acceptable words', async () => {
    generatePostDrill.mockResolvedValue(
      fillBlankDrill([{ index: 1, word: 'quick', element: null }])
    );

    const { result } = renderHook(() => usePostSession());
    await act(async () => {
      await result.current.startSession([{ type: 'memory-fill-blank', config: {}, timeLimitSec: 60 }]);
    });
    act(() => {
      result.current.submitAnswer('slow');
    });

    expect(result.current.drillResults[0].questions[0].correct).toBe(false);
  });

  // Element attribution follows the indexed blank, while the question remains
  // partial until every generated answer is supplied.
  it('attributes indexed answer elements independently', async () => {
    generatePostDrill.mockResolvedValue(
      fillBlankDrill([
        { index: 1, word: 'hydrogen', element: 'H' },
        { index: 3, word: 'fox', element: null },
      ])
    );

    const { result } = renderHook(() => usePostSession());
    await act(async () => {
      await result.current.startSession([{ type: 'memory-fill-blank', config: {}, timeLimitSec: 60 }]);
    });
    act(() => {
      result.current.submitAnswer([{ index: 1, value: 'hydrogen' }]);
    });

    const q = result.current.drillResults[0].questions[0];
    expect(q.correct).toBe(false);
    expect(q.element).toBeUndefined();
    expect(q.answered[0]).toMatchObject({ index: 1, value: 'hydrogen', expected: 'hydrogen', correct: true, element: 'H' });
    expect(q.answered[1]).toMatchObject({ index: 3, value: null, expected: 'fox', correct: false });
  });

  it('omits element on an incorrect match — which blank was intended is ambiguous', async () => {
    generatePostDrill.mockResolvedValue(
      fillBlankDrill([{ index: 1, word: 'hydrogen', element: 'H' }])
    );

    const { result } = renderHook(() => usePostSession());
    await act(async () => {
      await result.current.startSession([{ type: 'memory-fill-blank', config: {}, timeLimitSec: 60 }]);
    });
    act(() => {
      result.current.submitAnswer('nope');
    });

    const q = result.current.drillResults[0].questions[0];
    expect(q.correct).toBe(false);
    expect(q).not.toHaveProperty('element');
    expect(q.answered).toEqual([{ index: 1, value: 'nope', expected: 'hydrogen', correct: false }]);
  });

  it('omits element when the matched answer has none (a plain-word blank)', async () => {
    generatePostDrill.mockResolvedValue(
      fillBlankDrill([{ index: 1, word: 'quick', element: null }])
    );

    const { result } = renderHook(() => usePostSession());
    await act(async () => {
      await result.current.startSession([{ type: 'memory-fill-blank', config: {}, timeLimitSec: 60 }]);
    });
    act(() => {
      result.current.submitAnswer('quick');
    });

    const q = result.current.drillResults[0].questions[0];
    expect(q.correct).toBe(true);
    expect(q).not.toHaveProperty('element');
    expect(q.answered[0]).toEqual({ index: 1, value: 'quick', expected: 'quick', correct: true });
    // chunkId still comes through via memoryAttribution(q) regardless.
    expect(q.chunkId).toBe('verse-1');
  });
});

// Regression (codex review of issue #2099): saveSession's returned session
// score (now module-weighted server-side, see meatspacePost.js
// computeSessionScore) must replace the pre-save local estimate
// (computeSessionScoreFromResults — a plain per-domain average that never
// reads config.scoring.weights), or the results screen keeps showing the
// stale unweighted estimate even after the weighted score was toasted/saved.
describe('usePostSession — sessionScore syncs to the server score on save (issue #2099)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replaces the local pre-save score estimate with the server-computed session.score', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'doubling-chain',
      config: { startValue: 2, steps: 1 },
      questions: [{ prompt: '2 x 2', expected: 4 }],
    });
    // Server's weighted score (e.g. a de-emphasized module) diverges from
    // whatever the client's local per-domain estimate computed pre-save.
    submitPostSession.mockResolvedValue({ id: 'session-1', score: 37 });

    const { result } = renderHook(() => usePostSession());
    await act(async () => {
      await result.current.startSession([{ type: 'doubling-chain', config: {}, timeLimitSec: 60 }]);
    });
    act(() => {
      result.current.submitAnswer('4');
    });

    expect(result.current.sessionScore).not.toBe(37); // the local estimate, pre-save

    await act(async () => {
      await result.current.saveSession({});
    });

    expect(result.current.sessionScore).toBe(37);
  });
});

describe('usePostSession — LLM training-log correctCount (issue #2097)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Regression: completeLlmDrill stores the scored responses under
  // `responses` (with an `llmScore` field), never under `questions` (with a
  // boolean `correct`) — but saveSession's training-mode branch used to read
  // `r.questions?.filter(q => q.correct)`, which is always undefined for an
  // LLM drill. Every LLM training entry (including wordplay) therefore
  // silently logged correctCount=0 no matter how well the user actually did.
  it('derives correctCount from the scored llmScore, not from the always-undefined r.questions', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'compound-chain', config: {}, challenges: [{ rootWord: 'fire' }],
    });
    scorePostLlmDrill.mockResolvedValue({
      score: 90,
      questions: [{ questionIndex: 0, items: ['firehouse'], llmScore: 90 }],
      evaluation: { overallScore: 90, scores: [{ score: 90 }] },
    });
    submitTrainingRun.mockResolvedValue({ id: 'training-run' });

    const { result } = renderHook(() => usePostSession());

    await act(async () => {
      await result.current.startSession([{ type: 'compound-chain', config: {}, timeLimitSec: 120 }], true);
    });

    await act(async () => {
      await result.current.completeLlmDrill({
        module: 'llm-drills',
        type: 'compound-chain',
        config: {},
        drillData: {},
        responses: [{ questionIndex: 0, items: ['firehouse'], responseMs: 500 }],
        totalMs: 5000,
      });
    });

    await act(async () => {
      await result.current.saveSession({});
    });

    expect(submitTrainingRun.mock.calls[0][0].attempts[0]).toEqual(expect.objectContaining({
      module: 'llm-drills',
      drillType: 'compound-chain',
      questionCount: 1,
      correctCount: 1,
      latencyMs: 5000,
      inputMode: 'text',
      scorerProvenance: 'server-llm',
    }));
  });

  it('reuses immediate training scores instead of calling the scorer again at completion', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'compound-chain', config: {}, challenges: [{ rootWord: 'fire' }],
    });
    const evaluation = {
      overallScore: 90,
      scores: [{ score: 90, feedback: 'Validated' }],
      summary: 'Validated',
      provenance: {
        generator: { schemaVersion: '1', promptVersion: '1', providerId: 'provider-a', model: 'model-a' },
        scorer: { kind: 'hybrid', rubricVersion: '1', providerId: 'provider-a', model: 'model-a' },
      },
    };

    const { result } = renderHook(() => usePostSession());
    await act(async () => {
      await result.current.startSession([{ type: 'compound-chain', config: {}, timeLimitSec: 120 }], true);
    });
    await act(async () => {
      await result.current.completeLlmDrill({
        module: 'llm-drills',
        type: 'compound-chain',
        config: {},
        drillData: {},
        score: 90,
        evaluation,
        responses: [{ questionIndex: 0, items: ['firehouse'], responseMs: 500, llmScore: 90, llmFeedback: 'Validated' }],
        totalMs: 5000,
      });
    });

    expect(scorePostLlmDrill).not.toHaveBeenCalled();
    expect(result.current.drillResults[0]).toMatchObject({ score: 90, evaluation });
  });

  it('scores a non-training response set in one completion batch', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'word-association', config: {}, questions: [{ prompt: 'ocean' }, { prompt: 'forest' }],
    });
    scorePostLlmDrill.mockResolvedValue({
      score: 75,
      questions: [
        { questionIndex: 0, response: 'wave', llmScore: 80 },
        { questionIndex: 1, response: 'trees', llmScore: 70 },
      ],
      evaluation: { overallScore: 75, scores: [{ score: 80 }, { score: 70 }] },
    });

    const { result } = renderHook(() => usePostSession());
    await act(async () => {
      await result.current.startSession([{ type: 'word-association', config: {}, timeLimitSec: 120 }], false);
    });
    await act(async () => {
      await result.current.completeLlmDrill({
        module: 'llm-drills', type: 'word-association', drillData: result.current.currentDrill,
        responses: [
          { questionIndex: 0, response: 'wave', responseMs: 500 },
          { questionIndex: 1, response: 'trees', responseMs: 500 },
        ],
        totalMs: 1000,
      });
    });

    expect(scorePostLlmDrill).toHaveBeenCalledTimes(1);
    expect(scorePostLlmDrill.mock.calls[0][2]).toHaveLength(2);
  });

  it('logs correctCount=0 when the llmScore is below the correct threshold', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'bridge-word', config: {}, puzzles: [{ clues: ['a', 'b'] }],
    });
    scorePostLlmDrill.mockResolvedValue({
      score: 20,
      questions: [{ questionIndex: 0, response: 'wrong', llmScore: 20 }],
      evaluation: { overallScore: 20, scores: [{ score: 20 }] },
    });
    submitTrainingRun.mockResolvedValue({ id: 'training-run' });

    const { result } = renderHook(() => usePostSession());

    await act(async () => {
      await result.current.startSession([{ type: 'bridge-word', config: {}, timeLimitSec: 120 }], true);
    });

    await act(async () => {
      await result.current.completeLlmDrill({
        module: 'llm-drills',
        type: 'bridge-word',
        config: {},
        drillData: {},
        responses: [{ questionIndex: 0, response: 'wrong', responseMs: 500 }],
        totalMs: 4000,
      });
    });

    await act(async () => {
      await result.current.saveSession({});
    });

    expect(submitTrainingRun.mock.calls[0][0].attempts[0]).toEqual(expect.objectContaining({
      drillType: 'bridge-word', questionCount: 1, correctCount: 0,
    }));
  });
});

describe('usePostSession — atomic training-run save (#4441)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('keeps a failed save retryable and reuses the same run and attempt ids', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'doubling-chain', config: { steps: 1 },
      questions: [{ prompt: '2 x 2', expected: 4 }],
    });
    submitTrainingRun
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ id: 'saved-training-run', attemptCount: 1 });

    const { result } = renderHook(() => usePostSession());
    await act(async () => {
      await result.current.startSession([{ type: 'doubling-chain', config: {}, timeLimitSec: 60 }], true);
    });
    act(() => { result.current.submitAnswer('4'); });
    act(() => { result.current.acknowledgeAnswer(); });

    let first;
    await act(async () => { first = await result.current.saveSession({}); });
    expect(first).toBeNull();
    expect(result.current.state).toBe('complete');
    const firstPayload = submitTrainingRun.mock.calls[0][0];
    expect(firstPayload.attempts[0].inputMode).toBe('numeric');

    await act(async () => { await result.current.saveSession({}); });
    expect(result.current.state).toBe('saved');
    const retryPayload = submitTrainingRun.mock.calls[1][0];
    expect(retryPayload.id).toBe(firstPayload.id);
    expect(retryPayload.attempts.map((attempt) => attempt.id))
      .toEqual(firstPayload.attempts.map((attempt) => attempt.id));
  });

  it('sends deterministic drill data and executive metrics for server-authoritative training rescoring', async () => {
    const drillData = {
      type: 'flanker',
      config: { seed: 'client-flanker', responseDeadlineMs: 1500 },
      trials: [{ target: 'right', flanker: 'left', congruent: false }],
    };
    generatePostDrill.mockResolvedValue(drillData);
    submitTrainingRun.mockResolvedValue({ id: 'training-run', attemptCount: 1 });
    const { result } = renderHook(() => usePostSession());
    await act(async () => {
      await result.current.startSession([{ type: 'flanker', config: {} }], true);
    });
    act(() => {
      result.current.completeCognitiveDrill({
        module: 'cognitive',
        type: 'flanker',
        config: drillData.config,
        drillData,
        questions: [{ index: 0, answered: 'right', correct: true, responseMs: 400, congruent: false }],
        score: 100,
        accuracy: 1,
        completion: 1,
        congruencyCostMs: null,
        incongruentAccuracy: 1,
        omissions: 0,
        commissionErrors: 0,
        latencyDistributionMs: [400],
        totalMs: 400,
      });
    });
    await act(async () => { await result.current.saveSession({}); });

    expect(submitTrainingRun.mock.calls[0][0].attempts[0]).toEqual(expect.objectContaining({
      drillType: 'flanker',
      drillData,
      accuracy: 1,
      congruencyCostMs: null,
      incongruentAccuracy: 1,
      omissions: 0,
      commissionErrors: 0,
      latencyDistributionMs: [400],
      scorerProvenance: 'client-deterministic',
    }));
  });
});

describe('usePostSession — LLM training-log per-question breakdown (issue #2114)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Follow-up to #2097: the standalone Wordplay tab already threads a
  // per-question breakdown through submitTrainingEntry (WordplayTrainer.jsx).
  // The in-session runner completes the same four drill types through
  // completeLlmDrill/saveSession here, and must populate the same field so a
  // completed in-session wordplay round isn't missing the breakdown.
  it('threads a per-question breakdown for a completed in-session wordplay drill', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'compound-chain', config: {}, challenges: [{ rootWord: 'fire' }],
    });
    scorePostLlmDrill.mockResolvedValue({
      score: 90,
      questions: [{ questionIndex: 0, prompt: 'fire', items: ['firehouse'], responseMs: 500, llmScore: 90, llmFeedback: 'Nice!' }],
      evaluation: { overallScore: 90, scores: [{ score: 90, feedback: 'Nice!' }] },
    });
    submitTrainingRun.mockResolvedValue({ id: 'training-run' });

    const { result } = renderHook(() => usePostSession());

    await act(async () => {
      await result.current.startSession([{ type: 'compound-chain', config: {}, timeLimitSec: 120 }], true);
    });

    await act(async () => {
      await result.current.completeLlmDrill({
        module: 'llm-drills',
        type: 'compound-chain',
        config: {},
        drillData: {},
        responses: [{ questionIndex: 0, prompt: 'fire', items: ['firehouse'], responseMs: 500 }],
        totalMs: 5000,
      });
    });

    await act(async () => {
      await result.current.saveSession({});
    });

    expect(submitTrainingRun.mock.calls[0][0].attempts[0]).toEqual(expect.objectContaining({
      drillType: 'compound-chain',
      questions: [expect.objectContaining({
        prompt: 'fire', items: ['firehouse'], score: 90, feedback: 'Nice!', correct: true,
      })],
    }));
  });

  // Non-wordplay LLM drill types (word-association, story-recall, etc.) have
  // no dashboard use case yet and their `r.responses` shape isn't guaranteed
  // to carry a renderable prompt — scope the breakdown to WORDPLAY_LLM_DRILL_TYPES
  // only, same as the standalone tab.
  it('omits the questions field for a non-wordplay LLM drill type', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'word-association', config: {}, prompts: ['x'],
    });
    scorePostLlmDrill.mockResolvedValue({
      score: 80,
      questions: [{ questionIndex: 0, response: 'y', llmScore: 80 }],
      evaluation: { overallScore: 80, scores: [{ score: 80 }] },
    });
    submitTrainingRun.mockResolvedValue({ id: 'training-run' });

    const { result } = renderHook(() => usePostSession());

    await act(async () => {
      await result.current.startSession([{ type: 'word-association', config: {}, timeLimitSec: 120 }], true);
    });

    await act(async () => {
      await result.current.completeLlmDrill({
        module: 'llm-drills',
        type: 'word-association',
        config: {},
        drillData: {},
        responses: [{ questionIndex: 0, response: 'y', responseMs: 500 }],
        totalMs: 3000,
      });
    });

    await act(async () => {
      await result.current.saveSession({});
    });

    const entry = submitTrainingRun.mock.calls[0][0].attempts[0];
    expect(entry).not.toHaveProperty('questions');
  });
});

describe('usePostSession — refresh-safe run + idempotent submit (issue #2098)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('generates a client run id and submits it as the session id (idempotent upsert key)', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'doubling-chain', config: { startValue: 2, steps: 1 }, questions: [{ prompt: '2 x 2', expected: 4 }],
    });
    submitPostSession.mockResolvedValue({ id: 'srv', score: 100 });

    const { result } = renderHook(() => usePostSession());
    await act(async () => {
      await result.current.startSession([{ type: 'doubling-chain', config: {}, timeLimitSec: 60 }]);
    });
    const runId = result.current.runId;
    expect(runId).toMatch(/^[0-9a-f-]{36}$/i);

    act(() => { result.current.submitAnswer('4'); });
    await act(async () => { await result.current.saveSession({}); });

    const payload = submitPostSession.mock.calls[0][0];
    expect(payload.id).toBe(runId); // same id the run started with → retry-safe
  });

  it('persists the in-progress run to sessionStorage and restores it on a fresh mount (refresh)', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'doubling-chain', config: { startValue: 2, steps: 3 },
      questions: [
        { prompt: '2 x 2', expected: 4 },
        { prompt: '4 x 2', expected: 8 },
        { prompt: '8 x 2', expected: 16 },
      ],
    });

    const first = renderHook(() => usePostSession());
    await act(async () => {
      await first.result.current.startSession([{ type: 'doubling-chain', config: {}, timeLimitSec: 60 }]);
    });
    act(() => { first.result.current.submitAnswer('4'); }); // answer q1, mid-drill
    const runId = first.result.current.runId;
    expect(first.result.current.state).toBe('drilling');

    // Simulate a page refresh: a brand-new hook instance reads sessionStorage.
    first.unmount();
    const second = renderHook(() => usePostSession());
    expect(second.result.current.runId).toBe(runId);
    expect(second.result.current.state).toBe('drilling');
    expect(second.result.current.currentDrill?.questions).toHaveLength(3);
    expect(second.result.current.answers).toHaveLength(1); // the mid-drill answer survived
  });

  it('keeps completed results in the snapshot during next-drill generation (does not drop the run on refresh)', async () => {
    generatePostDrill
      .mockResolvedValueOnce({ type: 'doubling-chain', config: {}, questions: [{ prompt: '2 x 2', expected: 4 }] })
      .mockImplementationOnce(() => new Promise(() => {})); // drill 2 generation hangs (mid-refresh)

    const { result } = renderHook(() => usePostSession());
    await act(async () => {
      await result.current.startSession([
        { type: 'doubling-chain', config: {}, timeLimitSec: 60 },
        { type: 'doubling-chain', config: {}, timeLimitSec: 60 },
      ]);
    });
    act(() => { result.current.submitAnswer('4'); }); // finish drill 1 → between-drills
    expect(result.current.state).toBe('between-drills');

    act(() => { result.current.nextDrill(); }); // drill 2 generation starts and hangs → loading
    expect(result.current.state).toBe('loading');

    // The 'loading' state must NOT have overwritten the stable between-drills
    // snapshot — drill 1's completed result must survive a refresh here.
    const snap = JSON.parse(sessionStorage.getItem('post.activeRun'));
    expect(snap.state).toBe('between-drills');
    expect(snap.drillResults).toHaveLength(1);
  });

  it('restores a training run persisted mid-save for an idempotent retry', () => {
    sessionStorage.setItem('post.activeRun', JSON.stringify({
      runId: '11111111-1111-4111-8111-111111111111', state: 'saving', isTraining: true,
      drills: [{ type: 'compound-chain' }], currentDrillIndex: 0, currentDrill: null,
      currentQuestionIndex: 0, answers: [],
      drillResults: [{ module: 'llm-drills', type: 'compound-chain', score: 90 }],
      sessionScore: 90, conditions: {},
    }));
    const { result } = renderHook(() => usePostSession());
    expect(result.current.state).toBe('complete');
    expect(result.current.drillResults).toHaveLength(1);
  });

  it('preserves legacy free-text tags from a run resumed after an app upgrade (issue #4442 codex review)', async () => {
    // A snapshot written by a PRE-upgrade build still has the old free-text
    // `tags` shape and no `conditions` key at all — e.g. a mid-session
    // refresh spanning a deploy. Those values must ride through to the
    // submitted payload's legacy `tags` field, not be silently dropped.
    sessionStorage.setItem('post.activeRun', JSON.stringify({
      runId: '22222222-2222-4222-8222-222222222222', state: 'complete', isTraining: false,
      drills: [{ type: 'doubling-chain', config: {}, timeLimitSec: 60 }],
      currentDrillIndex: 0, currentDrill: null, currentQuestionIndex: 0, answers: [],
      drillResults: [{ module: 'mental-math', type: 'doubling-chain', score: 80 }],
      sessionScore: 80,
      tags: { sleep: 'good', caffeine: '1 cup' },
    }));
    submitPostSession.mockResolvedValue({ id: 'session-legacy', score: 80 });

    const { result } = renderHook(() => usePostSession());
    expect(result.current.state).toBe('complete');

    await act(async () => {
      await result.current.saveSession({});
    });

    const payload = submitPostSession.mock.calls[0][0];
    expect(payload.tags).toEqual({ sleep: 'good', caffeine: '1 cup' });
    expect(payload.conditions).toEqual({});
  });

  it('does NOT resurrect legacy tags for a run resumed from a snapshot that already has conditions', async () => {
    sessionStorage.setItem('post.activeRun', JSON.stringify({
      runId: '33333333-3333-4333-8333-333333333333', state: 'complete', isTraining: false,
      drills: [{ type: 'doubling-chain', config: {}, timeLimitSec: 60 }],
      currentDrillIndex: 0, currentDrill: null, currentQuestionIndex: 0, answers: [],
      drillResults: [{ module: 'mental-math', type: 'doubling-chain', score: 80 }],
      sessionScore: 80,
      // Both keys present (shouldn't normally happen, but conditions being
      // set at all is the signal this is a post-upgrade snapshot) — tags
      // must not be treated as the legacy carrier here.
      tags: { sleep: 'good' },
      conditions: { sleepQuality: 'good' },
    }));
    submitPostSession.mockResolvedValue({ id: 'session-new', score: 80 });

    const { result } = renderHook(() => usePostSession());
    await act(async () => {
      await result.current.saveSession({});
    });

    const payload = submitPostSession.mock.calls[0][0];
    expect(payload.tags).toBeUndefined();
    expect(payload.conditions).toEqual({ sleepQuality: 'good' });
  });

  it('clears the persisted run on reset (no stale run resumes next mount)', async () => {
    generatePostDrill.mockResolvedValue({
      type: 'doubling-chain', config: { startValue: 2, steps: 1 }, questions: [{ prompt: '2 x 2', expected: 4 }],
    });
    const { result, unmount } = renderHook(() => usePostSession());
    await act(async () => {
      await result.current.startSession([{ type: 'doubling-chain', config: {}, timeLimitSec: 60 }]);
    });
    act(() => { result.current.reset(); });
    unmount();

    const next = renderHook(() => usePostSession());
    expect(next.result.current.state).toBe('idle');
    expect(next.result.current.runId).toBeNull();
  });
});

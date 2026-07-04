import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../services/api', () => ({
  generatePostDrill: vi.fn(),
  submitPostSession: vi.fn(),
  scorePostLlmDrill: vi.fn(),
  submitTrainingEntry: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { generatePostDrill, submitPostSession, scorePostLlmDrill, submitTrainingEntry } from '../services/api';
import { usePostSession } from './usePostSession';

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
    submitTrainingEntry.mockResolvedValue({});

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

    expect(submitTrainingEntry).toHaveBeenCalledWith(expect.objectContaining({
      module: 'llm-drills',
      drillType: 'compound-chain',
      questionCount: 1,
      correctCount: 1,
      totalMs: 5000,
    }));
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
    submitTrainingEntry.mockResolvedValue({});

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

    expect(submitTrainingEntry).toHaveBeenCalledWith(expect.objectContaining({
      drillType: 'bridge-word', questionCount: 1, correctCount: 0,
    }));
  });
});

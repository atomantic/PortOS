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
        responses: [{ questionIndex: 0, prompt: 'fire', items: ['firehouse'], responseMs: 500 }],
        totalMs: 5000,
      });
    });

    await act(async () => {
      await result.current.saveSession({});
    });

    expect(submitTrainingEntry).toHaveBeenCalledWith(expect.objectContaining({
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
    submitTrainingEntry.mockResolvedValue({});

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

    const entry = submitTrainingEntry.mock.calls[0][0];
    expect(entry).not.toHaveProperty('questions');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../services/api', () => ({
  generatePostDrill: vi.fn(),
  submitPostSession: vi.fn(),
  scorePostLlmDrill: vi.fn(),
  submitTrainingEntry: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { generatePostDrill, submitPostSession } from '../services/api';
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

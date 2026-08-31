import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Set();
vi.mock('../services/socket', () => ({
  default: {
    on: (event, handler) => { if (event === 'ai:status') handlers.add(handler); },
    off: (event, handler) => { if (event === 'ai:status') handlers.delete(handler); },
  },
}));

import useFableLoomAiRun from './useFableLoomAiRun.js';

const emit = (event) => handlers.forEach((handler) => handler(event));

beforeEach(() => handlers.clear());

describe('useFableLoomAiRun', () => {
  it('ignores stale operation events and exposes a ready shell handoff', () => {
    const { result } = renderHook(() => useFableLoomAiRun());
    let operationId;
    act(() => { operationId = result.current.begin(); });

    act(() => emit({ operationId: 'stale-operation', phase: 'running', message: 'Wrong run' }));
    expect(result.current.run.message).toBe('Starting AI…');

    act(() => emit({
      operationId,
      phase: 'ready',
      runId: 'run-tui-1',
      providerType: 'tui',
      providerName: 'Codex TUI',
      model: 'gpt-test',
      shellReady: true,
      message: 'TUI run is ready',
    }));
    expect(result.current.run).toMatchObject({
      operationId, runId: 'run-tui-1', phase: 'ready', shellReady: true,
    });
  });

  it('marks a client-side request failure as terminal', () => {
    const { result } = renderHook(() => useFableLoomAiRun());
    act(() => { result.current.begin(); });
    act(() => { result.current.fail('Provider unavailable'); });
    expect(result.current.run).toMatchObject({ phase: 'error', message: 'Provider unavailable', shellReady: false });
  });
});

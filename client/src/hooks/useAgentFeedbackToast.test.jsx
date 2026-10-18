import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';

// Capture the `cos:agent:completed` handler so tests can drive completions.
const handlers = new Map();
const emitted = [];
vi.mock('../services/socket', () => ({
  default: {
    connected: true,
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
    emit: (event, payload) => { emitted.push([event, payload]); },
  },
}));

const toastSpy = vi.fn();
vi.mock('../components/ui/Toast', () => ({ default: Object.assign((...a) => toastSpy(...a), { dismiss: vi.fn() }) }));

const { useAgentFeedbackToast } = await import('./useAgentFeedbackToast.jsx');
const fire = (agent) => handlers.get('cos:agent:completed')?.(agent);
const completed = (overrides = {}) => ({
  id: 'agent-1',
  taskId: 'task-1',
  status: 'completed',
  metadata: { taskType: 'user', taskDescription: 'Do the thing' },
  result: { success: true },
  ...overrides,
});

describe('useAgentFeedbackToast', () => {
  beforeEach(() => { handlers.clear(); emitted.length = 0; toastSpy.mockClear(); });
  afterEach(cleanup);

  // The server clears its per-socket subscriber Set on disconnect, so with no
  // sibling cos:* consumer mounted this hook must re-subscribe on its own
  // (#12033) or a completion after the first reconnect toasts nothing.
  it('re-subscribes to cos:* on reconnect with only this hook mounted, and still toasts', () => {
    renderHook(() => useAgentFeedbackToast());
    expect(emitted.filter(([e]) => e === 'cos:subscribe')).toHaveLength(1);

    act(() => { handlers.get('connect')?.(); });
    expect(emitted.filter(([e]) => e === 'cos:subscribe')).toHaveLength(2);

    fire(completed());
    expect(toastSpy).toHaveBeenCalledTimes(1);
  });

  it('prompts for a rating when a manual user task completes', () => {
    renderHook(() => useAgentFeedbackToast());
    fire(completed());
    expect(toastSpy).toHaveBeenCalledTimes(1);
  });

  // The server rejects feedback for autonomous runs ("Can only submit feedback
  // for completed agents"), so the toast must not offer thumbs it will refuse.
  it('stays silent for an autonomous scheduled run the server will not accept feedback for', () => {
    renderHook(() => useAgentFeedbackToast());
    fire(completed({ id: 'agent-2', metadata: { taskType: 'internal', taskDescription: 'claim-issue' } }));
    expect(toastSpy).not.toHaveBeenCalled();
  });
});

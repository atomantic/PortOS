import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

// Capture the `cos:agent:completed` handler so tests can drive completions.
const handlers = new Map();
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
    emit: () => {},
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
  beforeEach(() => { handlers.clear(); toastSpy.mockClear(); });
  afterEach(cleanup);

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

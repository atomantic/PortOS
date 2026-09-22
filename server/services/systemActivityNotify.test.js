import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimAppOperation, endAppOperation, __resetAppOperations } from './appOperations.js';
import { cosEvents } from './cosEvents.js';
import { mediaJobEvents } from './mediaJobQueue/index.js';
import {
  SYSTEM_ACTIVITY_COALESCE_MS,
  agentCompletionPhase,
  armSystemActivityWatchers,
  attachLlmActivityHooks,
  bindSystemActivityIo,
  drainActivityNotesForTests,
  mindActivityPhases,
  noteSystemActivity,
  resetSystemActivityNotifyForTests,
  taskQueuePhase,
} from './systemActivityNotify.js';

afterEach(() => {
  resetSystemActivityNotifyForTests();
  __resetAppOperations();
  vi.useRealTimers();
});

describe('system activity invalidation', () => {
  it('coalesces a burst into one frame that carries no snapshot', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    bindSystemActivityIo({ emit });
    noteSystemActivity('media', 'start');
    noteSystemActivity('media', 'completion');
    noteSystemActivity('agents', 'queued');
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SYSTEM_ACTIVITY_COALESCE_MS);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('system:activity', { seq: 1, source: 'agents', phase: 'queued' });
    expect(Object.keys(emit.mock.calls[0][1]).sort()).toEqual(['phase', 'seq', 'source']);
  });

  it('maps mind, agent, and task edges onto lifecycle phases', () => {
    expect(mindActivityPhases(null, { activeTurnId: 't', queuedMessageCount: 2, status: 'thinking', failureCount: 0 }))
      .toEqual(['start', 'queued']);
    expect(mindActivityPhases(
      { activeTurnId: 't', queuedMessageCount: 2, failureCount: 0 },
      { activeTurnId: null, queuedMessageCount: 0, status: 'idle', failureCount: 0 },
    )).toEqual(['completion', 'drained']);
    expect(mindActivityPhases(
      { activeTurnId: 't', queuedMessageCount: 0, failureCount: 0 },
      { activeTurnId: null, queuedMessageCount: 0, status: 'paused', failureCount: 0 },
    )).toEqual(['cancellation']);
    expect(mindActivityPhases(
      { activeTurnId: 't', queuedMessageCount: 0, failureCount: 0 },
      { activeTurnId: null, queuedMessageCount: 0, status: 'degraded', failureCount: 1 },
    )).toEqual(['failure']);

    expect(agentCompletionPhase({ result: { success: true } })).toBe('completion');
    expect(agentCompletionPhase({ result: { success: false, error: 'provider failed' } })).toBe('failure');
    expect(agentCompletionPhase({ result: { success: false, error: 'Agent terminated by user' } })).toBe('cancellation');
    expect(taskQueuePhase({ action: 'added' })).toBe('queued');
    expect(taskQueuePhase({ action: 'requeued' })).toBe('queued');
    expect(taskQueuePhase({ action: 'deleted' })).toBe('drained');
    expect(taskQueuePhase({ action: 'updated', previousStatus: 'pending', task: { status: 'in_progress' } })).toBe('drained');
    expect(taskQueuePhase({ action: 'updated', previousStatus: 'pending', task: { status: 'pending' } })).toBeNull();
  });

  it('notifies start, completion, failure, cancellation, and queue drain for every event-backed source', async () => {
    await armSystemActivityWatchers();
    drainActivityNotesForTests();

    mediaJobEvents.emit('enqueued', { id: 'job-1' });
    mediaJobEvents.emit('started', { id: 'job-1' });
    mediaJobEvents.emit('completed', { id: 'job-1', status: 'completed' });
    mediaJobEvents.emit('failed', { id: 'job-2', status: 'failed' });
    mediaJobEvents.emit('canceled', { id: 'job-3', status: 'canceled' });

    cosEvents.emit('agent:spawned', { id: 'agent-1' });
    cosEvents.emit('agent:completed', { id: 'agent-1', result: { success: true } });
    cosEvents.emit('agent:completed', { id: 'agent-2', result: { success: false, error: 'spawn failed' } });
    cosEvents.emit('agent:terminate', 'agent-3');
    cosEvents.emit('agent:completed', { id: 'agent-3', result: { success: false, error: 'Agent killed by user' } });
    cosEvents.emit('tasks:changed', { action: 'added', task: { status: 'pending' } });
    cosEvents.emit('tasks:changed', { action: 'updated', previousStatus: 'pending', task: { status: 'in_progress' } });

    cosEvents.emit('persistent-mind:status', { activeTurnId: 'turn-1', queuedMessageCount: 1, status: 'thinking', failureCount: 0 });
    cosEvents.emit('persistent-mind:status', { activeTurnId: null, queuedMessageCount: 0, status: 'idle', failureCount: 0 });
    cosEvents.emit('persistent-mind:status', { activeTurnId: 'turn-2', queuedMessageCount: 0, status: 'thinking', failureCount: 0 });
    cosEvents.emit('persistent-mind:status', { activeTurnId: null, queuedMessageCount: 0, status: 'paused', failureCount: 0 });
    cosEvents.emit('persistent-mind:status', { activeTurnId: 'turn-3', queuedMessageCount: 0, status: 'thinking', failureCount: 0 });
    cosEvents.emit('persistent-mind:status', { activeTurnId: null, queuedMessageCount: 0, status: 'interrupted', failureCount: 1 });

    const hooks = attachLlmActivityHooks({
      onRunCompleted: () => 'kept',
    });
    expect(hooks.onRunStarted({})).toBeUndefined();
    expect(hooks.onRunCompleted({}, '')).toBe('kept');
    hooks.onRunFailed({}, new Error('no'));
    hooks.onRunCanceled({ runId: 'run-1' });

    const io = { emit: vi.fn() };
    const app = { id: 'app-1', name: 'Example', repoPath: 'app-1' };
    expect(claimAppOperation(io, app, 'update').ok).toBe(true);
    endAppOperation(io, 'app-1', 'failure');
    expect(claimAppOperation(io, app, 'standardize').ok).toBe(true);
    endAppOperation(io, 'app-1', 'completion');
    expect(claimAppOperation(io, app, 'update').ok).toBe(true);
    endAppOperation(io, 'app-1', 'cancellation');

    const phases = drainActivityNotesForTests();
    const of = (source) => phases.filter((note) => note.source === source).map((note) => note.phase);
    expect(of('media')).toEqual([
      'queued', 'start', 'completion', 'drained', 'failure', 'drained', 'cancellation', 'drained',
    ]);
    expect(of('agents')).toEqual([
      'start', 'completion', 'failure', 'cancellation', 'cancellation', 'queued', 'drained',
    ]);
    expect(of('mind')).toEqual(['start', 'queued', 'completion', 'drained', 'start', 'cancellation', 'start', 'failure']);
    expect(of('llm')).toEqual(['start', 'completion', 'failure', 'cancellation']);
    expect(of('appOperations')).toEqual([
      'start', 'failure', 'drained', 'start', 'completion', 'drained', 'start', 'cancellation', 'drained',
    ]);
  });
});

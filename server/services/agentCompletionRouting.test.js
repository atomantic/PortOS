/**
 * Behavioral tests for `handleAgentCompletion`'s ROUTER (issue #3872).
 *
 * `handleAgentCompletion` has three mutually exclusive outcomes, picked before
 * any completion work runs:
 *
 *   1. the agent is paused  → return immediately, finalize NOTHING (the resume
 *      path owns the worktree and the task);
 *   2. the agent is not in `runnerAgents` (server restarted) → hand off to
 *      `completeUntrackedAgentFromCosState`, which retires it from persisted
 *      cos state without running finalize/worktree cleanup;
 *   3. the agent is live in `runnerAgents` → the full in-memory completion path.
 *
 * Outcome 1 is a data-loss guard: completing a paused agent cleans the worktree
 * and completes the task out from under a later resume. It used to be pinned by
 * a source-grep assertion in `agentManagement.test.js` ("`pausedAgents.has` must
 * appear before `completeAgent(` in the function's source text"), which broke the
 * moment the recovery path was extracted — the only `completeAgent(` in the
 * function moved with it. These tests drive the real exported function instead,
 * so they survive any future extraction and still fail if the guard is removed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./cos.js', () => ({
  getConfig: vi.fn().mockResolvedValue({}),
  updateTask: vi.fn().mockResolvedValue(true),
  getTaskById: vi.fn().mockResolvedValue(null),
  getAgentRecord: vi.fn().mockResolvedValue(null),
  // The recovery path reaches for this via `await import('./cos.js')`.
  getAgent: vi.fn().mockResolvedValue(null),
}));

vi.mock('./cosAgentLifecycle.js', () => ({
  registerAgent: vi.fn().mockResolvedValue(undefined),
  updateAgent: vi.fn().mockResolvedValue(undefined),
  completeAgent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./agentFinalization.js', () => ({
  dispatchRecoveredTaskOutputHook: vi.fn().mockResolvedValue(undefined),
  finalizeAgent: vi.fn().mockResolvedValue(undefined),
  releaseAgentLane: vi.fn(),
  stampLiExecutionVerdict: vi.fn(async (update) => update),
}));

vi.mock('./agentManagement.js', () => ({
  handleOrphanedTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./agentWorktreeCleanup.js', () => ({
  cleanupAgentWorktree: vi.fn().mockResolvedValue(undefined),
  releaseRetryHold: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./agentCompletionCleanup.js', () => ({
  runAgentCompletionCleanup: vi.fn().mockResolvedValue(undefined),
}));

import { handleAgentCompletion } from './agentLifecycle.js';
import { runnerAgents, pausedAgents } from './agentState.js';
import { completeAgent } from './cosAgentLifecycle.js';
import { getAgent, getAgentRecord, getTaskById, updateTask } from './cos.js';
import { dispatchRecoveredTaskOutputHook } from './agentFinalization.js';
import { handleOrphanedTask } from './agentManagement.js';

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks does NOT drain a queued `mockResolvedValueOnce` — and the pause
  // tests deliberately leave theirs unconsumed (that IS the assertion), so without
  // an explicit reset the leftover leaks into the next test's first read.
  getAgent.mockReset().mockResolvedValue(null);
  getTaskById.mockReset().mockResolvedValue(null);
  runnerAgents.clear();
  pausedAgents.clear();
});

describe('handleAgentCompletion — pause guard (data-loss guard)', () => {
  // Deliberately staged so that WITHOUT the guard this call completes the agent:
  // the persisted record says `running`, and the agent is absent from
  // `runnerAgents` (the post-restart shape), so the recovery path would retire
  // it and requeue the task the resume was going to pick up.
  it('finalizes nothing for a paused agent the recovery path would otherwise retire', async () => {
    getAgent.mockResolvedValueOnce({ agentId: 'agent-paused', status: 'running', taskId: 'task-1', metadata: {} });
    pausedAgents.set('agent-paused', { pausedAt: Date.now(), reason: 'user' });

    await handleAgentCompletion('agent-paused', 143, false, 1000);

    // The whole point: no completion write of any kind.
    expect(completeAgent).not.toHaveBeenCalled();
    expect(getAgent).not.toHaveBeenCalled();
    expect(handleOrphanedTask).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  // Same guard, live-agent shape: the pause must also win over the in-memory
  // completion path, which would run finalize + worktree cleanup. `getAgentRecord`
  // is that path's very first read, so never touching it proves we never entered it.
  it('does not enter the live completion path for a paused agent still in runnerAgents', async () => {
    pausedAgents.set('agent-paused', { pausedAt: Date.now(), reason: 'user' });
    runnerAgents.set('agent-paused', { task: { id: 'task-1' }, providerId: 'claude' });

    await handleAgentCompletion('agent-paused', 143, false, 1000);

    expect(getAgentRecord).not.toHaveBeenCalled();
    expect(completeAgent).not.toHaveBeenCalled();
  });

  it('drops both map entries so the pause is consumed and the slot is reclaimable', async () => {
    pausedAgents.set('agent-paused', { pausedAt: Date.now(), reason: 'user' });
    runnerAgents.set('agent-paused', { task: { id: 'task-1' } });

    await handleAgentCompletion('agent-paused', 143, false, 1000);

    expect(pausedAgents.has('agent-paused')).toBe(false);
    expect(runnerAgents.has('agent-paused')).toBe(false);
  });

  // Bypass probe: with the pause flag absent, the SAME call must reach a
  // completion path. Without this, a guard that swallowed every event
  // unconditionally (or a `return` moved to the top of the function) would pass
  // the two assertions above while breaking all completions.
  it('does NOT swallow the event when the agent is not paused', async () => {
    getAgent.mockResolvedValueOnce({ agentId: 'agent-live', status: 'running', taskId: null, metadata: {} });

    await handleAgentCompletion('agent-live', 0, true, 1000);

    expect(completeAgent).toHaveBeenCalledWith('agent-live', expect.objectContaining({ orphaned: true }));
  });
});

describe('handleAgentCompletion — post-restart recovery hand-off', () => {
  it('retires an untracked agent from persisted cos state', async () => {
    getAgent.mockResolvedValueOnce({
      agentId: 'agent-gone',
      status: 'running',
      taskId: 'task-9',
      startedAt: '2020-01-01T00:00:00.000Z',
      metadata: { workspacePath: '/repo/wt' },
    });
    getTaskById.mockResolvedValue({ id: 'task-9', status: 'running', taskType: 'user' });

    await handleAgentCompletion('agent-gone', 0, true, 500);

    expect(dispatchRecoveredTaskOutputHook).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-gone', workspacePath: '/repo/wt' })
    );
    expect(completeAgent).toHaveBeenCalledWith('agent-gone', expect.objectContaining({ orphaned: true, success: true }));
    expect(updateTask).toHaveBeenCalledWith('task-9', expect.objectContaining({ status: 'completed' }), 'user');
  });

  it('hands the dead run’s metadata + startedAt to the retry handler on failure', async () => {
    getAgent.mockResolvedValueOnce({
      agentId: 'agent-gone',
      status: 'running',
      taskId: 'task-9',
      startedAt: '2020-01-01T00:00:00.000Z',
      metadata: { worktreeBranch: 'cos/task-9' },
    });
    getTaskById.mockResolvedValue({ id: 'task-9', status: 'running', taskType: 'user' });

    await handleAgentCompletion('agent-gone', 1, false, 500);

    expect(handleOrphanedTask).toHaveBeenCalledWith(
      'task-9',
      'agent-gone',
      expect.any(Function),
      { agentMetadata: { worktreeBranch: 'cos/task-9' }, agentStartedAt: '2020-01-01T00:00:00.000Z' }
    );
  });

  it('ignores a completion for an agent whose persisted status is paused', async () => {
    getAgent.mockResolvedValueOnce({ agentId: 'agent-p', status: 'paused', taskId: 'task-9', metadata: {} });

    await handleAgentCompletion('agent-p', 143, false, 500);

    expect(completeAgent).not.toHaveBeenCalled();
    expect(handleOrphanedTask).not.toHaveBeenCalled();
  });

  it('ignores a completion for an agent with no persisted cos record', async () => {
    getAgent.mockResolvedValueOnce(null);

    await handleAgentCompletion('agent-unknown', 0, true, 500);

    expect(completeAgent).not.toHaveBeenCalled();
  });
});

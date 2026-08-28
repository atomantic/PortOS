import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

vi.mock('./cosAgentLifecycle.js', () => ({
  getAgent: vi.fn(),
  getAgentRecord: vi.fn(async () => null),
  updateAgent: vi.fn(),
  completeAgent: vi.fn(),
}));

vi.mock('./taskTypeHooks.js', () => ({
  canRunTaskOutputHookWithoutPayload: vi.fn(() => true),
  getTaskOutputHook: vi.fn(),
  getTaskOutputPayloadPredicate: vi.fn(async () => null),
  declaresNoCommitCriterion: vi.fn(() => false),
  isProgrammaticIoTaskType: vi.fn(() => true),
  resolveTaskHookType: vi.fn(task => task?.metadata?.analysisType || null),
}));

import { getAgent, updateAgent } from './cosAgentLifecycle.js';
import { canRunTaskOutputHookWithoutPayload, getTaskOutputHook } from './taskTypeHooks.js';
import {
  dispatchRecoveredTaskOutputHook,
  dispatchTaskOutputHookOnce,
} from './agentFinalization.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANAGEMENT_SOURCE = readFileSync(join(__dirname, 'agentManagement.js'), 'utf8');
const LIFECYCLE_SOURCE = readFileSync(join(__dirname, 'agentLifecycle.js'), 'utf8');
const TASK = {
  id: 'sys-example',
  taskType: 'internal',
  metadata: {
    analysisType: 'example-output-hook',
    app: 'app-example',
    repoPath: '/example/repo',
  },
};

describe('recovery output-hook dispatch (#3182)', () => {
  let persistedAgent;
  let hook;

  beforeEach(() => {
    vi.clearAllMocks();
    persistedAgent = {
      id: 'agent-example',
      status: 'running',
      metadata: {},
    };
    getAgent.mockImplementation(async () => persistedAgent);
    updateAgent.mockImplementation(async (_agentId, updates) => {
      persistedAgent = {
        ...persistedAgent,
        metadata: { ...persistedAgent.metadata, ...updates.metadata },
      };
      return persistedAgent;
    });
    hook = vi.fn().mockResolvedValue({ recorded: true });
    getTaskOutputHook.mockResolvedValue(hook);
  });

  it.each([
    ['orphan cleanup', false],
    ['post-restart completion', true],
  ])('runs a registered processTaskOutput hook for %s with no stale sentinel payload', async (_path, success) => {
    const result = await dispatchRecoveredTaskOutputHook({
      agentId: persistedAgent.id,
      task: TASK,
      success,
    });

    expect(result).toEqual({ ran: true, outcome: { recorded: true } });
    expect(hook).toHaveBeenCalledOnce();
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({
      agentId: persistedAgent.id,
      task: TASK,
      appId: 'app-example',
      success,
      payload: null,
      workspacePath: null,
    }));
    expect(updateAgent).toHaveBeenCalledWith(
      persistedAgent.id,
      { metadata: { outputHookDispatchedAt: expect.any(String) } },
    );
  });

  it('deduplicates concurrent normal/recovery completion and persists the gate', async () => {
    let finishHook;
    hook.mockReturnValueOnce(new Promise(resolve => { finishHook = resolve; }));

    const normal = dispatchTaskOutputHookOnce({
      agentId: persistedAgent.id,
      task: TASK,
      success: true,
      workspacePath: '/example/worktree',
    });
    const recovery = dispatchRecoveredTaskOutputHook({
      agentId: persistedAgent.id,
      task: TASK,
      success: false,
    });

    expect(recovery).toBe(normal);
    await vi.waitFor(() => expect(hook).toHaveBeenCalledOnce());
    finishHook({ recorded: true });
    await expect(normal).resolves.toEqual({ ran: true, outcome: { recorded: true } });

    await expect(dispatchRecoveredTaskOutputHook({
      agentId: persistedAgent.id,
      task: TASK,
      success: false,
    })).resolves.toEqual({ ran: false, alreadyDispatched: true });
    expect(hook).toHaveBeenCalledOnce();
  });

  it('keeps a timed-out hook recoverable until the original dispatch settles', async () => {
    vi.useFakeTimers();
    let finishHook;
    hook.mockReturnValueOnce(new Promise(resolve => { finishHook = resolve; }));

    const original = dispatchTaskOutputHookOnce({
      agentId: persistedAgent.id,
      task: TASK,
      success: true,
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    await expect(original).resolves.toEqual({ ran: false, timedOut: true });
    expect(updateAgent).not.toHaveBeenCalled();
    expect(dispatchRecoveredTaskOutputHook({
      agentId: persistedAgent.id,
      task: TASK,
      success: false,
    })).toBe(original);

    finishHook({ recorded: true });
    await vi.waitFor(() => expect(updateAgent).toHaveBeenCalledWith(
      persistedAgent.id,
      { metadata: { outputHookDispatchedAt: expect.any(String) } },
    ));
    vi.useRealTimers();

    await expect(dispatchRecoveredTaskOutputHook({
      agentId: persistedAgent.id,
      task: TASK,
      success: false,
    })).resolves.toEqual({ ran: false, alreadyDispatched: true });
    expect(hook).toHaveBeenCalledOnce();
  });

  it('does not dispatch after finalizeAgent persisted the explicit hook marker', async () => {
    persistedAgent.metadata.outputHookDispatchedAt = new Date().toISOString();

    await expect(dispatchRecoveredTaskOutputHook({
      agentId: persistedAgent.id,
      task: TASK,
      success: false,
    })).resolves.toEqual({ ran: false, alreadyDispatched: true });
    expect(hook).not.toHaveBeenCalled();
  });

  it('still dispatches for an agent completed early by terminate/kill before finalizeAgent', async () => {
    persistedAgent.status = 'completed';

    await expect(dispatchTaskOutputHookOnce({
      agentId: persistedAgent.id,
      task: TASK,
      success: false,
    })).resolves.toEqual({ ran: true, outcome: { recorded: true } });
    expect(hook).toHaveBeenCalledOnce();
  });

  it('does not persist a dispatch marker when recovery has no registered hook', async () => {
    getTaskOutputHook.mockResolvedValueOnce(null);

    await expect(dispatchRecoveredTaskOutputHook({
      agentId: persistedAgent.id,
      task: TASK,
      success: false,
    })).resolves.toEqual({ ran: false });
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('does not invoke a payload-dependent hook when recovery cannot read a sentinel', async () => {
    canRunTaskOutputHookWithoutPayload.mockReturnValueOnce(false);

    await expect(dispatchRecoveredTaskOutputHook({
      agentId: persistedAgent.id,
      task: TASK,
      success: true,
    })).resolves.toEqual({ ran: false, recoveryPayloadUnavailable: true });
    expect(hook).not.toHaveBeenCalled();
    expect(updateAgent).not.toHaveBeenCalled();
  });
});

describe('recovery path wiring (#3182)', () => {
  it('dispatches before orphan cleanup marks the agent complete', () => {
    const start = MANAGEMENT_SOURCE.indexOf('async function runCleanupOrphanedAgents');
    const body = MANAGEMENT_SOURCE.slice(start, start + 12_000);
    expect(body.indexOf('dispatchRecoveredTaskOutputHook({')).toBeGreaterThan(-1);
    expect(body.indexOf('dispatchRecoveredTaskOutputHook({')).toBeLessThan(body.indexOf('await completeAgent(agent.id'));
  });

  it('dispatches before post-restart recovery marks the agent complete', () => {
    const start = LIFECYCLE_SOURCE.indexOf('Completing untracked agent');
    const body = LIFECYCLE_SOURCE.slice(start, start + 2_000);
    expect(body.indexOf('dispatchRecoveredTaskOutputHook({')).toBeGreaterThan(-1);
    expect(body.indexOf('dispatchRecoveredTaskOutputHook({')).toBeLessThan(body.indexOf('await completeAgent(agentId'));
  });
});

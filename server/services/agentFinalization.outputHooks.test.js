vi.mock('./appQuality.js', () => ({ recordAuditQuality: vi.fn(async () => true) }));
import { recordAuditQuality } from './appQuality.js';
// The goal-fidelity gate (#5994) reaches a local model at completion. Pinned OFF
// here so these tests exercise the path they are about without depending on the
// developer's own reviewer settings — and so a machine that HAS a local reviewer
// configured never has its suite dispatch a real review request.
vi.mock('./codeReview.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getGoalFidelityConfig: vi.fn(async () => null),
}));

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

import { getAgent, updateAgent, completeAgent } from './cosAgentLifecycle.js';
import { canRunTaskOutputHookWithoutPayload, getTaskOutputHook } from './taskTypeHooks.js';
import {
  finalizeAgent,
  dispatchRecoveredTaskOutputHook,
  dispatchTaskOutputHookOnce,
} from './agentFinalization.js';


vi.mock('./cos.js', () => ({
  updateTask: vi.fn(async () => ({})),
  addTask: vi.fn(async () => ({ id: 'investigation-test' })),
}));
vi.mock('./investigationTaskProducer.js', () => ({
  investigationCircuitOpen: vi.fn(() => false),
  noteInvestigationFiled: vi.fn(),
  readAllTasksFlat: vi.fn(async () => []),
  recentInvestigationCreations: vi.fn(() => []),
}));
vi.mock('./agentErrorAnalysis.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, resolveFailedTaskUpdate: vi.fn(actual.resolveFailedTaskUpdate) };
});
vi.mock('./agentRunTracking.js', () => ({ completeAgentRun: vi.fn(async () => null) }));
vi.mock('./agentCompletion.js', () => ({ processAgentCompletion: vi.fn(async () => null) }));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn(), cosEvents: { emit: vi.fn(), on: vi.fn() } }));
vi.mock('./taskSchedule.js', () => ({
  recordTaskTypeFailure: vi.fn(async () => null),
  recordTaskTypeSuccess: vi.fn(async () => null),
}));
import { updateTask, addTask } from './cos.js';
import { completeAgentRun } from './agentRunTracking.js';
import { resolveFailedTaskUpdate } from './agentErrorAnalysis.js';

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
      startedAt: '2026-09-10T00:00:00Z',
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

  it('captures audit telemetry on the shared completion path without waiving fix-mode delivery criteria', async () => {
    const task = { ...TASK, metadata: { ...TASK.metadata, analysisType: 'better-complexity' } };
    await expect(dispatchTaskOutputHookOnce({ agentId: 'agent-audit', task, success: true, workspacePath: '/worktree' }))
      .resolves.toEqual({ ran: false });
    expect(recordAuditQuality).toHaveBeenCalledWith({ task, taskType: 'better-complexity', agentId: 'agent-audit', success: true, workspacePath: '/worktree', assessedAt: persistedAgent.startedAt });
    expect(hook).not.toHaveBeenCalled();
    expect(updateAgent).not.toHaveBeenCalled();
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

// #6124: the escalation the old `hookRejected && success` guard could not reach.
// The pr-reviewer stage that produced no output exited NON-zero with no captured
// error, so the run was already `success === false` and the permanent verdict
// never applied — the task consumed its retries and the pipeline re-spawned.
describe('permanent output-hook rejection (#6124)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAgent.mockResolvedValue({ id: 'agent-rejected', metadata: {} });
    updateAgent.mockResolvedValue(null);
    getTaskOutputHook.mockResolvedValue(async () => ({
      accepted: false, permanent: true, reason: 'output-missing', message: 'No parseable output',
    }));
  });

  const finish = (errorAnalysis, metadata = {}) => finalizeAgent({
    agentId: 'agent-rejected',
    task: { ...TASK, metadata: { ...TASK.metadata, ...metadata } },
    runId: 'run-rejected', success: false, exitCode: 1, duration: 1000,
    outputBuffer: '', errorAnalysis,
  });

  it('blocks an already-failed unknown run and records failure for cleanup and run history', async () => {
    expect(await finish({ category: 'unknown' })).toMatchObject({ success: false });
    expect(updateTask).toHaveBeenCalledWith(TASK.id, expect.objectContaining({
      status: 'blocked', metadata: expect.objectContaining({ blockedCategory: 'output-missing' }),
    }), 'internal');
    expect(completeAgent).toHaveBeenCalledWith('agent-rejected', expect.objectContaining({
      success: false, completionReason: 'output-missing', error: 'No parseable output',
      errorAnalysis: expect.objectContaining({ permanent: true, origin: 'task-output-hook' }),
    }));
    expect(completeAgentRun).toHaveBeenCalledWith('run-rejected', '', 1, 1000,
      expect.objectContaining({ category: 'output-missing', permanent: true }), false);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('leaves a named failure on its ordinary retry path', async () => {
    await finish({ category: 'rate-limit', message: 'Try later' });
    expect(updateTask).toHaveBeenCalledWith(TASK.id, expect.objectContaining({
      status: 'in_progress', metadata: expect.objectContaining({ lastErrorCategory: 'rate-limit' }),
    }), 'internal');
    expect(completeAgent).toHaveBeenCalledWith('agent-rejected', expect.objectContaining({
      error: 'Try later', completionReason: 'rate-limit',
      errorAnalysis: { category: 'rate-limit', message: 'Try later' },
    }));
    expect(resolveFailedTaskUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not re-resolve an already-blocked task or duplicate its investigation', async () => {
    await finish({ category: 'unknown' }, { failureCount: 3 });
    expect(updateTask).toHaveBeenCalledWith(TASK.id, expect.objectContaining({ status: 'blocked' }), 'internal');
    expect(resolveFailedTaskUpdate).toHaveBeenCalledTimes(1);
    expect(addTask).toHaveBeenCalledTimes(1);
  });
});

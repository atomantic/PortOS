/**
 * Tests for `retireDeadAgent` (#8440) — the single retirement step list the
 * orphan sweep (`runCleanupOrphanedAgents` in agentManagement.js) and the
 * post-restart recovery (`completeUntrackedAgentFromCosState` in
 * agentLifecycle.js) now both call, in place of each hand-maintaining its
 * own copy. Exercises the REAL function against mocked leaves so a future
 * drift between the two callers' expectations shows up here instead of only
 * in production.
 *
 * `dispatchRecoveredTaskOutputHook` and `removeCompletionSentinel` are
 * mocked rather than exercised for real: the output-hook dispatch machinery
 * has its own suite (`agentFinalization.outputHooks.test.js`) and sentinel
 * removal has its own (`agentCompletionCleanup.test.js`). This file's job is
 * the ORCHESTRATION — order, the private-security override, and which
 * per-caller facts land where.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('portos-retire-dead-agent-') }));
afterAll(cleanupTempDataRoots);

vi.mock('./cosAgentLifecycle.js', () => ({
  getAgent: vi.fn(async () => null),
  updateAgent: vi.fn(async () => null),
  completeAgent: vi.fn(async () => null),
}));
vi.mock('./agentCompletionCleanup.js', () => ({
  removeCompletionSentinel: vi.fn(async () => undefined),
}));
vi.mock('./agentRunTracking.js', () => ({ completeAgentRun: vi.fn(async () => null) }));
vi.mock('./cosTaskStore.js', () => ({ updateTask: vi.fn(async () => ({})), addTask: vi.fn(async () => ({ id: 'investigation-test' })) }));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn(), cosEvents: { emit: vi.fn(), on: vi.fn() } }));
vi.mock('./taskTypeHooks.js', () => ({
  canRunTaskOutputHookWithoutPayload: vi.fn(() => true),
  getTaskOutputHook: vi.fn(async () => null),
  getTaskOutputPayloadPredicate: vi.fn(async () => null),
  declaresNoCommitCriterion: vi.fn(() => false),
  isProgrammaticIoTaskType: vi.fn(() => false),
  // No task in this suite carries an analysisType, so the real resolver's
  // taskType fallback is fine — mirrors production, unlike the sibling
  // output-hook suite which forces null to isolate its own dispatch cases.
  resolveTaskHookType: vi.fn(task => task?.metadata?.analysisType || task?.metadata?.taskAnalysisType || task?.taskType || null),
}));
vi.mock('./agentErrorAnalysis.js', async importOriginal => ({ ...(await importOriginal()), resolveFailedTaskUpdate: vi.fn(), resolveTypeFailureSignal: vi.fn() }));
vi.mock('./agentWorktreeCleanup.js', () => ({ releaseRetryHold: vi.fn(async () => ({})) }));
vi.mock('./reviewFollowUpCompletion.js', () => ({
  verifyMergedReviewFollowUp: vi.fn(async () => null),
}));
vi.mock('./agentCompletion.js', () => ({ processAgentCompletion: vi.fn(async () => null) }));
vi.mock('./investigationTaskProducer.js', () => ({
  investigationCircuitOpen: vi.fn(() => false),
  noteInvestigationFiled: vi.fn(),
  readAllTasksFlat: vi.fn(async () => []),
  recentInvestigationCreations: vi.fn(() => []),
}));
vi.mock('./taskSchedule.js', () => ({
  recordTaskTypeFailure: vi.fn(async () => null),
  recordTaskTypeSuccess: vi.fn(async () => null),
}));
vi.mock('./codeReview.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getGoalFidelityConfig: vi.fn(async () => null),
}));

import { verifyMergedReviewFollowUp } from './reviewFollowUpCompletion.js';
import { releaseRetryHold } from './agentWorktreeCleanup.js';
import { completeAgent } from './cosAgentLifecycle.js';
import { updateTask } from './cosTaskStore.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeCompletionSentinel } from './agentCompletionCleanup.js';
import { getTaskOutputHook, isProgrammaticIoTaskType } from './taskTypeHooks.js';
import { completeAgentRun } from './agentRunTracking.js';
import { retireDeadAgent } from './agentFinalization.js';
import { PRIVATE_SECURITY_TASK_TYPE } from '../lib/privateSecurityPolicy.js';

const AGENT = { id: 'agent-dead', metadata: {}, output: [], startedAt: '2026-09-25T00:00:00Z' };
const TASK = { id: 'task-1', taskType: 'user', metadata: {} };

describe('retireDeadAgent (#8440)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removeCompletionSentinel.mockResolvedValue(undefined);
    completeAgentRun.mockResolvedValue(undefined);
    completeAgent.mockResolvedValue(undefined);
  });

  it('closes the run record before completing the agent record, when the agent carries a runId', async () => {
    const order = [];
    completeAgentRun.mockImplementation(async () => { order.push('run'); });
    completeAgent.mockImplementation(async () => { order.push('agent'); });

    await retireDeadAgent({
      agent: { ...AGENT, metadata: { runId: 'run-1' } },
      task: TASK,
      success: false,
      exitCode: 1,
      duration: 500,
      errorMessage: 'Agent process terminated unexpectedly',
      category: 'orphaned',
    });

    expect(order).toEqual(['run', 'agent']);
    expect(completeAgentRun).toHaveBeenCalledWith('run-1', '', 1, 500, {
      message: 'Agent process terminated unexpectedly',
      category: 'orphaned',
    }, false, { executionSuccess: false, taskOutcome: null });
    expect(completeAgent).toHaveBeenCalledWith('agent-dead', {
      success: false,
      executionSuccess: false,
      taskOutcome: null,
      validationPassed: null,
      exitCode: 1,
      duration: 500,
      orphaned: true,
      error: 'Agent process terminated unexpectedly',
    });
  });

  it.each(['blocked', 'incomplete'])('preserves a recovered %s sentinel and holds its retry until evidence is removed', async status => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'recovered-outcome-'));
    const taskOutcome = { status, reason: 'Invented prerequisite remains unmet.' };
    const order = [];
    updateTask.mockImplementationOnce(async () => { order.push('task'); return {}; });
    removeCompletionSentinel.mockImplementationOnce(async () => { order.push('remove'); });
    releaseRetryHold.mockImplementationOnce(async () => { order.push('release'); });
    try {
      await writeFile(join(workspacePath, '.agent-done-agent-dead'), JSON.stringify({ taskOutcome }));
      const result = await retireDeadAgent({ agent: { ...AGENT, metadata: { workspacePath, runId: 'run-1' } },
        task: TASK, success: true, exitCode: 0, duration: 100 });
      expect(result).toEqual({ success: false, taskOutcome, deliveryHeld: true });
      expect(completeAgent).toHaveBeenCalledWith(AGENT.id, expect.objectContaining({ success: false, executionSuccess: true, taskOutcome }));
      expect(updateTask).toHaveBeenCalledWith(TASK.id, expect.objectContaining({ status: 'in_progress', metadata: expect.objectContaining({ taskOutcome, retryPendingCleanup: AGENT.id, failureCount: 1 }) }), 'user', expect.objectContaining({ recoveryOwner: { id: AGENT.id, startedAt: AGENT.startedAt } }));
      expect(order).toEqual(['task', 'remove', 'release']);
    } finally { await rm(workspacePath, { recursive: true, force: true }); }
  });

  it('preserves the first attempt pointer when a recovered outcome needs approval', async () => {
    const taskOutcome = { status: 'blocked', reason: 'Authorized budget exhausted.', recovery: {
      mode: 'approval', options: ['Increase the budget and retry.', 'Preserve the stopped work.'],
    } };
    await retireDeadAgent({ agent: { ...AGENT, result: { taskOutcome } }, task: TASK, success: true, exitCode: 0, duration: 100 });
    expect(updateTask).toHaveBeenCalledWith(TASK.id, expect.objectContaining({ status: 'blocked',
      metadata: expect.objectContaining({ deliveryDecisionAgentId: AGENT.id }) }), 'user', expect.objectContaining({ expectedTask: { description: TASK.description, priority: TASK.priority, metadata: TASK.metadata } }));
    expect(releaseRetryHold).toHaveBeenCalledWith({ agentId: AGENT.id, task: TASK, success: false, agentMetadata: AGENT.metadata });
  });

  it('keeps a recorded failed validation when a merged review follow-up is also verified, and passes it when none was recorded', async () => {
    verifyMergedReviewFollowUp.mockResolvedValue({ prUrl: 'https://example.com/acme/repo/pull/1' });
    const recover = validationPassed => retireDeadAgent({
      agent: { ...AGENT, result: validationPassed === undefined ? undefined : { validationPassed } },
      task: TASK, success: true, exitCode: 0, duration: 1, errorMessage: 'orphaned', category: 'orphaned',
    });
    await recover(false);
    expect(completeAgent).toHaveBeenLastCalledWith('agent-dead', expect.objectContaining({ validationPassed: false }));
    await recover(undefined);
    expect(completeAgent).toHaveBeenLastCalledWith('agent-dead', expect.objectContaining({ validationPassed: true }));
    verifyMergedReviewFollowUp.mockResolvedValue(null);
  });

  it.each([false, true])('retires only the dead run when the guarded recovery write loses task ownership (cleanup=%s)', async cleanup => {
    const taskOutcome = { status: 'incomplete', reason: 'Original attempt needs validation.' };
    const task = { ...TASK, status: 'in_progress', metadata: { claimedBy: 'original', lastSpawnedAt: AGENT.startedAt,
      ...(cleanup && { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: AGENT.id }) } };
    updateTask.mockResolvedValueOnce({ statusChanged: true, task: { ...task, metadata: { ...task.metadata, blocker: 'Operator hold' } } });
    await retireDeadAgent({ agent: { ...AGENT, result: { taskOutcome } }, task, success: true, exitCode: 0, duration: 100 });
    expect(updateTask).toHaveBeenCalledWith(TASK.id, expect.any(Object), 'user', expect.objectContaining({
      expectedStatus: 'in_progress', expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata },
      recoveryOwner: { id: AGENT.id, startedAt: AGENT.startedAt },
    }));
    expect(completeAgent.mock.calls.at(-1)[1].deliveryRecoveryOwned).not.toBe(true);
    expect(completeAgent.mock.calls.at(-1)[1].cleanupPending).not.toBe(true);
    expect(completeAgent.mock.calls.at(-1)[1].cleanupDeliveryVerified).not.toBe(true);
    expect(releaseRetryHold).not.toHaveBeenCalled();
  });

  it('accepts a recovered no-op only after its output hook verifies delivery', async () => {
    const taskOutcome = { status: 'no-action-needed', reason: 'Invented verification found no remaining work.' };
    const hook = vi.fn(async () => ({ accepted: true }));
    getTaskOutputHook.mockResolvedValueOnce(hook);
    isProgrammaticIoTaskType.mockReturnValueOnce(true);
    const result = await retireDeadAgent({ agent: { ...AGENT, result: { taskOutcome } }, task: TASK,
      success: true, exitCode: 0, duration: 100 });
    expect(result).toEqual({ success: true, taskOutcome, deliveryHeld: false });
    expect(completeAgent).toHaveBeenCalledWith(AGENT.id, expect.objectContaining({ success: true,
      validationPassed: true, taskOutcome }));
    expect(updateTask).not.toHaveBeenCalled();
  });

  it.each([
    { success: false, status: 'completed', exitCode: 1 },
    { success: true, status: 'no-action-needed', exitCode: 0 },
  ])('keeps failure recovery enabled for a synthesized incomplete outcome ($status, success=$success)', async ({ success, status, exitCode }) => {
    const reportedOutcome = { status, reason: 'Invented delivery report.' };
    const result = await retireDeadAgent({ agent: { ...AGENT, result: { taskOutcome: reportedOutcome } },
      task: TASK, success, exitCode, duration: 100 });
    expect(result).toEqual({ success: false, deliveryHeld: false,
      taskOutcome: expect.objectContaining({ status: 'incomplete' }) });
    expect(completeAgent).toHaveBeenCalledWith(AGENT.id, expect.objectContaining({ success: false,
      taskOutcome: result.taskOutcome }));
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('leaves recovery retryable when parking the held task cannot be persisted', async () => {
    const taskOutcome = { status: 'blocked', reason: 'Invented prerequisite.' };
    updateTask.mockResolvedValueOnce({ error: 'storage-unavailable' });
    await expect(retireDeadAgent({ agent: { ...AGENT, result: { taskOutcome } }, task: TASK,
      success: true, exitCode: 0, duration: 100 })).rejects.toThrow('storage-unavailable');
    expect(completeAgent).not.toHaveBeenCalled();
    expect(removeCompletionSentinel).not.toHaveBeenCalled();
  });

  it('skips closing the run record for an agent with no runId', async () => {
    await retireDeadAgent({ agent: AGENT, task: TASK, success: true, exitCode: 0, duration: 100 });

    expect(completeAgentRun).not.toHaveBeenCalled();
    expect(completeAgent).toHaveBeenCalledWith('agent-dead', expect.objectContaining({ success: true }));
  });

  it.each([true, false])('preserves a saved refusal when recovery reports success=%s', async success => {
    const executionInterruption = { category: 'content-refusal', source: 'provider', at: '2026-01-01T00:00:00Z' };
    const result = await retireDeadAgent({
      agent: { ...AGENT, metadata: { runId: 'run-refused', executionInterruption } }, task: TASK,
      success, exitCode: success ? 0 : 143, duration: 100, category: 'interrupted',
    });
    expect(result).toEqual({ success: false, taskOutcome: null, deliveryHeld: false });
    expect(completeAgentRun).toHaveBeenCalledWith('run-refused', '', success ? 0 : 143, 100,
      expect.objectContaining({ category: 'content-refusal', origin: 'provider', permanent: true, requiresFallback: false }), false, { executionSuccess: success, taskOutcome: null });
    expect(completeAgent).toHaveBeenCalledWith('agent-dead', expect.objectContaining({ success: false,
      executionInterruption, errorAnalysis: expect.objectContaining({ category: 'content-refusal' }) }));
  });

  it('dispatches the output hook before removing the sentinel, and removes the sentinel only after persisting the run and agent records', async () => {
    const order = [];
    getTaskOutputHook.mockResolvedValueOnce(async () => { order.push('hook'); return { accepted: true }; });
    removeCompletionSentinel.mockImplementation(async () => { order.push('sentinel-removed'); });
    completeAgentRun.mockImplementation(async () => { order.push('run'); });
    completeAgent.mockImplementation(async () => { order.push('agent'); });

    await retireDeadAgent({
      agent: { ...AGENT, metadata: { runId: 'run-1' } },
      task: TASK,
      success: false,
      exitCode: 1,
      duration: 0,
    });

    expect(removeCompletionSentinel).toHaveBeenCalledWith({ agentId: 'agent-dead', agentState: expect.objectContaining({ id: 'agent-dead' }) });
    expect(order).toEqual(['hook', 'run', 'agent', 'sentinel-removed']);
  });

  // No immutable source inventory survives to validate a recovered private-security
  // report, so the run is always retired as a failure — no matter what the caller
  // believed — and the run record's output is redacted rather than the raw transcript.
  it('forces success:false and redacts the run-record output for a private-security task', async () => {
    const privateTask = { ...TASK, metadata: { analysisType: PRIVATE_SECURITY_TASK_TYPE } };

    const result = await retireDeadAgent({
      agent: { ...AGENT, metadata: { runId: 'run-private' } },
      task: privateTask,
      success: true,
      exitCode: 0,
      duration: 10,
    });

    expect(result).toEqual({ success: false, taskOutcome: null, deliveryHeld: false });
    expect(completeAgentRun).toHaveBeenCalledWith(
      'run-private',
      'Private security assessment interrupted; inspect its local assessment archive.',
      0,
      10,
      expect.anything(),
      false,
      { executionSuccess: true, taskOutcome: null },
    );
    expect(completeAgent).toHaveBeenCalledWith('agent-dead', expect.objectContaining({ success: false }));
  });

  it('merges caller-specific extra fields into the agent-record result without leaking them into the run record', async () => {
    await retireDeadAgent({
      agent: AGENT,
      task: TASK,
      success: false,
      exitCode: 143,
      duration: 0,
      agentResultExtra: { interruptedByRestart: true },
    });

    expect(completeAgent).toHaveBeenCalledWith('agent-dead', expect.objectContaining({ interruptedByRestart: true }));
  });
});

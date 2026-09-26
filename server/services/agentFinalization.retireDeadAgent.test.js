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
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./cosAgentLifecycle.js', () => ({
  getAgent: vi.fn(async () => null),
  updateAgent: vi.fn(async () => null),
  completeAgent: vi.fn(async () => null),
}));
vi.mock('./agentCompletionCleanup.js', () => ({
  removeCompletionSentinel: vi.fn(async () => undefined),
}));
vi.mock('./agentRunTracking.js', () => ({ completeAgentRun: vi.fn(async () => null) }));
vi.mock('./cos.js', () => ({ updateTask: vi.fn(async () => ({})), addTask: vi.fn(async () => ({ id: 'investigation-test' })) }));
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
vi.mock('./agentErrorAnalysis.js', () => ({ resolveFailedTaskUpdate: vi.fn(), resolveTypeFailureSignal: vi.fn() }));
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

import { completeAgent } from './cosAgentLifecycle.js';
import { removeCompletionSentinel } from './agentCompletionCleanup.js';
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
    });
    expect(completeAgent).toHaveBeenCalledWith('agent-dead', {
      success: false,
      exitCode: 1,
      duration: 500,
      orphaned: true,
      error: 'Agent process terminated unexpectedly',
    });
  });

  it('skips closing the run record for an agent with no runId', async () => {
    await retireDeadAgent({ agent: AGENT, task: TASK, success: true, exitCode: 0, duration: 100 });

    expect(completeAgentRun).not.toHaveBeenCalled();
    expect(completeAgent).toHaveBeenCalledWith('agent-dead', expect.objectContaining({ success: true }));
  });

  it('removes the completion sentinel before checking for a runId', async () => {
    await retireDeadAgent({ agent: AGENT, task: TASK, success: false, exitCode: 1, duration: 0 });

    expect(removeCompletionSentinel).toHaveBeenCalledWith({ agentId: 'agent-dead', agentState: AGENT });
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

    expect(result).toEqual({ success: false });
    expect(completeAgentRun).toHaveBeenCalledWith(
      'run-private',
      'Private security assessment interrupted; inspect its local assessment archive.',
      0,
      10,
      expect.anything(),
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

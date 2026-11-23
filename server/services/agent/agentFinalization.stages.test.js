/**
 * Direct unit tests for the decomposed finalization stages in
 * `agentFinalization.js` (#17013):
 *   - `createCompletionContext`
 *   - `resolveForgeOutcome`
 *   - `applyDeliverySettlement`
 *   - `recordCompletionArtifacts`
 *
 * Each stage is exercised independently with its typed context/stage outputs
 * so stage-boundary regressions (dropped fields, wrong stage handoff, broken
 * cleanup/privacy ordering) fail right at the offending stage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const emitLogMock = vi.fn();
vi.mock('../cos/cosEvents.js', () => ({ emitLog: (...args) => emitLogMock(...args) }));

const getAgentRecordMock = vi.fn(async () => null);
const updateAgentMock = vi.fn(async () => null);
const completeAgentMock = vi.fn(async () => ({ completedAt: '2026-11-20T00:00:00.000Z', result: {} }));
vi.mock('../cos/cosAgentLifecycle.js', () => ({
  getAgentRecord: (...args) => getAgentRecordMock(...args),
  updateAgent: (...args) => updateAgentMock(...args),
  completeAgent: (...args) => completeAgentMock(...args),
}));

const updateTaskMock = vi.fn(async () => ({}));
vi.mock('../cos/cosTaskStore.js', () => ({ updateTask: (...args) => updateTaskMock(...args) }));

const completeAgentRunMock = vi.fn(async () => null);
vi.mock('./agentRunTracking.js', () => ({ completeAgentRun: (...args) => completeAgentRunMock(...args) }));

const appendRunEventMock = vi.fn(async () => ({ appended: true }));
vi.mock('./agentRunEventLog.js', () => ({ appendRunEvent: (...args) => appendRunEventMock(...args) }));

const processAgentCompletionMock = vi.fn(async () => null);
vi.mock('./agentCompletion.js', () => ({ processAgentCompletion: (...args) => processAgentCompletionMock(...args) }));

const getAppDataForTaskMock = vi.fn(async () => null);
vi.mock('./agentAppWorkspace.js', () => ({ getAppDataForTask: (...args) => getAppDataForTaskMock(...args) }));

const releaseAppIssueClaimMock = vi.fn(async () => ({ released: true }));
vi.mock('../appIssues.js', () => ({ releaseAppIssueClaim: (...args) => releaseAppIssueClaimMock(...args) }));

const observePrClaimMock = vi.fn();
vi.mock('./agentPrVerification.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    observePrClaim: (...args) => observePrClaimMock(...args),
  };
});

const reviewGoalFidelityMock = vi.fn(async () => ({ fidelity: { review: null }, fidelityDowngrade: null }));
const followUpAgentGoalFidelityMock = vi.fn(async () => null);
vi.mock('./agentGoalFidelity.js', () => ({
  reviewGoalFidelity: (...args) => reviewGoalFidelityMock(...args),
  followUpAgentGoalFidelity: (...args) => followUpAgentGoalFidelityMock(...args),
}));

const dispatchTaskOutputHookOnceMock = vi.fn(async () => ({ ran: false }));
vi.mock('./agentOutputHookDispatch.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    dispatchTaskOutputHookOnce: (...args) => dispatchTaskOutputHookOnceMock(...args),
  };
});

const committedDuringRunMock = vi.fn(async () => true);
vi.mock('../../lib/gitCommitProbe.js', () => ({ committedDuringRun: (...args) => committedDuringRunMock(...args) }));

const detectPrimaryCheckoutDriftMock = vi.fn(async () => ({ drifted: false }));
vi.mock('../../lib/primaryCheckoutGuard.js', () => ({ detectPrimaryCheckoutDrift: (...args) => detectPrimaryCheckoutDriftMock(...args) }));

const resolveFailedTaskDecisionMock = vi.fn(() => ({ status: 'pending' }));
const resolveFailedTaskUpdateMock = vi.fn(async () => ({ status: 'pending', metadata: {} }));
const resolveUndeliveredTaskUpdateMock = vi.fn(async (_task, outcome) => ({ status: 'pending', metadata: { taskOutcome: outcome } }));
const resolveTypeFailureSignalMock = vi.fn(() => ({ record: 'skip' }));
vi.mock('./agentErrorAnalysis.js', () => ({
  resolveFailedTaskDecision: (...args) => resolveFailedTaskDecisionMock(...args),
  resolveFailedTaskUpdate: (...args) => resolveFailedTaskUpdateMock(...args),
  resolveUndeliveredTaskUpdate: (...args) => resolveUndeliveredTaskUpdateMock(...args),
  resolveTypeFailureSignal: (...args) => resolveTypeFailureSignalMock(...args),
}));

const prepareCompletionTaskHandoffMock = vi.fn(async () => null);
const recoverCompletionTaskHandoffMock = vi.fn(async () => ({ ok: true }));
vi.mock('./agentCompletionTaskHandoff.js', () => ({
  completionDispatchFence: vi.fn(() => null),
  prepareCompletionTaskHandoff: (...args) => prepareCompletionTaskHandoffMock(...args),
  recoverCompletionTaskHandoff: (...args) => recoverCompletionTaskHandoffMock(...args),
}));

const storeCompletionDataMock = vi.fn(async () => 'replay-ref');
vi.mock('./agentCompletionData.js', () => ({
  storeCompletionData: (...args) => storeCompletionDataMock(...args),
  completionReplayInput: vi.fn((x) => x),
}));

const removeCreativeDirectorScratchCwdMock = vi.fn(async () => null);
vi.mock('../../lib/spawnCwd.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    removeCreativeDirectorScratchCwd: (...args) => removeCreativeDirectorScratchCwdMock(...args),
  };
});

vi.mock('../provider/providers.js', () => ({ getActiveProvider: vi.fn(async () => null) }));
vi.mock('../provider/providerStatus.js', () => ({
  markProviderUsageLimit: vi.fn(async () => null),
  markProviderUnavailable: vi.fn(async () => null),
}));

import {
  createCompletionContext,
  resolveForgeOutcome,
  applyDeliverySettlement,
  recordCompletionArtifacts,
} from './agentFinalization.js';
import { PR_OBSERVATION, prObservation } from './agentPrVerification.js';

function baseInput(overrides = {}) {
  return {
    agentId: 'agent-stage-1',
    task: { id: 'task-1', taskType: 'internal', metadata: {} },
    runId: 'run-1',
    providerId: 'claude-code',
    success: true,
    exitCode: 0,
    duration: 5000,
    outputBuffer: 'finished cleanly',
    finalSummary: null,
    errorAnalysis: null,
    executionInterruption: null,
    terminatedByUser: false,
    error: undefined,
    completionReason: undefined,
    workspacePath: '/tmp/example-worktree',
    recovery: false,
    prExpected: false,
    startedAt: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAgentRecordMock.mockResolvedValue(null);
  completeAgentMock.mockResolvedValue({ completedAt: '2026-11-20T00:00:00.000Z', result: {} });
  updateTaskMock.mockResolvedValue({});
  observePrClaimMock.mockResolvedValue(prObservation(PR_OBSERVATION.SKIPPED));
  reviewGoalFidelityMock.mockResolvedValue({ fidelity: { review: null }, fidelityDowngrade: null });
  dispatchTaskOutputHookOnceMock.mockResolvedValue({ ran: false });
  committedDuringRunMock.mockResolvedValue(true);
  detectPrimaryCheckoutDriftMock.mockResolvedValue({ drifted: false });
});

describe('createCompletionContext', () => {
  it('normalizes defaults, derives executionSuccess from exitCode, and uses explicit startedAt', () => {
    const ctx = createCompletionContext(baseInput({ exitCode: 0, startedAt: 12345 }));
    expect(ctx.taskType).toBe('internal');
    expect(ctx.executionSuccess).toBe(true);
    expect(ctx.runStartedAt).toBe(12345);
  });

  it('derives runStartedAt from positive duration when startedAt is absent and keeps null for zero-duration runs', () => {
    const before = Date.now();
    const withDuration = createCompletionContext(baseInput({ startedAt: null, duration: 4000 }));
    expect(withDuration.runStartedAt).toBeGreaterThanOrEqual(before - 4050);
    expect(withDuration.runStartedAt).toBeLessThanOrEqual(Date.now());

    const zeroDuration = createCompletionContext(baseInput({ startedAt: null, duration: 0, success: true, exitCode: 1 }));
    expect(zeroDuration.runStartedAt).toBeNull();
    expect(zeroDuration.executionSuccess).toBe(false);
  });
});

describe('resolveForgeOutcome', () => {
  it('skips PR observation when terminated by user and produces a clean forge outcome', async () => {
    const ctx = createCompletionContext(baseInput({ terminatedByUser: true, success: false }));
    const outcome = await resolveForgeOutcome(ctx);

    expect(observePrClaimMock).not.toHaveBeenCalled();
    expect(outcome.forgeVerifiable).toBe(false);
    expect(outcome.prEvidence.completionOk).toBe(true);
    expect(outcome.judgedVerdict.success).toBe(false);
    expect(followUpAgentGoalFidelityMock).toHaveBeenCalledOnce();
  });

  it('records a run.pr-verified ledger event and downgrades judgedVerdict when PR claim is missing', async () => {
    observePrClaimMock.mockResolvedValue(prObservation(PR_OBSERVATION.MISSING_PR, { branch: 'cos/task-1' }));
    const ctx = createCompletionContext(baseInput({ prExpected: true }));
    const outcome = await resolveForgeOutcome(ctx);

    expect(appendRunEventMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'run.pr-verified',
      agentId: 'agent-stage-1',
      runId: 'run-1',
      data: expect.objectContaining({ verified: false, branch: 'cos/task-1' }),
    }));
    expect(outcome.prEvidence.completionOk).toBe(false);
    expect(outcome.judgedVerdict.success).toBe(false);
  });

  it('falls back to no-drift when primary checkout drift check throws', async () => {
    getAgentRecordMock.mockResolvedValue({ id: 'agent-stage-1', metadata: { primaryCheckoutBaseline: { head: 'abc' } } });
    detectPrimaryCheckoutDriftMock.mockRejectedValue(new Error('git failed'));

    const ctx = createCompletionContext(baseInput());
    const outcome = await resolveForgeOutcome(ctx);

    expect(outcome.verdictEvidence.drift).toEqual({ drifted: false });
    expect(outcome.judgedVerdict.success).toBe(true);
  });
});

describe('applyDeliverySettlement', () => {
  function sampleForgeOutcome(overrides = {}) {
    const prEvidence = {
      completionOk: true,
      completionVerdict: { ok: true },
      branchProvenEmpty: false,
      emptyBranchInconclusiveEvidence: null,
      evidenceBranch: null,
      ledgerEntry: null,
      cleanupEvidence: { ok: true },
    };
    return {
      reportedTaskOutcome: null,
      forgeVerifiable: true,
      mergedReviewFollowUp: null,
      claimDisposition: null,
      deliveryHeld: false,
      executionInterruption: null,
      prEvidence,
      verdictEvidence: {
        reportedSuccess: true,
        errorAnalysis: null,
        error: undefined,
        completionReason: undefined,
        terminatedByUser: false,
        drift: { drifted: false },
        prEvidence,
      },
      retirementCompletion: null,
      fidelity: { review: null },
      judgedVerdict: { success: true, source: 'reported', errorAnalysis: null },
      ...overrides,
    };
  }

  it('applies output-hook metadata patch, evaluates success criteria, and resolves a completed taskUpdate', async () => {
    dispatchTaskOutputHookOnceMock.mockResolvedValue({
      ran: true,
      outcome: { accepted: true, taskMetadata: { stageAdvanced: true } },
    });
    const ctx = createCompletionContext(baseInput());
    const settlement = await applyDeliverySettlement(ctx, sampleForgeOutcome());

    expect(ctx.task.metadata.stageAdvanced).toBe(true);
    expect(settlement.preHookTask.metadata.stageAdvanced).toBeUndefined();
    expect(settlement.validationPassed).toBe(true);
    expect(settlement.deliverySuccess).toBe(true);
    expect(settlement.taskUpdate.status).toBe('completed');
    expect(settlement.taskUpdate.metadata.stageAdvanced).toBe(true);
  });

  it('normalizes a cleanup-only recovery outcome on a clean validated run into completed', async () => {
    const ctx = createCompletionContext(baseInput());
    const settlement = await applyDeliverySettlement(ctx, sampleForgeOutcome({
      reportedTaskOutcome: { status: 'incomplete', reason: 'cleanup remains', recovery: { mode: 'cleanup' } },
      deliveryHeld: true,
    }));

    expect(settlement.taskOutcome).toEqual({ status: 'completed', reason: 'cleanup remains' });
    expect(settlement.deliverySuccess).toBe(true);
    expect(settlement.taskUpdate.status).toBe('completed');
  });

  it('turns an unrecovered incomplete outcome into deliverySuccess=false and routes to delivery recovery', async () => {
    const ctx = createCompletionContext(baseInput());
    const settlement = await applyDeliverySettlement(ctx, sampleForgeOutcome({
      reportedTaskOutcome: { status: 'incomplete', reason: 'work remaining' },
      deliveryHeld: true,
    }));

    expect(settlement.deliverySuccess).toBe(false);
    expect(settlement.deliveryVerdict.success).toBe(false);
    expect(settlement.deliveryVerdict.error).toBe('work remaining');
    expect(resolveUndeliveredTaskUpdateMock).toHaveBeenCalledOnce();
    expect(settlement.taskUpdate.status).toBe('pending');
  });
});

describe('recordCompletionArtifacts', () => {
  function sampleStageInputs(ctxOverrides = {}, settlementOverrides = {}) {
    const ctx = createCompletionContext(baseInput(ctxOverrides));
    const prEvidence = {
      completionOk: true,
      completionVerdict: { ok: true },
      branchProvenEmpty: false,
      emptyBranchInconclusiveEvidence: null,
      evidenceBranch: null,
      ledgerEntry: null,
      cleanupEvidence: { ok: true, prClaimVerified: false },
    };
    const forgeOutcome = {
      executionInterruption: null,
      prEvidence,
      claimDisposition: null,
      retirementCompletion: null,
      fidelity: { review: null },
    };
    const verdict = { success: true, source: 'reported', errorAnalysis: null };
    const settlement = {
      hookResult: { ran: false },
      preHookTask: { ...ctx.task, metadata: { ...ctx.task.metadata } },
      verdict,
      validationPassed: true,
      taskOutcome: { status: 'completed' },
      deliverySuccess: true,
      deliveryVerdict: verdict,
      cleanupOwner: null,
      cleanupEligible: false,
      taskUpdate: { status: 'completed', metadata: { taskOutcome: { status: 'completed' } } },
      ...settlementOverrides,
    };
    return { ctx, forgeOutcome, settlement };
  }

  it('persists agent completion, run record, task update, and returns the completion summary', async () => {
    const { ctx, forgeOutcome, settlement } = sampleStageInputs();
    const result = await recordCompletionArtifacts(ctx, forgeOutcome, settlement);

    expect(completeAgentMock).toHaveBeenCalledWith('agent-stage-1', expect.objectContaining({
      success: true,
      executionSuccess: true,
      validationPassed: true,
    }));
    expect(completeAgentRunMock).toHaveBeenCalledWith(
      'run-1', 'finished cleanly', 0, 5000, null, null,
      { executionSuccess: true, taskOutcome: { status: 'completed' } },
    );
    expect(updateTaskMock).toHaveBeenCalledWith('task-1', settlement.taskUpdate, 'internal');
    expect(processAgentCompletionMock).toHaveBeenCalledWith('agent-stage-1', ctx.task, true, 'finished cleanly');
    expect(result).toEqual({
      success: true,
      taskOutcome: { status: 'completed' },
      prClaimVerified: false,
      branchProvenEmpty: false,
      cleanupEvidence: forgeOutcome.prEvidence.cleanupEvidence,
    });
  });

  it('routes through cleanup handoff recovery and returns success=false when completeAgent marks cleanupPending', async () => {
    completeAgentMock.mockResolvedValue({
      completedAt: '2026-11-20T00:00:00.000Z',
      result: { cleanupPending: true, taskOutcome: { status: 'incomplete', reason: 'pending cleanup' } },
    });
    const { ctx, forgeOutcome, settlement } = sampleStageInputs({}, { cleanupEligible: true });
    const result = await recordCompletionArtifacts(ctx, forgeOutcome, settlement);

    expect(prepareCompletionTaskHandoffMock).toHaveBeenCalledOnce();
    expect(recoverCompletionTaskHandoffMock).toHaveBeenCalledOnce();
    expect(updateTaskMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('strips privateSecurityScope from task and taskUpdate before writing and redacts run output', async () => {
    const { ctx, forgeOutcome, settlement } = sampleStageInputs({
      task: {
        id: 'sec-1',
        taskType: 'internal',
        privateSecurityScope: { files: ['secret.txt'] },
        metadata: { analysisType: 'private-security-assessment', privateSecurityScope: { files: ['secret.txt'] } },
      },
      outputBuffer: 'sensitive security findings',
    }, {
      taskUpdate: {
        status: 'completed',
        metadata: { privateSecurityScope: { files: ['secret.txt'] }, taskOutcome: { status: 'completed' } },
      },
    });

    await recordCompletionArtifacts(ctx, forgeOutcome, settlement);

    expect(ctx.task.privateSecurityScope).toBeUndefined();
    expect(settlement.taskUpdate.metadata.privateSecurityScope).toBeUndefined();
    expect(completeAgentRunMock).toHaveBeenCalledWith(
      'run-1',
      'Private security assessment: see the local Review Hub report.',
      0, 5000, null, null,
      expect.any(Object),
    );
  });

  it('releases unused server-provisioned claim markers on a clean no-action-needed exit with no PR', async () => {
    const resolvedApp = { id: 'app-1', name: 'Widget', repoPath: '/repo' };
    getAppDataForTaskMock.mockResolvedValueOnce(resolvedApp);
    const { ctx, forgeOutcome, settlement } = sampleStageInputs({
      task: {
        id: 'claim-1',
        taskType: 'user',
        metadata: { app: 'app-1', claimFlow: true, claimTarget: '42', claimServerCheckout: true },
      },
    }, {
      taskOutcome: { status: 'no-action-needed', reason: 'already fixed' },
      taskUpdate: { status: 'completed', metadata: { taskOutcome: { status: 'no-action-needed' } } },
    });

    await recordCompletionArtifacts(ctx, forgeOutcome, settlement);
    expect(releaseAppIssueClaimMock).toHaveBeenCalledWith(resolvedApp, '42');
  });

  it('does not release server-provisioned claim markers when the run delivered a PR or is retrying', async () => {
    const resolvedApp = { id: 'app-1', name: 'Widget', repoPath: '/repo' };
    getAppDataForTaskMock.mockResolvedValue(resolvedApp);
    const { ctx, forgeOutcome, settlement } = sampleStageInputs({
      task: {
        id: 'claim-2',
        taskType: 'user',
        metadata: { app: 'app-1', claimFlow: true, claimTarget: '42', claimServerCheckout: true },
      },
    }, {
      taskOutcome: { status: 'completed' },
      taskUpdate: { status: 'completed', metadata: { taskOutcome: { status: 'completed' } } },
    });
    forgeOutcome.prEvidence.cleanupEvidence = { ok: true, prs: [{ number: 100 }] };

    await recordCompletionArtifacts(ctx, forgeOutcome, settlement);
    expect(releaseAppIssueClaimMock).not.toHaveBeenCalled();
  });
});

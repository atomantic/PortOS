/**
 * Agent Repo-State Verification
 *
 * The programmatic audit that runs after `cleanupAgentWorktree` and asks the
 * question cleanup cannot: is the repository actually in the state this task
 * asked for?
 *
 * Cleanup reports only what it TRIED and failed to do. The case this exists for
 * is an agent that opens its own PR (`metadata.prOpenedBy` naming the agent),
 * merges it itself, and exits before deleting the branch — or exits with the PR
 * still open.
 * Cleanup may stand down for those runs, leaving the branch and checkout for
 * another completion owner.
 *
 * It probes and classifies via `lib/repoStateExpectations.js`, tries the shared
 * deterministic cleanup gates, and files one recovery task when needed. A held
 * merged checkout requires persisted inventory and a fresh review preview;
 * the recovery agent cannot substitute shell deletion for the direct branch-reconcile removal.
 *
 * Detection is what this adds over `branchReconcile.js`: that reconciler is an
 * opt-in scheduled task on a recheck cadence, and it parks on no-progress. This
 * is immediate, per-agent, and attributed to the run that caused it.
 *
 * Gated per managed app by `verifyRepoStateOnCompletion` (default ON).
 *
 * Concurrency: other agents legitimately hold their own worktrees and branches at
 * the same time. Every probe is scoped to ONE branch — the one this agent owned —
 * so a live sibling agent is structurally invisible to it.
 */

import { isDeepStrictEqual } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { recoverCompletionTaskHandoff } from './agentCompletionTaskHandoff.js';
import { getDeliveryActivity, withDeliveryActivity } from './agentDeliveryActivity.js';
import { findValidCheckoutCaptures } from '../completedCheckoutEvidence.js';
import { createRepoStateSweep } from './agentRepoStateSweep.js';
import { cosEvents, emitLog } from '../cos/cosEvents.js';
import { updateTask, getTaskById } from '../cos/cosTaskStore.js';
import { leavesPrForHuman, prStaysOpen } from '../../lib/prDisposition.js';
import { REPO_STATE_SKIPS } from '../../lib/repoStateExpectations.js';
import { getInstanceId } from '../instanceIdentity.js';
import {
  COMPLETION_RECEIPT_VERSION, COMPLETION_STAGE, REPOSITORY_HOLD, completionReceiptDone,
  completionWaitingOnRepository, verifiedRepositoryWorktreeStage,
} from '../../lib/agent/agentCompletionStages.js';
import { verifyRunBranches } from './agentBranchVerification.js';
import {
  recordedCheckoutScope, pendingCheckoutScope, pendingCheckoutAbsent, handedOffRetirementScope,
  settleAbsentScope, settleReleasedSelectionHistory,
} from './agentAbsentCheckoutSettlement.js';
import { canonicalRepository, skipped } from './agentRepoCleanupLedger.js';

export { REPO_STATE_REMEDIATIONS } from './agentRepoStateRecoveryTask.js';

const verificationRuns = new Map();
// Events emitted by an explicit cleanup-only recheck must not start another
// completion replay. Unrelated events retain their normal wake behaviour.
const manualCleanupContext = new AsyncLocalStorage();

function manualCompletionMode(receipt) {
  if (completionReceiptDone(receipt)) return 'ready';
  if (completionWaitingOnRepository(receipt)) return 'repository-held';
  return null;
}

// These are the execution-side prerequisites of isSettleableCompletionReceipt.
// Repository verification produces the remaining cleanup and integration
// receipts, so they cannot be required until after the recheck has run.
function manualCleanupProvenanceValid(agent) {
  const result = agent?.result;
  const metadata = agent?.metadata;
  return result?.deliveryRecoveryOwned === true && result.executionSuccess === true
    && result.validationPassed !== false && result.taskOutcome?.status === 'incomplete'
    && result.taskOutcome?.recovery?.mode === 'cleanup' && !result.executionInterruption
    && !metadata?.executionInterruption && !metadata?.blocker;
}

function manualSwarmContinuationPending(agent) {
  const proof = agent?.metadata?.swarmCleanupDelivery;
  return !!proof && proof.continuationIssued !== true;
}

async function notifyDeliveredSwarmCleanup(agentId, { notify = true } = {}) {
  const [{ getAgentRecord }, contract] = await Promise.all([
    import('../cos/cosAgentLifecycle.js'), import('../swarmCleanupDelivery.js'),
  ]);
  let agent = await getAgentRecord(agentId);
  const task = agent && await getTaskById(agent.taskId);
  const instance = await getInstanceId();
  if (!contract.cleanupRefillSourceMatches(task, agent, instance)) {
    const proof = await contract.proveSwarmCleanupDelivery(task, agent, instance);
    if (!proof) return;
    const { recordSwarmCleanupDelivery } = await import('../cos/cosAgentLifecycle.js');
    if (!await recordSwarmCleanupDelivery(agentId, agent, proof)) return;
    agent = await getAgentRecord(agentId);
  }
  if (notify && contract.cleanupRefillSourceMatches(task, agent, instance) && !agent.metadata.swarmCleanupDelivery.continuationIssued) {
    cosEvents.emit('swarm:cleanup-delivery-verified', { agentId });
  }
}

/** A removed task is never recreated. Its immutable replay only authorizes
 * verification of already absent, exactly captured checkouts. */
async function readAbsentTaskSnapshot(agent) {
  const { readCompletionData } = await import('./agentCompletionData.js');
  const snapshot = (await readCompletionData(agent, agent.metadata?.completionCleanup?.replay).catch(() => null))?.task;
  if (!snapshot || snapshot.id !== agent.taskId) return null;
  const meta = agent.metadata;
  const branches = meta.isWorktree === true ? [meta.worktreeBranch]
    : [meta.claimBranches, meta.claimReleasedBranches].flatMap(value => Array.isArray(value) ? value : []);
  if (!branches.length || branches.some(branch => typeof branch !== 'string' || !branch)) return null;
  const repository = meta.sourceWorkspace || meta.workspacePath;
  const canonical = await canonicalRepository(repository);
  if (!canonical) return null;
  for (const branch of new Set(branches)) {
    const rawCount = meta.completedCheckouts?.filter(row => row?.branch === branch).length ?? 0;
    if (rawCount !== 1 || findValidCheckoutCaptures(agent, { branch, repoPath: canonical }).length !== 1) return null;
  }
  return snapshot;
}

/** Exhaustion stops provider work, not proof of already completed delivery.
 * Only the original cleanup owner and charged dispatch may settle receipts;
 * human holds, another dispatch and failed execution remain stopped.
 */
function exhaustedCleanupOwner(task, agent) {
  const meta = task.metadata || {};
  const binding = agent.metadata?.completionTaskDispatch;
  const expected = binding?.expected;
  return task.status === 'blocked' && meta.blockedCategory === 'task-recovery-exhausted' && !meta.blocker
    && agent.status === 'completed' && agent.taskId === task.id && binding?.taskId === task.id
    && binding.taskType === (task.taskType || 'user') && Array.isArray(expected)
    && meta.deliveryDecisionAgentId === agent.id && agent.result?.executionSuccess === true
    && agent.result.validationPassed !== false && !agent.metadata?.executionInterruption && !agent.result.executionInterruption
    && ['lastSpawnedAt', 'totalSpawnCount'].every(key => {
      const rows = expected.filter(row => Array.isArray(row) && row[0] === key);
      return rows.length === 1 && rows[0][1] != null && meta[key] != null && String(rows[0][1]) === String(meta[key]);
    });
}

const UNSUPPORTED_CLEANUP_SKIPS = new Set([
  REPO_STATE_SKIPS.DISABLED,
  REPO_STATE_SKIPS.NOT_WORKTREE,
  REPO_STATE_SKIPS.PERSISTENT_WORKTREE,
  REPO_STATE_SKIPS.DISCARDED_WORKTREE,
  'retirement-app-unavailable',
  'retirement-app-ambiguous',
]);

const TERMINAL_VERIFICATION_SKIPS = new Set([
  REPO_STATE_SKIPS.DISABLED,
  REPO_STATE_SKIPS.NOT_WORKTREE,
  REPO_STATE_SKIPS.PERSISTENT_WORKTREE,
  REPO_STATE_SKIPS.DISCARDED_WORKTREE,
  REPO_STATE_SKIPS.FAILED_RUN,
]);

async function runManualRecheck(state, options) {
  if (!state.manualCleanupOnly) return null;
  return state.recheckCleanup(options).then(() => null, error => error.message);
}

async function resolveVerificationState(input, cleanupPending) {
  const preCaptureReason = await runManualRecheck(input, { requireCapture: false });
  if (preCaptureReason) return { state: input, skipResult: skipped(preCaptureReason) };
  // A capture that can never complete because its checkout is already gone
  // falls through to the absent-checkout path, which proves delivery from the
  // forge without a captured head.
  let state = input;
  if (state.agentState?.metadata?.checkoutCapture?.status === 'pending' && !(cleanupPending && await pendingCheckoutAbsent(state.agentState))) {
    const { retryCompletionCheckoutCapture, getAgentRecord } = await import('../cos/cosAgentLifecycle.js');
    if (!await retryCompletionCheckoutCapture(state.agentId).catch(() => false)) {
      return { state, skipResult: skipped(REPOSITORY_HOLD.CAPTURE) };
    }
    const recovered = await getAgentRecord(state.agentId).catch(() => null);
    if (!recovered || recovered.status !== 'completed' || recovered.startedAt !== state.agentState.startedAt
      || recovered.metadata?.checkoutCapture?.status !== 'captured') {
      return { state, skipResult: skipped(REPOSITORY_HOLD.CAPTURE) };
    }
    state = { ...state, agentState: recovered };
  }
  const postCaptureReason = await runManualRecheck(state);
  if (postCaptureReason) return { state, skipResult: skipped(postCaptureReason) };
  if (cleanupPending) {
    const original = await getTaskById(state.task.id);
    if (!original) {
      if (state.manualCleanupOnly) return { state, skipResult: skipped('cleanup-owner-changed') };
      const snapshot = await readAbsentTaskSnapshot(state.agentState);
      if (!snapshot) return { state, skipResult: skipped('cleanup-task-unavailable') };
      const absentState = { ...state, task: snapshot, originTaskAbsent: true };
      return { state: absentState, branchInput: { ...absentState, success: true, cleanupWarnings: [] } };
    }
    const current = state.manualCleanupOnly ? original : await recoverCompletionTaskHandoff(state.agentState) || original;
    if ((state.manualCleanupOnly && !isDeepStrictEqual(current, state.task))
      || (current.status !== 'in_progress' && !exhaustedCleanupOwner(current, state.agentState))
      || current.metadata?.deliveryRecovery !== 'cleanup'
      || current.metadata.deliveryRecoveryAgentId !== state.agentId) {
      return { state, skipResult: skipped('cleanup-owner-changed') };
    }
    state = { ...state, task: current };
  }
  // A cleanup warning describes retained work this audit must settle.
  return {
    state,
    branchInput: { ...state, success: state.success || cleanupPending, ...(cleanupPending ? { cleanupWarnings: [] } : {}) },
  };
}

async function settleOwnershipOrAbsentTask(state, result) {
  if (result.skipReason === 'cleanup-owner-changed' && !state.manualCleanupOnly) {
    // Delivery now belongs to the task's current owner; this run keeps only its own checkout.
    const scope = handedOffRetirementScope(state.agentState);
    return scope && await settleAbsentScope(state.agentState, scope)
      ? { ...result, physicalRetirementVerified: true, skipReason: 'original-result-preserved' } : result;
  }
  if (result.skipReason === 'cleanup-owner-changed' || result.skipReason === 'cleanup-task-unavailable') return result;
  if (state.originTaskAbsent) {
    if (!result.verified) return result;
    const { settleAbsentTaskCompletion } = await import('../cos/cosAgentLifecycle.js');
    const settled = await settleAbsentTaskCompletion(state.agentId, state.agentState);
    return settled ? result : { ...result, verified: false, skipReason: 'cleanup-receipt-settlement-unverified' };
  }
  return null;
}

const isReadableMissingPrCleanupSkip = item => item.skipReason === 'cleanup-delivery-unverified'
  && item.observed?.prState === null && item.observed?.prUrl === null && item.observed?.unreadable?.length === 0;

async function findUnsupportedCleanupOutcome(state, result, { swarmCleanup }) {
  const outcomes = result.branches || [result];
  // A retirement policy refusal is a preservation hold, not failed delivery.
  // Keep its persisted obligation pending for service replay; requeueing the
  // original task would launch another review agent against an already merged PR.
  const unsupportedOutcomes = prStaysOpen(state.task)
    ? [{ skipReason: 'leave-open-cleanup-unsupported' }]
    : outcomes.filter(item => UNSUPPORTED_CLEANUP_SKIPS.has(item.skipReason)
      || (item.skipReason === 'cleanup-delivery-unverified' && (['OPEN', 'CLOSED'].includes(item.observed?.prState)
        || isReadableMissingPrCleanupSkip(item))));
  const unsupported = unsupportedOutcomes[0] || null;
  if (!swarmCleanup || !unsupported || !unsupportedOutcomes.every(isReadableMissingPrCleanupSkip)) return unsupported;
  // A parked child has no PR by design. Verify every selected issue and
  // the parked checkout independently before retaining this as a service
  // hold; this evidence neither retires the checkout nor completes the task.
  const { verifyCleanupClaimDisposition } = await import('../claimDisposition.js');
  const disposition = await verifyCleanupClaimDisposition({ task: state.task, agent: state.agentState }).catch(() => null);
  const allOperatorBlocked = disposition?.status === 'verified' && unsupportedOutcomes.every(item => {
    const issue = item.branch?.match(/^claim\/issue-([1-9]\d*)$/)?.[1];
    return issue && disposition.issues?.some(row => row.issue === Number(issue) && row.disposition === 'operator-blocked');
  });
  return allOperatorBlocked ? null : unsupported;
}

async function transferUnsupportedCleanupToRecovery(state, result, unsupported) {
  // An exhausted task gets no new recovery dispatch or refunded budget.
  if (state.task.status === 'blocked') return result;
  const { resolveUndeliveredTaskUpdate } = await import('./agentErrorAnalysis.js');
  const outcome = { status: 'incomplete', reason: `Cleanup verification cannot run (${unsupported.skipReason}). ${state.task.metadata?.taskOutcome?.reason || ''}`.trim() };
  const planned = resolveUndeliveredTaskUpdate(state.task, outcome, state.agentId);
  const saved = await updateTask(state.task.id, planned, state.task.taskType || 'user', {
    expectedStatus: 'in_progress',
    expectedMetadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: state.agentId },
  });
  if (saved?.status !== planned.status || saved?.error || saved?.statusChanged) {
    return { ...result, skipReason: 'cleanup-transfer-unverified' };
  }
  if (planned.metadata.retryPendingCleanup) {
    const { releaseRetryHold } = await import('./agentWorktreeCleanup.js');
    await releaseRetryHold({ agentId: state.agentId, task: state.task, success: false, agentMetadata: state.agentState.metadata });
  }
  const { recordRepoStateVerification } = await import('../cos/cosAgentLifecycle.js');
  await recordRepoStateVerification(state.agentId, { status: 'completed', reasons: ['cleanup-transferred-to-recovery'] });
  return { ...result, skipReason: 'cleanup-transferred-to-recovery' };
}

async function settleVerifiedCleanupTask(state, result) {
  const preLedgerReason = await runManualRecheck(state);
  if (preLedgerReason) return { ...result, verified: false, skipReason: preLedgerReason };
  const { recordCompletionCleanup } = await import('../cos/cosAgentLifecycle.js');
  if (state.agentState.metadata?.completionCleanup?.version === COMPLETION_RECEIPT_VERSION) {
    // A deferred receipt releases held chain stages to the normal replay,
    // whose later verification pass settles the task after they finish.
    const recorded = await recordCompletionCleanup(state.agentId, state.agentState.startedAt, {
      stages: { [COMPLETION_STAGE.WORKTREE]: verifiedRepositoryWorktreeStage(state.deferTaskSettlement) },
    });
    if (!recorded) return { ...result, verified: false, skipReason: 'cleanup-ledger-settlement-unverified' };
  }
  const preTaskReason = await runManualRecheck(state);
  if (preTaskReason) return { ...result, verified: false, skipReason: preTaskReason };
  if (state.deferTaskSettlement) {
    const { recordRepoStateVerification } = await import('../cos/cosAgentLifecycle.js');
    await recordRepoStateVerification(state.agentId, {
      status: 'pending', checkedAt: new Date().toISOString(), reasons: ['completion-handoff-pending'],
    });
    return { ...result, verified: false, skipReason: 'completion-handoff-pending' };
  }
  const settlementFence = state.task.status === 'blocked' ? {
    expectedStatus: 'blocked', expectedTask: { description: state.task.description, priority: state.task.priority, metadata: state.task.metadata },
    recoveryOwner: { id: state.agentId, startedAt: state.agentState.startedAt }, preserveRetryBudget: true,
  } : {
    expectedStatus: 'in_progress', expectedMetadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: state.agentId },
    // getTaskById projects the queue source into taskType; the stored row
    // may have a different or absent value, so fence its remaining fields.
    ...(state.manualCleanupOnly && {
      suppressCompletionWake: true,
      recoveryOwner: { id: state.agentId, startedAt: state.agentState.startedAt, requireInactive: true },
      expectedTask: Object.fromEntries(Object.entries(state.task).filter(([key]) => key !== 'taskType')),
    }),
  };
  const updated = await updateTask(state.task.id, { status: 'completed', metadata: {
    deliveryRecovery: undefined, deliveryRecoveryAgentId: undefined,
    taskOutcome: { status: 'completed', reason: 'Delivery and repository cleanup were verified by completion recovery.' },
  } }, state.task.taskType || 'user', settlementFence);
  if (updated?.status !== 'completed' || updated?.error || updated?.statusChanged) {
    return { ...result, verified: false, skipReason: 'cleanup-task-settlement-unverified' };
  }
  return null;
}

async function recordPendingRepoStateStatus(state, result, { cleanupPending }) {
  // Completion persists pending before publishing its event. A failed probe,
  // active follow-up or refused task write stays pending for the timer sweep.
  if (state.agentState?.metadata?.repoStateVerification?.status !== 'pending') return;
  const outcomes = result.branches || [result];
  const settled = cleanupPending ? result.verified
    : outcomes.every(item => item.verified || (TERMINAL_VERIFICATION_SKIPS.has(item.skipReason)
      && !(item.skipReason === REPO_STATE_SKIPS.FAILED_RUN && state.agentState?.metadata?.cleanupOutcome?.status === 'pending')))
      || leavesPrForHuman(state.task);
  const { recordRepoStateVerification } = await import('../cos/cosAgentLifecycle.js');
  await recordRepoStateVerification(state.agentId, {
    status: settled ? 'completed' : 'pending',
    checkedAt: new Date().toISOString(),
    reasons: [...new Set(outcomes.map(item => item.skipReason).filter(Boolean))],
  });
}

/**
 * Verify one completed worktree agent left the repository as its task asked, and
 * file a recovery task when it did not.
 *
 * @param {object} input
 * @param {string} input.agentId
 * @param {object} input.task - the CoS task
 * @param {object|null} input.agentState - persisted agent record (worktree metadata)
 * @param {boolean} input.success - effective success of the run
 * @param {boolean} [input.prExpected] - legacy override for the live task's `openPR` hint
 * @param {'force-branch' | 'sweep-review-target'} [input.prProbeFallback] - internal branch lookup adapter
 * @param {string[]} [input.cleanupWarnings] - warnings cleanup already raised
 * @returns {Promise<{verified: boolean, skipReason: string|null, issues: Array<{code: string, message: string}>, observed: object|null, recoveryTaskId: string|null}>}
 */
export async function verifyAgentRepoState(input) {
  if (verificationRuns.has(input.agentId)) return verificationRuns.get(input.agentId);
  const cleanupPending = input.agentState?.result?.cleanupPending === true;
  const swarmCleanup = cleanupPending && input.agentState?.metadata?.configClaimFlow === true
    && input.agentState.metadata.isWorktree === false;
  const run = withDeliveryActivity(input.agentId, 'Checking delivery and repository preservation', async () => {
    if (swarmCleanup && !input.manualCleanupOnly) {
      // Persist delivery proof before cleanup can settle the task, but let the
      // first retirement pass finish before a new picker enters the repository.
      await notifyDeliveredSwarmCleanup(input.agentId, { notify: false }).catch(error => {
        emitLog('warn', `Swarm delivery verification deferred: ${error.message}`, { agentId: input.agentId });
      });
    }
    const resolved = await resolveVerificationState(input, cleanupPending);
    const { state } = resolved;
    const result = resolved.skipResult || await verifyRunBranches(resolved.branchInput);
    const earlyOwnership = await settleOwnershipOrAbsentTask(state, result);
    if (earlyOwnership) return earlyOwnership;
    const unsupported = await findUnsupportedCleanupOutcome(state, result, { swarmCleanup });
    if (cleanupPending && unsupported && !state.manualCleanupOnly) {
      return transferUnsupportedCleanupToRecovery(state, result, unsupported);
    }
    if (cleanupPending && result.verified) {
      const heldSettlement = await settleVerifiedCleanupTask(state, result);
      if (heldSettlement) return heldSettlement;
    }
    await recordPendingRepoStateStatus(state, result, { cleanupPending });
    if (swarmCleanup && !state.manualCleanupOnly) {
      await notifyDeliveredSwarmCleanup(state.agentId).catch(error => {
        emitLog('warn', `Swarm delivery verification deferred: ${error.message}`, { agentId: state.agentId });
      });
    }
    return result;
  }).finally(() => verificationRuns.delete(input.agentId));
  verificationRuns.set(input.agentId, run);
  return run;
}

/** Recheck one current cleanup owner without starting another provider task. */
export async function recheckAgentCleanup(agentId, taskId) {
  const { getAgentRecord } = await import('../cos/cosAgentLifecycle.js');
  const agent = await getAgentRecord(agentId);
  const task = await getTaskById(taskId);
  if (!agent || !task || agent.taskId !== taskId || agent.status !== 'completed'
    || agent.result?.cleanupPending !== true || task.status !== 'in_progress'
    || task.metadata?.deliveryRecovery !== 'cleanup' || task.metadata.deliveryRecoveryAgentId !== agentId) {
    return { ok: false, reason: 'cleanup-owner-changed' };
  }
  if (verificationRuns.has(agentId) || getDeliveryActivity(agentId)) return { ok: false, reason: 'cleanup-already-running' };
  if (!manualCleanupProvenanceValid(agent)) return { ok: true, verified: false, reasons: ['cleanup-provenance-unverified'] };
  if (manualSwarmContinuationPending(agent)) return { ok: true, verified: false, reasons: ['swarm-continuation-pending'] };
  const mode = manualCompletionMode(agent.metadata?.completionCleanup);
  if (!mode) return { ok: true, verified: false, reasons: ['completion-stages-pending'] };
  const recheckCleanup = async ({ requireCapture = true } = {}) => {
    const [currentTask, currentAgent] = await Promise.all([getTaskById(taskId), getAgentRecord(agentId)]);
    if (!isDeepStrictEqual(currentTask, task) || currentAgent?.status !== 'completed' || currentAgent.result?.cleanupPending !== true
      || currentAgent.taskId !== taskId || currentAgent.startedAt !== agent.startedAt) throw new Error('cleanup-owner-changed');
    if (!manualCleanupProvenanceValid(currentAgent)) throw new Error('cleanup-provenance-unverified');
    if (manualSwarmContinuationPending(currentAgent)) throw new Error('swarm-continuation-pending');
    // A held run never settles here, even if its stages finish concurrently.
    const current = manualCompletionMode(currentAgent.metadata?.completionCleanup);
    if (!current || (mode === 'ready' && current !== 'ready')) throw new Error('completion-stages-pending');
    if (requireCapture && currentAgent.metadata?.checkoutCapture?.status !== 'captured') throw new Error('checkout-capture-unverified');
  };
  const result = await manualCleanupContext.run(true, () => verifyAgentRepoState({ agentId, agentState: agent, task, success: agent.result.success === true,
    manualCleanupOnly: true, recheckCleanup,
    deferTaskSettlement: mode === 'repository-held' }));
  if (result.skipReason === 'cleanup-owner-changed') return { ok: false, reason: result.skipReason };
  const reasons = [...new Set([result.skipReason, ...(result.branches || []).map(row => row.skipReason)].filter(Boolean))];
  return { ok: true, verified: result.verified === true, reasons };
}
const {
  resumeAgentCompletionRetirement,
  bindCompletionRetirementEvents,
  sweepRepoStateVerifications,
  resumeDeferredRepoStateVerifications,
} = createRepoStateSweep({
  verificationRuns,
  manualCleanupContext,
  verifyAgentRepoState,
  notifyDeliveredSwarmCleanup,
  readAbsentTaskSnapshot,
  recordedCheckoutScope,
  pendingCheckoutScope,
  settleAbsentScope,
  settleReleasedSelectionHistory,
  skipped,
});

export {
  resumeAgentCompletionRetirement,
  bindCompletionRetirementEvents,
  sweepRepoStateVerifications,
  resumeDeferredRepoStateVerifications,
};

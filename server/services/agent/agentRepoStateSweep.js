/** Sweep and replay pending repository verification after agent completion. */

import { claimCheckoutOwner } from '../../lib/claimContinuation.js';
import { COMPLETION_RECOVERY_BATCH_SIZE } from './agentDeliveryActivity.js';
import { shortBranch } from '../completedCheckoutEvidence.js';
import { readLocalBranchPresence } from '../repoCleanupObservation.js';
import { emitLog } from '../cos/cosEvents.js';
import { getTaskById } from '../cos/cosTaskStore.js';
import { listWorktrees } from '../worktreeManager.js';
import { readAllTasksFlat } from '../investigationTaskProducer.js';
import { readClaimOwnershipAgents } from '../cos/cosClaimOwnership.js';
import { CLAIM_OWNER_HOLDS, agentIdOf, createCompletionRetirement } from './agentCompletionRetirement.js';

const awaitsSwarmContinuation = row => row.status === 'completed' && row.result?.success === true
  && row.metadata?.swarmCleanupDelivery?.version === 1
  && !row.metadata.swarmCleanupDelivery.continuationIssued;

const ownsUnverifiedDeliveryRecovery = agent => agent.status === 'completed'
  && agent.result?.deliveryRecoveryOwned === true && agent.result.executionSuccess === true
  && agent.metadata?.repoStateVerification?.deliveryVerified !== true;

const lastCompletionAuditAttempt = agent => [agent.metadata.repoStateVerification?.checkedAt, agent.metadata.completionCleanup?.updatedAt,
  agent.metadata.completionCleanup?.lastAttemptAt].filter(value => typeof value === 'string').sort().at(-1) || '';

const awaitsCompletionAudit = agent => agent.status === 'completed' && (agent.metadata?.repoStateVerification?.status === 'pending'
  || agent.metadata?.completionCleanup?.status === 'pending');

const heldByClaimOwner = agent => agent.metadata.repoStateVerification?.status === 'pending'
  && Array.isArray(agent.metadata.repoStateVerification.reasons)
  && agent.metadata.repoStateVerification.reasons.some(reason => CLAIM_OWNER_HOLDS.has(reason));

// A claim-owner hold may skip its backoff when the caller asks to recheck holds.
const completionAuditDue = (agent, recheckClaimHolds) => !agent.metadata.completionCleanup?.retryAt
  || Date.parse(agent.metadata.completionCleanup.retryAt) <= Date.now()
  || (recheckClaimHolds && heldByClaimOwner(agent));

function selectPendingCompletionAudits(agents, { onlyAgentIds, recheckClaimHolds }) {
  return agents.filter(awaitsCompletionAudit)
    .filter(agent => completionAuditDue(agent, recheckClaimHolds))
    .filter(agent => !onlyAgentIds || onlyAgentIds.has(agentIdOf(agent)))
    .sort((a, b) => lastCompletionAuditAttempt(a).localeCompare(lastCompletionAuditAttempt(b)));
}

// Back off exponentially from one minute to 30 minutes, then double the wait for
// each further day of failed attempts, up to one day. Some audits can never settle
// (their task was deleted), and each attempt costs git and forge reads; retirement,
// ownership and follow-up events still wake a record whatever its backoff.
const REPLAY_ATTEMPTS_PER_DAY = 48;
const MAX_REPLAY_DELAY_MS = 24 * 60 * 60_000;
function completionReplayDelayMs(attempt) {
  const base = Math.min(30 * 60_000, 60_000 * 2 ** Math.min(attempt - 1, 5));
  return Math.min(MAX_REPLAY_DELAY_MS, base * 2 ** Math.min(Math.floor((attempt - 1) / REPLAY_ATTEMPTS_PER_DAY), 6));
}

async function recordCompletionReplayAttempt(original) {
  const { recordCompletionCleanup } = await import('../cos/cosAgentLifecycle.js');
  const attempt = (original.metadata.completionCleanup?.replayAttempts || 0) + 1;
  await recordCompletionCleanup(agentIdOf(original), original.startedAt, { lastAttemptAt: new Date().toISOString(),
    replayAttempts: attempt, retryAt: new Date(Date.now() + completionReplayDelayMs(attempt)).toISOString() });
}

// Older receipts already proved delivery and cleanup, but left the deferred
// domain verdict pending. Replay the existing writer, without another probe,
// task, completion event or provider budget expenditure.
async function replayDeferredDeliverySettlements(agents) {
  const { recordRepoStateVerification, isSettleableCompletionReceipt } = await import('../cos/cosAgentLifecycle.js');
  const { agentRunDeliveryNeedsReconciliation } = await import('./agentRunTracking.js');
  const candidates = agents.filter(row => {
    const result = row.result?.deferredDeliveryOutcome ? { ...row.result, cleanupPending: true,
      taskOutcome: row.result.deferredDeliveryOutcome } : row.result;
    return row.status === 'completed' && isSettleableCompletionReceipt({ ...row, result }, row.metadata || {});
  }).sort((a, b) => Number(a.result?.success === true) - Number(b.result?.success === true)
    || (b.completedAt || '').localeCompare(a.completedAt || ''));
  let replayed = 0;
  for (const agent of candidates) {
    if (replayed >= COMPLETION_RECOVERY_BATCH_SIZE) break;
    if (agent.result?.success === true && !await agentRunDeliveryNeedsReconciliation(agent)) continue;
    replayed++;
    await recordRepoStateVerification(agentIdOf(agent), agent.metadata.repoStateVerification).catch(error => {
      emitLog('warn', `Deferred delivery settlement retained: ${error.code || 'receipt-unavailable'}`);
    });
  }
}

// Mark any durable request whose agent was recorded before a crash. Its fence
// remains until admission settles, and then either side can remove it.
async function acknowledgeIssuedSwarmRefills(agents) {
  const issuedAgents = new Set(agents.filter(row => row.metadata?.swarmCleanupDelivery?.continuationIssued === true)
    .map(agentIdOf));
  if (!issuedAgents.size) return;
  const { loadSchedule } = await import('../taskScheduleStore.js');
  const schedule = await loadSchedule().catch(() => null);
  const fences = schedule?.swarmCleanupRefillPending || {};
  const staleFences = Object.keys(fences).filter(id => {
    const handoff = schedule.onDemandHandoffs?.[fences[id].id];
    return issuedAgents.has(id) && (!fences[id].sourceMarked || (handoff && handoff.status !== 'preparing'));
  }).slice(0, COMPLETION_RECOVERY_BATCH_SIZE);
  if (!staleFences.length) return;
  const { acknowledgeSwarmCleanupRefill } = await import('../taskSchedule.js');
  for (const id of staleFences) await acknowledgeSwarmCleanupRefill(id).catch(error => {
    emitLog('warn', `Swarm refill receipt cleanup deferred: ${error.message}`, { agentId: id });
  });
}

export function createRepoStateSweep({
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
}) {
  const {
    settleAbsentCheckoutRetirement, resumeAgentCompletionRetirement,
    resumeCompletedDeliveryParent, bindCompletionRetirementEvents,
  } = createCompletionRetirement({
    verificationRuns, manualCleanupContext, verifyAgentRepoState,
    readAbsentTaskSnapshot, recordedCheckoutScope, pendingCheckoutScope, settleAbsentScope, skipped,
  });

  let completionSweep = null;
  let completionWake = null;
  const runCompletionPass = run => {
    if (completionSweep) return completionSweep;
    completionSweep = Promise.resolve().then(run).finally(() => { completionSweep = null; });
    return completionSweep;
  };

  /** Resume interrupted completion from existing agent archives, bounded per pass. */
  function sweepRepoStateVerifications() {
    return runCompletionPass(() => resumeCompletionAudits());
  }

  /** An actual startup/release wake drains its initial eligible snapshot once,
   * yielding between existing bounded batches. Failed records retain backoff and
   * cannot cycle through this wake again, even when a slow batch outlasts retryAt.
   */
  function resumeDeferredRepoStateVerifications(blocked) {
    if (typeof blocked !== 'function') return Promise.reject(new Error('completion-recovery-gate-required'));
    if (completionWake) return completionWake;
    completionWake = (async () => {
      while (completionSweep) await completionSweep;
      return runCompletionPass(async () => {
        let remaining;
        let checked = 0;
        let pendingAtStart = 0;
        while (true) {
          const reason = await blocked();
          if (reason) return { checked, pendingAtStart, skipReason: reason };
          const result = await resumeCompletionAudits({ onlyAgentIds: remaining, skipPrelude: remaining !== undefined, recheckClaimHolds: true, legacyRepairs: true });
          if (!remaining) {
            pendingAtStart = result.pendingAtStart;
            remaining = new Set(result.pendingAgentIds);
          }
          for (const id of result.attemptedAgentIds) remaining.delete(id);
          checked += result.checked;
          if (!remaining.size || result.checked === 0) return { checked, pendingAtStart };
          await new Promise(nextTick => setImmediate(nextTick));
        }
      });
    })().finally(() => { completionWake = null; });
    return completionWake;
  }

  async function reconcileReleasedSelectionHistory(agents) {
    for (const agent of agents) {
      const meta = agent.metadata || {};
      if (agent.status !== 'completed' || meta.repoStateVerification?.status !== 'completed') continue;
      const branches = Object.values(meta.cleanupOutcomes || {}).filter(row => row.status === 'verified'
        && row.reason === 'released-selection-no-local-artifacts' && meta.claimReleasedBranches?.includes(row.branch)
        && !meta.claimBranches?.includes(row.branch)
        && Object.values(meta.cleanupOutcomes || {}).some(held => held.branch === row.branch && held.status !== 'verified'))
        .map(row => row.branch);
      if (!branches.length) continue;
      const sourceWorkspace = meta.sourceWorkspace || meta.workspacePath;
      if (typeof sourceWorkspace !== 'string') continue;
      const trees = await listWorktrees(sourceWorkspace).catch(() => null);
      const owners = await readClaimOwnershipAgents().catch(() => null);
      if (!trees || !owners) continue;
      for (const branch of new Set(branches)) {
        if (claimCheckoutOwner({ branchName: branch, sourceWorkspace, agents: owners, ignoreIds: [agentIdOf(agent)] })
          || trees.some(tree => shortBranch(tree.branch) === branch)
          || await readLocalBranchPresence(sourceWorkspace, branch).catch(() => null) !== false) continue;
        await settleReleasedSelectionHistory(agentIdOf(agent), meta, branch, trees)
          .catch(error => emitLog('warn', `Released-selection ledger repair deferred for ${agentIdOf(agent)}: ${error.message}`));
      }
    }
  }

  // Rotate pending registered checkout scopes with the existing attempt timestamp.
  async function replayPendingCheckoutRetirements(agents) {
    const due = agents.filter(pendingCheckoutScope)
      .sort((a, b) => (a.metadata.completionCleanup.lastAttemptAt || '').localeCompare(b.metadata.completionCleanup.lastAttemptAt || ''))
      .slice(0, COMPLETION_RECOVERY_BATCH_SIZE);
    for (const agent of due) {
      const settled = await settleAbsentCheckoutRetirement(agent).catch(error => {
        emitLog('warn', `Checkout retirement settlement deferred for ${agent.id}: ${error.message}`);
        return false;
      });
      if (settled) continue;
      const { recordCompletionCleanup } = await import('../cos/cosAgentLifecycle.js');
      await recordCompletionCleanup(agent.id, agent.startedAt, { lastAttemptAt: new Date().toISOString() }).catch(error => {
        emitLog('warn', `Checkout retirement attempt retained: ${error.message}`);
      });
    }
  }

  // A crash can occur after retirement settled the task but before the verified
  // drain's refill was queued. Its exact source receipt survives in the agent
  // archive, so replay that continuation without rerunning work.
  async function replaySwarmCleanupContinuations(agents) {
    const replays = agents.filter(awaitsSwarmContinuation)
      .sort((a, b) => (a.metadata.swarmCleanupDelivery.lastAttemptAt || '')
        .localeCompare(b.metadata.swarmCleanupDelivery.lastAttemptAt || ''))
      .slice(0, COMPLETION_RECOVERY_BATCH_SIZE);
    for (const agent of replays) {
      const agentId = agentIdOf(agent);
      const { recordSwarmCleanupContinuationAttempt } = await import('../cos/cosAgentLifecycle.js');
      await recordSwarmCleanupContinuationAttempt(agentId).catch(error => {
        emitLog('warn', `Swarm continuation attempt could not be recorded: ${error.message}`, { agentId });
      });
      await notifyDeliveredSwarmCleanup(agentId).catch(error => {
        emitLog('warn', `Swarm continuation replay deferred: ${error.message}`, { agentId });
      });
    }
  }

  // Replay completed handoffs after restart as well as at their event. Only
  // terminal parents with unfinished delivery qualify; ordinary completed history
  // never incurs a forge probe. Existing batch bounds still apply.
  async function resumeVerifiedFollowUpParents(agents) {
    const parents = new Set(agents.filter(ownsUnverifiedDeliveryRecovery).map(agentIdOf));
    if (!parents.size) return;
    const followUps = (await readAllTasksFlat()).filter(task => task.status === 'completed'
      && task.metadata?.mergedReviewFollowUp?.status === 'verified'
      && parents.has(task.metadata.sourceAgentId)).slice(0, COMPLETION_RECOVERY_BATCH_SIZE);
    for (const task of followUps) await resumeCompletedDeliveryParent(task);
  }

  // legacyRepairs: repairs for records written by older versions. Upgraded
  // installs need them once per start, so only the startup/resume wake runs them.
  async function runCompletionAuditPrelude(agents, { legacyRepairs }) {
    const { recoverReleaseSynchronizationHandoffs } = await import('../releaseSynchronization.js');
    await recoverReleaseSynchronizationHandoffs(agents).catch(error => {
      emitLog('warn', `Release synchronization handoffs retained: ${error.code || 'outbox-unavailable'}`);
    });
    if (legacyRepairs) await reconcileReleasedSelectionHistory(agents);
    await replayPendingCheckoutRetirements(agents);
    if (legacyRepairs) await replayDeferredDeliverySettlements(agents);
    await replaySwarmCleanupContinuations(agents);
    await acknowledgeIssuedSwarmRefills(agents);
    await resumeVerifiedFollowUpParents(agents);
    const { reconcileCleanupThreads } = await import('../brainTaskThreads.js');
    await reconcileCleanupThreads({ dryRun: false }).catch(error => emitLog('warn', `Cleanup thread reconciliation deferred: ${error.message}`));
    if (!legacyRepairs) return;
    const { recoverLegacyDeliveryBlocks } = await import('../deliveryRecovery.js');
    await recoverLegacyDeliveryBlocks(agents);
  }

  // Definite absence may use the existing immutable-snapshot receipt proof. An
  // unreadable task is not absent, and neither case replays external stages.
  async function settleTasklessCompletionAudit(agent, { readable }) {
    const resumed = readable && (agent.result?.cleanupPending === true || agent.result?.success === true)
      ? await resumeAgentCompletionRetirement(agentIdOf(agent)).catch(() => null) : null;
    if (resumed?.verified) return;
    const { recordRepoStateVerification } = await import('../cos/cosAgentLifecycle.js');
    await recordRepoStateVerification(agentIdOf(agent), { status: 'pending',
      checkedAt: new Date().toISOString(), reasons: [resumed?.skipReason || 'task-unavailable'] });
  }

  async function verifyAndReplayCompletion(agent, task) {
    const { getAgentRecord } = await import('../cos/cosAgentLifecycle.js');
    const { replayAgentCompletionCleanup } = await import('./agentCompletionCleanup.js');
    const deferCleanup = error => emitLog('warn', `Completion cleanup deferred for ${agent.id}: ${error.message}`, { agentId: agent.id });
    await replayAgentCompletionCleanup(agent).catch(deferCleanup);
    const refreshed = await getAgentRecord(agentIdOf(agent)).catch(() => null) || agent;
    await verifyAgentRepoState({ agentId: agentIdOf(refreshed), agentState: refreshed, task,
      success: refreshed.result?.success === true, prProbeFallback: 'sweep-review-target' })
      .catch(error => emitLog('warn', `Completion recovery deferred for ${refreshed.id}: ${error.message}`, { agentId: refreshed.id }));
    const updated = await getAgentRecord(agentIdOf(refreshed)).catch(() => null);
    if (updated) await replayAgentCompletionCleanup(updated)
      .catch(error => emitLog('warn', `Completion cleanup deferred for ${refreshed.id}: ${error.message}`, { agentId: refreshed.id }));
  }

  // Returns false only when the record turned out to be already settled, so the
  // caller's `checked` count excludes it.
  async function resumePendingCompletionAudit(original, loadTaskById) {
    const { getAgentRecord, recordRepoStateVerification } = await import('../cos/cosAgentLifecycle.js');
    let agent = await getAgentRecord(agentIdOf(original)).catch(() => null) || original;
    if (agent.metadata.completionCleanup?.status === 'completed' && agent.metadata.checkoutCapture?.status === 'retired'
      && agent.metadata.repoStateVerification?.physicalRetirementVerified === true) {
      await recordRepoStateVerification(agentIdOf(agent), agent.metadata.repoStateVerification);
      agent = await getAgentRecord(agentIdOf(agent)).catch(() => null) || agent;
    }
    if (agent.metadata.completionCleanup?.status === 'completed' && agent.metadata.repoStateVerification?.status === 'completed') return false;
    if (!pendingCheckoutScope(agent) && await settleAbsentCheckoutRetirement(agent)) return true;
    await recordCompletionReplayAttempt(original);
    agent = await getAgentRecord(agentIdOf(original)).catch(() => null) || original;
    const lookup = await loadTaskById(agent.taskId).then(task => ({ task, readable: true }), () => ({ task: null, readable: false }));
    const { task } = lookup;
    if (!task) await settleTasklessCompletionAudit(agent, lookup);
    else await verifyAndReplayCompletion(agent, task);
    return true;
  }

  async function resumeCompletionAudits({ onlyAgentIds, skipPrelude = false, recheckClaimHolds = false, legacyRepairs = false } = {}) {
    const { readBranchCompletionPolicies } = await import('../branchCompletionPolicy.js');
    const agents = await readBranchCompletionPolicies({ repairIndex: false });
    if (!skipPrelude) await runCompletionAuditPrelude(agents, { legacyRepairs });
    const pending = selectPendingCompletionAudits(agents, { onlyAgentIds, recheckClaimHolds });
    let checked = 0;
    const selected = pending.slice(0, COMPLETION_RECOVERY_BATCH_SIZE);
    for (const original of selected) {
      if (await resumePendingCompletionAudit(original, getTaskById)) checked++;
    }
    return { checked, pendingAtStart: pending.length, pendingAgentIds: pending.map(agentIdOf),
      attemptedAgentIds: selected.map(agentIdOf) };
  }

  return {
    resumeAgentCompletionRetirement,
    bindCompletionRetirementEvents,
    sweepRepoStateVerifications,
    resumeDeferredRepoStateVerifications,
  };
}

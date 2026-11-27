/** Persist repository verification and cleanup receipts on live or archived CoS completion records. */
import { isDeepStrictEqual } from 'node:util';
import { join } from 'path';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { tryReadFile } from '../../lib/fileUtils.js';
import { COMPLETION_RECEIPT_VERSION, COMPLETION_STAGE, completionReceiptDone, completionStagesDone,
  completionStagesDoneExceptWorktree, verifiedRepositoryWorktreeStage } from '../../lib/agent/agentCompletionStages.js';
import { cosEvents } from './cosEvents.js';
import { loadState, saveState, withStateLock, readAgentsStateForSafetyCheck } from './cosState.js';
import { loadAgentIndex, getAgentDir, writeArchivedAgentMetadata } from './cosAgentIndex.js';

/** Persist completion work after live-state retention expires. The same state
 * lock serializes live updates and archive rewrites; no transcript is loaded.
 */
export function recordRepoStateVerification(agentId, verification) {
  return updateCompletionReceipt(agentId, (metadata, agent) => {
    const capture = metadata.checkoutCapture;
    const verifiedBy = metadata.completionCleanup?.stages?.[COMPLETION_STAGE.WORKTREE]?.verifiedBy;
    const currentInventory = ['current-inventory', 'inherited-current-inventory'].includes(verifiedBy);
    // Completed agent records from before the inventory transition remain valid.
    const legacyRetirement = ['service-retirement-receipt', 'inherited-service-retirement-receipt'].includes(verifiedBy)
      && /^[a-f0-9]{64}$/.test(capture?.receiptDigest || '')
      && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(capture?.retiredHead || '');
    const retired = capture?.status === 'retired' && capture.unknown === true
      && (currentInventory || (legacyRetirement && /^[a-f0-9]{64}$/.test(capture.checkoutIdentity || '')))
      && metadata.repoStateVerification?.physicalRetirementVerified === true
      && metadata.completionCleanup?.status === 'completed';
    // An absent task cannot undo an already verified physical retirement. The
    // startup selector may still hold the snapshot from before receipt replay.
    const next = verification.status === 'pending' && retired ? { ...verification, status: 'completed', reasons: [] } : verification;
    const completionCleanup = metadata.completionCleanup;
    if (next.status === 'completed' && agent.result?.cleanupPending !== true && completionCleanup?.replay
      && ['completed', 'failed', 'abandoned'].includes(completionCleanup.status)) {
      const { replay: _replay, ...settled } = completionCleanup;
      return { ...metadata, completionCleanup: settled, repoStateVerification: { ...metadata.repoStateVerification, ...next } };
    }
    return { ...metadata, repoStateVerification: { ...metadata.repoStateVerification, ...next } };
  });
}

/** Reserve a cognitive recovery once per exact observation on its original run.
 * Persist before dispatch: an interrupted publication stays held, never launches
 * another agent just because the old task completed or the server restarted.
 */
export async function reserveRepoCleanupRecovery(agentId, branch, observation) {
  let reservation = null;
  const saved = await updateCompletionReceipt(agentId, async metadata => {
    const prior = metadata.repoCleanupRecoveries?.[branch];
    const history = prior?.observations || (prior?.observation ? [prior.observation] : []);
    const refuse = reason => { reservation = { ...prior, admitted: false, reason }; return metadata; };
    // A changed observation never steals an active/uncertain successor's work.
    if (prior?.phase === 'reserved' && !prior.taskId) return refuse('cleanup-publication-unverified');
    if (prior?.taskId) {
      const { getTaskById } = await import('./cosTaskStore.js');
      const task = await getTaskById(prior.taskId).catch(() => null);
      if (!task || task.status !== 'completed') return refuse('cleanup-successor-owned');
    }
    if (history.includes(observation)) return refuse('cleanup-observation-already-attempted');
    // Three meaningful observations on the same original run/branch are enough
    // to establish a persistent issue. Further scans retain the evidence gap.
    if ((prior?.attempt || 0) >= 3) return refuse('cleanup-cognitive-budget-exhausted');
    const attempt = (prior?.attempt || 0) + 1;
    const entry = { observation, observations: [...history, observation], attempt, phase: 'reserved', at: new Date().toISOString() };
    reservation = { admitted: true, ...entry };
    return { ...metadata, repoCleanupRecoveries: { ...metadata.repoCleanupRecoveries, [branch]: entry } };
  });
  return saved ? reservation : null;
}

export async function recordRepoCleanupRecovery(agentId, branch, observation, patch) {
  return updateCompletionReceipt(agentId, metadata => {
    const prior = metadata.repoCleanupRecoveries?.[branch];
    if (prior?.observation !== observation) return metadata;
    // A definitive refusal before publication did not spend cognitive work.
    // Release only this reserved observation, retaining every actual attempt.
    const deferred = prior.phase === 'reserved' && !prior.taskId
      && patch.phase === 'blocked-before-dispatch' && patch.taskId === null;
    const entry = { ...prior, ...patch, observation, attempt: deferred ? Math.max(0, prior.attempt - 1) : prior.attempt,
      ...(deferred ? { observations: (prior.observations || []).filter(value => value !== observation) } : {}) };
    return { ...metadata, repoCleanupRecoveries: { ...metadata.repoCleanupRecoveries, [branch]: entry } };
  });
}

/** Domain outcome is independent of whether the provider process exited cleanly. */
export function recordCleanupOutcome(agentId, outcome) {
  return updateCompletionReceipt(agentId, metadata => metadataWithCleanupOutcome(metadata, outcome));
}

/** Persist independently verified delivery without settling the cleanup task. */
export async function recordSwarmCleanupDelivery(agentId, expected, proof) {
  let matched = false;
  const saved = await updateCompletionReceipt(agentId, async (metadata, agent) => {
    const [{ getTaskById }, { getInstanceId }, { activeAgents, runnerAgents, getActiveAgentIds }, contract] = await Promise.all([
      import('./cosTaskStore.js'), import('../instanceIdentity.js'), import('../agent/agentState.js'), import('../swarmCleanupDelivery.js'),
    ]);
    const [task, instance] = await Promise.all([getTaskById(agent.taskId), getInstanceId()]);
    if (!contract.sameSwarmCleanupSnapshot(agent, expected)
      || !contract.cleanupDeliveryProofMatches(task, { ...agent, metadata: { ...metadata, swarmCleanupDelivery: proof } }, instance)) return metadata;
    const owners = await readAgentsStateForSafetyCheck();
    if (!owners.trusted || getActiveAgentIds().includes(agentId) || Object.values(owners.agents).some(owner => owner.id !== agentId
      && owner.taskId === agent.taskId && ['running', 'queued', 'finalizing', 'paused'].includes(owner.status))) return metadata;
    for (const map of [activeAgents, runnerAgents]) {
      if ([...map].some(([id, owner]) => id === agentId || (owner.taskId || owner.task?.id) === agent.taskId)) return metadata;
    }
    matched = true;
    return { ...metadata, swarmCleanupDelivery: { ...proof,
      ...(metadata.swarmCleanupDelivery?.continuationIssued && { continuationIssued: true }) } };
  });
  return saved && matched;
}

export async function markSwarmCleanupContinuationIssued(agentId, expectedProof) {
  let matched = false;
  const saved = await updateCompletionReceipt(agentId, (metadata) => {
    const proof = metadata.swarmCleanupDelivery;
    if (proof?.version !== 1 || !isDeepStrictEqual(proof.branches, expectedProof?.branches)) return metadata;
    matched = true;
    return proof.continuationIssued ? metadata : { ...metadata, swarmCleanupDelivery: { ...proof, continuationIssued: true } };
  });
  return saved && matched;
}

export async function recordSwarmCleanupContinuationAttempt(agentId) {
  return updateCompletionReceipt(agentId, metadata => {
    const proof = metadata.swarmCleanupDelivery;
    if (proof?.version !== 1 || proof.continuationIssued) return metadata;
    return { ...metadata, swarmCleanupDelivery: { ...proof, lastAttemptAt: new Date().toISOString() } };
  });
}

function metadataWithCleanupOutcome(metadata, outcome) {
  const key = JSON.stringify([outcome.branch || null, outcome.path || null]);
  const prior = { ...metadata.cleanupOutcomes };
  // A branch-only hold is provisional, not a separate checkout. Resolving
  // its original path replaces that placeholder, never another known path.
  if (outcome.branch && outcome.path) delete prior[JSON.stringify([outcome.branch, null])];
  const cleanupOutcomes = { ...prior, [key]: { ...outcome, observedAt: new Date().toISOString() } };
  const rows = Object.values(cleanupOutcomes);
  const incomplete = rows.filter(row => row.status !== 'verified');
  const aggregate = incomplete.find(row => row.status === 'blocked') || incomplete[0] || rows[0];
  return { ...metadata, cleanupOutcomes, cleanupOutcome: { ...aggregate,
    status: incomplete.length ? aggregate.status : 'verified', total: rows.length, unresolved: incomplete.length } };
}

// Deferred delivery is a domain outcome, not a failed provider execution.
// Only the server's complete verification and retirement ledgers can settle it.
export function isSettleableCompletionReceipt(agent, metadata) {
  const result = agent.result;
  const cleanup = metadata.completionCleanup;
  const outcome = metadata.cleanupOutcome;
  if (result?.cleanupPending !== true || result.deliveryRecoveryOwned !== true
    || result.executionSuccess !== true || result.validationPassed === false
    || result.taskOutcome?.status !== 'incomplete' || result.taskOutcome?.recovery?.mode !== 'cleanup'
    || result.executionInterruption || metadata.executionInterruption || metadata.blocker
    || metadata.checkoutCapture?.status !== 'captured'
    || metadata.repoStateVerification?.status !== 'completed'
    || !completionReceiptDone(cleanup)
    || outcome?.status !== 'verified' || outcome.unresolved !== 0
    || outcome.committedIntegrationVerified !== true) return false;
  return true;
}

function resultAfterCompletionReceipt(agent, metadata) {
  if (!isSettleableCompletionReceipt(agent, metadata)) return agent.result;
  const result = agent.result;
  return { ...result, success: true, cleanupPending: false,
    deferredDeliveryOutcome: result.taskOutcome,
    taskOutcome: { status: 'completed', reason: 'Delivery and repository cleanup verified by server completion receipts.' } };
}

export async function updateCompletionReceipt(agentId, update, { preserveResult = false } = {}) {
  return withBackupAssetPublication(() => withStateLock(async () => {
    const state = await loadState();
    let agent = state.agents[agentId];
    const date = agent?.completedAt?.slice(0, 10) || (await loadAgentIndex()).get(agentId);
    if (!agent && date) {
      const content = await tryReadFile(join(getAgentDir(agentId, date), 'metadata.json'));
      if (!content) return false;
      agent = JSON.parse(content);
    }
    if (!agent || (agent.id || agent.agentId) !== agentId || agent.status !== 'completed') return false;
    const metadata = agent.metadata || {};
    const nextMetadata = await update(metadata, agent);
    const result = preserveResult ? agent.result : resultAfterCompletionReceipt(agent, nextMetadata);
    const updated = { ...agent, result, metadata: nextMetadata };
    if (result?.deferredDeliveryOutcome?.recovery?.mode === 'cleanup') {
      const { reconcileAgentRunDelivery } = await import('../agent/agentRunTracking.js');
      await reconcileAgentRunDelivery(updated);
    }
    if (nextMetadata === metadata && result === agent.result) return true;
    // Never synthesize a bucket before archiveCompletedAgent moved the flat
    // directory: its retry treats an existing bucket as the completed move.
    if (date && (!state.agents[agentId] || await tryReadFile(join(getAgentDir(agentId, date), 'metadata.json')))) {
      const { output: _output, ...record } = updated;
      await writeArchivedAgentMetadata(getAgentDir(agentId, date), record);
    }
    if (state.agents[agentId]) { state.agents[agentId] = updated; await saveState(state, { changedAgentIds: [agentId] }); }
    cosEvents.emit('agent:updated', updated);
    return true;
  }));
}

/** An archived completed run's audit receipt; the execution verdict is unchanged. */
export async function recordAuditFindingsReceipt(agentId, startedAt, auditFindings) {
  let matched = false;
  const saved = await updateCompletionReceipt(agentId, (metadata, agent) => {
    if (agent.startedAt !== startedAt) return metadata;
    matched = true;
    return { ...metadata, auditFindings };
  }, { preserveResult: true });
  return saved && matched;
}

/** A terminal run keeps independent post-ingestion obligations in its existing
 * durable record, including after the record moved to its archive bucket.
 */
export async function recordCompletionCleanup(agentId, startedAt, patch) {
  let matched = false;
  const saved = await updateCompletionReceipt(agentId, (metadata, agent) => {
    if (agent.startedAt !== startedAt) return metadata;
    matched = true;
    const prior = metadata.completionCleanup || { version: COMPLETION_RECEIPT_VERSION, stages: {} };
    const completionCleanup = { ...prior, ...patch,
      stages: { ...prior.stages, ...patch.stages }, updatedAt: new Date().toISOString() };
    if (['completed', 'failed', 'abandoned'].includes(completionCleanup.status)) {
      delete completionCleanup.context;
      // Repository cleanup can outlive the other completion stages, including
      // when its task has aged out of the queue. Keep its existing replay input.
      if (agent.result?.cleanupPending !== true
        && !(agent.result?.success === true && metadata.repoStateVerification?.status === 'pending')) delete completionCleanup.replay;
    }
    return { ...metadata, completionCleanup };
  });
  return saved && matched;
}

/** Verified absence settles physical cleanup without inventing a terminal
 * head or changing the original execution result. A captured checkout settles
 * only for a cleanup run whose task already completed or names another
 * cleanup owner; neither state can be handed back to this run, while a merely
 * unowned task may still be awaiting this run's own cleanup handoff. A cleanup
 * run with an unknown capture follows the same rule. */
export async function recordAbsentCheckoutRetirement(agentId, expected, proof) {
  const verifiedBy = proof.inheritedFromAgentId ? 'inherited-current-inventory' : 'current-inventory';
  let matched = false;
  const saved = await updateCompletionReceipt(agentId, async (metadata, agent) => {
    if (agent.status !== 'completed' || agent.startedAt !== expected.startedAt || agent.taskId !== expected.taskId
      || !isDeepStrictEqual(metadata, expected.metadata) || metadata.completionCleanup?.status !== 'pending') return metadata;
    const handedOff = metadata.checkoutCapture?.status === 'captured';
    if (handedOff ? agent.result?.cleanupPending !== true || metadata.isWorktree !== true
        || proof.branch !== metadata.worktreeBranch || proof.path !== metadata.workspacePath
      : metadata.checkoutCapture?.status !== 'pending' || metadata.checkoutCapture.unknown !== true) return metadata;
    // A run that still owns its task's cleanup keeps its delivery obligation
    // whether or not its capture completed.
    if (handedOff || agent.result?.cleanupPending === true) {
      const { getTaskById } = await import('./cosTaskStore.js');
      const task = await getTaskById(agent.taskId).catch(() => null);
      const owner = task?.metadata?.deliveryRecoveryAgentId;
      if (task?.status !== 'completed' && !(typeof owner === 'string' && owner && owner !== agentId)) return metadata;
    }
    if (verifiedBy === 'inherited-current-inventory'
      && (!proof.inheritedFromAgentId || metadata.resumedFromAgentId !== proof.inheritedFromAgentId
        || metadata.isWorktree !== false || metadata.completedCheckouts?.length
        || metadata.worktreeBranch || metadata.prDeliveryTarget || metadata.reviewLoopMergeTarget)) return metadata;
    const stages = metadata.completionCleanup.stages;
    if (!completionStagesDoneExceptWorktree(stages)) return metadata;
    matched = true;
    const completionCleanup = { ...metadata.completionCleanup, status: 'completed', updatedAt: new Date().toISOString(),
      stages: { ...stages, [COMPLETION_STAGE.WORKTREE]: { status: 'done', retryable: false, verifiedBy } } };
    delete completionCleanup.context; delete completionCleanup.replay;
    const updated = { ...metadata, completionCleanup,
      repoStateVerification: { ...metadata.repoStateVerification, status: 'completed', reasons: [],
        checkedAt: new Date().toISOString(), physicalRetirementVerified: true } };
    // The captured checkout stays recorded; its ledger row shows the cleanup
    // settled without claiming integration, so the execution result is unchanged.
    if (handedOff) return metadataWithCleanupOutcome(updated, { status: 'verified', reason: 'already-absent-after-handoff',
      branch: proof.branch, path: proof.path });
    return { ...updated, checkoutCapture: { ...metadata.checkoutCapture, status: 'retired',
      reason: verifiedBy === 'inherited-current-inventory' ? 'inherited-scope-already-retired' : 'retired-from-current-inventory', ...proof } };
  });
  return saved && matched;
}

/** Commit receipt-backed verification and ledger settlement together. Removing
 * replay proof before the verification write would strand a crash/restart. */
export async function settleAbsentTaskCompletion(agentId, expected) {
  let matched = false;
  const saved = await updateCompletionReceipt(agentId, async (metadata, agent) => {
    const { getTaskById } = await import('./cosTaskStore.js');
    const keys = ['completionCleanup', 'completedCheckouts',
      'worktreeBranch', 'workspacePath', 'sourceWorkspace', 'isWorktree', 'claimBranches', 'claimReleasedBranches'];
    const successfulAudit = agent.result?.success === true && agent.result?.cleanupPending !== true;
    if (agent.startedAt !== expected.startedAt || agent.taskId !== expected.taskId
      || (agent.result?.cleanupPending !== true && !successfulAudit)
      || keys.some(key => !isDeepStrictEqual(metadata[key], expected.metadata?.[key]))
      || await getTaskById(agent.taskId)) return metadata;
    const prior = metadata.completionCleanup;
    if (prior?.version !== COMPLETION_RECEIPT_VERSION || !prior.replay
      || (successfulAudit ? prior.status !== 'completed' || prior.stages?.[COMPLETION_STAGE.WORKTREE]?.status !== 'done' : prior.status !== 'pending')) return metadata;
    const stages = { ...prior.stages, [COMPLETION_STAGE.WORKTREE]: verifiedRepositoryWorktreeStage() };
    if (!completionStagesDone(stages)) return metadata;
    const { context: _context, replay: _replay, ...ledger } = prior;
    const now = new Date().toISOString();
    matched = true;
    return { ...metadata, completionCleanup: { ...ledger, stages, status: 'completed', updatedAt: now },
      repoStateVerification: { ...metadata.repoStateVerification, status: 'completed', checkedAt: now,
        reasons: ['removed-task-delivery-and-retirement-verified'] } };
  });
  return saved && matched;
}

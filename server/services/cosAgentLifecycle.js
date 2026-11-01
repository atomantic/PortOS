import { retirementCheckoutIdentityFromPointer } from '../lib/retirementCheckoutObservation.js';
/**
 * CoS Agent Lifecycle Module
 *
 * Agent register/update/complete/output/terminate/pause/kill/BTW/zombie-cleanup
 * and single-agent reads. Extracted from the former monolithic cosAgents.js
 * (issue #2530); the date-bucket index + archive layout lives in cosAgentIndex.js
 * and is shared via loadAgentIndex/saveAgentIndex/getAgentDir.
 *
 * The `cosAgents.js` barrel that used to re-export this module is retired
 * (#3450) — callers import from here directly.
 */

import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { isDeepStrictEqual } from 'node:util';
import { readFile, rm, stat, realpath } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { cosEvents } from './cosEvents.js';
import { ServerError } from '../lib/errorHandler.js';
import { loadState, saveState, withStateLock, readAgentsStateForSafetyCheck, AGENTS_DIR } from './cosState.js';
import { atomicWrite, ensureDir, readFileTail, safeJSONParse, tryReadFile } from '../lib/fileUtils.js';
import { runnerEntryShieldsRunningRecord } from '../lib/runnerAgentLiveness.js';
import { recordDomainUsage } from './domainUsage.js';
import { repairCodexTaskSummary } from './codexSummaryRepair.js';
import { loadAgentIndex, saveAgentIndex, getAgentDir, recordArchivedAgentOrder, moveAgentDir } from './cosAgentIndex.js';
import { hasClaimCheckoutBindings, hasReleaseCandidateBinding, boundCheckoutBranches, completedCheckoutReceiptValid } from './completedCheckoutEvidence.js';
import { isAgentHandoff } from '../lib/agentOutcome.js';
import { collectProtectedCleanupOwners } from '../lib/taskRetryHold.js';
import { reconcileStaleAgentReservations, releaseAgentReservation } from './agentMaintenanceReservations.js';
import { initialCandidateLifecycle } from './releaseCandidateLifecycle.js';

function hasPendingRepoStateVerification(agent) {
  return agent?.status === 'completed' && agent?.metadata?.repoStateVerification?.status === 'pending';
}

async function assertInlineReleaseDelivery(agent) {
  const { verifyInlineReleaseDelivery } = await import('./releaseSynchronization.js');
  const delivery = await verifyInlineReleaseDelivery(agent);
  if (!delivery?.verified) throw new ServerError(`Release synchronization is unfinished: ${delivery?.reason || 'evidence unavailable'}`,
    { status: 409, code: 'RELEASE_SYNC_DELIVERY_UNVERIFIED' });
}

export async function readProtectedCleanupOwners({ state = null, index = null, targetAgentId = null } = {}) {
  const store = await import('./cosTaskStore.js').catch(err => {
    throw new ServerError(`Cannot verify task cleanup ownership: ${err.message}`, {
      status: 503, code: 'CLEANUP_OWNERSHIP_UNAVAILABLE',
    });
  });
  const getTaskView = 'getTaskView' in store ? store.getTaskView : null;
  if (typeof getTaskView !== 'function') {
    throw new ServerError('Cannot verify task cleanup ownership before deleting agent history', {
      status: 503, code: 'CLEANUP_OWNERSHIP_UNAVAILABLE',
    });
  }
  const view = await getTaskView({ kind: 'queue' }).catch(err => {
    throw new ServerError(`Cannot verify task cleanup ownership: ${err.message}`, {
      status: 503, code: 'CLEANUP_OWNERSHIP_UNAVAILABLE',
    });
  });
  if (!Array.isArray(view?.user?.tasks) || !Array.isArray(view?.cos?.tasks)) {
    throw new ServerError('Cannot verify task cleanup ownership before deleting agent history', {
      status: 503, code: 'CLEANUP_OWNERSHIP_UNAVAILABLE',
    });
  }
  const protectedOwners = collectProtectedCleanupOwners([...view.user.tasks, ...view.cos.tasks]);
  let synchronizations;
  try {
    const { readReleaseSynchronizationRetention } = await import('./releaseSynchronization.js');
    synchronizations = await readReleaseSynchronizationRetention();
  } catch (err) {
    throw new ServerError(`Cannot verify release synchronization ownership: ${err.message}`, {
      status: 503, code: 'CLEANUP_OWNERSHIP_UNAVAILABLE',
    });
  }
  const pending = synchronizations.filter(entry => !entry.verified);
  const continuationTasks = new Set(pending.map(entry => entry.taskId));
  const { isInlineReleaseOwner } = await import('../lib/releaseSynchronization.js');
  for (const entry of pending) protectedOwners.ownerIds.add(entry.owner.agentId);
  const protectSynchronizationEvidence = (id, agent) => {
    if (continuationTasks.size && (!agent || typeof agent !== 'object' || Array.isArray(agent)
      || (agent.id || agent.agentId) !== id || typeof agent.taskId !== 'string' || !agent.taskId)) protectedOwners.ownerIds.add(id);
    if (continuationTasks.has(agent?.taskId)) protectedOwners.ownerIds.add(id);
    const publication = agent?.metadata?.releasePublication;
    // A verified receipt precedes its outbox registration. Retain that owner
    // even if registration failed before the outbox entry could be written.
    if (publication?.status === 'verified' && [1, 2].includes(publication.synchronizationHandoffVersion)
      && !synchronizations.some(entry => entry.verified && entry.identity === publication.identity
        && ((entry.owner.agentId === id && entry.owner.taskId === agent.taskId && entry.owner.startedAt === agent.startedAt)
          || isInlineReleaseOwner(entry, { ...agent, id })))) {
      protectedOwners.ownerIds.add(id);
    }
  };
  // Completion is persisted before its task hold; pending repo-state verification
  // on a resident or archived completion record also protects restart evidence.
  for (const [id, agent] of Object.entries(state?.agents || {})) {
    if (hasPendingRepoStateVerification(agent)) protectedOwners.ownerIds.add(id);
    protectSynchronizationEvidence(id, agent);
  }
  if (index instanceof Map) {
    const candidates = targetAgentId
      ? (index.has(targetAgentId) ? [[targetAgentId, index.get(targetAgentId)]] : [])
      : [...index.entries()];
    for (const [id, date] of candidates) {
      if (protectedOwners.ownerIds.has(id) || state?.agents?.[id] || !date) continue;
      const content = await tryReadFile(join(AGENTS_DIR, date, id, 'metadata.json'));
      if (!content) {
        if (continuationTasks.size) protectedOwners.ownerIds.add(id);
        continue;
      }
      const parsed = safeJSONParse(content, null, { logError: false });
      if (hasPendingRepoStateVerification(parsed)) protectedOwners.ownerIds.add(id);
      protectSynchronizationEvidence(id, parsed);
    }
  }
  return protectedOwners;
}

export async function registerAgent(agentId, taskId, metadata = {}) {
  const { releaseCandidateLifecycle: _lifecycle, ...untrustedMetadata } = metadata;
  metadata = untrustedMetadata;
  metadata = { ...metadata, releasePublication: null };
  if (metadata.taskAnalysisType === 'do-release') {
    // A task's supplied metadata is not a server-observed checkout reservation.
    const { releaseCandidateRecovery: _recovery, releaseCandidateSuccessor: _successor, releaseCandidate: _candidate,
      releaseSynchronizationCheckout: _syncCheckout, checkoutSeeds: _seeds, completedCheckouts: _completed, checkoutCapture: _capture, ...trusted } = metadata;
    metadata = trusted;
  }
  return withStateLock(async () => {
    const state = await loadState();

    const registered = {
      id: agentId,
      taskId,
      status: 'running',
      startedAt: new Date().toISOString(),
      metadata,
      output: []
    };
    if (metadata.taskAnalysisType === 'do-release' && metadata.isWorktree === false) {
      registered.metadata = { ...metadata, releaseCandidateLifecycle: initialCandidateLifecycle(registered) };
    }
    if (metadata.isWorktree === true && metadata.worktreeBranch && metadata.sourceWorkspace) {
      const { captureCheckoutSeeds } = await import('./completedCheckoutEvidence.js');
      registered.metadata = { ...metadata, checkoutSeeds: await captureCheckoutSeeds(registered) };
    }
    if (process.platform === 'win32' && ['do-release', 'release-sync'].includes(metadata.taskAnalysisType)) {
      const { reserveWindowsAgentProcess } = await import('../lib/windowsAgentProcess.js');
      await reserveWindowsAgentProcess(registered);
    }
    state.agents[agentId] = registered;

    state.stats.agentsSpawned++;
    await saveState(state, { changedAgentIds: [agentId] });

    cosEvents.emit('agent:spawned', state.agents[agentId]);
    return state.agents[agentId];
  });
}

export async function updateAgent(agentId, updates) {
  let completionOwner = null;
  if (updates.status === 'completed') {
    const existing = await getAgentRecord(agentId);
    if (existing?.status !== 'completed' && [1, 2].includes(existing?.metadata?.releasePublication?.synchronizationHandoffVersion)) {
      const { ensureReleaseSynchronization } = await import('./releaseSynchronization.js');
      await ensureReleaseSynchronization(existing);
      completionOwner = { taskId: existing.taskId, startedAt: existing.startedAt, identity: existing.metadata.releasePublication.identity };
    }
    if (existing?.status !== 'completed' && existing?.metadata?.releasePublication?.synchronizationHandoffVersion === 2
      && updates.result?.success === true) {
      // Generic metadata updates are reachable from read-only routes. A
      // successful release must use completeAgent's fresh delivery check.
      throw new ServerError('Inline release success requires verified agent completion',
        { status: 409, code: 'RELEASE_SYNC_DELIVERY_UNVERIFIED' });
    }
  }
  return withStateLock(async () => {
    const state = await loadState();

    if (!state.agents[agentId]) {
      return null;
    }

    const current = state.agents[agentId];
    if (updates.status === 'completed' && current.status !== 'completed' && [1, 2].includes(current.metadata?.releasePublication?.synchronizationHandoffVersion)
      && (current.taskId !== completionOwner?.taskId || current.startedAt !== completionOwner?.startedAt
        || current.metadata.releasePublication.identity !== completionOwner?.identity)) {
      throw new ServerError('Release synchronization handoff ownership changed before completion', { status: 409 });
    }

    // Only forge verification may write publication receipts. Generic updates
    // and stale completion metadata cannot forge or revoke an observed release.
    if (updates.metadata && Object.hasOwn(updates.metadata, 'releasePublication')) {
      const { releasePublication: _publication, ...metadata } = updates.metadata;
      updates = { ...updates, metadata };
    }
    if (updates.metadata && Object.hasOwn(updates.metadata, 'releaseCandidateLifecycle')) {
      const { releaseCandidateLifecycle: _lifecycle, ...metadata } = updates.metadata;
      updates = { ...updates, metadata };
    }
    if (current.metadata?.taskAnalysisType === 'do-release' && updates.metadata) {
      // Only the ownership transaction and completion capture write these
      // fields; generic updates cannot manufacture or revoke their evidence.
      const { releaseCandidateRecovery: _recovery, releaseCandidateSuccessor: _successor, releaseCandidate: _candidate,
        releaseSynchronizationCheckout: _syncCheckout, checkoutSeeds: _seeds, completedCheckouts: _completed, checkoutCapture: _capture, ...metadata } = updates.metadata;
      updates = { ...updates, metadata };
    }

    // Socket events, reconnect snapshots and finalization may arrive out of
    // order. Runner receipts outrank agent claims and only advance revision.
    const previousScan = state.agents[agentId].metadata?.securityScan;
    const incomingScan = updates.metadata?.securityScan;
    if (previousScan?.source === 'runner' && incomingScan
      && (incomingScan.source !== 'runner' || incomingScan.sequence <= previousScan.sequence)) {
      updates = { ...updates, metadata: { ...updates.metadata, securityScan: previousScan } };
    }

    // Each claim-swarm branch has its own recovery. Merge these server-written
    // backlinks under the state lock so sibling audits cannot revoke one another.
    if (updates.metadata?.repoStateRecoveries) {
      updates = { ...updates, metadata: { ...updates.metadata, repoStateRecoveries: {
        ...state.agents[agentId].metadata?.repoStateRecoveries, ...updates.metadata.repoStateRecoveries,
      } } };
    }
    // Merge metadata if present in updates
    if (updates.metadata) {
      state.agents[agentId] = {
        ...state.agents[agentId],
        ...updates,
        metadata: { ...state.agents[agentId].metadata, ...updates.metadata }
      };
    } else {
      state.agents[agentId] = { ...state.agents[agentId], ...updates };
    }
    await saveState(state, { changedAgentIds: [agentId] });

    // Completion writes the archive before later completion hooks enrich an
    // agent's metadata (task summaries, scan reports, etc.). Mirror those
    // post-completion updates into the archived metadata too, otherwise they
    // disappear as soon as in-memory retention expires.
    const updatedAgent = state.agents[agentId];
    if (updatedAgent.status === 'completed' && updatedAgent.completedAt) {
      const { output: _output, ...metadata } = updatedAgent;
      const dateStr = updatedAgent.completedAt.slice(0, 10);
      await atomicWrite(join(getAgentDir(agentId, dateStr), 'metadata.json'), metadata);
    }

    cosEvents.emit('agent:updated', updatedAgent);
    return updatedAgent;
  });
}

/** Persist one forge-verified milestone without changing execution/delivery status. */
export async function recordAgentReleasePublication(owner, receipt) {
  return withStateLock(async () => {
    const state = await loadState();
    const agent = state.agents[owner.id];
    if (!agent || agent.status !== 'running' || agent.taskId !== owner.taskId
      || agent.startedAt !== owner.startedAt || agent.metadata?.taskAnalysisType !== 'do-release'
      || agent.metadata?.sourceWorkspace !== owner.metadata?.sourceWorkspace
      || agent.metadata?.workspacePath !== owner.metadata?.workspacePath
      || !isDeepStrictEqual(agent.metadata?.releaseCandidateRecovery, owner.metadata?.releaseCandidateRecovery)) {
      throw new ServerError('Release coordinator ownership changed during verification', { status: 409 });
    }
    const previous = agent.metadata.releasePublication;
    if (previous) {
      if (previous.identity !== receipt.identity) throw new ServerError('Release coordinator already recorded a different publication', { status: 409 });
      if ([1, 2].includes(previous.synchronizationHandoffVersion)
        || ![1, 2].includes(receipt.synchronizationHandoffVersion)) return previous;
      // An explicit verification request can enroll a legacy receipt. Startup
      // recovery alone must never manufacture new provider work from history.
      receipt = { ...previous, synchronizationHandoffVersion: receipt.synchronizationHandoffVersion };
    }
    const updated = { ...agent, metadata: { ...agent.metadata, releasePublication: receipt } };
    await saveState({ ...state, agents: { ...state.agents, [owner.id]: updated } }, { changedAgentIds: [owner.id] });
    cosEvents.emit('agent:updated', updated);
    return receipt;
  });
}

/**
 * Move a completed agent's directory into its `YYYY-MM-DD` bucket and index it.
 * Split out of `completeAgent` and made idempotent so the duplicate-completion
 * path can re-run it to finish an archive a prior call left half-done (an fs
 * failure anywhere after the state write) without touching the recorded verdict.
 */
async function archiveCompletedAgent(agentId, agent) {
  // Determine date bucket from completedAt
  const dateStr = agent.completedAt.slice(0, 10);
  const targetDir = join(AGENTS_DIR, dateStr, agentId);

  // Skipped once the bucket dir exists — a prior completion already moved it.
  // Rewriting metadata into a recreated flat dir would both litter and let a
  // later caller's verdict reach the archive the state record no longer accepts.
  if (!existsSync(targetDir)) {
    await ensureDir(join(AGENTS_DIR, dateStr));

    // Write metadata to flat dir first (may already have output.txt/prompt.txt there)
    const flatDir = join(AGENTS_DIR, agentId);
    if (!existsSync(flatDir)) {
      await ensureDir(flatDir);
    }
    const { output: _output, ...agentWithoutOutput } = agent;
    await atomicWrite(join(flatDir, 'metadata.json'), agentWithoutOutput);

    // Move entire agent dir into date bucket (atomic on same filesystem)
    // Cross-filesystem / Windows-handle fallback copies bytes and rolls back a
    // partial target (the duplicate-completion repair reads an existing
    // `targetDir` as "already archived", so a partial one would strand the run).
    await moveAgentDir(flatDir, targetDir);
  }

  // Update index — deliberately NOT gated on the in-memory map already holding
  // this entry. A failed `saveAgentIndex` leaves the map updated, so a failed write
  // leaves the map correct while index.json on disk is missing the agent; after a
  // restart the archive would be unreachable from history. Re-running the write
  // is cheap (a small map, atomically written) and repairs exactly that.
  const idx = await loadAgentIndex();
  idx.set(agentId, dateStr);
  // Project the completion order BEFORE saving: `saveAgentIndex` prunes the
  // projection to the ids the index owns, so recording after it is a no-op.
  await recordArchivedAgentOrder([{ ...agent, id: agentId }]);
  await saveAgentIndex();
}

/** Persist completion work after live-state retention expires. The same state
 * lock serializes live updates and archive rewrites; no transcript is loaded.
 */
export function recordRepoStateVerification(agentId, verification) {
  return updateCompletionReceipt(agentId, metadata => {
    const capture = metadata.checkoutCapture;
    const retired = capture?.status === 'retired' && capture.unknown === true
      && /^[a-f0-9]{64}$/.test(capture.receiptDigest || '') && /^[a-f0-9]{64}$/.test(capture.checkoutIdentity || '')
      && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(capture.retiredHead || '')
      && metadata.repoStateVerification?.physicalRetirementVerified === true
      && metadata.completionCleanup?.status === 'completed'
      && ['service-retirement-receipt', 'inherited-service-retirement-receipt'].includes(metadata.completionCleanup.stages?.worktree?.verifiedBy);
    // An absent task cannot undo an already verified physical retirement. The
    // startup selector may still hold the snapshot from before receipt replay.
    const next = verification.status === 'pending' && retired ? { ...verification, status: 'completed', reasons: [] } : verification;
    return { ...metadata, repoStateVerification: { ...metadata.repoStateVerification, ...next } };
  });
}

/** Historical cleanup has its own ledger; the runs' original verdicts and
 * transferred verification records remain evidence, never rewritten success. */
export async function recordHistoricalCleanupReconciliation(agentId, expected, patch) {
  let matched = false;
  const saved = await updateCompletionReceipt(agentId, (metadata, agent) => {
    const { historicalCleanupReconciliation: _prior, ...current } = metadata;
    const { historicalCleanupReconciliation: _expected, ...original } = expected.metadata || {};
    if (agent.startedAt !== expected.startedAt || agent.taskId !== expected.taskId
      || !isDeepStrictEqual(agent.result, expected.result) || !isDeepStrictEqual(current, original)) return metadata;
    matched = true;
    const { branchOutcome, ...fields } = patch;
    const prior = metadata.historicalCleanupReconciliation || {};
    return { ...metadata, historicalCleanupReconciliation: { ...prior, ...fields,
      ...(branchOutcome && { branches: { ...prior.branches,
        [JSON.stringify([branchOutcome.branch, branchOutcome.path || null])]: { ...branchOutcome, observedAt: patch.checkedAt } } }),
    } };
  }, { preserveResult: true });
  return saved && matched;
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
      import('./cosTaskStore.js'), import('./instanceIdentity.js'), import('./agentState.js'), import('./swarmCleanupDelivery.js'),
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

/** Server-only recovery backlink; works after the parent leaves live retention. */
export function recordRepoStateRecovery(agentId, link, { claimRun = false } = {}) {
  return updateCompletionReceipt(agentId, metadata => ({ ...metadata, repoStateRecovery: link,
    ...(claimRun ? { repoStateRecoveries: { ...metadata?.repoStateRecoveries, [link.branch]: link } } : {}),
  }));
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
    || cleanup?.status !== 'completed' || cleanup.version !== 1
    || ['sentinel', 'jira', 'notification', 'pipeline', 'creative', 'report', 'worktree']
      .some(key => cleanup.stages?.[key]?.status !== 'done')
    || Object.values(cleanup.stages).some(stage => stage.status !== 'done')
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

async function updateCompletionReceipt(agentId, update, { preserveResult = false } = {}) {
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
      const { reconcileAgentRunDelivery } = await import('./agentRunTracking.js');
      await reconcileAgentRunDelivery(updated);
    }
    if (nextMetadata === metadata && result === agent.result) return true;
    // Never synthesize a bucket before archiveCompletedAgent moved the flat
    // directory: its retry treats an existing bucket as the completed move.
    if (date && (!state.agents[agentId] || await tryReadFile(join(getAgentDir(agentId, date), 'metadata.json')))) {
      const { output: _output, ...record } = updated;
      await atomicWrite(join(getAgentDir(agentId, date), 'metadata.json'), record);
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
    const prior = metadata.completionCleanup || { version: 1, stages: {} };
    const completionCleanup = { ...prior, ...patch,
      stages: { ...prior.stages, ...patch.stages }, updatedAt: new Date().toISOString() };
    if (['completed', 'failed', 'abandoned'].includes(completionCleanup.status)) {
      delete completionCleanup.context;
      delete completionCleanup.replay;
    }
    return { ...metadata, completionCleanup };
  });
  return saved && matched;
}

/** Settle only an earlier run's physical cleanup after its verified successor.
 * Keep the original unknown capture and failed execution verdict explicit. */
export function recordSuccessorCheckoutRetirement(agentId, expected, proof) {
  return recordCheckoutRetirement(agentId, expected, proof, 'delivered-successor');
}

/** A canonical service receipt proves physical retirement, not an unknown
 * original terminal head or a successful execution. Preserve both as history. */
export function recordSeededCheckoutRetirement(agentId, expected, proof) {
  return recordCheckoutRetirement(agentId, expected, proof, 'service-retirement-receipt');
}

/** An unseeded primary continuation never acquires its parent's retired checkout. */
export function recordInheritedCheckoutRetirement(agentId, expected, proof) {
  return recordCheckoutRetirement(agentId, expected, proof, 'inherited-service-retirement-receipt');
}

async function recordCheckoutRetirement(agentId, expected, proof, verifiedBy) {
  let matched = false;
  const saved = await updateCompletionReceipt(agentId, (metadata, agent) => {
    if (agent.status !== 'completed' || agent.startedAt !== expected.startedAt || agent.taskId !== expected.taskId
      || !isDeepStrictEqual(metadata, expected.metadata) || metadata.completionCleanup?.status !== 'pending') return metadata;
    const source = proof.sourceCapture;
    if (source) {
      if (verifiedBy !== 'delivered-successor' || metadata.checkoutCapture?.status !== 'captured'
        || agent.result?.executionSuccess !== true || agent.result.validationPassed === false
        || agent.result.cleanupPending !== true || agent.result.deliveryRecoveryOwned !== true
        || agent.result.taskOutcome?.status !== 'incomplete' || agent.result.taskOutcome?.recovery?.mode !== 'cleanup'
        || agent.result.executionInterruption || metadata.executionInterruption || metadata.blocker
        || !proof.successorAgentId || proof.successorAgentId === agentId || proof.head !== source.head
        || !/^[a-f0-9]{64}$/.test(proof.receiptDigest || '')
        || retirementCheckoutIdentityFromPointer(source.incarnation?.pointer) !== proof.checkoutIdentity
        || proof.prUrl !== metadata.reviewLoopMergeTarget?.url || source.branch !== metadata.worktreeBranch
        || source.repoPath !== metadata.sourceWorkspace || source.path !== metadata.workspacePath
        || !metadata.completedCheckouts?.some(row => completedCheckoutReceiptValid(agent, row) && isDeepStrictEqual(row, source))) return metadata;
    } else if (metadata.checkoutCapture?.status !== 'pending' || metadata.checkoutCapture.unknown !== true) return metadata;
    if (verifiedBy === 'inherited-service-retirement-receipt'
      && (!proof.inheritedFromAgentId || metadata.resumedFromAgentId !== proof.inheritedFromAgentId
        || metadata.isWorktree !== false || metadata.checkoutSeeds?.length || metadata.completedCheckouts?.length
        || metadata.worktreeBranch || metadata.prDeliveryTarget || metadata.reviewLoopMergeTarget)) return metadata;
    const stages = metadata.completionCleanup.stages;
    if (!stages || !stages.worktree || ['sentinel', 'jira', 'notification', 'pipeline', 'creative', 'report'].some(key => stages[key]?.status !== 'done')
      || Object.entries(stages).some(([key, stage]) => key !== 'worktree' && stage.status !== 'done')) return metadata;
    matched = true;
    const completionCleanup = { ...metadata.completionCleanup, status: 'completed', updatedAt: new Date().toISOString(),
      stages: { ...stages, worktree: { status: 'done', retryable: false, verifiedBy, ...(proof.successorAgentId && { successorAgentId: proof.successorAgentId }) } } };
    delete completionCleanup.context; delete completionCleanup.replay;
    const updated = { ...metadata, completionCleanup,
      checkoutCapture: source ? metadata.checkoutCapture : { ...metadata.checkoutCapture, status: 'retired', reason: verifiedBy === 'delivered-successor' ? 'retired-by-verified-successor'
        : verifiedBy === 'inherited-service-retirement-receipt' ? 'inherited-scope-already-retired' : 'retired-by-service-receipt', ...proof },
      repoStateVerification: { ...metadata.repoStateVerification, status: 'completed', reasons: [],
        checkedAt: new Date().toISOString(), ...(proof.successorAgentId
          ? { deliveryVerifiedBySuccessor: proof.successorAgentId } : { physicalRetirementVerified: true }) } };
    return source ? metadataWithCleanupOutcome(updated, { status: 'verified', reason: 'same-head-successor-retirement-verified',
      branch: source.branch, path: source.path, prUrl: proof.prUrl, committedIntegrationVerified: true,
      successorAgentId: proof.successorAgentId, preservation: { verifiedAt: new Date().toISOString(),
        checkoutIdentity: proof.checkoutIdentity, receiptDigest: proof.receiptDigest } }) : updated;
  });
  return saved && matched;
}

/** Commit receipt-backed verification and ledger settlement together. Removing
 * replay proof before the verification write would strand a crash/restart. */
export async function settleAbsentTaskCompletion(agentId, expected) {
  let matched = false;
  const saved = await updateCompletionReceipt(agentId, async (metadata, agent) => {
    const { getTaskById } = await import('./cosTaskStore.js');
    const { getInstanceId, UNKNOWN_INSTANCE_ID } = await import('./instanceIdentity.js');
    const instanceId = await getInstanceId();
    const keys = ['instanceId', 'completionCleanup', 'completionTaskDispatch', 'completedCheckouts', 'checkoutSeeds',
      'worktreeBranch', 'workspacePath', 'sourceWorkspace', 'isWorktree', 'claimBranches', 'claimReleasedBranches'];
    if (agent.startedAt !== expected.startedAt || agent.taskId !== expected.taskId || !agent.result?.cleanupPending
      || !instanceId || instanceId === UNKNOWN_INSTANCE_ID || metadata.instanceId !== instanceId
      || keys.some(key => !isDeepStrictEqual(metadata[key], expected.metadata?.[key]))
      || await getTaskById(agent.taskId)) return metadata;
    const prior = metadata.completionCleanup;
    if (prior?.version !== 1 || !prior.replay || prior.status !== 'pending') return metadata;
    const stages = { ...prior.stages, worktree: { status: 'done', retryable: false, value: [], verifiedBy: 'repository-state-verification' } };
    if (['sentinel', 'jira', 'notification', 'pipeline', 'creative', 'report'].some(key => stages[key]?.status !== 'done')
      || Object.values(stages).some(stage => stage.status !== 'done')) return metadata;
    const { context: _context, replay: _replay, ...ledger } = prior;
    const now = new Date().toISOString();
    matched = true;
    return { ...metadata, completionCleanup: { ...ledger, stages, status: 'completed', updatedAt: now },
      repoStateVerification: { ...metadata.repoStateVerification, status: 'completed', checkedAt: now,
        reasons: ['removed-task-delivery-and-retirement-verified'] } };
  });
  return saved && matched;
}

/**
 * Whether this agent's recorded delivery target owns the checkout at
 * `{ branch, path, repoPath }`. The pre-lock forge read passes
 * `includeReviewLoop: true`; the in-lock re-check passes false because there the
 * review-loop PR is already covered by `knownPr`.
 */
async function deliveryTargetBindsCheckout(meta, { branch, path, repoPath }, { includeReviewLoop }) {
  const resolves = async (target, expected) => await realpath(target || '').catch(() => null) === expected;
  if (meta?.prOpenedBy === 'agent-inline' && meta.configOpenPR === true && meta.prDeliveryTarget?.branch === branch
    && await resolves(meta.prDeliveryTarget?.workspacePath, path)) return true;
  if (meta?.configClaimFlow === true && hasClaimCheckoutBindings(meta) && meta.claimBranches?.includes(branch)
    && await resolves(meta.sourceWorkspace || meta.workspacePath, repoPath)) return true;
  return includeReviewLoop && meta?.prCompletionPolicy === 'review-then-merge'
    && meta.reviewLoopMergeTarget?.branch === branch && meta.worktreeBranch === branch
    && await resolves(meta.workspacePath, path);
}

/** Resolve an explicit retirement's paths and head; null when any is unusable. */
async function normalizeRetirement(retirement) {
  const [repoPath, path] = await Promise.all([realpath(retirement.repoPath).catch(() => null), realpath(retirement.path).catch(() => null)]);
  if (!repoPath || !path || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(retirement.head || '')) return null;
  return { ...retirement, repoPath, path };
}

/** Fresh merge proof read outside the ownership lock for an unknown terminal capture. */
async function resolveMergedCaptureRetirement(agentId) {
  const { readMergedClaimEvidence } = await import('./completedCheckoutEvidence.js');
  const original = await getAgentRecord(agentId);
  const meta = original?.metadata;
  const seed = meta?.checkoutSeeds?.length === 1 ? meta.checkoutSeeds[0] : null;
  // Inline, claim and review-loop deliveries can merge before terminal capture fails.
  // The locked replay still rechecks the original generation, head and every later owner.
  if (!(original?.status === 'completed' && original.result?.executionSuccess === true
    && original.result.validationPassed !== false && meta.checkoutCapture?.status === 'pending'
    && meta.checkoutCapture.unknown === true && meta.checkoutCapture.targets?.length === 0
    && seed?.agentId === agentId && seed.startedAt === original.startedAt
    && await deliveryTargetBindsCheckout(meta, seed, { includeReviewLoop: true }))) return null;
  const { execGit } = await import('../lib/execGit.js');
  const head = await execGit(['rev-parse', '--verify', 'HEAD^{commit}'], seed.path, {
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' }, timeout: 5000,
  }).then(result => result.stdout.trim()).catch(() => null);
  const proof = head && await readMergedClaimEvidence({ repoPath: seed.repoPath, branch: seed.branch, head }).catch(() => null);
  return proof ? { repoPath: seed.repoPath, branch: seed.branch, path: seed.path, head,
    prUrl: proof.prUrl, verifiedPrUrl: proof.prUrl, verifiedMergedHead: head, observedStartedAt: original.startedAt } : null;
}

/** True when another record on this branch and repository is not strictly earlier than this generation. */
async function hasCompetingGenerationOnBranch(history, agentId, startedAt, target) {
  for (const other of history) {
    if ((other.id || other.agentId) === agentId) continue;
    const meta = other.metadata || {};
    const branches = [meta.worktreeBranch, ...(meta.claimBranches || []), ...(meta.claimReleasedBranches || [])];
    if (!branches.includes(target.branch)) continue;
    const repository = await realpath(meta.sourceWorkspace || meta.workspacePath || '').catch(() => null);
    if (repository !== target.repoPath) continue;
    if (!Number.isFinite(Date.parse(other.startedAt)) || Date.parse(other.startedAt) >= Date.parse(startedAt)) return true;
  }
  return false;
}

/** A pre-terminal capture snapshot must lie inside the run and still match the physical checkout. */
async function capturedSnapshotIsCurrent(agent, target) {
  const { readCompletedCheckoutIdentity } = await import('./completedCheckoutEvidence.js');
  if (!Number.isFinite(Date.parse(target.capturedAt)) || Date.parse(target.capturedAt) < Date.parse(agent.startedAt)
    || Date.parse(target.capturedAt) > Date.parse(agent.completedAt)) return false;
  const current = await readCompletedCheckoutIdentity(target).catch(() => null);
  const expected = { repoPath: target.repoPath, branch: target.branch, path: target.path, head: target.head, incarnation: target.incarnation };
  return Boolean(current) && JSON.stringify(current) === JSON.stringify(expected);
}

/** Every target must belong to this generation: same agent, no later owner, no competing generation, current snapshot. */
async function targetsOwnedByThisGeneration({ agent, agentId, targets, seedBacked, owners, history }) {
  const { claimCheckoutOwner } = await import('../lib/claimContinuation.js');
  for (const target of targets) {
    if (target.agentId !== agentId || target.startedAt !== agent.startedAt
      || claimCheckoutOwner({ branchName: target.branch, holderPath: target.path, sourceWorkspace: target.repoPath, agents: owners })) return false;
    if (await hasCompetingGenerationOnBranch(history, agentId, agent.startedAt, target)) return false;
    if (!seedBacked && !await capturedSnapshotIsCurrent(agent, target)) return false;
  }
  return true;
}

/** A merge-verified retirement of a successful, unblocked run whose PR is the known one or was proven inline. */
function isReviewedRetirement(retirement, agent, { knownPr, verifiedInline }) {
  return retirement?.verifiedMergedHead === retirement?.head
    && typeof retirement?.prUrl === 'string' && (retirement.prUrl === knownPr || verifiedInline)
    && agent?.result?.executionSuccess === true && agent.result.validationPassed !== false
    && agent.result?.taskOutcome?.recovery?.mode !== 'approval' && !agent.metadata?.blocker;
}

/** An orphaned run whose empty capture is retired against one of its own physical seeds. */
function isSeededOrphanRetirement(retirement, agent, pending) {
  return retirement && agent?.result?.orphaned === true && agent.result.validationPassed !== false
    && pending?.status === 'captured' && agent.metadata.completedCheckouts?.length === 0
    && agent.metadata.checkoutSeeds?.some(seed => seed.repoPath === retirement.repoPath
      && seed.branch === retirement.branch && seed.path === retirement.path);
}

/** Replay requires preterminal snapshots. An explicit, freshly merged retirement
 * review may observe the current head inside the original physical seed instead.
 * Neither path discovers a replacement by name or rewrites execution history.
 */
export async function retryCompletionCheckoutCapture(agentId, { retirement } = {}) {
  const { withClaimOwnershipLock, readClaimOwnershipAgents } = await import('./cosClaimOwnership.js');
  const { captureSeededCompletionCheckouts } = await import('./completedCheckoutEvidence.js');
  if (!retirement) retirement = await resolveMergedCaptureRetirement(agentId) ?? undefined;
  const recovered = await withClaimOwnershipLock(async () => {
    if (retirement && !(retirement = await normalizeRetirement(retirement))) return false;
    const agent = await getAgentRecord(agentId);
    const pending = agent?.metadata?.checkoutCapture;
    const knownPr = agent?.metadata?.branchCompletionPolicy?.prUrl || agent?.metadata?.reviewLoopMergeTarget?.url;
    const verifiedInline = !knownPr
      && retirement?.verifiedPrUrl === retirement?.prUrl && retirement?.observedStartedAt === agent?.startedAt
      && await deliveryTargetBindsCheckout(agent?.metadata, { branch: retirement?.branch, path: retirement?.path,
        repoPath: retirement?.repoPath }, { includeReviewLoop: false });
    const reviewedRetirement = isReviewedRetirement(retirement, agent, { knownPr, verifiedInline });
    if (retirement?.verifiedMergedHead && !reviewedRetirement) return false;
    const seededOrphan = isSeededOrphanRetirement(retirement, agent, pending);
    if (agent?.status !== 'completed' || (pending?.status !== 'pending' && !seededOrphan)) return false;
    const owners = await readClaimOwnershipAgents().catch(() => null);
    const { readBranchCompletionPolicies } = await import('./branchCompletionPolicy.js');
    const history = await readBranchCompletionPolicies({ repairIndex: false }).catch(() => null);
    if (!Array.isArray(owners) || !Array.isArray(history)) return false;
    const bound = boundCheckoutBranches(agent.metadata);
    const seeds = (agent.metadata?.checkoutSeeds || []).filter(seed => Array.isArray(bound) && bound.includes(seed.branch));
    const targets = seeds.length ? seeds : pending.unknown === false ? pending.targets : null;
    if (!targets?.length) return false;
    if (!await targetsOwnedByThisGeneration({ agent, agentId, targets, seedBacked: seeds.length > 0, owners, history })) return false;
    const captured = seeds.length ? await captureSeededCompletionCheckouts(agent,
      reviewedRetirement ? { retirement } : {}).catch(() => null) : targets;
    if (!captured?.length) return false;
    if (retirement && !captured.some(row => row.repoPath === retirement.repoPath && row.branch === retirement.branch
      && row.path === retirement.path && row.head === retirement.head)) return false;
    let recorded = false;
    const saved = await updateCompletionReceipt(agentId, (metadata, current) => {
      if (current.startedAt !== agent.startedAt || JSON.stringify(metadata.checkoutCapture) !== JSON.stringify(pending)
        || JSON.stringify(metadata.checkoutSeeds) !== JSON.stringify(agent.metadata.checkoutSeeds)) return metadata;
      recorded = true;
      return { ...metadata, checkoutCapture: { status: 'captured', retriedAt: new Date().toISOString() }, completedCheckouts: captured };
    });
    return saved && recorded;
  });
  // Publish after releasing the ownership lock: the existing completion replay
  // acquires that same lock and must not wait on its own capture operation.
  if (recovered) cosEvents.emit('agent:checkout-captured', { agentId });
  return recovered;
}

export async function completeAgent(agentId, result = {}) {
  const existing = await getAgentRecord(agentId);
  const publicationIdentity = existing?.metadata?.releasePublication?.identity;
  let publicationHandoffConfirmed = false;
  if (existing?.status !== 'completed' && [1, 2].includes(existing?.metadata?.releasePublication?.synchronizationHandoffVersion)) {
    const { ensureReleaseSynchronization } = await import('./releaseSynchronization.js');
    // All completion paths share this fence, including orphan/error recovery.
    // Task registration takes the ordinary state lock, so do it before ours.
    await ensureReleaseSynchronization(existing);
    publicationHandoffConfirmed = true;
  }
  if (result.success === true && existing?.metadata?.releasePublication?.synchronizationHandoffVersion === 2) {
    await assertInlineReleaseDelivery(existing);
  }
  if (existing?.metadata?.taskAnalysisType === 'security' && existing.metadata.useRunner) {
    const { settleAgentSecurityScan } = await import('./agentSecurityScan.js');
    const scanner = await settleAgentSecurityScan(agentId);
    if (scanner?.status === 'refused') result = { ...result, success: false, error: 'Security scanner safety refusal; automatic retry stopped' };
  }
  // Set inside the lock when the record is already terminal, so the post-lock
  // tail below (budget ledger + `agent:completed`) is skipped too — see #3384.
  let alreadyCompleted = false;

  const completed = await withBackupAssetPublication(() => withStateLock(async () => {
    const state = await loadState();

    if (!state.agents[agentId]) {
      return null;
    }

    // Idempotence (#3384): six call sites funnel here and each carries the
    // "I might be second" assumption. A duplicate completion used to overwrite
    // the recorded verdict — a stray runner `agent:completed` once replaced a
    // real success with `success: false, exitCode: 143`, flipping the card to
    // Failed and requeueing a finished task. Caller-level guards read the record
    // outside this lock, so they narrow the window rather than closing it.
    // Guard on `completed` specifically, NOT `!== 'running'`: `paused` records
    // are legitimately completed on resume.
    if (state.agents[agentId].status === 'completed') {
      alreadyCompleted = true;
      // One exception to "do nothing": if a prior completion threw partway
      // through archiving, the record says completed but its directory never
      // reached the date bucket (or never got indexed). `archiveCompletedAgent`
      // is idempotent, so re-running it finishes the job with the ALREADY-
      // RECORDED result rather than the second caller's (typically bogus) one.
      if (state.agents[agentId].completedAt) {
        await archiveCompletedAgent(agentId, state.agents[agentId]);
      }
      return state.agents[agentId];
    }

    // Capture while the state lock still protects this run's active bindings.
    // A later audit must never turn an old branch name into checkout authority.
    const agent = state.agents[agentId];
    if ([1, 2].includes(agent.metadata?.releasePublication?.synchronizationHandoffVersion) && (!publicationHandoffConfirmed || agent.metadata.releasePublication.identity !== publicationIdentity
      || agent.startedAt !== existing?.startedAt || agent.taskId !== existing?.taskId)) {
      throw new ServerError('Release synchronization handoff ownership changed before completion', { status: 409 });
    }
    let completedCheckouts;
    let checkoutCapture;
    if (hasClaimCheckoutBindings(agent.metadata) || hasReleaseCandidateBinding(agent.metadata) || agent.metadata?.isWorktree) {
      completedCheckouts = [];
      // Identity capture describes the owned physical checkout, not a passing
      // execution verdict. Failed/orphaned runs may already have delivered code.
      const { captureCompletedCheckouts, captureSeededCompletionCheckouts } = await import('./completedCheckoutEvidence.js');
      try { completedCheckouts = await captureCompletedCheckouts(agent, { success: true, strict: true }); }
      catch (error) {
        // Ingestion remains terminal. Retry only an originally captured exact
        // generation, never finalize/output hooks or historical branch names.
        checkoutCapture = { status: 'pending', reason: 'checkout-evidence-unavailable',
          targets: error.checkoutCapture?.targets || [], unknown: error.checkoutCapture?.unknown !== false,
          observedAt: new Date().toISOString() };
        result = { ...result, executionSuccess: result.executionSuccess ?? (result.success === true) };
      }
      if (!completedCheckouts.length && agent.metadata?.checkoutSeeds?.length) {
        // Capture a terminal head before publishing completion, even when the
        // ordinary inventory read failed. A later retry must match this head.
        const targets = await captureSeededCompletionCheckouts(agent, { preterminal: true }).catch(() => null);
        if (targets?.length) checkoutCapture = { ...(checkoutCapture || { status: 'captured' }), targets, unknown: false };
      }
    }

    const { requireCheckoutSettlement: _requireCheckoutSettlement, ...persistedResult } = result;
    result = persistedResult;

    const cleanup = agent.metadata?.completionCleanup;
    const cleanupContext = cleanup?.replay || cleanup?.context;
    const metadata = { ...agent.metadata,
      completionCleanup: { version: 1, stages: {}, ...cleanup, startedAt: agent.startedAt,
        status: cleanupContext ? cleanup.status || 'pending' : 'abandoned',
        ...(!cleanupContext && { reason: 'completion-context-unavailable' }) },
      ...(completedCheckouts ? { checkoutCapture: checkoutCapture || { status: 'captured' } } : {}),
      ...((result.success || result.cleanupPending === true || checkoutCapture?.status === 'pending') && (agent.metadata?.isWorktree || hasClaimCheckoutBindings(agent.metadata))
        ? { repoStateVerification: { status: 'pending' } } : {}),
    };
    state.agents[agentId] = {
      ...agent, status: 'completed', completedAt: new Date().toISOString(),
      result: { validationPassed: null, ...result }, metadata,
    };
    if (completedCheckouts) state.agents[agentId].metadata = { ...state.agents[agentId].metadata, completedCheckouts };

    if (result.success) {
      state.stats.tasksCompleted++;
    } else if (!isAgentHandoff({ result })) {
      // `resumed` records are retired by `resumeAgent`, not failed: the user paused
      // the run and its task is already requeued, so the continuation will land in
      // one of these two counters itself. Counting it here reports an error the user
      // caused deliberately and never saw.
      //
      // Asked of the bare `result` because the record does not exist yet — this is
      // the same predicate every downstream reader uses (`lib/agentOutcome.js`),
      // not a second spelling of it.
      state.stats.errors = (state.stats.errors || 0) + 1;
    }

    await saveState(state, { changedAgentIds: [agentId] });
    // `agent:completed` is intentionally emitted later, after the domain-usage
    // ledger is updated (see the recordDomainUsage block below, #1683). Do NOT
    // move it back here. `agent:updated` carries no scheduling side effect, so it
    // stays inside the lock.
    cosEvents.emit('agent:updated', state.agents[agentId]);

    await archiveCompletedAgent(agentId, state.agents[agentId]);

    return state.agents[agentId];
  }));

  // A duplicate completion never runs the completion tail: re-recording the
  // domain-usage action would double-charge the daily budget, and re-emitting
  // `agent:completed` would re-run the scheduler hand-off for an agent that
  // already finished (#3384). The existing record still comes back to the caller.
  if (alreadyCompleted) {
    return completed;
  }

  // Daily CoS budget accounting (#711): all non-user runs, including on-demand
  // work that bypasses the auto-run mode gate and pause, count toward the
  // domain's actions/minutes ledger. Recorded outside the state lock
  // (separate ledger file + write tail) so it never serializes against state.json.
  //
  // This MUST land before the `agent:completed` emit below: that event's handler
  // schedules `dequeueNextTask()`, whose daily action-budget gate reads this
  // ledger. Recording first ensures the gate counts the just-finished action, so
  // a perpetual drain can't admit one spawn past `maxActionsPerDay` at the
  // boundary (#1683).
  if (completed?.metadata?.taskType && completed.metadata.taskType !== 'user') {
    await recordDomainUsage('cos', { actions: 1, ms: Number(result.duration) || 0 })
      .catch(err => console.error(`❌ Failed to record CoS budget usage for ${agentId}: ${err.message}`));
  }

  // Emit now that the ledger reflects this action (#1683). Fires for every
  // completed agent, matching prior behavior — only the timing moved.
  if (completed) {
    cosEvents.emit('agent:completed', completed);
  }

  return completed;
}

export async function appendAgentOutput(agentId, line) {
  const result = await withStateLock(async () => {
    const state = await loadState();

    if (!state.agents[agentId]) {
      return null;
    }

    state.agents[agentId].output.push({
      timestamp: new Date().toISOString(),
      line
    });

    // Trim to last 1000 lines in state
    if (state.agents[agentId].output.length > 1000) {
      state.agents[agentId].output = state.agents[agentId].output.slice(-1000);
    }

    await saveState(state, { changedAgentIds: [agentId] });
    return state.agents[agentId];
  });

  if (result) {
    cosEvents.emit('agent:output', { agentId, line });
  }

  return result;
}

// Batched variant — single state load+save for many lines. Used by the TUI
// spawner to avoid write-amplification on chatty TUIs that emit hundreds of
// lines per second; per-line appendAgentOutput would re-load and re-save the
// entire state JSON for every line.
export async function appendAgentOutputLines(agentId, lines) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const result = await withStateLock(async () => {
    const state = await loadState();
    if (!state.agents[agentId]) return null;
    const timestamp = new Date().toISOString();
    for (const line of lines) {
      state.agents[agentId].output.push({ timestamp, line });
    }
    if (state.agents[agentId].output.length > 1000) {
      state.agents[agentId].output = state.agents[agentId].output.slice(-1000);
    }
    await saveState(state, { changedAgentIds: [agentId] });
    return state.agents[agentId];
  });

  if (result) {
    for (const line of lines) {
      cosEvents.emit('agent:output', { agentId, line });
    }
  }

  return result;
}

// Debounce window for batching streamed agent output to state. A chatty
// producer (CoS Runner stream events, non-stream CLI stdout) can emit dozens
// of lines/sec; without batching, each line round-trips a full state
// load+save (see appendAgentOutput). 250ms is invisible to the live tail but
// cuts state I/O by 1-2 orders of magnitude. Matches OUTPUT_FLUSH_INTERVAL_MS
// in agentTuiSpawning.js.
const OUTPUT_FLUSH_INTERVAL_MS = 250;

// Debounced per-agent output batcher. Wraps appendAgentOutputLines with a
// ~250ms flush window so a hot streaming producer triggers one state load+save
// per window instead of per line — the write-amplification guard documented in
// AGENTS.md ("High-frequency state writes must batch"). The TUI spawner rolls
// its own equivalent inline because it co-flushes an output.txt appendFile in
// the same batch; producers that only need the state write should use this.
//
// Callers MUST `await flush()` in their finish/cleanup path before the
// completion event so the final lines land before the agent is marked done.
export function createAgentOutputBatcher(agentId, { intervalMs = OUTPUT_FLUSH_INTERVAL_MS, flushBatch } = {}) {
  let pending = [];
  let timer = null;
  let flushing = null;

  const drain = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    // Swallow+log state-write failures so neither the debounced timer nor a
    // caller's `await flush()` ever rejects — this runs in child-process /
    // timer callbacks where an uncaught throw would crash Node (AGENTS.md "No
    // try/catch" exception). The authoritative transcript lives in output.txt;
    // a dropped live-tail batch is non-fatal. Mirrors the TUI spawner's
    // `.catch(() => {})` on its own batched append.
    await (flushBatch ? flushBatch(batch) : appendAgentOutputLines(agentId, batch)).catch((err) => {
      console.error(`❌ agent ${agentId} output batch flush failed: ${err.message}`);
    });
  };

  const schedule = () => {
    if (timer || flushing) return;
    timer = setTimeout(() => {
      timer = null;
      flushing = drain().finally(() => {
        flushing = null;
        // Catch lines that arrived during the in-flight drain — without this a
        // producer that goes quiet right after the timer fires strands its last
        // batch in `pending` until flush().
        if (pending.length > 0) schedule();
      });
    }, intervalMs);
  };

  return {
    push(lineOrLines) {
      if (Array.isArray(lineOrLines)) {
        if (lineOrLines.length === 0) return;
        pending.push(...lineOrLines);
      } else {
        pending.push(lineOrLines);
      }
      schedule();
    },
    // Wait for any in-flight drain, then fully empty `pending`. A push can race
    // in during an awaited drain, so loop until nothing is left rather than
    // draining a fixed number of times (which could strand a late line to the
    // debounce timer). flush() is only called once the producer has stopped, so
    // the loop terminates promptly.
    async flush() {
      if (flushing) await flushing;
      while (pending.length > 0) await drain();
    },
  };
}

// Get all agents from in-memory state (includes running and recently completed; archived agents loaded via getAgentsByDate)
export async function getAgents() {
  const state = await loadState();
  return Object.values(state.agents);
}

/**
 * Is this agent record still work in flight, rather than a run PortOS has
 * already finalized?
 *
 * `completed` is the only terminal status; a missing record is terminal too,
 * because a finalized agent is archived out of `state.agents` into its date
 * bucket, and an id that was never registered is not a run at all. `paused`
 * counts as live: its task is still owed a resume, and pausing already removes
 * the agent from the in-memory maps, so it can never inflate a map-derived
 * count on its own.
 */
export const isLiveAgentRecord = (record) => Boolean(record) && record.status !== 'completed';

/**
 * Returned by `readAgentRecordOrUnreadable` when the READ ITSELF failed — which
 * is not the same answer as `null` ("there is genuinely no such record"), and
 * leads to the opposite decision: an absent record means the run is finalized
 * and its tracking can go, while a failed read proves nothing and must leave
 * live state alone.
 */
export const AGENT_RECORD_UNREADABLE = Symbol('agent-record-unreadable');

/**
 * `getAgentRecord` that reports an I/O failure as `AGENT_RECORD_UNREADABLE`
 * instead of collapsing it into `null`. Pair it with `isLiveAgentRecord`:
 *
 *   const read = await readAgentRecordOrUnreadable(id);
 *   if (read !== AGENT_RECORD_UNREADABLE && !isLiveAgentRecord(read)) { … }
 */
export const readAgentRecordOrUnreadable = (agentId) =>
  getAgentRecord(agentId).then(record => record, () => AGENT_RECORD_UNREADABLE);

/**
 * Narrow a set of in-memory agent ids to the ones PortOS still considers work
 * in flight.
 *
 * The in-memory maps (`activeAgents` / `runnerAgents`) are not self-cleaning:
 * `syncRunnerAgents` adopts whatever `GET /agents` on the CoS Runner reports,
 * so a TUI PTY the runner never managed to kill stays "active" for the life of
 * the process. That is how the Update page came to sit on "4 CoS agents are
 * currently running" above an empty agent list — four finalized codex TUIs the
 * runner was still advertising, blocking the restart that would have cleared
 * them. `registerAgent` writes the record before the spawn, and the whole spawn
 * runs inside `spawningTasks`, so no genuinely starting agent falls through.
 *
 * **Fails CLOSED.** The one caller gates a pm2 restart that severs live agents,
 * so this reads the records through `readAgentsStateForSafetyCheck` — which
 * reports whether they could be established at all — rather than `loadState`,
 * which silently substitutes an EMPTY default state for a corrupt file. Reading
 * that default would judge every tracked id finalized and hand the gate a
 * confident zero, restarting PortOS out from under whatever was running. When
 * the records cannot be trusted, every tracked id counts as live instead.
 */
export async function filterLiveAgentIds(agentIds) {
  if (agentIds.length === 0) return [];
  const ids = [...new Set(agentIds)];
  const { trusted, agents } = await readAgentsStateForSafetyCheck();
  if (!trusted || !agents) {
    console.warn(`⚠️ CoS agent records could not be established — treating all ${ids.length} tracked agent(s) as live`);
    return ids;
  }
  return ids.filter(id => isLiveAgentRecord(agents[id]));
}

// Get agent by ID with full output from file
/**
 * The agent record WITHOUT its transcript — in-memory state first, falling back
 * to the on-disk `metadata.json` the index points at.
 *
 * Split out of `getAgent` so callers that only need the record's fields (the
 * worktree/provider metadata, the status) don't pay to read and line-split a
 * completed agent's entire output.txt — which for a long TUI run is megabytes,
 * and whose read failing would otherwise take the whole lookup down with it.
 * `releaseRetryHold` is the motivating caller (#3368).
 */
export async function getAgentRecord(agentId) {
  const state = await loadState();
  const agent = state.agents[agentId];
  if (agent) return agent;

  // Fall back to disk metadata via index if not in state
  const idx = await loadAgentIndex();
  const dateStr = idx.get(agentId);
  if (!dateStr) return null;
  const content = await tryReadFile(join(AGENTS_DIR, dateStr, agentId, 'metadata.json'));
  if (!content) return null;
  const raw = safeJSONParse(content, null);
  if (!raw) return null;
  const { output, ...rest } = raw;
  return { ...rest, id: raw.id || raw.agentId || agentId, status: raw.status || 'completed' };
}

// Transcript read caps for `getAgent` (#3498). `output.txt` is append-only and
// has no upper bound — a long TUI run writes tens of MB — so reading it whole
// and mapping EVERY line to a `{ line, timestamp }` object spiked heap by
// ~2x the file size per request. Both caps are load-bearing and neither
// subsumes the other:
//   - the LINE cap bounds the object count (the allocation the issue is about)
//   - the BYTE cap bounds the string read, because a repaint-heavy TUI spool
//     can be one multi-MB "line" with no newlines at all, on which a
//     line-based tail is a no-op.
export const AGENT_OUTPUT_TAIL_LINES = 1000;
export const AGENT_OUTPUT_TAIL_BYTES = 512 * 1024;

/**
 * Tail an agent's `output.txt` into the `{ line, timestamp }` shape the UI
 * renders, reading at most `maxBytes` from the end of the file and keeping at
 * most `limit` lines.
 *
 * Deliberately tail-only: an `offset` from the head of the file would have to
 * read everything before it, which is the exact cost this cap exists to avoid.
 * The interesting end of an agent transcript is the end (that's where the
 * failure and the summary are), so the trailing window is what callers want.
 *
 * @returns {Promise<{ lines: string[], truncated: boolean, totalBytes: number }|null>}
 *          null when the file is missing or unreadable. `totalBytes` is the
 *          size of the WHOLE transcript on disk, not of the window returned.
 */
async function readAgentTranscriptTail(outputFile, { limit, maxBytes }) {
  // Stat separately from the tail read: the caller needs the FULL on-disk size
  // for the truncation marker, and `readFileTail` only hands back the window.
  const info = await stat(outputFile).catch(() => null);
  if (!info) return null;
  const text = await readFileTail(outputFile, maxBytes);
  if (text === null) return null;
  const clippedByBytes = info.size > maxBytes;
  // The byte window can start mid-line (and mid-multibyte-character), so drop
  // the leading fragment rather than surfacing a garbled partial line — UNLESS
  // it is the only thing in the window. A repainted TUI transcript is one
  // enormous newline-free line, and dropping it would hand the UI an empty
  // transcript for a file that is plainly not empty; a partial last screen
  // beats nothing.
  const split = text.split('\n');
  const kept = split.filter(line => line.trim());
  const withoutFragment = clippedByBytes ? split.slice(1).filter(line => line.trim()) : kept;
  const lines = withoutFragment.length > 0 ? withoutFragment : kept;
  const clippedByLines = lines.length > limit;
  return {
    lines: clippedByLines ? lines.slice(-limit) : lines,
    truncated: clippedByBytes || clippedByLines,
    totalBytes: info.size
  };
}

/**
 * The agent record hydrated with the TAIL of its on-disk transcript.
 *
 * Callers that only need the record's fields should use `getAgentRecord` —
 * this one still touches the filesystem. When the transcript is longer than
 * the caps, the result carries `outputTruncated: true` so the UI can say the
 * transcript was clipped instead of silently presenting a partial log as whole.
 *
 * @param {string} agentId
 * @param {Object} [options]
 * @param {number} [options.limit=AGENT_OUTPUT_TAIL_LINES] - Max transcript lines to return (from the tail)
 * @param {number} [options.maxBytes=AGENT_OUTPUT_TAIL_BYTES] - Max bytes to read from the end of output.txt
 */
export async function getAgent(agentId, { limit = AGENT_OUTPUT_TAIL_LINES, maxBytes = AGENT_OUTPUT_TAIL_BYTES } = {}) {
  let agent = await getAgentRecord(agentId);
  if (!agent) return null;

  // Completed agents live in date buckets; paused agents remain in the flat
  // agent dir but should still expose their preserved transcript.
  if (agent.status === 'completed' || agent.status === 'paused') {
    const dateStr = agent.status === 'completed' ? agent.completedAt?.slice(0, 10) : null;
    const agentDir = dateStr ? getAgentDir(agentId, dateStr) : getAgentDir(agentId);
    const repaired = await repairCodexTaskSummary(agentDir, agent);
    if (repaired) agent = { ...agent, metadata: { ...agent.metadata, taskSummary: repaired } };
    const outputFile = join(agentDir, 'output.txt');
    const tail = await readAgentTranscriptTail(outputFile, { limit, maxBytes });
    if (tail) {
      const timestamp = agent.completedAt || agent.pausedAt;
      return {
        ...agent,
        output: tail.lines.map(line => ({ line, timestamp })),
        outputTruncated: tail.truncated,
        outputTotalBytes: tail.totalBytes
      };
    }
  }

  return agent;
}

// Read the prompt that was sent to an agent at spawn time.
// Used by the AgentCard UI to let the user inspect what was pasted into the
// TUI / sent to the CLI so the prompt can be iterated on.
export async function getAgentPrompt(agentId) {
  const agent = await getAgentRecord(agentId);
  if (!agent) throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });
  const date = agent.archiveDate || (agent.status === 'completed' ? agent.completedAt?.slice(0, 10) : null);
  const promptPath = join(getAgentDir(agentId, date), 'prompt.txt');
  if (!existsSync(promptPath)) throw new ServerError('Prompt file not found', { status: 404, code: 'NOT_FOUND' });
  const prompt = await readFile(promptPath, 'utf8');
  return { prompt, bytes: Buffer.byteLength(prompt) };
}

// Terminate an agent (will be handled by spawner)
export async function terminateAgent(agentId) {
  // Emit event to kill the process FIRST
  cosEvents.emit('agent:terminate', agentId);
  // The spawner will handle marking the agent as completed after termination
  return { success: true, agentId };
}

// `pauseAgent` / `killAgent` / `getAgentProcessStats` moved to
// `agentOrchestrator.js` (#3450). They lived here as deferred-import forwarders
// into the process layer, which this STATE layer cannot import statically
// without inverting the layering — so do not re-add one. Ask the facade for a
// transition; `agentImportCycles.test.js` fails on any new deferred import of
// `agentManagement.js` from this file.

// Send a BTW (additional context) message to a running agent.
//
// BTW is only supported for Claude Code TUI agents — the message gets
// bracket-pasted directly into the live PTY session as if the user typed it
// themselves. The legacy BTW.md path is gone: it required headless agents to
// poll a file mid-run, which most CLIs (codex / antigravity / LM Studio) don't do
// reliably anyway, and the indirection had to be reflected in the prompt with
// a brittle "check this file" instruction. Other TUI kinds (codex, antigravity)
// don't honor bracketed-paste in the same way, so they're not eligible
// either.
export async function sendBtwToAgent(agentId, message) {
  const agentInfo = await withStateLock(async () => {
    const state = await loadState();
    const agent = state.agents[agentId];
    if (!agent) throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });
    if (agent.status !== 'running') throw new ServerError('Agent is not running', { status: 400, code: 'INVALID_STATE' });
    if (agent.metadata?.executionMode !== 'tui') {
      throw new ServerError('BTW is only supported for Claude Code TUI agents.', { status: 400, code: 'INVALID_STATE' });
    }
    if (agent.metadata?.tuiKind !== 'claude') {
      throw new ServerError(`BTW is only supported for Claude Code TUI agents (this agent runs ${agent.metadata.tuiKind || 'an unknown TUI'}).`, { status: 400, code: 'INVALID_STATE' });
    }
    if (!agent.metadata?.tuiSessionId) {
      throw new ServerError('Agent has no attached TUI session', { status: 400, code: 'INVALID_STATE' });
    }
    return { tuiSessionId: agent.metadata.tuiSessionId };
  });

  const shellService = await import('./shell.js');
  if (!shellService.getSession(agentInfo.tuiSessionId)) {
    throw new ServerError('TUI session is no longer alive', { status: 400, code: 'INVALID_STATE' });
  }
  // Bracketed-paste + delayed Enter, mirroring the initial prompt paste in
  // agentTuiSpawning.js: Claude Code commits the paste buffer before the
  // submit arrives, so multi-line messages land as a single paste event.
  shellService.pasteToSession(agentInfo.tuiSessionId, message, { label: '[cosAgents] BTW' });

  // Track in agent state (cap at 50 messages)
  const timestamp = new Date().toISOString();
  await withStateLock(async () => {
    const state = await loadState();
    if (!state.agents[agentId]) return;
    if (!state.agents[agentId].btwMessages) {
      state.agents[agentId].btwMessages = [];
    }
    state.agents[agentId].btwMessages.push({ message, timestamp });
    if (state.agents[agentId].btwMessages.length > 50) {
      state.agents[agentId].btwMessages = state.agents[agentId].btwMessages.slice(-50);
    }
    await saveState(state, { changedAgentIds: [agentId] });
  });

  cosEvents.emit('agent:btw', { agentId, message, timestamp });
  return { success: true, delivered: 'tui-paste', tuiSessionId: agentInfo.tuiSessionId };
}

// Check if a PID is still running
async function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Cleanup zombie agents - agents marked as running but whose process is dead
export async function cleanupZombieAgents() {
  // Direct-spawn handles in this process (not leftover runnerAgents adopts —
  // those are only a handle, same as GET /agents). Read from the side-effect-free
  // state module, not subAgentSpawner.
  const { activeAgents, completingAgents, spawningTasks } = await import('./agentState.js');

  // Also check with the CoS runner for agents it's actively tracking
  const { getActiveAgentsFromRunner } = await import('./cosRunnerClient.js');
  const runnerProbe = await getActiveAgentsFromRunner().then(
    (agents) => Array.isArray(agents)
      ? { available: true, agents }
      : { available: false, agents: [] },
    () => ({ available: false, agents: [] }),
  );
  const runnerById = new Map(
    runnerProbe.agents
      .filter((row) => row?.id)
      .map((row) => [row.id, row]),
  );

  // Finalized records, emitted as `agent:completed` once the lock and archive
  // pass are done (same ordering as completeAgent) so listeners that re-read
  // state see them finished.
  const finalized = [];

  const summary = await withBackupAssetPublication(() => withStateLock(async () => {
    const state = await loadState();
    const runningAgents = Object.values(state.agents).filter(a => a.status === 'running');
    const cleaned = [];

    for (const agent of runningAgents) {
      // A runner listing is only a shield when corroborated (live pid or
      // processActive from onExit/pid probe). Leftover runnerAgents ownership
      // from an earlier adopt is not.
      if (activeAgents.has(agent.id)) continue;
      // The record is written before the spawn finishes (prompt build, claim
      // update, forge/env lookups, PTY open), and that window can run for
      // minutes under load — well past the pid grace below. While the dispatch
      // still owns the task, a missing pid means 'not spawned yet', not 'never
      // started'. Reaping here archives a run that goes on to launch normally.
      if (agent.taskId && spawningTasks.has(agent.taskId)) continue;
      const executionMode = agent.metadata?.executionMode;
      const runnerOwned = agent.metadata?.useRunner === true
        || agent.metadata?.useRunner === 'true'
        || executionMode === 'runner'
        || executionMode === 'runner-tui';
      // Same as the orphan sweep: a failed probe is not evidence the runner
      // process died. A pid-0 TUI after restart would otherwise be archived
      // as "never started" the moment the runner is unreachable.
      if (!runnerProbe.available && runnerOwned) continue;
      if (await runnerEntryShieldsRunningRecord(runnerById.get(agent.id), isPidAlive)) {
        continue;
      }

      // If agent has a PID, verify the process is actually dead
      if (agent.pid) {
        const alive = await isPidAlive(agent.pid);
        if (alive) continue;
      } else {
        // No PID yet - agent might still be initializing
        // Give it a 30 second grace period before marking as zombie
        const startedAt = agent.startedAt ? new Date(agent.startedAt).getTime() : 0;
        const ageMs = Date.now() - startedAt;
        if (ageMs < 30000) continue;
      }

      // Completion may have started while the liveness probes awaited. Its
      // hook/validation/persistence chain owns the outcome even after PTY exit.
      if (completingAgents.has(agent.id)) continue;

      // Agent is not tracked anywhere and process is dead — it's a zombie.
      // A record that never recorded a pid never spawned at all (the pid is
      // written only after a successful spawn), so "terminated unexpectedly"
      // is the wrong diagnosis: it points at a crash when the real cause is
      // upstream, at spawn time. Spawn failures now finalize themselves with
      // the actual error, so reaching here without a pid means the spawn died
      // somewhere that still doesn't report — say so rather than inventing a
      // termination that never happened.
      const neverStarted = !agent.pid;
      console.log(`🧟 Zombie agent detected: ${agent.id} (${neverStarted ? 'no process was ever launched' : `PID ${agent.pid} not running`})`);
      state.agents[agent.id] = {
        ...agent,
        status: 'completed',
        completedAt: new Date().toISOString(),
        result: {
          success: false,
          error: neverStarted
            ? 'Agent never started — no process was ever launched (check the provider command and CoS Runner logs)'
            : 'Agent process terminated unexpectedly'
        }
      };
      cleaned.push(agent.id);
    }

    if (cleaned.length > 0) {
      await saveState(state, { changedAgentIds: cleaned });

      // Persist zombie-cleaned agents to date-bucketed dirs and update index
      const idx = await loadAgentIndex();
      const archived = [];
      for (const agentId of cleaned) {
        const agent = state.agents[agentId];
        const dateStr = agent.completedAt?.slice(0, 10);
        if (!dateStr) continue;
        const bucketDir = join(AGENTS_DIR, dateStr);
        await ensureDir(bucketDir);

        const flatDir = join(AGENTS_DIR, agentId);
        const { output, ...agentWithoutOutput } = agent;

        // Ensure metadata is written before move
        if (!existsSync(flatDir)) await ensureDir(flatDir);
        await atomicWrite(join(flatDir, 'metadata.json'), agentWithoutOutput).catch(() => {});

        // Move to date bucket
        const targetDir = join(bucketDir, agentId);
        if (!existsSync(targetDir)) await moveAgentDir(flatDir, targetDir);

        idx.set(agentId, dateStr);
        archived.push({ ...agent, id: agentId });
      }
      await recordArchivedAgentOrder(archived);
      await saveAgentIndex();
      finalized.push(...cleaned.map(agentId => state.agents[agentId]));

      console.log(`🧹 Cleaned up ${cleaned.length} zombie agents: ${cleaned.join(', ')}`);
      cosEvents.emit('agents:changed', { action: 'zombie-cleanup', cleaned });
    }

    return { cleaned, count: cleaned.length };
  }));

  // Every `agent:completed` consumer (feature-agent pointer release, task
  // settlement/dequeue, maintenance and quota-burn step advancement, learning)
  // keys off this event, so a zombie-finalized run must fire it too (#11766).
  // The sweep can't route through completeAgent: it batches one lock/archive
  // pass, and completeAgent's duplicate guard would see these as already done.
  for (const agent of finalized) {
    cosEvents.emit('agent:completed', agent);
  }
  for (const agentId of summary.cleaned) await releaseAgentReservation(agentId);
  await reconcileStaleAgentReservations({ agents: await getAgents() });

  return summary;
}

// Delete a single agent from state and disk
export async function deleteAgent(agentId) {
  return withBackupAssetPublication(() => withStateLock(async () => {
    const state = await loadState();
    const idx = await loadAgentIndex();

    const inState = !!state.agents[agentId];
    const inIndex = idx.has(agentId);
    if (!inState && !inIndex) {
      throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });
    }

    const protectedOwners = await readProtectedCleanupOwners({ state, index: idx, targetAgentId: agentId });
    if (protectedOwners.isProtected(agentId)) {
      throw new ServerError(
        `Agent ${agentId} is still needed for task cleanup or release synchronization and cannot be deleted until that work is verified`,
        { status: 409, code: 'AGENT_CLEANUP_OWNED' },
      );
    }

    const wasRunning = state.agents[agentId]?.status === 'running';
    delete state.agents[agentId];
    await saveState(state, { changedAgentIds: [agentId] });

    // Persist reference removal before deleting bytes. Failed index writes
    // retain both the disk tree and its cached lookup for a safe retry.
    const agentDir = getAgentDir(agentId);
    const previousDate = idx.get(agentId);
    idx.delete(agentId);
    try { await saveAgentIndex(); }
    catch (err) { if (inIndex) idx.set(agentId, previousDate); throw err; }
    if (existsSync(agentDir)) {
      await rm(agentDir, { recursive: true }).catch(err => console.error(`❌ Failed to remove agent ${agentId} directory: ${err.message}`));
    }

    cosEvents.emit('agents:changed', { action: 'deleted', agentId });
    // A purged record can never settle its own reservation; a live run keeps its hold.
    if (!wasRunning) await releaseAgentReservation(agentId);
    return { success: true, agentId };
  }));
}

/**
 * Claim-branch ownership outside the run that holds it (#10089).
 *
 * A claim run cuts its own `claim/…` checkout, so its registered workspace stays
 * the source repository and nothing on disk names the owner. Two calls close
 * that gap:
 *   - `updateClaimOwnership` — the claim run binds the concrete branch it is
 *     about to check out (an epic's child, a split slice, a picked issue), or
 *     releases one it hands off before it ends. The run's completion releases
 *     everything; nothing here infers inactivity.
 *   - `checkReconcileOwnership` — a branch-reconcile worker re-reads the live
 *     owners immediately before it edits, rebases, pushes, merges, moves or
 *     removes a checkout, because ownership can be acquired after the scan that
 *     dispatched it. Anything unreadable or changed refuses. When the caller
 *     names its agent, a successful check also RESERVES the branch on that run's
 *     record under the binding lock, so a claim run cannot bind or adopt it
 *     while the worker mutates it; the run's completion releases it.
 */
import { resolve } from 'path';
import { bindClaimBranch, ownsClaimBranch, releaseClaimBranch, reserveReconcileBranch, reconcileAssignedTarget, reconcileMergeTarget, claimCheckoutOwnerReason } from '../../lib/claimContinuation.js';
import { isTruthyMeta } from '../../lib/metadataFlags.js';
import { advanceCandidateLifecycle } from '../releaseCandidateLifecycle.js';
import { withGitMutationLifetime } from '../../lib/gitMutationLifetime.js';

import { withClaimOwnershipLock, readClaimOwnershipAgents } from './cosClaimOwnershipState.js';

const normalize = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && normalize(a) === normalize(b);
const branchOf = (wt) => String(wt?.branch || '').replace(/^refs\/heads\//, '');

export { withClaimOwnershipLock, readClaimOwnershipAgents } from './cosClaimOwnershipState.js';

// Match merge admission's pre-start budget, across BOTH queues. A deadline is
// cancellation only until the state callback starts; afterwards it diagnoses
// pending work while both locks stay owned through real settlement.
export const CLAIM_OWNERSHIP_QUEUE_TIMEOUT_MS = 15_000;
const retryAfterMs = 5000;

export async function ownershipTransaction(operation, done, work) {
  const { withStateLock, loadState, saveState } = await import('./cosState.js');
  const queuedAt = performance.now();
  let started = false;
  let cancelled = false;
  let phase = 'ownershipQueue';
  let phaseStartedAt = queuedAt;
  const timings = { ownershipQueue: 0, stateQueue: 0, ownerRead: 0, ownershipCheck: 0, persistence: 0 };
  const elapsed = since => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(performance.now() - since)));
  const finishPhase = () => { timings[phase] = elapsed(phaseStartedAt); };
  const enter = name => { finishPhase(); phase = name; phaseStartedAt = performance.now(); };
  const report = status => {
    // A queue-timeout or pending report means the lock was held past its budget, which only happens
    // during the event-loop stalls #12852 reopens on — an anomaly, so it stays on stderr; settled is routine.
    const log = status === 'failed' ? console.error : status === 'settled' ? console.log : console.warn;
    log(`🔒 Claim ownership operation=${operation} status=${status} phase=${phase} phaseMs=${elapsed(phaseStartedAt)} totalMs=${elapsed(queuedAt)} ownershipQueueMs=${timings.ownershipQueue} stateQueueMs=${timings.stateQueue} ownerReadMs=${timings.ownerRead} ownershipCheckMs=${timings.ownershipCheck} persistenceMs=${timings.persistence}`);
  };
  const refuse = reason => ({ [done]: false, reason });
  return new Promise((resolve, reject) => {
    const expire = () => {
      cancelled = true;
      finishPhase();
      report('queue-timeout');
      resolve({ ...refuse(phase === 'ownershipQueue' ? 'ownership-queue-timeout' : 'state-queue-timeout'), retryAfterMs });
    };
    const fenced = () => {
      if (cancelled) return true;
      // A busy event loop can resume the queue before its overdue timer fires.
      if (performance.now() - queuedAt >= CLAIM_OWNERSHIP_QUEUE_TIMEOUT_MS) { expire(); return true; }
      return false;
    };
    const timer = setTimeout(() => {
      if (!started) expire();
      else report('pending');
    }, CLAIM_OWNERSHIP_QUEUE_TIMEOUT_MS);
    const queued = withClaimOwnershipLock(() => {
      if (fenced()) return;
      enter('stateQueue');
      return withStateLock(async () => {
        if (fenced()) return;
        started = true;
        enter('ownerRead');
        const agents = await readClaimOwnershipAgents();
        if (!agents) return refuse('ownership-unreadable');
        const state = await loadState();
        if (JSON.stringify(Object.values(state.agents ?? {})) !== JSON.stringify(agents)) return refuse('ownership-stale');
        // Do not alter loadState's shared pre-image before persistence starts.
        const next = { ...state, agents: { ...state.agents } };
        enter('ownershipCheck');
        return work(next, async () => {
          enter('persistence');
          await saveState(next);
        });
      });
    });
    queued.then(result => {
      if (!cancelled) { finishPhase(); report('settled'); resolve(result); }
    }, error => {
      if (!cancelled) { finishPhase(); report('failed'); reject(error); }
    }).finally(() => clearTimeout(timer));
  });
}

const agentRepoPath = agent => agent?.sourceWorkspace || agent?.metadata?.sourceWorkspace || agent?.workspacePath || agent?.metadata?.workspacePath;

/**
 * @param {{ agentId: string, action: 'bind'|'release', branch: string, handoff?: true }} input
 * @returns {Promise<{ bound: true, branch: string }|{ released: true, branch: string }|{ bound?: false, released?: false, reason: string }>}
 */
export async function updateClaimOwnership({ agentId, action, branch, handoff }) {
  const done = action === 'bind' ? 'bound' : 'released';
  const { cosEvents } = await import('./cosEvents.js');
  let wakeRecovery = false;
  const result = await ownershipTransaction(action === 'bind' ? 'bind' : 'release', done, async (state, save) => {
    const agent = state.agents?.[agentId];
    if (!agent || agent.id !== agentId) return { [done]: false, reason: 'owner-unknown' };
    const repoPath = agentRepoPath(agent);
    if (!repoPath) return { [done]: false, reason: 'ownership-unreadable' };
    const meta = agent.metadata || {};
    const released = meta.claimReleasedBranches ?? agent.claimReleasedBranches ?? [];
    const bound = meta.claimBranches ?? agent.claimBranches ?? [];
    wakeRecovery = action === 'release' ? !released.includes(branch)
      : isTruthyMeta(agent.claimSelectionPending ?? meta.claimSelectionPending)
        || (isTruthyMeta(agent.claimPicksOwnBranch ?? meta.claimPicksOwnBranch) && !bound.length && !released.length);
    return withGitMutationLifetime(async () => {
      const patch = action === 'bind' ? bindClaimBranch(agent, branch, Object.values(state.agents)) : releaseClaimBranch(agent, branch);
      if (patch.refused) return { [done]: false, reason: patch.refused };
      const reserved = Array.isArray(meta.reconcileReservations)
        && meta.reconcileReservations.some(target => target?.branch === branch);
      if (action === 'release' && handoff !== true && ownsClaimBranch(agent, branch)
        && !reserved) {
        // Completion can only retire a checkout if the run still owns its branch.
        const { listWorktrees } = await import('../worktreeManager.js');
        const trees = await listWorktrees(repoPath).catch(() => null);
        if (trees?.some(tree => branchOf(tree) === branch)) return { released: false, reason: 'checkout-present' };
      }
      const updated = { ...agent, metadata: { ...agent.metadata, ...patch } };
      state.agents[agentId] = updated;
      await save();
      cosEvents.emit('agent:updated', state.agents[agentId]);
      return { [done]: true, branch, repository: repoPath };
    });
  });
  // Wake completion recovery only after the ownership transaction releases its
  // locks. A picker settling its selection can unblock unrelated old claims.
  if (result[done] && wakeRecovery) cosEvents.emit('claim:ownership-changed', { agentId, repository: result.repository });
  const { repository: _repository, ...outcome } = result;
  return outcome;
}

/** Reserve a new scheduled release candidate before its branch or checkout
 * exists. The only accepted branch is server-derived from the active run ID;
 * capture locates the physical checkout through Git, never a caller path.
 * Existing/unregistered candidates intentionally cannot be adopted here.
 */
export async function updateReleaseCandidateOwnership(agentId, action, { version } = {}) {
  const done = action === 'reserve' ? 'reserved' : 'captured';
  if (!/^agent-[a-z0-9-]+$/.test(agentId) || !['reserve', 'capture'].includes(action)) return { [done]: false, reason: 'candidate-owner-invalid' };
  const branch = `codex/release-${agentId}`;
  const { cosEvents } = await import('./cosEvents.js');
  return ownershipTransaction(`release-${action}`, done, async (state, save) => {
    const agent = state.agents?.[agentId];
    if (!agent || agent.id !== agentId || agent.status !== 'running' || agent.metadata?.taskAnalysisType !== 'do-release'
      || agent.metadata.isWorktree !== false || !Number.isFinite(Date.parse(agent.startedAt))) return { [done]: false, reason: 'release-owner-unverified' };
    const repoPath = agent.sourceWorkspace || agent.metadata?.sourceWorkspace || agent.workspacePath || agent.metadata?.workspacePath;
    if (!repoPath) return { [done]: false, reason: 'ownership-unreadable' };
    return withGitMutationLifetime(async () => {
      if (action === 'reserve') {
        const { releasePreflight } = await import('../releasePreflight.js');
        const preflight = await releasePreflight({ repoPath, agentId, agents: Object.values(state.agents), version })
          .catch(() => ({ ok: false, reason: 'release-preflight-unavailable' }));
        if (!preflight.ok) return { reserved: false, reason: preflight.reason };
      }
      const prior = agent.metadata.releaseCandidate;
      if (prior && (prior.version !== 1 || prior.branch !== branch || prior.startedAt !== agent.startedAt)) return { [done]: false, reason: 'candidate-owner-conflict' };
      const other = claimCheckoutOwnerReason({ branchName: branch, sourceWorkspace: repoPath, agents: Object.values(state.agents), ignoreIds: [agentId] });
      if (other) return { [done]: false, reason: other };
      if (action === 'reserve') {
        if (prior) return { reserved: true, branch };
        const [{ listWorktrees }, { execGit }] = await Promise.all([import('../worktreeManager.js'), import('../../lib/execGit.js')]);
        const [trees, ref] = await Promise.all([listWorktrees(repoPath), execGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoPath, { ignoreExitCode: true })]);
        if (!Array.isArray(trees) || ref.exitCode !== 1 || trees.some(tree => branchOf(tree) === branch)) return { reserved: false, reason: 'candidate-branch-not-available' };
        const candidate = { version: 1, branch, startedAt: agent.startedAt, reservedAt: new Date().toISOString() };
        let lifecycle;
        try { lifecycle = advanceCandidateLifecycle(agent, 'reserved', candidate); }
        catch { return { reserved: false, reason: 'candidate-lifecycle-conflict' }; }
        state.agents[agentId] = { ...agent, metadata: { ...agent.metadata, releaseCandidate: candidate,
          ...(lifecycle && { releaseCandidateLifecycle: lifecycle }) } };
      } else {
        if (!prior) return { captured: false, reason: 'candidate-reservation-missing' };
        const { captureCompletedCheckouts } = await import('../completedCheckoutEvidence.js');
        const rows = await captureCompletedCheckouts(agent, { success: true, strict: true }).catch(() => null);
        if (rows?.filter(row => row.branch === branch).length !== 1) return { captured: false, reason: 'checkout-unavailable' };
        let lifecycle;
        try { lifecycle = advanceCandidateLifecycle(agent, 'captured', prior); }
        catch { return { captured: false, reason: 'candidate-lifecycle-conflict' }; }
        state.agents[agentId] = { ...agent, metadata: { ...agent.metadata,
          ...(lifecycle && { releaseCandidateLifecycle: lifecycle }) } };
      }
      await save();
      cosEvents.emit('agent:updated', state.agents[agentId]);
      return { [done]: true, branch };
    });
  });
}

/** The publisher reserves and captures its own separate synchronization tree. */
export async function updateReleaseSynchronizationOwnership(agentId, action) {
  const done = action === 'sync-reserve' ? 'reserved' : 'captured';
  if (!/^agent-[a-z0-9-]+$/.test(agentId) || !['sync-reserve', 'sync-capture'].includes(action)) {
    return { [done]: false, reason: 'synchronization-owner-invalid' };
  }
  const { cosEvents } = await import('./cosEvents.js');
  return ownershipTransaction(action, done, async (state, save) => {
    const agent = state.agents?.[agentId];
    const publication = agent?.metadata?.releasePublication;
    if (!agent || agent.id !== agentId || agent.status !== 'running' || agent.metadata?.taskAnalysisType !== 'do-release'
      || agent.metadata.isWorktree !== false || publication?.status !== 'verified'
      || publication.synchronizationHandoffVersion !== 2 || !/^[a-f0-9]{64}$/.test(publication.identity || '')) {
      return { [done]: false, reason: 'synchronization-owner-unverified' };
    }
    const { isInlineReleaseOwner, inlineSynchronizationBranch } = await import('../../lib/releaseSynchronization.js');
    const { readReleaseSynchronizationOutbox } = await import('../releaseSynchronizationStore.js');
    const entry = (await readReleaseSynchronizationOutbox().catch(() => null))?.publications?.[publication.identity];
    if (!entry || !entry.registeredAt || !isInlineReleaseOwner(entry, agent)) {
      return { [done]: false, reason: 'synchronization-registration-unverified' };
    }
    const branch = inlineSynchronizationBranch(publication.identity);
    const repoPath = agent.sourceWorkspace || agent.metadata.sourceWorkspace || agent.workspacePath || agent.metadata.workspacePath;
    if (!repoPath) return { [done]: false, reason: 'ownership-unreadable' };
    return withGitMutationLifetime(async () => {
      const prior = agent.metadata.releaseSynchronizationCheckout;
      if (prior && (prior.version !== 1 || prior.branch !== branch || prior.identity !== publication.identity
        || prior.startedAt !== agent.startedAt)) return { [done]: false, reason: 'synchronization-owner-conflict' };
      const other = claimCheckoutOwnerReason({ branchName: branch, sourceWorkspace: repoPath,
        agents: Object.values(state.agents), ignoreIds: [agentId] });
      if (other) return { [done]: false, reason: other };
      let resumePath;
      if (action === 'sync-reserve') {
        const { releasePreflight } = await import('../releasePreflight.js');
        const preflight = await releasePreflight({ repoPath, agentId, agents: Object.values(state.agents) })
          .catch(() => ({ ok: false, reason: 'release-preflight-unavailable' }));
        if (!preflight.ok) return { reserved: false, reason: preflight.reason };
        const [{ listWorktrees }, { execGit }] = await Promise.all([import('../worktreeManager.js'), import('../../lib/execGit.js')]);
        const [trees, ref] = await Promise.all([listWorktrees(repoPath), execGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoPath, { ignoreExitCode: true })]);
        if (!Array.isArray(trees)) return { reserved: false, reason: 'synchronization-branch-not-available' };
        const holders = trees.filter(tree => branchOf(tree) === branch);
        if (ref.exitCode === 0 && holders.length === 1 && !holders[0].locked && holders[0].path !== repoPath) {
          resumePath = holders[0].path;
        } else if (ref.exitCode !== 1 || holders.length) {
          return { reserved: false, reason: 'synchronization-branch-not-available' };
        }
        if (prior) return { reserved: true, branch, ...(resumePath && { path: resumePath }) };
        state.agents[agentId] = { ...agent, metadata: { ...agent.metadata, releaseSynchronizationCheckout: {
          version: 1, identity: publication.identity, branch, startedAt: agent.startedAt, reservedAt: new Date().toISOString(),
        } } };
      } else {
        if (!prior) return { captured: false, reason: 'synchronization-reservation-missing' };
        const { captureCompletedCheckouts } = await import('../completedCheckoutEvidence.js');
        const rows = await captureCompletedCheckouts(agent, { success: true, strict: true }).catch(() => null);
        if (rows?.filter(row => row.branch === branch).length !== 1) return { captured: false, reason: 'checkout-unavailable' };
      }
      await save();
      cosEvents.emit('agent:updated', state.agents[agentId]);
      return { [done]: true, branch, ...(resumePath && { path: resumePath }) };
    });
  });
}

/**
 * Completion hold as the reconcile classifier sees it. The classifier hands an
 * unshipped review-then-merge branch (no PR ever recorded) to a coordinator to
 * open its PR, so the recheck must not refuse that same branch on the hold the
 * classifier released. The Recheck carries no PR URL, so only an exact forge
 * read showing no open (or closed-unmerged) PR releases it: once the coordinator
 * opens one, the before-merge recheck sees it and the review hold gates the
 * merge again.
 * @returns {Promise<string|null>}
 */
async function readReconcileCompletionHold(input, deps = {}) {
  const policy = await import('../branchCompletionPolicy.js');
  const reason = await (deps.readStrictCompletionHold ?? policy.readBranchCompletionHold)(input);
  if (reason !== 'pr-completion-review-required' || input.prUrl) return reason;
  const detail = await (deps.readCompletionHoldDetail ?? policy.readBranchCompletionHoldDetail)(input);
  if (detail?.reason !== reason || detail.unshipped !== true) return reason;
  const readUnshipped = deps.readBranchUnshipped ?? (await import('../branchReconcile/forgeShipment.js')).readBranchUnshipped;
  const unshipped = await readUnshipped(input.repoPath, input.branch, { forgeAccount: input.forgeAccount ?? null }).catch(() => null);
  return unshipped === true ? null : reason;
}

/**
 * Whether a branch-reconcile worker may mutate `branch` right now. Admits only
 * when the checkout it was dispatched at still holds the branch and no live
 * owner (agent, lock, or registered/possible claim run) holds it.
 *
 * With `agentId` the admission is also an acquire: under the same lock `bind`
 * takes, the branch is recorded on that coordinator's run record, so every other
 * caller (claim `bind`, continuation, adoption, a later reconcile scan) sees a
 * live owner until the run ends or releases it. Without `agentId` the answer is
 * read-only. A named run that is not a live registered agent is refused: the
 * reservation could not be recorded.
 *
 * @param {{ appId: string, branch: string, prUrl?: string, worktreePath?: string, agentId?: string }} input
 * @param {object} [deps] - injected for tests
 * @returns {Promise<{ admitted: true }|{ admitted: false, reason: string }>}
 */
export async function checkReconcileOwnership(input, deps = {}) {
  const { appId, branch, prUrl, worktreePath, agentId } = input;
  const getAppById = deps.getAppById ?? (await import('../apps.js')).getAppById;
  const listWorktrees = deps.listWorktrees ?? (await import('../worktreeManager.js')).listWorktrees;
  const getAgents = deps.getAgents ?? readClaimOwnershipAgents;
  const readCompletionHold = deps.readCompletionHold ?? (holdInput => readReconcileCompletionHold(holdInput, deps));
  const getActiveAgentIds = deps.getActiveAgentIds ?? (await import('../agent/agentState.js')).getActiveAgentIds;
  const { buildActiveOwnerIds, resolveLiveOwnerReason } = await import('../branchRetirementDecision.js');

  const app = await getAppById(appId).catch(() => null);
  const repoPath = app?.repoPath;
  if (!repoPath) return { admitted: false, reason: 'app-unknown' };
  // The git read stays outside the lock; only the agent registry — the half a
  // concurrent bind changes — is re-read where the reservation is decided.
  const worktrees = await listWorktrees(repoPath).catch(() => null);
  const holder = Array.isArray(worktrees) ? worktrees.find(wt => branchOf(wt) === branch) || null : null;

  const admit = async () => {
    const agents = await getAgents().catch(() => null);
    if (!Array.isArray(worktrees) || !Array.isArray(agents)) return { admitted: false, reason: 'ownership-unreadable' };
    const completionHold = await readCompletionHold({ repoPath, branch, prUrl, forgeAccount: app.forgeAccount ?? null })
      .catch(() => 'pr-completion-policy-unavailable');
    if (completionHold) return { admitted: false, reason: completionHold };
    if (worktreePath && !samePath(holder?.path, worktreePath)) return { admitted: false, reason: 'holder-changed' };
    const others = agentId ? agents.filter((a) => a?.id !== agentId) : agents;
    const reason = resolveLiveOwnerReason({
      branch, path: holder?.path || null, locked: Boolean(holder?.locked),
      activeAgentIds: buildActiveOwnerIds(new Set(getActiveAgentIds().filter((id) => id !== agentId)), others),
    }) || claimCheckoutOwnerReason({ branchName: branch, holderPath: holder?.path || null, sourceWorkspace: repoPath, agents: others });
    return reason ? { admitted: false, reason } : { admitted: true };
  };
  if (!agentId || deps.reserve === false) return withGitMutationLifetime(admit)
    .catch(() => ({ admitted: false, reason: 'ownership-unreadable' }));

  const { cosEvents } = await import('./cosEvents.js');
  // Decided inside the lock a bind takes, so no bind can land between
  // "admitted" and "reserved".
  return ownershipTransaction('reserve', 'admitted', async (state, save) => withGitMutationLifetime(async () => {
    const admission = await admit();
    if (!admission.admitted) return admission;
    const agent = state.agents?.[agentId];
    if (!agent || agent.id !== agentId) return { admitted: false, reason: 'owner-unknown' };
    let reservation = null;
    if (agent.metadata?.reconcileAssignment) {
      const { getTaskById } = await import('./cosTaskStore.js');
      const task = await getTaskById(agent.taskId).catch(() => null);
      const proof = reconcileAssignedTarget(agent, task, { branch, workspacePath: holder?.path || null }, { bindCheckout: true });
      const { getOriginInfo } = await import('../../lib/gitRemote.js');
      const origin = await getOriginInfo(repoPath).catch(() => null);
      if (!proof || proof.assignment.appId !== appId || !samePath(proof.assignment.repoPath, repoPath)
        || origin?.host !== proof.assignment.origin.host || origin?.fullName !== proof.assignment.origin.fullName) {
        return { admitted: false, reason: 'reconcile-target-unverified' };
      }
      const reconcileReservations = [...(agent.metadata.reconcileReservations || []).filter(target => target.branch !== branch),
        { branch, workspacePath: proof.target.workspacePath }];
      const reservedAgent = { ...agent, metadata: { ...agent.metadata, reconcileReservations } };
      reservation = { reconcileReservations,
        reconcileMergeReservation: reconcileMergeTarget(reservedAgent, task, proof.target)?.target || null };
    }
    const patch = { ...reserveReconcileBranch(agent, branch), ...reservation };
    if (!Object.keys(patch).length) return admission;
    if (patch.refused) return { admitted: false, reason: patch.refused };
    state.agents[agentId] = { ...agent, metadata: { ...agent.metadata, ...patch } };
    await save();
    cosEvents.emit('agent:updated', state.agents[agentId]);
    return admission;
  }).catch(() => ({ admitted: false, reason: 'ownership-unreadable' })));
}

/** Read-only snapshot publication gate. Registered review work remains owned
 * even between checkouts; neither an absent process nor a missing tree releases
 * it. The safety reader must not default corrupt runtime state to an empty list.
 */
export async function checkSnapshotPublicationOwnership({ appId, branch, prUrl }, deps = {}) {
  const readAgents = deps.readAgentsStateForSafetyCheck
    || (await import('./cosState.js')).readAgentsStateForSafetyCheck;
  const snapshot = await readAgents().catch(() => null);
  if (snapshot?.trusted !== true || !snapshot.agents || typeof snapshot.agents !== 'object' || Array.isArray(snapshot.agents)) {
    return { admitted: false, reason: 'ownership-unreadable' };
  }
  const entries = Object.entries(snapshot.agents);
  if (entries.some(([id, agent]) => !agent || agent.id !== id || !['running', 'paused', 'completed'].includes(agent.status))) {
    return { admitted: false, reason: 'ownership-unreadable' };
  }
  const agents = entries.map(([, agent]) => agent);
  if (prUrl && agents.some(agent => agent.status !== 'completed'
    && agent.metadata?.reviewLoopMergeTarget?.url === prUrl
    && agent.metadata.reviewLoopMergeTarget.branch === branch)) {
    return { admitted: false, reason: 'review-owner-active' };
  }
  // Publication keeps the strict hold: the reconcile-only unshipped release
  // exists for a coordinator that opens the PR through the review workflow.
  const readCompletionHold = deps.readCompletionHold ?? (await import('../branchCompletionPolicy.js')).readBranchCompletionHold;
  return checkReconcileOwnership({ appId, branch, prUrl }, { ...deps, readCompletionHold, getAgents: async () => agents });
}

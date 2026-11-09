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
import { bindClaimBranch, releaseClaimBranch, reserveReconcileBranch, reconcileAssignedTarget, reconcileMergeTarget, claimCheckoutOwnerReason, ownsClaimBranch } from '../lib/claimContinuation.js';
import { isTruthyMeta } from '../lib/metadataFlags.js';
import { advanceCandidateLifecycle } from './releaseCandidateLifecycle.js';

import { withClaimOwnershipLock, readClaimOwnershipAgents, checkoutRetirementFenceReason } from './cosClaimOwnershipState.js';

const normalize = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && normalize(a) === normalize(b);
const branchOf = (wt) => String(wt?.branch || '').replace(/^refs\/heads\//, '');

export { withClaimOwnershipLock, readClaimOwnershipAgents, checkoutRetirementFenceReason, reserveCheckoutRetirementFence, retireWithUnlockedArchive } from './cosClaimOwnershipState.js';

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

// Whether nothing local or on origin still carries `branch`: no worktree, no
// local ref and (with `remote`) no origin head. Every unreadable answer is
// "still present". An open PR needs its origin head and unpushed work its
// local ref, so an absent branch has no delivery left to protect.
async function claimBranchArtifactsGone(repoPath, branch, { remote = true } = {}) {
  const [{ listWorktrees }, { readLocalBranchPresence }, { execGit }] = await Promise.all([
    import('./worktreeManager.js'), import('./repoCleanupObservation.js'), import('../lib/execGit.js')]);
  const trees = await listWorktrees(repoPath).catch(() => null);
  if (!Array.isArray(trees) || trees.some(tree => branchOf(tree) === branch)) return false;
  if (await readLocalBranchPresence(repoPath, branch).catch(() => null) !== false) return false;
  if (!remote) return true;
  // `--exit-code` answers 2 only for "no such ref"; any other failure proves nothing.
  const listed = await execGit(['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`], repoPath, { ignoreExitCode: true })
    .catch(() => null);
  return listed?.exitCode === 2;
}

// Live runs other than `agent` (and its predecessor) whose binding of
// `branch` outlived the delivery (#15459): each recorded a physical checkout
// of it (a seed) and every recorded checkout path is gone. A binding with no
// seed may name a checkout about to be cut, so it stays an owner. Null when a
// holder does not qualify — the bind then keeps its `owner-active` refusal.
async function retiredBranchHolders(state, agent, branch, repoPath) {
  const { readCheckoutPathPresence } = await import('./repoCleanupObservation.js');
  const ignore = new Set([agent.id, agent.metadata?.resumedFromAgentId].filter(Boolean));
  const holders = Object.values(state.agents).filter(other => other && !ignore.has(other.id)
    && (other.status === 'running' || other.status === 'paused') && ownsClaimBranch(other, branch)
    && samePath(agentRepoPath(other), repoPath));
  for (const holder of holders) {
    const seeds = (holder.metadata?.checkoutSeeds || []).filter(seed => seed?.branch === branch);
    if (!seeds.length || seeds.some(seed => typeof seed.path !== 'string' || !seed.path)) return null;
    for (const seed of seeds) if (await readCheckoutPathPresence(seed.path) !== false) return null;
  }
  return holders.length ? holders : null;
}

/**
 * A bind refused only because live runs still hold a branch whose checkout they
 * retired takes the name from them in the same transaction. Bound runs are
 * told to release on delivery; this keeps a run that forgot from stranding the
 * name until it ends.
 */
async function bindOverRetiredHolders(state, agent, branch, repoPath) {
  const holders = await retiredBranchHolders(state, agent, branch, repoPath);
  if (!holders || !await claimBranchArtifactsGone(repoPath, branch, { remote: false })) return null;
  const released = [];
  for (const holder of holders) {
    const patch = releaseClaimBranch(holder, branch);
    if (patch.refused) return null;
    released.push({ ...holder, metadata: { ...holder.metadata, ...patch } });
  }
  const agents = { ...state.agents, ...Object.fromEntries(released.map(holder => [holder.id, holder])) };
  const patch = bindClaimBranch(agent, branch, Object.values(agents));
  return patch.refused ? null : { patch, released };
}

/**
 * @param {{ agentId: string, action: 'bind'|'release', branch: string }} input
 * @returns {Promise<{ bound: true, branch: string }|{ released: true, branch: string }|{ bound?: false, released?: false, reason: string }>}
 */
export async function updateClaimOwnership({ agentId, action, branch }) {
  const done = action === 'bind' ? 'bound' : 'released';
  const { cosEvents } = await import('./cosEvents.js');
  let wakeRecovery = false;
  let repository;
  const attempt = retiredRemoteGone => ownershipTransaction(action === 'bind' ? 'bind' : 'release', done, async (state, save) => {
    const agent = state.agents?.[agentId];
    if (!agent || agent.id !== agentId) return { [done]: false, reason: 'owner-unknown' };
    const repoPath = agentRepoPath(agent);
    if (!repoPath) return { [done]: false, reason: 'ownership-unreadable' };
    repository = repoPath;
    const meta = agent.metadata || {};
    const released = meta.claimReleasedBranches ?? agent.claimReleasedBranches ?? [];
    const bound = meta.claimBranches ?? agent.claimBranches ?? [];
    wakeRecovery = action === 'release' ? !released.includes(branch)
      : isTruthyMeta(agent.claimSelectionPending ?? meta.claimSelectionPending)
        || (isTruthyMeta(agent.claimPicksOwnBranch ?? meta.claimPicksOwnBranch) && !bound.length && !released.length);
    // Binding a checkout that is mid-archive would hand it to a run that the
    // retirement then removes; releasing a branch never needs the fence.
    const fenced = action === 'bind' && checkoutRetirementFenceReason({ repoPath, branch });
    if (fenced) return { [done]: false, reason: fenced };
    const { withCheckoutPublication } = await import('../lib/checkoutRetirementAdmission.js');
    return withCheckoutPublication(repoPath, async () => {
      let patch = action === 'bind' ? bindClaimBranch(agent, branch, Object.values(state.agents)) : releaseClaimBranch(agent, branch);
      let released = [];
      if (patch.refused === 'owner-active' && retiredRemoteGone) {
        const taken = await bindOverRetiredHolders(state, agent, branch, repoPath);
        if (taken) ({ patch, released } = taken);
      }
      if (patch.refused) return { [done]: false, reason: patch.refused };
      const updated = { ...agent, metadata: { ...agent.metadata, ...patch } };
      if (action === 'bind') {
        const { captureCheckoutSeeds, supersedeReleasedCheckoutSeed } = await import('./completedCheckoutEvidence.js');
        // Judged on the pre-bind record: the bind patch drops the release mark.
        Object.assign(updated.metadata, await supersedeReleasedCheckoutSeed(agent, branch));
        try { updated.metadata.checkoutSeeds = await captureCheckoutSeeds(updated); }
        catch { return { [done]: false, reason: 'checkout-seed-unavailable' }; }
      }
      for (const holder of released) state.agents[holder.id] = holder;
      state.agents[agentId] = updated;
      await save();
      for (const holder of released) {
        console.log(`🔓 Claim ownership: ${holder.id} retired ${branch}; released its binding for ${agentId}`);
        cosEvents.emit('agent:updated', holder);
      }
      cosEvents.emit('agent:updated', state.agents[agentId]);
      return { [done]: true, branch };
    }).catch(error => {
      if (error.code === 'CHECKOUT_RETIREMENT_RESERVED') return { [done]: false, reason: 'checkout-retirement-reserved' };
      throw error;
    });
  });
  let result = await attempt(false);
  // The origin read is network I/O, so it runs outside both locks and only for
  // a bind another live run refused; the retry rechecks everything local.
  if (action === 'bind' && result.reason === 'owner-active' && repository
    && await claimBranchArtifactsGone(repository, branch)) result = await attempt(true);
  // Wake completion recovery only after the ownership transaction releases its
  // locks. A picker settling its selection can unblock unrelated old claims.
  if (result[done] && wakeRecovery) cosEvents.emit('claim:ownership-changed', { agentId, repository });
  return result;
}

/** Reserve a new scheduled release candidate before its branch or checkout
 * exists. The only accepted branch is server-derived from the active run ID;
 * capture locates the physical checkout through Git, never a caller path.
 * Existing/unregistered candidates intentionally cannot be adopted here.
 */
export async function updateReleaseCandidateOwnership(agentId, action) {
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
    if (checkoutRetirementFenceReason({ repoPath, branch })) return { [done]: false, reason: 'checkout-retirement-reserved' };
    const { withCheckoutPublication } = await import('../lib/checkoutRetirementAdmission.js');
    return withCheckoutPublication(repoPath, async () => {
      if (agent.metadata.releaseCandidateRecovery || agent.metadata.resumedFromAgentId) return { [done]: false, reason: 'candidate-recovery-required' };
      const prior = agent.metadata.releaseCandidate;
      if (prior && (prior.version !== 1 || prior.branch !== branch || prior.startedAt !== agent.startedAt)) return { [done]: false, reason: 'candidate-owner-conflict' };
      const other = claimCheckoutOwnerReason({ branchName: branch, sourceWorkspace: repoPath, agents: Object.values(state.agents), ignoreIds: [agentId] });
      if (other) return { [done]: false, reason: other };
      if (action === 'reserve') {
        if (prior) return { reserved: true, branch };
        const [{ listWorktrees }, { execGit }] = await Promise.all([import('./worktreeManager.js'), import('../lib/execGit.js')]);
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
        const { captureCheckoutSeeds } = await import('./completedCheckoutEvidence.js');
        let seeds;
        try { seeds = await captureCheckoutSeeds(agent, { allowUncreated: false }); }
        catch { return { captured: false, reason: 'checkout-seed-unavailable' }; }
        if (seeds.length !== 1 || seeds[0].agentId !== agentId || seeds[0].startedAt !== agent.startedAt
          || seeds[0].branch !== branch) return { captured: false, reason: 'checkout-seed-unavailable' };
        let lifecycle;
        try { lifecycle = advanceCandidateLifecycle(agent, 'captured', prior); }
        catch { return { captured: false, reason: 'candidate-lifecycle-conflict' }; }
        state.agents[agentId] = { ...agent, metadata: { ...agent.metadata, checkoutSeeds: seeds,
          ...(lifecycle && { releaseCandidateLifecycle: lifecycle }) } };
      }
      await save();
      cosEvents.emit('agent:updated', state.agents[agentId]);
      return { [done]: true, branch };
    }).catch(error => {
      if (error.code === 'CHECKOUT_RETIREMENT_RESERVED') return { [done]: false, reason: 'checkout-retirement-reserved' };
      throw error;
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
    const { isInlineReleaseOwner, publisherCandidateSeed } = await import('../lib/releaseSynchronization.js');
    if (!publisherCandidateSeed({ publication, owner: { agentId, taskId: agent.taskId, startedAt: agent.startedAt },
      checkouts: agent.metadata.checkoutSeeds || [] })) return { [done]: false, reason: 'candidate-checkout-unverified' };
    const { readReleaseSynchronizationOutbox } = await import('./releaseSynchronizationStore.js');
    const entry = (await readReleaseSynchronizationOutbox().catch(() => null))?.publications?.[publication.identity];
    if (!entry || !entry.registeredAt || !isInlineReleaseOwner(entry, agent)) {
      return { [done]: false, reason: 'synchronization-registration-unverified' };
    }
    const branch = `codex/release-sync-${publication.identity}`;
    const repoPath = agent.sourceWorkspace || agent.metadata.sourceWorkspace || agent.workspacePath || agent.metadata.workspacePath;
    if (!repoPath) return { [done]: false, reason: 'ownership-unreadable' };
    if (checkoutRetirementFenceReason({ repoPath, branch })) return { [done]: false, reason: 'checkout-retirement-reserved' };
    const { withCheckoutPublication } = await import('../lib/checkoutRetirementAdmission.js');
    return withCheckoutPublication(repoPath, async () => {
      const prior = agent.metadata.releaseSynchronizationCheckout;
      if (prior && (prior.version !== 1 || prior.branch !== branch || prior.identity !== publication.identity
        || prior.startedAt !== agent.startedAt)) return { [done]: false, reason: 'synchronization-owner-conflict' };
      const other = claimCheckoutOwnerReason({ branchName: branch, sourceWorkspace: repoPath,
        agents: Object.values(state.agents), ignoreIds: [agentId] });
      if (other) return { [done]: false, reason: other };
      if (action === 'sync-reserve') {
        if (prior) return { reserved: true, branch };
        const [{ listWorktrees }, { execGit }] = await Promise.all([import('./worktreeManager.js'), import('../lib/execGit.js')]);
        const [trees, ref] = await Promise.all([listWorktrees(repoPath), execGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoPath, { ignoreExitCode: true })]);
        if (!Array.isArray(trees) || ref.exitCode !== 1 || trees.some(tree => branchOf(tree) === branch)) {
          return { reserved: false, reason: 'synchronization-branch-not-available' };
        }
        state.agents[agentId] = { ...agent, metadata: { ...agent.metadata, releaseSynchronizationCheckout: {
          version: 1, identity: publication.identity, branch, startedAt: agent.startedAt, reservedAt: new Date().toISOString(),
        } } };
      } else {
        if (!prior) return { captured: false, reason: 'synchronization-reservation-missing' };
        const { captureCheckoutSeeds } = await import('./completedCheckoutEvidence.js');
        let seeds;
        try { seeds = await captureCheckoutSeeds(agent, { allowUncreated: false }); }
        catch { return { captured: false, reason: 'checkout-seed-unavailable' }; }
        if (seeds.filter(seed => seed.branch === branch && seed.agentId === agentId && seed.startedAt === agent.startedAt).length !== 1) {
          return { captured: false, reason: 'checkout-seed-unavailable' };
        }
        state.agents[agentId] = { ...agent, metadata: { ...agent.metadata, checkoutSeeds: seeds } };
      }
      await save();
      cosEvents.emit('agent:updated', state.agents[agentId]);
      return { [done]: true, branch };
    }).catch(error => {
      if (error.code === 'CHECKOUT_RETIREMENT_RESERVED') return { [done]: false, reason: 'checkout-retirement-reserved' };
      throw error;
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
  const policy = await import('./branchCompletionPolicy.js');
  const reason = await (deps.readStrictCompletionHold ?? policy.readBranchCompletionHold)(input);
  if (reason !== 'pr-completion-review-required' || input.prUrl) return reason;
  const detail = await (deps.readCompletionHoldDetail ?? policy.readBranchCompletionHoldDetail)(input);
  if (detail?.reason !== reason || detail.unshipped !== true) return reason;
  const readUnshipped = deps.readBranchUnshipped ?? (await import('./branchReconcile.js')).readBranchUnshipped;
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
  const getAppById = deps.getAppById ?? (await import('./apps.js')).getAppById;
  const listWorktrees = deps.listWorktrees ?? (await import('./worktreeManager.js')).listWorktrees;
  const getAgents = deps.getAgents ?? readClaimOwnershipAgents;
  const readCompletionHold = deps.readCompletionHold ?? (holdInput => readReconcileCompletionHold(holdInput, deps));
  const getActiveAgentIds = deps.getActiveAgentIds ?? (await import('./agentState.js')).getActiveAgentIds;
  const { buildActiveOwnerIds, resolveLiveOwnerReason } = await import('./branchReconcile.js');

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
    const fenced = checkoutRetirementFenceReason({ repoPath, branch, path: holder?.path || null });
    if (fenced) return { admitted: false, reason: fenced };
    const others = agentId ? agents.filter((a) => a?.id !== agentId) : agents;
    const reason = resolveLiveOwnerReason({
      branch, path: holder?.path || null, locked: Boolean(holder?.locked),
      activeAgentIds: buildActiveOwnerIds(new Set(getActiveAgentIds().filter((id) => id !== agentId)), others),
    }) || claimCheckoutOwnerReason({ branchName: branch, holderPath: holder?.path || null, sourceWorkspace: repoPath, agents: others });
    return reason ? { admitted: false, reason } : { admitted: true };
  };
  const { withCheckoutPublication } = await import('../lib/checkoutRetirementAdmission.js');
  if (!agentId || deps.reserve === false) return withCheckoutPublication(repoPath, admit)
    .catch(() => ({ admitted: false, reason: 'checkout-retirement-reserved' }));

  const { cosEvents } = await import('./cosEvents.js');
  // Decided inside the lock a bind takes, so no bind can land between
  // "admitted" and "reserved".
  return ownershipTransaction('reserve', 'admitted', async (state, save) => withCheckoutPublication(repoPath, async () => {
    const admission = await admit();
    if (!admission.admitted) return admission;
    const agent = state.agents?.[agentId];
    if (!agent || agent.id !== agentId) return { admitted: false, reason: 'owner-unknown' };
    let reservation = null;
    if (agent.metadata?.reconcileAssignment) {
      const { getTaskById } = await import('./cosTaskStore.js');
      const task = await getTaskById(agent.taskId).catch(() => null);
      const proof = reconcileAssignedTarget(agent, task, { branch, workspacePath: holder?.path || null }, { bindCheckout: true });
      const { getOriginInfo } = await import('../lib/gitRemote.js');
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
  }).catch(() => ({ admitted: false, reason: 'checkout-retirement-reserved' })));
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
  const readCompletionHold = deps.readCompletionHold ?? (await import('./branchCompletionPolicy.js')).readBranchCompletionHold;
  return checkReconcileOwnership({ appId, branch, prUrl }, { ...deps, readCompletionHold, getAgents: async () => agents });
}

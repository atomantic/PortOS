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
import { bindClaimBranch, releaseClaimBranch, reserveReconcileBranch, claimCheckoutOwnerReason } from '../lib/claimContinuation.js';

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

async function ownershipTransaction(operation, done, work) {
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

/**
 * @param {{ agentId: string, action: 'bind'|'release', branch: string }} input
 * @returns {Promise<{ bound: true, branch: string }|{ released: true, branch: string }|{ bound?: false, released?: false, reason: string }>}
 */
export async function updateClaimOwnership({ agentId, action, branch }) {
  const done = action === 'bind' ? 'bound' : 'released';
  const { cosEvents } = await import('./cosEvents.js');
  return ownershipTransaction(action === 'bind' ? 'bind' : 'release', done, async (state, save) => {
    const agent = state.agents?.[agentId];
    if (!agent || agent.id !== agentId) return { [done]: false, reason: 'owner-unknown' };
    const patch = action === 'bind' ? bindClaimBranch(agent, branch, Object.values(state.agents)) : releaseClaimBranch(agent, branch);
    if (patch.refused) return { [done]: false, reason: patch.refused };
    state.agents[agentId] = { ...agent, metadata: { ...agent.metadata, ...patch } };
    await save();
    cosEvents.emit('agent:updated', state.agents[agentId]);
    return { [done]: true, branch };
  });
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
  const readCompletionHold = deps.readCompletionHold ?? (await import('./branchCompletionPolicy.js')).readBranchCompletionHold;
  const getActiveAgentIds = deps.getActiveAgentIds ?? (await import('./agentState.js')).getActiveAgentIds;
  const { buildActiveOwnerIds, resolveLiveOwnerReason } = await import('./branchReconcile.js');

  const app = await getAppById(appId).catch(() => null);
  const repoPath = app?.repoPath;
  if (!repoPath) return { admitted: false, reason: 'app-unknown' };
  // The git read stays outside the lock; only the agent registry — the half a
  // concurrent bind changes — is re-read where the reservation is decided.
  const worktrees = await listWorktrees(repoPath).catch(() => null);

  const admit = async () => {
    const agents = await getAgents().catch(() => null);
    if (!Array.isArray(worktrees) || !Array.isArray(agents)) return { admitted: false, reason: 'ownership-unreadable' };
    const completionHold = await readCompletionHold({ repoPath, branch, prUrl }).catch(() => 'pr-completion-policy-unavailable');
    if (completionHold) return { admitted: false, reason: completionHold };
    const holder = worktrees.find((wt) => branchOf(wt) === branch) || null;
    if (worktreePath && !samePath(holder?.path, worktreePath)) return { admitted: false, reason: 'holder-changed' };
    const others = agentId ? agents.filter((a) => a?.id !== agentId) : agents;
    const reason = resolveLiveOwnerReason({
      branch, path: holder?.path || null, locked: Boolean(holder?.locked),
      activeAgentIds: buildActiveOwnerIds(getActiveAgentIds().filter((id) => id !== agentId), others),
    }) || claimCheckoutOwnerReason({ branchName: branch, holderPath: holder?.path || null, sourceWorkspace: repoPath, agents: others });
    return reason ? { admitted: false, reason } : { admitted: true };
  };
  if (!agentId) return admit();

  const { cosEvents } = await import('./cosEvents.js');
  // Decided inside the lock a bind takes, so no bind can land between
  // "admitted" and "reserved".
  return ownershipTransaction('reserve', 'admitted', async (state, save) => {
    const admission = await admit();
    if (!admission.admitted) return admission;
    const agent = state.agents?.[agentId];
    if (!agent || agent.id !== agentId) return { admitted: false, reason: 'owner-unknown' };
    const patch = reserveReconcileBranch(agent, branch);
    if (!patch) return admission;
    if (patch.refused) return { admitted: false, reason: patch.refused };
    state.agents[agentId] = { ...agent, metadata: { ...agent.metadata, ...patch } };
    await save();
    cosEvents.emit('agent:updated', state.agents[agentId]);
    return admission;
  });
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
  return checkReconcileOwnership({ appId, branch, prUrl }, { ...deps, getAgents: async () => agents });
}

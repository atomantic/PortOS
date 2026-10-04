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

const normalize = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && normalize(a) === normalize(b);
const branchOf = (wt) => String(wt?.branch || '').replace(/^refs\/heads\//, '');

// One in-process tail shared by binding and branch-reconcile's retirement, so a
// bind cannot land between cleanup's ownership re-read and its removal.
let ownershipTail = Promise.resolve();
export function withClaimOwnershipLock(work) {
  const run = ownershipTail.then(work, work);
  ownershipTail = run.catch(() => {});
  return run;
}

/**
 * @param {{ agentId: string, action: 'bind'|'release', branch: string }} input
 * @returns {Promise<{ bound: true, branch: string }|{ released: true, branch: string }|{ bound?: false, released?: false, reason: string }>}
 */
export async function updateClaimOwnership({ agentId, action, branch }) {
  const done = action === 'bind' ? 'bound' : 'released';
  const { withStateLock, loadState, saveState } = await import('./cosState.js');
  const { cosEvents } = await import('./cosEvents.js');
  return withClaimOwnershipLock(() => withStateLock(async () => {
    const state = await loadState();
    const agent = state.agents?.[agentId];
    if (!agent || agent.id !== agentId) return { [done]: false, reason: 'owner-unknown' };
    const patch = action === 'bind' ? bindClaimBranch(agent, branch, Object.values(state.agents)) : releaseClaimBranch(agent, branch);
    if (patch.refused) return { [done]: false, reason: patch.refused };
    state.agents[agentId] = { ...agent, metadata: { ...agent.metadata, ...patch } };
    await saveState(state);
    cosEvents.emit('agent:updated', state.agents[agentId]);
    console.log(`🔒 Claim ownership ${done}: ${branch} → ${agentId}`);
    return { [done]: true, branch };
  }));
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
 * @param {{ appId: string, branch: string, worktreePath?: string, agentId?: string }} input
 * @param {object} [deps] - injected for tests
 * @returns {Promise<{ admitted: true }|{ admitted: false, reason: string }>}
 */
export async function checkReconcileOwnership(input, deps = {}) {
  const { appId, branch, worktreePath, agentId } = input;
  const getAppById = deps.getAppById ?? (await import('./apps.js')).getAppById;
  const listWorktrees = deps.listWorktrees ?? (await import('./worktreeManager.js')).listWorktrees;
  const getAgents = deps.getAgents ?? (await import('./cosAgentLifecycle.js')).getAgents;
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

  const { withStateLock, loadState, saveState } = await import('./cosState.js');
  const { cosEvents } = await import('./cosEvents.js');
  // Decided inside the lock a bind takes, so no bind can land between
  // "admitted" and "reserved".
  return withClaimOwnershipLock(() => withStateLock(async () => {
    const admission = await admit();
    if (!admission.admitted) return admission;
    const state = await loadState();
    const agent = state.agents?.[agentId];
    if (!agent || agent.id !== agentId) return { admitted: false, reason: 'owner-unknown' };
    const patch = reserveReconcileBranch(agent, branch);
    if (!patch) return admission;
    if (patch.refused) return { admitted: false, reason: patch.refused };
    state.agents[agentId] = { ...agent, metadata: { ...agent.metadata, ...patch } };
    await saveState(state);
    cosEvents.emit('agent:updated', state.agents[agentId]);
    console.log(`🔒 Reconcile reservation: ${branch} → ${agentId}`);
    return admission;
  }));
}

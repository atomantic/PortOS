/**
 * Claim-flow relaunch — continue the worktree the previous run of this task
 * already created, instead of treating that claim as someone else's.
 *
 * A claim agent cuts `claim/issue-<n>` (or `claim/<key>`) itself, under
 * `data/cos/worktrees/claim-*`, and stamps `in-progress`. PortOS does not own
 * that directory as an `agent-*` worktree, so a provider relaunch used to
 * requeue onto a clean checkout. The replacement then followed the claim
 * prompt's "already in progress / already on this branch → exit" rule and
 * abandoned the work the user asked it to finish.
 *
 * The pointer stays on the claim directory. Moving it to `agent-<id>` would
 * break the claim prompt's own path and the claim-shaped reaper. Pure: the
 * git listing and the agent list stay with the caller.
 */

import { resolve } from 'path';
import { isPathInsideDir } from './pathSafety.js';
import { isHumanClaimWorktree, worktreeAgentId } from './worktreeOwnership.js';
import { isTruthyMeta } from './metadataFlags.js';

const CASE_FOLD = process.platform === 'win32';

/** Branch a pinned claim target checks out, or null when the ref is not a claim name. */
export function claimContinuationBranch(claimTarget) {
  const ref = String(claimTarget ?? '').trim();
  if (!ref || ref.length > 80) return null;
  if (/^\d+$/.test(ref)) return `claim/issue-${ref}`;
  if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(ref)) return `claim/${ref}`;
  if (/^[a-z0-9][a-z0-9-]*$/i.test(ref)) return `claim/${ref}`;
  return null;
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const left = resolve(a);
  const right = resolve(b);
  return CASE_FOLD ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * The claim ownership a claim-flow run registers on its agent record. PortOS does
 * not provision the `claim-*` directory the agent cuts, so `workspacePath` never
 * names it; the branch is the only identity both sides know:
 *   - a run pinned to a target owns exactly `claim/…` for that target;
 *   - an unpinned run (the issue picker, including a swarm orchestrator whose
 *     fan-out children cut their own trees) owns a branch it chooses later, so
 *     it is registered as possibly owning ANY claim branch in its repository
 *     until it binds the concrete ones (`bindClaimBranch`).
 * Null for a task that is not a claim flow. Pure.
 *
 * @returns {{ claimBranch: string|null, claimPicksOwnBranch: boolean, claimSelectionPending?: true }|null}
 */
export function claimOwnershipBinding(task) {
  if (!isTruthyMeta(task?.metadata?.claimFlow)) return null;
  const claimBranch = claimContinuationBranch(task?.metadata?.claimTarget);
  // A pinned run may still check out a DIFFERENT branch: a pinned tracking epic
  // ships its first eligible child, and an oversized issue is split and its
  // first slice shipped. Until the run binds the branch it actually works on
  // (`bindClaimBranch`), it may own any claim tree in its repository.
  return { claimBranch, claimPicksOwnBranch: !claimBranch, ...(claimBranch ? { claimSelectionPending: true } : {}) };
}

/** A branch a claim run may bind to itself: `claim/…` or slashdo's `next/…`. */
export function isClaimOwnershipBranch(name) {
  const branch = String(name ?? '');
  return branch.length <= 200 && /^(claim|next)\/[A-Za-z0-9._/-]+$/.test(branch)
    && !branch.includes('..') && !branch.endsWith('/') && !branch.endsWith('.lock');
}

const ownershipList = (agent, key) => {
  const list = agent?.metadata?.[key] ?? agent?.[key];
  return Array.isArray(list) ? list.filter((b) => typeof b === 'string') : [];
};

/** Most branches one run may hold bound at once — a swarm binds one per child. */
export const MAX_BOUND_CLAIM_BRANCHES = 50;

/**
 * The metadata patch that binds `branch` to a running claim run: the concrete
 * branch it is about to check out (the pinned target, an epic's child, a split
 * slice, or the issue a picker selected). The first binding settles the run's
 * open selection (see `mayPickClaimBranch`). `{ refused }` when the record is
 * not a live claim run, the branch is not claim-shaped, another live run in
 * `agents` already owns it, or the bound list is full. Pure.
 *
 * @returns {{ claimBranches: string[], claimReleasedBranches: string[], claimSelectionPending: false }|{ refused: string }}
 */
export function bindClaimBranch(agent, branch, agents = []) {
  const refused = bindingRefusal(agent, branch);
  if (refused) return { refused };
  // Another live run in this repository already owns the branch: binding it too
  // would hand both runs the same checkout. A predecessor this run continues is
  // not a rival. A merely POSSIBLE owner (a picker that has not bound) does not
  // refuse — git refuses a second checkout of one branch on its own.
  const occupancy = claimHolderOccupancy({
    agents, holderPath: null, branchName: branch, sourceWorkspace: agentRepository(agent),
    ignoreIds: new Set([agent.id, agent.metadata?.resumedFromAgentId].filter(Boolean)),
  });
  if (occupancy === 'active') return { refused: 'owner-active' };
  const bound = ownershipList(agent, 'claimBranches');
  if (!bound.includes(branch) && bound.length >= MAX_BOUND_CLAIM_BRANCHES) return { refused: 'too-many-branches' };
  return {
    claimBranches: bound.includes(branch) ? bound : [...bound, branch],
    claimReleasedBranches: ownershipList(agent, 'claimReleasedBranches').filter((b) => b !== branch),
    claimSelectionPending: false,
  };
}

/**
 * The metadata patch that explicitly releases `branch` from a running claim run
 * that is handing it to somebody else before the run ends. Completion of the run
 * releases everything without this. `{ refused }` on the same conditions as
 * `bindClaimBranch`. Pure.
 */
export function releaseClaimBranch(agent, branch) {
  const refused = bindingRefusal(agent, branch);
  if (refused) return { refused };
  const released = ownershipList(agent, 'claimReleasedBranches');
  return {
    claimBranches: ownershipList(agent, 'claimBranches').filter((b) => b !== branch),
    claimReleasedBranches: released.includes(branch) ? released : [...released, branch].slice(-MAX_BOUND_CLAIM_BRANCHES),
  };
}

// Only a live claim run may change its own bindings, and only for a claim branch.
function bindingRefusal(agent, branch) {
  if (!isLiveAgent(agent)) return 'owner-not-running';
  const claimRun = Boolean(registeredClaimBranch(agent)) || isTruthyMeta(agent?.claimPicksOwnBranch ?? agent?.metadata?.claimPicksOwnBranch);
  if (!claimRun) return 'claim-owner-unverified';
  return isClaimOwnershipBranch(branch) ? null : 'branch-invalid';
}

function isLiveAgent(agent) {
  return agent?.status === 'running' || agent?.status === 'paused';
}

function agentWorkspace(agent) {
  return agent.workspacePath || agent.metadata?.workspacePath;
}

function agentRepository(agent) {
  return agent.sourceWorkspace || agent.metadata?.sourceWorkspace || agentWorkspace(agent);
}

// Conservative: an agent whose repository cannot be read is treated as being in
// this one, because the alternative is to wave a possible owner through.
function inRepository(agent, sourceWorkspace) {
  const repository = agentRepository(agent);
  return !repository || !sourceWorkspace || samePath(repository, sourceWorkspace);
}

function registeredClaimBranch(agent) {
  return agent?.claimBranch ?? agent?.metadata?.claimBranch;
}

// Every branch the run registered — its pinned target plus each branch it bound
// — minus the ones it explicitly released.
function ownsClaimBranch(agent, branchName) {
  if (ownershipList(agent, 'claimReleasedBranches').includes(branchName)) return false;
  return registeredClaimBranch(agent) === branchName || ownershipList(agent, 'claimBranches').includes(branchName);
}

// A run that may hold a claim checkout nobody can name yet: a picker until it
// binds its first branch, a pinned run until it binds the branch it actually
// works on. The claim prompt binds every branch BEFORE its worktree exists, so
// once a run has bound one, each tree it cuts is named — releasing it later
// does not reopen the selection. A run that never binds (an older prompt, a
// provider that cannot curl) stays possible owner of every claim tree in its
// repository until it ends, except a branch it explicitly released.
function mayPickClaimBranch(agent, branchName) {
  if (ownershipList(agent, 'claimReleasedBranches').includes(branchName)) return false;
  if (isTruthyMeta(agent?.claimSelectionPending ?? agent?.metadata?.claimSelectionPending)) return true;
  return isTruthyMeta(agent?.claimPicksOwnBranch ?? agent?.metadata?.claimPicksOwnBranch)
    && ownershipList(agent, 'claimBranches').length === 0
    && ownershipList(agent, 'claimReleasedBranches').length === 0;
}

/**
 * Whether a running or paused agent other than `ignoreIds` holds, or may hold,
 * the claim checkout:
 *   - `active`: it works inside the directory, or registered or bound this
 *     exact branch in this repository (and has not released it);
 *   - `ambiguous`: it is a claim run that picks its own branch, or a pinned run
 *     that has not yet bound the branch it works on, in this same repository,
 *     so it might be the one that cut this tree — unprovable from the registry
 *     alone.
 * `active` outranks `ambiguous` across the whole list.
 *
 * @returns {'active'|'ambiguous'|null}
 */
function claimHolderOccupancy({ agents, holderPath, branchName, sourceWorkspace, ignoreIds }) {
  let ambiguous = false;
  const claimHolder = /^(claim|next)\//.test(branchName) || isHumanClaimWorktree(worktreeAgentId(holderPath));
  for (const agent of agents) {
    if (!agent || ignoreIds.has(agent.id) || !isLiveAgent(agent)) continue;
    const workspace = agentWorkspace(agent);
    if (samePath(workspace, holderPath) || (holderPath && workspace && isPathInsideDir(holderPath, workspace))) return 'active';
    if (!inRepository(agent, sourceWorkspace)) continue;
    if (ownsClaimBranch(agent, branchName)) return 'active';
    if (claimHolder && mayPickClaimBranch(agent, branchName)) ambiguous = true;
  }
  return ambiguous ? 'ambiguous' : null;
}

/**
 * The claim worktree this task's previous run left on its own branch, when
 * PortOS may hand it to the relaunch. Null when there is nothing to continue:
 * not a claim task, no pinned target, no holder, a lock, a tree outside the
 * claim root, or another live or paused agent already working in that directory.
 *
 * @param {{
 *   task: object,
 *   agentId: string,
 *   worktrees?: Array<{path?: string, branch?: string, locked?: boolean, prunable?: boolean}>,
 *   agents?: Array<{id?: string, status?: string, workspacePath?: string, metadata?: object}>,
 *   worktreesRoot: string,
 *   sourceWorkspace?: string,
 * }} input
 * @returns {{ existingBranch: string, resumedFromAgentId: string, resumeWorktreePath: string, claimResumeInPlace: true }|null}
 */
export function claimContinuationPointer({ task, agentId, worktrees = [], agents = [], worktreesRoot, sourceWorkspace }) {
  if (task?.metadata?.claimFlow !== true && task?.metadata?.claimFlow !== 'true') return null;
  const branchName = claimContinuationBranch(task?.metadata?.claimTarget);
  if (!branchName || !agentId || !worktreesRoot) return null;
  if (!Array.isArray(agents)) return null;

  const holder = worktrees.find((wt) => {
    const branch = String(wt?.branch || '').replace(/^refs\/heads\//, '');
    return branch === branchName && wt?.path && !wt.locked && !wt.prunable;
  });
  if (!holder) return null;
  if (!isHumanClaimWorktree(worktreeAgentId(holder.path))) return null;
  if (!isPathInsideDir(worktreesRoot, holder.path)) return null;

  // Only a definite owner withholds the pointer. A possible one (a picker run
  // in the same repository) is left to `claimContinuationAdmission`, which sees
  // the checkout's activity at the moment of launch.
  const occupancy = claimHolderOccupancy({
    agents, holderPath: holder.path, branchName, sourceWorkspace, ignoreIds: new Set([agentId]),
  });
  if (occupancy === 'active') return null;

  return {
    existingBranch: branchName,
    resumedFromAgentId: agentId,
    resumeWorktreePath: holder.path,
    claimResumeInPlace: true,
  };
}

/**
 * Workspace a relaunch should use when the claim pointer is still valid on
 * disk. Null sends the caller down the ordinary prep path.
 *
 * @param {{ metadata?: object, pathExists?: (path: string) => boolean, worktreesRoot: string }} input
 */
export function claimContinuationWorkspace({ metadata, pathExists = () => false, worktreesRoot }) {
  if (metadata?.claimResumeInPlace !== true && metadata?.claimResumeInPlace !== 'true') return null;
  const worktreePath = metadata?.resumeWorktreePath;
  const branchName = metadata?.existingBranch;
  if (!worktreePath || !branchName || !worktreesRoot) return null;
  if (!isHumanClaimWorktree(worktreeAgentId(worktreePath))) return null;
  if (!isPathInsideDir(worktreesRoot, worktreePath)) return null;
  if (!pathExists(worktreePath)) return null;
  return {
    workspacePath: worktreePath,
    worktreeInfo: {
      worktreePath,
      branchName,
      baseBranch: null,
      existingBranch: true,
      adopted: true,
      claimResumeInPlace: true,
    },
  };
}

/**
 * Shared admission for coordinator adoption/release and claim continuations.
 * A missing cache may discover the holder; a supplied cache must still match.
 * With no holder, branch/repository owners still prevent a new checkout from
 * taking over publication while the original run is between worktrees.
 */
export function claimBranchAdmission({ branchName, preferredPath, agentId, sourceWorkspace, worktrees, agents, ignoreIds = [] }) {
  if (!Array.isArray(worktrees) || !Array.isArray(agents)) return { admit: false, reason: 'ownership-unreadable' };
  if (!branchName) return { admit: false, reason: 'pointer-incomplete' };
  const holder = preferredPath
    ? worktrees.find(wt => samePath(wt?.path, preferredPath))
    : worktrees.find(wt => String(wt?.branch || '').replace(/^refs\/heads\//, '') === branchName);
  if (preferredPath && !holder) return { admit: false, reason: 'holder-missing' };
  if (holder && String(holder.branch || '').replace(/^refs\/heads\//, '') !== branchName) {
    return { admit: false, reason: 'branch-changed' };
  }
  if (holder?.locked || holder?.prunable) return { admit: false, reason: 'holder-locked' };
  const occupancy = claimHolderOccupancy({
    agents, holderPath: holder?.path, branchName, sourceWorkspace,
    ignoreIds: new Set([agentId, ...ignoreIds].filter(Boolean)),
  });
  if (occupancy === 'active') return { admit: false, reason: 'owner-active' };
  if (occupancy === 'ambiguous') return { admit: false, reason: 'owner-ambiguous' };
  return { admit: true };
}

/**
 * Launch-time ownership admission for an in-place continuation. A pointer is a
 * cached answer from when the previous run died; another owner can appear after
 * that, so the pointer alone is not authority to enter the checkout. Re-reads
 * the holder and the agent registry as supplied by the caller and admits only
 * when the same branch is still checked out in the same directory and no other
 * live owner holds it. Anything unreadable or changed refuses — the caller
 * defers the launch and touches neither ref nor tree.
 *
 * A live claim run that picks its own branch (a swarm orchestrator whose
 * children cut trees PortOS never sees) might own this tree. Nothing observable
 * proves it does not — git activity, the continued run's own registration, and
 * the absence of a process inside the tree can all be true of a live owner — so
 * the launch stays deferred until that run binds the branches it works on (the
 * claim prompt binds each before cutting it) or ends.
 *
 * @param {{
 *   metadata?: object,
 *   agentId: string,
 *   sourceWorkspace?: string,
 *   worktrees: Array<object>|null,
 *   agents: Array<object>|null,
 * }} input
 * @returns {{ admit: true }|{ admit: false, reason: string }}
 */
export function claimContinuationAdmission({ metadata, agentId, sourceWorkspace, worktrees, agents }) {
  if (!Array.isArray(worktrees) || !Array.isArray(agents)) return { admit: false, reason: 'ownership-unreadable' };
  const branchName = metadata?.existingBranch;
  const worktreePath = metadata?.resumeWorktreePath;
  if (!branchName || !worktreePath) return { admit: false, reason: 'pointer-incomplete' };

  return claimBranchAdmission({
    branchName, preferredPath: worktreePath, agentId, sourceWorkspace, worktrees, agents,
    ignoreIds: [metadata?.resumedFromAgentId],
  });
}

/**
 * Why a live claim owner holds this branch's checkout, for a caller about to
 * classify, dispatch or mutate it from outside that run (branch-reconcile's
 * scan and its worker's pre-mutation recheck). The same branch/repository owner
 * contract as `claimBranchAdmission`, without its holder-path bookkeeping: the
 * caller already knows the checkout. An unreadable registry holds the branch.
 *
 * @param {{ branchName: string, holderPath?: string|null, sourceWorkspace?: string, agents: Array<object>|null, ignoreIds?: string[] }} input
 * @returns {'claim-owner-active'|'claim-owner-ambiguous'|'claim-ownership-unreadable'|null}
 */
export function claimCheckoutOwnerReason({ branchName, holderPath = null, sourceWorkspace, agents, ignoreIds = [] }) {
  if (!Array.isArray(agents) || !branchName) return 'claim-ownership-unreadable';
  const occupancy = claimHolderOccupancy({
    agents, holderPath, branchName, sourceWorkspace, ignoreIds: new Set(ignoreIds.filter(Boolean)),
  });
  return occupancy ? `claim-owner-${occupancy}` : null;
}

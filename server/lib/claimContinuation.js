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

/**
 * How long a claim checkout must sit untouched before a claim-flow agent that
 * has NOT named its branch (an unpinned or swarm orchestrator run, whose
 * children cut `claim/issue-<n>` trees PortOS never sees) stops counting as the
 * possible owner. Matches `SIBLING_NEXT_HOLDER_IDLE_MS`: a live session touches
 * its index constantly, a finished one waiting on CI goes quiet for longer.
 */
export const CLAIM_AMBIGUOUS_OWNER_IDLE_MS = 10 * 60 * 1000;

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
 *     it is registered as possibly owning ANY claim branch in its repository.
 * Null for a task that is not a claim flow. Pure.
 *
 * @returns {{ claimBranch: string|null, claimPicksOwnBranch: boolean }|null}
 */
export function claimOwnershipBinding(task) {
  if (!isTruthyMeta(task?.metadata?.claimFlow)) return null;
  const claimBranch = claimContinuationBranch(task?.metadata?.claimTarget);
  return { claimBranch, claimPicksOwnBranch: !claimBranch };
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

/**
 * Whether a running or paused agent other than `ignoreIds` holds, or may hold,
 * the claim checkout:
 *   - `active`: it works inside the directory, or registered this exact branch;
 *   - `ambiguous`: it is a claim run that picks its own branch, in this same
 *     repository, so it might be the one that cut this tree — unprovable from
 *     the registry alone.
 * `active` outranks `ambiguous` across the whole list.
 *
 * @returns {'active'|'ambiguous'|null}
 */
function claimHolderOccupancy({ agents, holderPath, branchName, sourceWorkspace, ignoreIds }) {
  let ambiguous = false;
  for (const agent of agents) {
    if (!agent || ignoreIds.has(agent.id) || !isLiveAgent(agent)) continue;
    const workspace = agentWorkspace(agent);
    if (samePath(workspace, holderPath) || (workspace && isPathInsideDir(holderPath, workspace))) return 'active';
    const registeredBranch = agent.claimBranch ?? agent.metadata?.claimBranch;
    if (registeredBranch === branchName) return 'active';
    const picksOwn = agent.claimPicksOwnBranch ?? agent.metadata?.claimPicksOwnBranch;
    if (isTruthyMeta(picksOwn) && samePath(agentRepository(agent), sourceWorkspace)) ambiguous = true;
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
 * Launch-time ownership admission for an in-place continuation. A pointer is a
 * cached answer from when the previous run died; another owner can appear after
 * that, so the pointer alone is not authority to enter the checkout. Re-reads
 * the holder and the agent registry as supplied by the caller and admits only
 * when the same branch is still checked out in the same directory and no other
 * live owner holds it. Anything unreadable or changed refuses — the caller
 * defers the launch and touches neither ref nor tree.
 *
 * `holderIdleMs` is how long the checkout has been untouched (null when it
 * cannot be read). It only matters for a possible owner that picks its own
 * branch; a registered owner refuses at any idleness.
 *
 * @param {{
 *   metadata?: object,
 *   agentId: string,
 *   sourceWorkspace?: string,
 *   worktrees: Array<object>|null,
 *   agents: Array<object>|null,
 *   holderIdleMs?: number|null,
 *   idleMs?: number,
 * }} input
 * @returns {{ admit: true }|{ admit: false, reason: string }}
 */
export function claimContinuationAdmission({
  metadata, agentId, sourceWorkspace, worktrees, agents, holderIdleMs = null, idleMs = CLAIM_AMBIGUOUS_OWNER_IDLE_MS,
}) {
  if (!Array.isArray(worktrees) || !Array.isArray(agents)) return { admit: false, reason: 'ownership-unreadable' };
  const branchName = metadata?.existingBranch;
  const worktreePath = metadata?.resumeWorktreePath;
  if (!branchName || !worktreePath) return { admit: false, reason: 'pointer-incomplete' };

  const holder = worktrees.find((wt) => samePath(wt?.path, worktreePath));
  if (!holder) return { admit: false, reason: 'holder-missing' };
  if (String(holder.branch || '').replace(/^refs\/heads\//, '') !== branchName) {
    return { admit: false, reason: 'branch-changed' };
  }
  if (holder.locked || holder.prunable) return { admit: false, reason: 'holder-locked' };

  const ignoreIds = new Set([agentId, metadata?.resumedFromAgentId].filter(Boolean));
  const occupancy = claimHolderOccupancy({ agents, holderPath: holder.path, branchName, sourceWorkspace, ignoreIds });
  if (occupancy === 'active') return { admit: false, reason: 'owner-active' };
  if (occupancy === 'ambiguous' && !(Number.isFinite(holderIdleMs) && holderIdleMs >= idleMs)) {
    return { admit: false, reason: 'owner-ambiguous' };
  }
  return { admit: true };
}

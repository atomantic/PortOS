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
 * The claim worktree this task's previous run left on its own branch, when
 * PortOS may hand it to the relaunch. Null when there is nothing to continue:
 * not a claim task, no pinned target, no holder, a lock, a tree outside the
 * claim root, or another live or paused agent already working in that directory.
 *
 * @param {{
 *   task: object,
 *   agentId: string,
 *   worktrees?: Array<{path?: string, branch?: string, locked?: boolean, prunable?: boolean}>,
 *   agents?: Array<{id?: string, status?: string, workspacePath?: string, metadata?: {workspacePath?: string}}>,
 *   worktreesRoot: string,
 * }} input
 * @returns {{ existingBranch: string, resumedFromAgentId: string, resumeWorktreePath: string, claimResumeInPlace: true }|null}
 */
export function claimContinuationPointer({ task, agentId, worktrees = [], agents = [], worktreesRoot }) {
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

  const occupied = agents.some((agent) => {
    if (!agent || agent.id === agentId) return false;
    if (agent.status !== 'running' && agent.status !== 'paused') return false;
    const workspace = agent.workspacePath || agent.metadata?.workspacePath;
    return samePath(workspace, holder.path);
  });
  if (occupied) return null;

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

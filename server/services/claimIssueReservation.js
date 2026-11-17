/**
 * Whether a GitHub issue's claim reservation (an assignee or the `in-progress` label on an open issue) still stands, as a tri-state read for the retirement gates.
 */
import { execGh } from './github.js';
import { githubRepoSpec } from '../lib/workTracker.js';
import { IN_PROGRESS_LABEL } from '../lib/dispatchLabels.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { resolveForgeExecOptions } from './forgeExecOptions.js';

/**
 * @param {object|null} target - `getOriginInfo`'s answer for the repository
 * @param {string|number} issue
 * @param {{ cwd?: string, env?: object }|null} forgeExec - the per-repo gh credential overlay
 * @returns {Promise<boolean|null>} true while the issue is open and assigned or
 *   labelled in progress; false when it is closed, or open with neither; null
 *   when it cannot be read (no GitHub origin, no credential overlay, a failed
 *   or malformed read). Never collapse null into either answer.
 */
export async function readClaimIssueReservation(target, issue, forgeExec) {
  const repoSpec = githubRepoSpec(target);
  if (!repoSpec || !forgeExec) return null;
  const raw = await execGh(['issue', 'view', String(issue), '--repo', repoSpec, '--json', 'state,labels,assignees'],
    undefined, { cwd: forgeExec.cwd, env: forgeExec.env }).catch(() => null);
  const view = safeJSONParse(raw, null);
  if (!view || !Array.isArray(view.labels) || !Array.isArray(view.assignees)) return null;
  if (view.state === 'CLOSED') return false;
  if (view.state !== 'OPEN') return null;
  return view.assignees.length > 0 || view.labels.some(label => label?.name === IN_PROGRESS_LABEL);
}

/**
 * `readClaimIssueReservation` for a repository path, resolving its origin and
 * gh credential overlay first (a caller without branch-reconcile's per-cycle
 * resolution: the early merged-worktree reaper, or the Git page's cleanup).
 *
 * @param {string} repoPath
 * @param {string|number} issue
 * @param {{ forgeAccount?: string|null }} [options] - the app record's pinned gh account
 * @returns {Promise<boolean|null>}
 */
export async function readRepoClaimIssueReservation(repoPath, issue, { forgeAccount = null } = {}) {
  const origin = await getOriginInfo(repoPath).catch(() => null);
  if (!githubRepoSpec(origin)) return null;
  const forgeExec = await resolveForgeExecOptions(repoPath, { forgeAccount }).catch(() => null);
  return readClaimIssueReservation(origin, issue, forgeExec);
}

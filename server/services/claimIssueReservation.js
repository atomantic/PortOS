/**
 * Whether an issue's claim reservation (an assignee or the `in-progress` label on an open issue) still stands on GitHub or GitLab, as a tri-state read for the retirement gates.
 */
import { execGh } from './github.js';
import { execGlab } from './gitlab.js';
import { withGlabJson } from '../lib/glabArgs.js';
import { githubRepoSpec, resolveRepoForgeTarget } from '../lib/workTracker.js';
import { IN_PROGRESS_LABEL } from '../lib/dispatchLabels.js';
import { safeJSONParse } from '../lib/fileUtils.js';
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
  return readGithubClaimIssueReservation(githubRepoSpec(target), issue, forgeExec);
}

async function readGithubClaimIssueReservation(repoSpec, issue, forgeExec) {
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
 * The same reservation on GitLab, through `glab` in the repository (it resolves
 * the project from `origin`). GitLab labels are plain strings and its states
 * are `opened`/`closed`; a view for another issue is unreadable, not an answer.
 *
 * @returns {Promise<boolean|null>}
 */
async function readGitlabClaimIssueReservation(repoPath, issue) {
  const view = safeJSONParse(await execGlab(withGlabJson(['issue', 'view', String(issue)]), repoPath), null);
  if (!view || typeof view !== 'object' || Array.isArray(view) || Number(view.iid) !== Number(issue)
    || !Array.isArray(view.labels) || !Array.isArray(view.assignees)) return null;
  if (view.state === 'closed') return false;
  if (view.state !== 'opened') return null;
  return view.assignees.length > 0 || view.labels.some(label => (typeof label === 'string' ? label : label?.name) === IN_PROGRESS_LABEL);
}

/**
 * The reservation for a repository path, read from the tracker its origin
 * names: GitHub (resolving the gh credential overlay) or GitLab. Any other
 * origin has no tracker to ask and reads unknown. For a caller without
 * branch-reconcile's per-cycle credential: the early merged-worktree reaper, the
 * Git page's cleanup, and reconcile on a non-GitHub origin.
 *
 * @param {string} repoPath
 * @param {string|number} issue
 * @param {{ forgeAccount?: string|null }} [options] - the app record's pinned gh account
 * @returns {Promise<boolean|null>}
 */
export async function readRepoClaimIssueReservation(repoPath, issue, { forgeAccount = null } = {}) {
  // The shared resolver, not a two-segment origin parse: a GitLab project in a
  // subgroup (group/subgroup/app) has no owner/repo pair but is still GitLab.
  const target = await resolveRepoForgeTarget(repoPath).catch(() => null);
  if (target?.forge === 'gitlab') return readGitlabClaimIssueReservation(repoPath, issue);
  if (target?.forge !== 'github') return null;
  const forgeExec = await resolveForgeExecOptions(repoPath, { forgeAccount }).catch(() => null);
  return readGithubClaimIssueReservation(target.repoSpec, issue, forgeExec);
}

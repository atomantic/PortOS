import { lstat } from 'fs/promises';
import { join } from 'path';
import { isSafeGitRef } from '../lib/gitArgs.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';
import { execGit } from '../lib/execGit.js';

/** Only ENOENT means absent. A broken symlink or non-directory still occupies
 * the requested path and cannot establish successful cleanup.
 */
export async function readCheckoutPathPresence(path) {
  return lstat(path).then(() => true).catch(error => error.code === 'ENOENT' ? false : null);
}

/** `show-ref --exists` exits 0 when present, 2 when cleanly absent, and
 * otherwise reports a broken or unreadable ref store (or a Git older than 2.43
 * that lacks the flag); anything but 0 or 2 is unknown, never absence.
 */
export async function readLocalBranchPresence(repoPath, branch) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
  const run = args => execGit(args, repoPath, { ignoreExitCode: true, env });
  const ref = `refs/heads/${branch}`;
  try {
    if ((await run(['check-ref-format', ref])).exitCode !== 0) return null;
    const { exitCode } = await run(['show-ref', '--exists', ref]);
    if (exitCode === 0) return true;
    if (exitCode !== 2) return null;
    // show-ref reports a directory or dangling symlink squatting on the loose
    // ref path as absent; it still blocks the branch, so it must read unknown.
    const gitDir = await run(['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (gitDir.exitCode !== 0) return null;
    return await readCheckoutPathPresence(join(gitDir.stdout.trim(), ref)) === false ? false : null;
  } catch { return null; }
}


const COMMIT_SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

/** Observe only existing local objects. A relationship describes two captured
 * commits; it never authorizes adopting a PR, fetching, or replacing local work.
 */
async function readDeliveryAncestry(repoPath, branch, publishedHead) {
  if (!isSafeGitRef(branch) || !COMMIT_SHA.test(publishedHead)) return null;
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' };
  const run = args => execGit(args, repoPath, { ignoreExitCode: true, env, timeout: 5000, maxBuffer: 4096 });
  const ref = `refs/heads/${branch}`;
  try {
    if ((await run(['check-ref-format', ref])).exitCode !== 0) return null;
    const readHead = () => run(['rev-parse', '--verify', `${ref}^{commit}`]);
    const local = await readHead();
    const localHead = local.stdout.trim();
    if (local.exitCode !== 0 || !COMMIT_SHA.test(localHead)) return null;
    if ((await run(['cat-file', '-e', `${publishedHead}^{commit}`])).exitCode !== 0) return null;
    let relation = 'equal';
    if (localHead !== publishedHead) {
      const publishedBeforeLocal = await run(['merge-base', '--is-ancestor', publishedHead, localHead]);
      const localBeforePublished = await run(['merge-base', '--is-ancestor', localHead, publishedHead]);
      if (![0, 1].includes(publishedBeforeLocal.exitCode) || ![0, 1].includes(localBeforePublished.exitCode)) return null;
      if (publishedBeforeLocal.exitCode === 0 && localBeforePublished.exitCode === 1) relation = 'local-ahead';
      else if (publishedBeforeLocal.exitCode === 1 && localBeforePublished.exitCode === 0) relation = 'local-behind';
      else if (publishedBeforeLocal.exitCode === 1 && localBeforePublished.exitCode === 1) {
        const shallow = await run(['rev-parse', '--is-shallow-repository']);
        if (shallow.exitCode !== 0 || shallow.stdout.trim() !== 'false') return null;
        relation = 'diverged';
      } else return null;
    }
    const current = await readHead();
    return current.exitCode === 0 && current.stdout.trim() === localHead ? { relation, localHead, publishedHead } : null;
  } catch { return null; }
}

/** A known open PR is not, by itself, a request for cognitive work. */
export async function inspectOpenDeliveryRepair(repoPath, branch, prUrl, { forgeAccount = null } = {}) {
  const target = parsePullRequestUrl(prUrl);
  const { getOriginInfo } = await import('../lib/gitRemote.js');
  const origin = await getOriginInfo(repoPath);
  if (!target || target.host !== origin?.host || `${target.owner}/${target.repo}` !== origin?.fullName) return { reason: 'delivery-repository-unverified' };
  const { execGh } = await import('./github.js');
  const { resolveForgeExecOptions } = await import('./forgeExecOptions.js');
  const { githubRepoSpec } = await import('../lib/workTracker.js');
  const spec = githubRepoSpec(origin);
  if (!spec) return { reason: 'delivery-forge-unsupported' };
  const options = await resolveForgeExecOptions(repoPath, { forgeAccount });
  const view = JSON.parse(await execGh(['pr', 'view', String(target.number), '--repo', spec,
    '--json', 'number,state,isDraft,isCrossRepository,headRefName,headRefOid,mergeable,reviewDecision,statusCheckRollup'], undefined, options));
  if (view.number !== target.number || view.state !== 'OPEN' || view.isCrossRepository !== false
    || view.headRefName !== branch || !COMMIT_SHA.test(view.headRefOid || '')) return { reason: 'delivery-head-unverified' };
  const ancestry = await readDeliveryAncestry(repoPath, branch, view.headRefOid);
  if (!ancestry) return { reason: 'delivery-head-unverified' };
  if (ancestry.relation !== 'equal') return { reason: `delivery-${ancestry.relation}`, ancestry };
  if (view.isDraft !== false) return { reason: 'delivery-draft-held', ancestry };
  const failed = (view.statusCheckRollup || []).filter(check => ['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(check.conclusion || check.state));
  const actionable = view.mergeable === 'CONFLICTING' || view.reviewDecision === 'CHANGES_REQUESTED' || failed.length > 0;
  return actionable ? { actionable: true, headSha: view.headRefOid, ancestry, evidence: { head: view.headRefOid, conflicts: view.mergeable === 'CONFLICTING',
    changesRequested: view.reviewDecision === 'CHANGES_REQUESTED', checks: failed.map(check => ({ name: check.name || check.context, conclusion: check.conclusion || check.state })).sort((a,b) => String(a.name).localeCompare(String(b.name))) } }
    : { headSha: view.headRefOid, ancestry, reason: 'delivery-ci-or-review-pending' };
}

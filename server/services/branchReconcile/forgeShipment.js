/**
 * Whether the forge shows a branch never shipped, by an exact `--head` PR query.
 *
 * A leaf so the claim-ownership fence can release a completion hold without
 * importing branch reconciliation, which statically imports that fence; the old
 * lazy import back held both in one CI-selection cycle (#12285, #17499).
 */
import { execGh } from '../github.js';
import { resolveForgeExecOptions } from '../forgeExecOptions.js';
import { getOriginInfo } from '../../lib/gitRemote.js';
import { githubRepoSpec } from '../../lib/workTracker.js';
import { safeJSONParse } from '../../lib/fileUtils.js';

/**
 * Whether the forge shows `branch` never shipped: no open PR, and none closed
 * unmerged (a deliberate decision, e.g. superseded, that a second PR must not
 * override). A merged PR does not count — later commits are new work. Null when
 * the forge cannot answer (non-GitHub origin, gh failure, unparseable output):
 * an exact `--head` query rather than `getOpenPrsByHead`'s capped list, whose
 * empty Map for a non-GitHub origin must never read as "no PR" to a caller
 * releasing a hold.
 * @returns {Promise<boolean|null>}
 */
export async function readBranchUnshipped(repoPath, branch, { origin, forgeExec = null, forgeAccount = null } = {}) {
  const repoSpec = githubRepoSpec(origin === undefined ? await getOriginInfo(repoPath).catch(() => null) : origin);
  if (!repoSpec || !branch) return null;
  const { cwd, env } = forgeExec || await resolveForgeExecOptions(repoPath, { forgeAccount });
  const raw = await execGh(['pr', 'list', '--repo', repoSpec, '--state', 'all', '--head', branch, '--json', 'state'],
    undefined, { cwd, env }).catch(() => null);
  const parsed = raw === null ? null : safeJSONParse(raw, null);
  return Array.isArray(parsed) ? parsed.every(pr => pr?.state === 'MERGED') : null;
}

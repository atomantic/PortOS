import { resolve } from 'node:path';
import { execGit } from '../lib/execGit.js';

/**
 * True only for a clean linked checkout of `branch` at exactly `headSha` that
 * shares the primary repository's object store. Pinned merge recovery launches
 * into this checkout, so a dirty, detached, or moved tree is never adopted.
 */
export async function verifyPendingMergeCheckout(repoPath, worktreePath, branch, headSha) {
  if (!worktreePath || resolve(repoPath) === resolve(worktreePath)) return false;
  const read = async (args, cwd = worktreePath) => (await execGit(args, cwd)).stdout.trim();
  // Drain sibling Git processes even if a probe rejects (such as detached
  // HEAD); their live cwd handles can otherwise block checkout retirement.
  const checked = await Promise.allSettled([
    read(['rev-parse', '--path-format=absolute', '--git-common-dir']),
    read(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoPath),
    read(['rev-parse', '--verify', 'HEAD^{commit}']),
    read(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    read(['status', '--porcelain=v1', '--untracked-files=all']),
  ]);
  if (checked.some(result => result.status === 'rejected')) return false;
  const [common, primaryCommon, head, ref, status] = checked.map(result => result.value);
  return common === primaryCommon && head === headSha && ref === branch && !status;
}

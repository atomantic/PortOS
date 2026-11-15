/**
 * `readGitCommonDirectory(repoPath)` — fresh canonical Git common-directory identity for
 * repository-scoped ownership
 *
 * ; aliases and linked worktrees share identity, independent clones do not, and unreadable evidence
 * returns null.
 */

import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execGit } from './execGit.js';

/** Fresh canonical identity shared by linked worktrees and filesystem aliases.
 * Unknown evidence is never proof that two repositories are independent.
 */
export async function readGitCommonDirectory(repoPath) {
  if (typeof repoPath !== 'string' || !repoPath.trim()) return null;
  return execGit(['rev-parse', '--git-common-dir'], repoPath)
    .then(result => {
      const common = result.stdout.trim();
      return common ? realpath(resolve(repoPath, common)) : null;
    }).catch(() => null);
}

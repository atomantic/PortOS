/** Shared per-repository admission for branch attachments and retirement. */

import { realpathSync } from 'fs';
import { isAbsolute } from 'path';
import { execGit } from '../../lib/execGit.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { withGitMutationLifetime } from '../../lib/gitMutationLifetime.js';

// Per-source-repo serialization tail for worktree-creating git operations —
// the createKeyCachedQueue pattern (see server/services/pipeline/issuesShared.js). Git
// serializes its own worktree bookkeeping behind a per-repo lock, so two
// `git worktree add` calls in the same evaluation tick race and the loser is
// blocked with `blockedCategory: worktree-failed` (#2193). A single promise
// tail per repo collapses that race: each create awaits the previous one to
// settle before touching the shared `.git/worktrees` state. Keyed by
// realpath-resolved repo path so /var vs /private/var (macOS) don't split the
// tail into two lanes that can still collide.
const queueWorktreeCreateForKey = createKeyCachedQueue();

export async function queueWorktreeCreate(repo, fn) {
  // Linked checkouts share branch refs even when their working paths differ.
  // Resolve that common identity before entering the mutation lane.
  const common = await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo)
    .then(result => result.stdout.trim()).catch(() => null);
  let key = common && isAbsolute(common) ? common : repo;
  try { key = realpathSync(key); } catch { /* invalid repositories fail in the operation itself */ }
  if (!key) key = '__unknown__';
  return queueWorktreeCreateForKey(key, async () => {
    return withGitMutationLifetime(() => fn(common));
  });
}

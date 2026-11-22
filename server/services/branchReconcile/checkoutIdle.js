/**
 * How long a checkout has sat unchanged: the newest of its directory, index and
 * HEAD-log mtimes.
 *
 * A leaf so worktree cleanup can apply the same idle floor as branch
 * reconciliation without importing it: reconciliation statically imports the
 * worktree modules, and the old lazy import back held both in one CI-selection
 * cycle (#12285, #17499).
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execGit } from '../../lib/execGit.js';

/** Time since the checkout last changed: its directory, index or HEAD log. Null when unreadable. */
export async function checkoutIdleMs(worktreePath) {
  const gitDir = (await execGit(['rev-parse', '--absolute-git-dir'], worktreePath).catch(() => null))?.stdout?.trim();
  if (!gitDir) return null;
  const stamps = await Promise.all([worktreePath, join(gitDir, 'index'), join(gitDir, 'logs', 'HEAD')]
    .map(path => stat(path).then(st => st.mtimeMs, error => (error.code === 'ENOENT' ? 0 : null))));
  if (stamps.some(stamp => stamp === null)) return null;
  return Math.max(0, Date.now() - Math.max(...stamps));
}

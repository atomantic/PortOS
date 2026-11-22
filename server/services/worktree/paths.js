/** Worktree paths and filesystem-aware path equality. */

import { realpathSync } from 'fs';
import { PATHS } from '../../lib/fileUtils.js';

// `git worktree list --porcelain` reports POSIX separators on every platform —
// `H:/repo/data/cos/worktrees/agent-x` — while WORKTREES_DIR is built with
// `join` and is backslash-separated on Windows. So a git-reported path is never
// compared with a bare `startsWith`/`split('/')`: `isPathInsideDir` resolves
// both sides first (and rejects a sibling like `worktrees-old`), and
// `worktreeAgentId()` treats either separator as one. Before this, every CoS
// worktree failed the containment check on Windows — `cleanupOrphanedWorktrees`
// skipped them all and `reapMergedWorktrees` filed them as `unmanaged-location`,
// so the daily line read "reaped 0 merged + 0 orphaned" with orphans on disk.
export const WORKTREES_DIR = PATHS.worktrees;

/**
 * Compare two filesystem paths for equality, resolving symlinks (e.g. macOS
 * /var → /private/var) and Windows short-name aliases. Native realpath resolves
 * the latter where the JavaScript implementation can retain the input spelling.
 */
export function pathsEqual(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const resolved = (p) => { try { return realpathSync.native(p); } catch { return p; } };
  return resolved(a) === resolved(b);
}

import { join } from 'path';
import { execGitSafe } from '../lib/execGit.js';

/**
 * Read-only classification of stale gitlinks. Only clean checkouts at an
 * ancestor of the parent's pin are mechanical repairs. Staged pointers, local
 * commits, edits, untracked files and unreadable state retain the dirty guard.
 * Porcelain v2's NUL framing preserves spaces and non-ASCII submodule paths.
 */
export async function inspectPinnedSubmoduleDrift(repoPath) {
  const status = await execGitSafe([
    'status', '--porcelain=v2', '-z', '--ignore-submodules=none', '--untracked-files=all',
  ], repoPath, { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (status.exitCode !== 0) return { repairablePaths: [], onlyRepairable: false };

  const records = status.stdout.split('\0').filter(Boolean);
  const repairablePaths = [];
  for (const record of records) {
    // Ordinary, unstaged gitlink changes only. The index must still match HEAD.
    const match = /^1 \.M S[C.][M.][U.] 160000 160000 160000 ([a-f0-9]+) \1 (.+)$/s.exec(record);
    if (!match) continue;
    const [, pin, path] = match;
    const dir = join(repoPath, path);
    const head = await execGitSafe(['rev-parse', '--verify', 'HEAD'], dir);
    if (head.exitCode !== 0) continue;
    if (head.stdout.trim() !== pin) {
      const ancestor = await execGitSafe(['merge-base', '--is-ancestor', 'HEAD', pin], dir);
      if (ancestor.exitCode !== 0) continue;
    }
    const nested = await inspectPinnedSubmoduleDrift(dir);
    // A clean submodule has no records; recursively stale children are safe too.
    if (nested.clean || nested.onlyRepairable) repairablePaths.push(path);
  }
  return {
    clean: records.length === 0,
    repairablePaths,
    onlyRepairable: records.length > 0 && repairablePaths.length === records.length,
  };
}

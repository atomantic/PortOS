/**
 * Stale `.agent-done-*` sentinel sweep.
 *
 * A run that reaches an outcome deletes its own sentinel through
 * `removeCompletionSentinel` (agentCompletionCleanup.js), including the recovery
 * paths. What can still be left behind:
 *
 *   - a run whose record the orphan sweep never reaps (no durable record, or a
 *     workspace the record does not name);
 *   - a host-shutdown ABANDON (#3202) runs no completion cleanup, and a race can
 *     strand a sentinel the abandon gate did not see;
 *   - a completion whose sentinel removal failed (unreadable record, I/O error);
 *   - the bare unscoped `.agent-done`, which no completion path will claim.
 *
 * A skipped cleanup leaves an untracked file in the USER'S repository, per dead run.
 *
 * Safety is the whole design: a sentinel is deleted only when its run is provably
 * not live (absent from `protectedAgentIds`) AND the file is older than
 * `STALE_SENTINEL_MIN_AGE_MS`. The age floor covers the window before a run is
 * registered and is the bare `.agent-done`'s only protection.
 */

import { readdir, stat } from 'fs/promises';
import { join } from 'path';

import { doneSentinelAgentId } from '../../lib/agent/agentSentinel.js';
import { execGit } from '../../lib/execGit.js';
import { HOUR, rmGuarded } from '../../lib/fileUtils.js';

export const STALE_SENTINEL_MIN_AGE_MS = HOUR;

/**
 * Delete abandoned done-sentinels from the given directories.
 *
 * @param {string[]} dirs - workspace roots to sweep (duplicates are fine).
 * @param {Set<string>} protectedAgentIds - agents whose sentinel must survive:
 *   everything live, paused, or otherwise not finished. A non-Set means agent
 *   state was unreadable: nothing is removed, since sweeping would delete the
 *   resume signal of every paused and interrupted run.
 * @returns {Promise<number>} sentinels removed.
 */
export async function sweepStaleDoneSentinels(dirs, protectedAgentIds) {
  if (!(protectedAgentIds instanceof Set)) return 0;
  const cutoff = Date.now() - STALE_SENTINEL_MIN_AGE_MS;
  let removed = 0;

  for (const dir of new Set((dirs || []).filter(d => typeof d === 'string' && d))) {
    const entries = await readdir(dir).catch(() => null);
    if (!entries) continue;

    for (const entry of entries) {
      const agentId = doneSentinelAgentId(entry);
      if (agentId === null) continue;
      if (agentId && protectedAgentIds.has(agentId)) continue;

      const target = join(dir, entry);
      const info = await stat(target).catch(() => null);
      if (!info?.isFile() || info.mtimeMs >= cutoff) continue;

      const gone = await rmGuarded(target, { force: true }).then(() => true, (err) => {
        console.warn(`⚠️ Failed to remove stale sentinel ${entry}: ${err.message}`);
        return false;
      });
      if (gone) removed++;
    }
  }

  return removed;
}

/**
 * Every checkout of the given repos: the repo itself plus its linked worktrees.
 * A sentinel stranded in a preserved agent worktree reads as uncommitted work and
 * blocks its merged-tree cleanup, so the sweep must cover those directories.
 *
 * @param {string[]} repoPaths
 * @returns {Promise<string[]>} unique checkout paths; an unreadable repo contributes itself only
 */
export async function checkoutDirsOf(repoPaths) {
  const dirs = new Set();
  for (const repo of new Set((repoPaths || []).filter(p => typeof p === 'string' && p))) {
    dirs.add(repo);
    const listed = await execGit(['worktree', 'list', '--porcelain'], repo).catch(() => null);
    for (const line of (listed?.stdout || '').split(/\r?\n/)) {
      if (line.startsWith('worktree ')) dirs.add(line.slice(9));
    }
  }
  return [...dirs];
}

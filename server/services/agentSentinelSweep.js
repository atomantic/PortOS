/**
 * Stale `.agent-done-*` sentinel sweep.
 *
 * A run's own finalize path deletes its sentinel (`releaseRunResources` in
 * agentTuiSpawning, and the CLI/finalization equivalents), so in the happy case
 * nothing is left behind. Three paths deliberately or unavoidably skip that:
 *
 *   - a host shutdown ABANDONS the run and preserves the sentinel on purpose,
 *     because the resume needs it (#3202);
 *   - a hard kill (`pm2 restart`, SIGKILL, a machine reboot) never reaches any
 *     cleanup at all;
 *   - the file only vanishes with the worktree for worktree-backed runs.
 *
 * Worktree-less agents share a real checkout — the PortOS repo, or a managed
 * app's own repo — so for them a skipped cleanup leaves an untracked file in the
 * USER'S repository, forever, one per dead run. That is what this sweeps.
 *
 * Safety is the whole design: a sentinel is deleted only when its run is
 * provably not live (its agent id is absent from `protectedAgentIds`) AND the
 * file is older than `STALE_SENTINEL_MIN_AGE_MS`. The age floor covers the
 * window where a sentinel exists before its run is registered, and gives the
 * bare unscoped `.agent-done` — which names no agent and so can never be
 * matched to a live run — its only protection.
 */

import { readdir, stat } from 'fs/promises';
import { join } from 'path';

import { doneSentinelAgentId } from '../lib/agentSentinel.js';
import { HOUR, rmGuarded } from '../lib/fileUtils.js';

/** How long a sentinel must have sat untouched before it counts as abandoned. */
export const STALE_SENTINEL_MIN_AGE_MS = HOUR;

/**
 * Delete abandoned done-sentinels from the given directories.
 *
 * @param {string[]} dirs - workspace roots to sweep (duplicates are fine).
 * @param {Set<string>} protectedAgentIds - agents whose sentinel must survive:
 *   everything live, paused, or otherwise not finished. Anything else is
 *   "liveness unknown" and removes nothing — the caller passes a non-Set when it
 *   could not read the agent state, and sweeping on that list would delete the
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

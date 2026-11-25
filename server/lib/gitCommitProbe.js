/**
 * Run-window git probes: machine-checkable "what did this run leave behind?" primitives.
 *
 * They answer `did it
 * commit anything?` (the success criterion, by committer date) and `what did it commit?` (the
 * accumulated diff the goal-fidelity review reads, which also excludes absorbed upstream history that
 * dates alone can't attribute). Lives in `server/lib/` because several agent paths (finalize, run
 * completion, runner completion, orphan recovery) share the answer.
 */

import { execGit } from './execGit.js';
import { resolveRemoteDefaultRef } from './primaryCheckoutGuard.js';

/**
 * Count commits reachable from HEAD whose COMMITTER date falls inside the run window. Commits the
 * agent created or rewrote are stamped now, while commits merely pulled from the remote keep their
 * older committer date, so they don't count as this agent's work.
 *
 * Returns null when Git cannot establish a count. Only a successful count proves zero.
 *
 * @param {string} workspacePath
 * @param {number} sinceMs - epoch ms marking the start of the run window
 * @returns {Promise<number|null>}
 */
export async function commitsSince(workspacePath, sinceMs) {
  if (!workspacePath || typeof workspacePath !== 'string' || !Number.isFinite(sinceMs)) return null;
  const since = new Date(sinceMs);
  if (Number.isNaN(since.getTime())) return null;
  const result = await execGit(
    ['rev-list', '--count', `--since=${since.toISOString()}`, 'HEAD'],
    workspacePath,
    { ignoreExitCode: true, timeout: 10_000 },
  ).catch(() => null);
  const value = result?.exitCode === 0 ? result.stdout.trim() : '';
  const count = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(count) ? count : null;
}

/**
 * Coerce an agent record's `startedAt` to epoch ms. In-memory agent maps stamp `Date.now()` (a
 * NUMBER) while persisted records stamp an ISO string; a bare `Date.parse(number)` returns NaN and
 * would silently skip the commit probe for that spawn path.
 *
 * @returns {number} epoch ms, or NaN when there is no usable timestamp.
 */
export function toEpochMs(startedAt) {
  if (typeof startedAt === 'number') return startedAt;
  if (typeof startedAt === 'string') return Date.parse(startedAt);
  if (startedAt instanceof Date) return startedAt.getTime();
  return NaN;
}

/** Did this run leave a commit behind? null preserves an unavailable count. */
export async function committedDuringRun(workspacePath, sinceMs) {
  const count = await commitsSince(workspacePath, sinceMs);
  return count === null ? null : count > 0;
}

/**
 * The accumulated run-window diff, excluding history absorbed from the remote default branch. Starts
 * at the newest pre-window commit and advances to the remote-default merge base only when ancestry
 * proves it newer; never uses the remote tip directly (it may include work this checkout hasn't
 * absorbed). Without a resolvable local remote-default ref it keeps the time-based fallback. This is a
 * review of the remaining change, not exact authorship attribution; no fetch or mutation is performed.
 *
 * Non-throwing, and every failure is a REASON rather than an empty diff: `''` reads as "this run
 * changed nothing", which a git that couldn't answer must never be confused with. A repo whose whole
 * history is inside the window has no `--before` (committer date) base and is reported, not diffed
 * against the empty tree, since the window is then wrong.
 *
 * @param {string} workspacePath
 * @param {number} sinceMs - epoch ms marking the start of the run window
 * @param {Object} [options]
 * @param {number} [options.maxChars] - hard cap on the returned text; truncated (and flagged) because
 *   the caller feeds it to a model with a fixed context window.
 * @param {string} [options.head] - pinned commit to review; defaults to HEAD
 * @returns {Promise<{diff: string|null, base: string|null, truncated: boolean, reason: string|null}>}
 */
export async function runWindowDiff(workspacePath, sinceMs, { maxChars = 60_000, head = 'HEAD' } = {}) {
  const decline = (reason) => ({ diff: null, base: null, truncated: false, reason });
  if (!workspacePath || typeof workspacePath !== 'string') return decline('no workspace path');
  if (!Number.isFinite(sinceMs)) return decline('no run window');
  const since = new Date(sinceMs);
  if (Number.isNaN(since.getTime())) return decline('unusable run window');

  const baseResult = await execGit(
    ['rev-list', '-n', '1', `--before=${since.toISOString()}`, head],
    workspacePath,
    { ignoreExitCode: true, timeout: 10_000 },
  ).catch(() => null);
  if (!baseResult || baseResult.exitCode !== 0) return decline('could not resolve the run window base commit');
  let base = baseResult.stdout.trim();
  if (!base) return decline('no commit predates the run window');

  const upstream = await resolveRemoteDefaultRef(workspacePath);
  if (upstream) {
    const mergeBaseResult = await execGit(
      ['merge-base', head, upstream.sha], workspacePath,
      { ignoreExitCode: true, timeout: 10_000 },
    ).catch(() => null);
    const upstreamBase = mergeBaseResult?.exitCode === 0 ? mergeBaseResult.stdout.trim() : null;
    if (!upstreamBase) return decline('could not resolve the absorbed upstream base');
    if (upstreamBase !== base) {
      const ancestry = await execGit(
        ['merge-base', '--is-ancestor', base, upstreamBase], workspacePath,
        { ignoreExitCode: true, timeout: 10_000 },
      ).catch(() => null);
      if (ancestry?.exitCode === 0) {
        base = upstreamBase;
      } else if (ancestry?.exitCode === 1) {
        // A later pre-window agent commit must stay excluded. If neither base
        // contains the other, one two-tree diff cannot exclude both histories.
        const reverse = await execGit(
          ['merge-base', '--is-ancestor', upstreamBase, base], workspacePath,
          { ignoreExitCode: true, timeout: 10_000 },
        ).catch(() => null);
        if (reverse?.exitCode !== 0) return decline('run window and upstream bases could not be ordered');
      } else {
        return decline('could not compare the run window and upstream bases');
      }
    }
  }

  // `--no-ext-diff` so an external difftool can't replace the text (or block on a GUI); `--no-color`
  // keeps escape codes from a model reading it as source.
  const diffResult = await execGit(
    ['diff', '--no-color', '--no-ext-diff', `${base}..${head}`],
    workspacePath,
    { ignoreExitCode: true, timeout: 30_000 },
  ).catch(() => null);
  if (!diffResult || diffResult.exitCode !== 0) return decline('could not read the run window diff');

  const diff = diffResult.stdout;
  if (!diff.trim()) return { diff: '', base, truncated: false, reason: null };
  // The cap bounds what the CALLER receives, marker included, so a consumer re-checking the length
  // against the same constant doesn't reject this function's own output.
  if (diff.length > maxChars) {
    const marker = '\n…[diff truncated]';
    return { diff: `${diff.slice(0, Math.max(0, maxChars - marker.length))}${marker}`, base, truncated: true, reason: null };
  }
  return { diff, base, truncated: false, reason: null };
}

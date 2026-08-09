/**
 * Run-window commit probe — the single machine-checkable "did this run commit
 * anything?" primitive (#3637).
 *
 * It replaced the `[task-<id>]` commit-marker grep that used to live in
 * `agentRunTracking.js`: nothing in PortOS ever emitted that marker (the root
 * CLAUDE.md requires human-readable commit subjects, so stamping an opaque task
 * id into every permanent commit was never an option), so the criterion was
 * unsatisfiable and scored every ordinary code-editing run a failure.
 *
 * Lives in `server/lib/` rather than under `services/agentTuiSpawning/` because
 * four separate agent paths — finalize's success-criteria evaluation, run
 * completion, runner completion, and orphan recovery — all need the same
 * answer, and none of them should have to reach into the TUI spawner for it.
 */

import { execGit } from './execGit.js';

/**
 * Count commits reachable from HEAD whose COMMITTER date falls inside the run
 * window. `git rev-list --since` filters on committer date, which is what makes
 * this a usable "did this agent commit anything?" probe: commits the agent
 * created (or rewrote via rebase) are stamped now, while commits merely pulled
 * in from the remote keep the committer date they were written with — usually
 * before the run started, so they don't count as this agent's work.
 *
 * Non-throwing: a repo with no commits yet (`rev-list HEAD` fails), a missing,
 * detached, or broken checkout, or a git timeout all return 0.
 *
 * @param {string} workspacePath
 * @param {number} sinceMs - epoch ms marking the start of the run window
 * @returns {Promise<number>}
 */
export async function commitsSince(workspacePath, sinceMs) {
  if (!workspacePath || typeof workspacePath !== 'string') return 0;
  if (!Number.isFinite(sinceMs)) return 0;
  // `Number.isFinite` is not enough: a finite but out-of-range epoch (±1e15)
  // makes `toISOString()` throw RangeError, which would break this function's
  // non-throwing contract on a path that runs outside the request lifecycle.
  const since = new Date(sinceMs);
  if (Number.isNaN(since.getTime())) return 0;
  // `ignoreExitCode` so a repo with no HEAD resolves to a non-zero exit we can
  // read as "no commits" rather than rejecting — the house convention for
  // probe-shaped git calls (see git.js `isRepo` / `getRemote`).
  //
  // `timeout` preserves the retired marker-grep's 10s bound rather than taking
  // execGit's 30s default: this sits on the agent-completion path, and a git
  // wedged on a locked index or a slow network mount must not hold finalize open
  // for half a minute. A timeout rejects, which the catch below reads as 0.
  const result = await execGit(
    ['rev-list', '--count', `--since=${since.toISOString()}`, 'HEAD'],
    workspacePath,
    { ignoreExitCode: true, timeout: 10_000 },
  ).catch(() => null);
  if (!result || result.exitCode !== 0) return 0;
  const count = parseInt(result.stdout.trim(), 10);
  return Number.isFinite(count) ? count : 0;
}

/**
 * Coerce an agent record's `startedAt` to epoch ms, whichever shape it is in.
 * The in-memory agent maps stamp `Date.now()` (a NUMBER); the persisted record
 * stamps an ISO string. `Date.parse(1754696324000)` stringifies its argument and
 * returns NaN, so a bare `Date.parse` silently drops the numeric half — and a
 * dropped window means the commit probe is skipped for that whole spawn path.
 *
 * @returns {number} epoch ms, or NaN when there is no usable timestamp.
 */
export function toEpochMs(startedAt) {
  if (typeof startedAt === 'number') return startedAt;
  if (typeof startedAt === 'string') return Date.parse(startedAt);
  if (startedAt instanceof Date) return startedAt.getTime();
  return NaN;
}

/**
 * Boolean form of `commitsSince` — "did this run leave a commit behind?".
 * The shape every agent-completion path actually wants.
 */
export async function committedDuringRun(workspacePath, sinceMs) {
  return (await commitsSince(workspacePath, sinceMs)) > 0;
}

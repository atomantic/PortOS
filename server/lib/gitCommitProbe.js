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
  const since = new Date(sinceMs).toISOString();
  // `ignoreExitCode` so a repo with no HEAD resolves to a non-zero exit we can
  // read as "no commits" rather than rejecting — the house convention for
  // probe-shaped git calls (see git.js `isRepo` / `getRemote`).
  const result = await execGit(['rev-list', '--count', `--since=${since}`, 'HEAD'], workspacePath, { ignoreExitCode: true })
    .catch(() => null);
  if (!result || result.exitCode !== 0) return 0;
  const count = parseInt(result.stdout.trim(), 10);
  return Number.isFinite(count) ? count : 0;
}

/**
 * Boolean form of `commitsSince` — "did this run leave a commit behind?".
 * The shape every agent-completion path actually wants.
 */
export async function committedDuringRun(workspacePath, sinceMs) {
  return (await commitsSince(workspacePath, sinceMs)) > 0;
}

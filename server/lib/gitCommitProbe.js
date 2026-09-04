/**
 * Run-window git probes — the machine-checkable "what did this run leave
 * behind?" primitives (#3637).
 *
 * Two questions share one window definition, so they share one module: `did it
 * commit anything?` (the success criterion) and `what did it commit?` (the
 * accumulated diff the goal-fidelity review reads, #5994). Splitting them would
 * duplicate the "commits stamped inside the window are this run's" rule, and a
 * drift between the two would mean the gate reviewed a different set of commits
 * than the criterion counted.
 *
 * `commitsSince` replaced the `[task-<id>]` commit-marker grep that used to live in
 * `agentRunTracking.js`: nothing in PortOS ever emitted that marker (the root
 * AGENTS.md requires human-readable commit subjects, so stamping an opaque task
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

/**
 * The ACCUMULATED diff of everything this run committed — the base being the
 * newest commit that predates the run window, so a run that landed five commits
 * is reviewed as the one change it actually made rather than five partial ones.
 *
 * Non-throwing, like its siblings, and every failure is a REASON rather than an
 * empty diff. That distinction is the whole point: `''` would read as "this run
 * changed nothing", and a consumer gating on the diff must never confuse a git
 * that could not answer with a run that did nothing.
 *
 * `--before` resolves the base off COMMITTER date, matching `commitsSince`'s
 * `--since` — so the two probes always agree on which commits belong to the run.
 * A repo whose entire history falls inside the window has no such base; that is
 * reported rather than diffed against the empty tree, because on a real
 * workspace it means the window is wrong, not that the run wrote the repo.
 *
 * @param {string} workspacePath
 * @param {number} sinceMs - epoch ms marking the start of the run window
 * @param {Object} [options]
 * @param {number} [options.maxChars] - hard cap on the returned text; the diff
 *   is truncated (and flagged) rather than returned whole, because the caller
 *   feeds it to a model with a fixed context window.
 * @returns {Promise<{diff: string|null, base: string|null, truncated: boolean, reason: string|null}>}
 */
export async function runWindowDiff(workspacePath, sinceMs, { maxChars = 60_000 } = {}) {
  const decline = (reason) => ({ diff: null, base: null, truncated: false, reason });
  if (!workspacePath || typeof workspacePath !== 'string') return decline('no workspace path');
  if (!Number.isFinite(sinceMs)) return decline('no run window');
  const since = new Date(sinceMs);
  if (Number.isNaN(since.getTime())) return decline('unusable run window');

  const baseResult = await execGit(
    ['rev-list', '-n', '1', `--before=${since.toISOString()}`, 'HEAD'],
    workspacePath,
    { ignoreExitCode: true, timeout: 10_000 },
  ).catch(() => null);
  if (!baseResult || baseResult.exitCode !== 0) return decline('could not resolve the run window base commit');
  const base = baseResult.stdout.trim();
  if (!base) return decline('no commit predates the run window');

  // `--no-ext-diff` so a user's configured external difftool can't replace the
  // unified text (or block on a GUI); `--no-color` so escape codes don't reach
  // a model reading it as source.
  const diffResult = await execGit(
    ['diff', '--no-color', '--no-ext-diff', `${base}..HEAD`],
    workspacePath,
    { ignoreExitCode: true, timeout: 30_000 },
  ).catch(() => null);
  if (!diffResult || diffResult.exitCode !== 0) return decline('could not read the run window diff');

  const diff = diffResult.stdout;
  if (!diff.trim()) return { diff: '', base, truncated: false, reason: null };
  // The cap bounds what the CALLER receives, marker included — a consumer that
  // re-checks the length against the same constant would otherwise reject the
  // very text this function handed it.
  if (diff.length > maxChars) {
    const marker = '\n…[diff truncated]';
    return { diff: `${diff.slice(0, Math.max(0, maxChars - marker.length))}${marker}`, base, truncated: true, reason: null };
  }
  return { diff, base, truncated: false, reason: null };
}

/**
 * Primary-checkout branch-jack detector (#3680).
 *
 * A CoS agent spawned with a worktree must only ever write inside that
 * worktree. On 2026-08-09 one didn't: running `/do:pr` from its worktree it
 * applied its three commits onto the PRIMARY checkout's local `main`, where
 * they sat unpushed and unreviewed. `main` is unprotected on this repo, so a
 * later `git push` from the primary would have landed them without a PR.
 *
 * The chosen remedy is DETECT-AND-REPORT, not prevention and not auto-repair:
 *
 *   - Prevention (making the primary read-only for the duration of a run) would
 *     break the many legitimate flows that read and write the primary checkout.
 *   - Auto-repair means `git reset --hard`, which DISCARDS commits. That stays a
 *     human decision, so the failure message states the recovery command instead
 *     of running it — and notes that the same work also exists on the agent's
 *     own branch, which is what makes the reset safe.
 *
 * Two halves, deliberately split so they can sit on opposite ends of a run:
 * `capturePrimaryCheckoutState` stamps a baseline at spawn time (onto the agent
 * metadata, in `agentLifecycle.js`), and `detectPrimaryCheckoutDrift` re-reads it
 * in the shared finalize path (`agentFinalization.js`) — the one chokepoint all
 * three spawn modes (TUI, direct CLI, runner) already funnel through, so the
 * guard is not TUI-only without triplicating it.
 *
 * Every function here is NON-THROWING, for the same reason `gitCommitProbe.js`
 * is: it runs on the agent-completion path, outside the Express request
 * lifecycle, where a rejection has nothing to bubble to. An unreadable or
 * missing checkout, or a wedged git, degrades to "no drift observed" — the guard
 * never manufactures a failure out of a check that could not run.
 */

import { execGit } from './execGit.js';

/**
 * The completion reason a drifted run is recorded under. Registered in
 * `COMPLETION_REASON_ANALYSES` (agentErrorAnalysis.js) so the analyzer has a
 * verdict for it instead of falling through to a keyword sweep of the
 * transcript.
 */
export const PRIMARY_CHECKOUT_MUTATED_REASON = 'primary-checkout-mutated';

/**
 * The taxonomy token the drift is classified under. Reuses the pre-existing
 * `git-error` category rather than minting a new one, so every downstream
 * consumer (auto-fix tiers, learning buckets, the failure ledger) keeps
 * classifying it with no new token to teach them. Deliberately NOT in
 * `ENVIRONMENTAL_ERROR_CATEGORIES`: this is the run's own misbehavior, and it
 * should dent the task type's measured success rate.
 */
export const PRIMARY_CHECKOUT_MUTATED_CATEGORY = 'git-error';

/**
 * What a human has to do before this task may run again. Lives here so the
 * finalize-path analysis and the `COMPLETION_REASON_ANALYSES` registration can't
 * drift apart on it. A retry cannot repair a mutated checkout, so this
 * deliberately escalates rather than blind-retrying.
 */
export const PRIMARY_CHECKOUT_MUTATED_ESCALATION =
  'A worktree agent committed to the primary checkout. Confirm the commits are preserved (agent branch / open PR), restore the primary, then approve the retry.';

/** Bound on every git call here — this sits on finalize; nothing may wedge it. */
const GIT_TIMEOUT_MS = 10_000;

/** First line of a probe-shaped execGit result, or null. */
function firstLine(result) {
  if (!result || result.exitCode !== 0) return null;
  const value = (result.stdout || '').trim();
  return value || null;
}

/**
 * Read a checkout's current branch + HEAD SHA. Returns null when the path is
 * absent, is not a repo, has no commits yet, or git could not be run.
 *
 * A DETACHED head reports its branch as the literal `HEAD` and is kept as-is
 * (rather than nulled, the way `resolveWorkspaceBranch` does it) — this value is
 * only ever compared against a later reading of itself, and "detached, then on a
 * branch" is exactly the kind of movement worth reporting.
 *
 * @param {string} checkoutPath
 * @returns {Promise<{path: string, branch: string, head: string}|null>}
 */
export async function capturePrimaryCheckoutState(checkoutPath) {
  if (!checkoutPath || typeof checkoutPath !== 'string') return null;
  const options = { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS };
  const [branchResult, headResult] = await Promise.all([
    execGit(['rev-parse', '--abbrev-ref', 'HEAD'], checkoutPath, options).catch(() => null),
    execGit(['rev-parse', 'HEAD'], checkoutPath, options).catch(() => null),
  ]);
  const branch = firstLine(branchResult);
  const head = firstLine(headResult);
  if (!branch || !head) return null;
  return { path: checkoutPath, branch, head };
}

/**
 * How many commits `head` is ahead of `baseHead`. Returns null (not 0) when the
 * range can't be resolved — a rewritten/pruned baseline commit, or a git that
 * timed out — so the prose can say "moved" without asserting a count it doesn't
 * have.
 */
async function countCommitsAhead(checkoutPath, baseHead, head) {
  const result = await execGit(
    ['rev-list', '--count', `${baseHead}..${head}`],
    checkoutPath,
    { ignoreExitCode: true, timeout: GIT_TIMEOUT_MS },
  ).catch(() => null);
  const value = firstLine(result);
  const count = value === null ? NaN : parseInt(value, 10);
  return Number.isFinite(count) ? count : null;
}

/** Short SHA for human-readable prose. */
const short = sha => String(sha || '').slice(0, 9);

/**
 * Re-read the baseline and report whether the primary checkout moved during the
 * run.
 *
 * Three outcomes, never collapsed:
 *   - `{ drifted: false }` — it didn't move, OR there was nothing to check, OR
 *     the checkout could not be read (nothing was verified, so nothing is
 *     claimed).
 *   - `{ drifted: true, … }` — the branch or HEAD moved.
 *
 * @param {{path: string, branch: string, head: string}|null} baseline stamped by
 *   `capturePrimaryCheckoutState` at spawn time
 * @param {{ agentBranch?: string|null }} [options] the agent's own worktree
 *   branch, named in the recovery prose because it is where the same commits
 *   almost certainly also live
 */
export async function detectPrimaryCheckoutDrift(baseline, { agentBranch = null } = {}) {
  if (!baseline?.path || !baseline?.branch || !baseline?.head) return { drifted: false };
  const current = await capturePrimaryCheckoutState(baseline.path);
  // Unreadable now (deleted, mid-rebase, git wedged): we verified nothing, so we
  // report nothing rather than inventing a failure.
  if (!current) return { drifted: false };
  if (current.branch === baseline.branch && current.head === baseline.head) return { drifted: false };

  const commitCount = await countCommitsAhead(baseline.path, baseline.head, current.head);
  return {
    drifted: true,
    reason: PRIMARY_CHECKOUT_MUTATED_REASON,
    category: PRIMARY_CHECKOUT_MUTATED_CATEGORY,
    baseline,
    current,
    commitCount,
    message: formatDriftMessage({ baseline, current, commitCount }),
    suggestedFix: formatDriftRecovery({ current, commitCount, agentBranch }),
  };
}

/** Human-readable "what moved". Pure. */
export function formatDriftMessage({ baseline, current, commitCount }) {
  const branchPart = current.branch === baseline.branch
    ? `branch ${current.branch}`
    : `branch ${baseline.branch} → ${current.branch}`;
  const countPart = commitCount === null
    ? 'commit count unresolved'
    : `${commitCount} new commit${commitCount === 1 ? '' : 's'}`;
  return `Worktree agent mutated the primary checkout ${baseline.path}: ${branchPart}, HEAD ${short(baseline.head)} → ${short(current.head)} (${countPart})`;
}

/**
 * The recovery advice. Names the exact commands and is explicit that the reset
 * discards commits — PortOS deliberately does not run it (see the module header).
 * Pure.
 */
export function formatDriftRecovery({ current, commitCount, agentBranch }) {
  const alsoOn = agentBranch
    ? `The same commits were almost certainly pushed on the agent's own branch \`${agentBranch}\` too, so check there (and for an open PR) before discarding anything.`
    : 'Check the agent\'s own branch (and for an open PR) for the same commits before discarding anything.';
  const countPhrase = commitCount === null ? 'commits' : `${commitCount} commit${commitCount === 1 ? '' : 's'}`;
  return [
    `A worktree-isolated agent committed to the PRIMARY checkout instead of its worktree, leaving \`${current.branch}\` carrying ${countPhrase} PortOS never reviewed.`,
    alsoOn,
    `Inspect them with \`git -C ${current.path} log --oneline origin/${current.branch}..${current.branch}\`, and once you have confirmed the content is upstream (or preserved on the agent branch) restore the checkout with \`git -C ${current.path} reset --hard origin/${current.branch}\`.`,
    'That reset DISCARDS those commits, so PortOS will not run it for you.',
  ].join(' ');
}

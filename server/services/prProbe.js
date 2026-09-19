/**
 * Forge-agnostic "what change request exists for this branch" lookup.
 *
 * Extracted out of `agentRepoStateVerification.js`'s `probePr` (#5876) so a
 * second caller — the merge-gate contract check in `agentTuiSpawning.js`,
 * which asks the same question BEFORE that module's post-teardown audit runs
 * — shares one definition instead of re-deriving the tri-state contract.
 */

import * as git from './git.js';

// `resolveForgeForRepo` spawns `git remote get-url` + `gh auth status` + `gh
// auth token` with no internal timeout, so a stalled `gh` (network / keychain
// hang) must not hold a caller open indefinitely.
const FORGE_RESOLVE_TIMEOUT_MS = 10000;

// The timer is cleared once the race settles: an uncleared one keeps the event
// loop hot for its full duration after the forge has already answered, which on
// a teardown path delays the process that is trying to finish.
const withTimeout = (promise, ms, fallback) => {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
};

/** The repo's forge CLI + credential overlay, or null when it cannot be resolved. */
const resolveForge = (sourceWorkspace) => withTimeout(
  git.resolveForgeForRepo(sourceWorkspace).catch(() => null),
  FORGE_RESOLVE_TIMEOUT_MS,
  null
);

/**
 * Resolve the open (or merged/closed) pull/merge request for `branchName`.
 *
 * Every field is tri-state: `readable: false` means the lookup itself could
 * not be completed (no forge CLI resolvable, or the forge call failed) — not
 * "no PR exists". `prState: null` with `readable: true` means the forge was
 * asked and answered "none" for this branch.
 *
 * @param {string} sourceWorkspace - a git working directory with the remote
 *   configured (a worktree qualifies — it shares its parent's git config).
 * @param {string} branchName
 * @param {{cli: string, env: object|null}|null} [resolvedForge] - a forge a
 *   delegating caller already resolved, so the `gh auth` probe chain runs once.
 * @returns {Promise<{prState: string|null, prUrl: string|null, prNumber: number|string|null, cli: string|null, readable: boolean}>}
 */
export async function probePrForBranch(sourceWorkspace, branchName, resolvedForge = null) {
  const forge = resolvedForge || await resolveForge(sourceWorkspace);
  if (!forge?.cli) return { prState: null, prUrl: null, prNumber: null, cli: null, readable: false };
  const { cli, env } = forge;
  const found = cli === 'glab'
    ? await (await import('./gitlab.js')).findMergeRequestForBranch(branchName, sourceWorkspace)
      .catch(() => ({ status: 'unavailable' }))
    : await (await import('./github.js')).findPullRequestForBranch(branchName, { cwd: sourceWorkspace, env: env || null })
      .catch(() => ({ status: 'unavailable' }));
  if (found.status === 'unavailable') return { prState: null, prUrl: null, prNumber: null, cli, readable: false };
  // `none` is a real answer, not a gap — callers that need "the agent never
  // opened one" distinguished from "we couldn't ask" read `readable` for that.
  if (found.status !== 'found') return { prState: null, prUrl: null, prNumber: null, cli, readable: true };
  return {
    prState: found.detail ? String(found.detail).toUpperCase() : null,
    prUrl: found.url || null,
    // The forge's own identifier for the change request — a GitLab `glab mr
    // merge` line needs the IID, and emitting a literal `<iid>` placeholder
    // hands a caller a command it cannot run.
    prNumber: found.number ?? null,
    cli,
    readable: !!found.detail,
  };
}

/**
 * Read ONE change request's state, by its forge-native number.
 *
 * The truth `probePrForBranch` cannot give a caller that already knows WHICH
 * change request it means: a branch lookup answers with the most recent PR on
 * that branch, and a reused branch makes that a different one. Same tri-state
 * discipline — `readable: false` is "we could not ask", never "not merged".
 *
 * GitHub answers by number directly. GitLab has no by-IID state read wired here,
 * so it goes through the branch lookup and the IID is CROSS-CHECKED: a mismatch
 * means the branch's newest MR is not the one asked about, which is unreadable
 * rather than an answer about the wrong MR.
 *
 * @param {string} sourceWorkspace - a git working directory with the remote configured
 * @param {{ number: number, branch: string }} target
 * @returns {Promise<{ prState: string|null, cli: string|null, readable: boolean }>}
 *   `prState` is upper-cased (`MERGED` / `OPEN` / `CLOSED`) when `readable`, and
 *   is named to match `probePrForBranch` so both results read the same way.
 */
export async function probeChangeRequestState(sourceWorkspace, { number, branch } = {}) {
  const unreadable = (cli = null) => ({ prState: null, cli, readable: false });
  // `Number(null)` is 0 and `Number.isSafeInteger(0)` is true, so the positivity
  // check is what keeps a missing number from being asked about as PR #0.
  const id = Number(number);
  if (!sourceWorkspace || !Number.isSafeInteger(id) || id <= 0) return unreadable();
  const forge = await resolveForge(sourceWorkspace);
  if (!forge?.cli) return unreadable();
  const { cli, env } = forge;
  if (cli === 'glab') {
    const probe = await probePrForBranch(sourceWorkspace, branch, forge);
    if (!probe.readable || Number(probe.prNumber) !== id) return unreadable(cli);
    return { prState: probe.prState, cli, readable: true };
  }
  const { getPullRequestState } = await import('./github.js');
  const view = await getPullRequestState(String(id), { cwd: sourceWorkspace, env: env || null })
    .catch(() => ({ status: 'unavailable', state: null }));
  if (view.status !== 'known' || !view.state) return unreadable(cli);
  return { prState: view.state, cli, readable: true };
}

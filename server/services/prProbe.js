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

const withTimeout = (promise, ms, fallback) => Promise.race([
  promise,
  new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
]);

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
 * @returns {Promise<{prState: string|null, prUrl: string|null, prNumber: number|string|null, cli: string|null, readable: boolean}>}
 */
export async function probePrForBranch(sourceWorkspace, branchName) {
  const forge = await withTimeout(
    git.resolveForgeForRepo(sourceWorkspace).catch(() => null),
    FORGE_RESOLVE_TIMEOUT_MS,
    null
  );
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

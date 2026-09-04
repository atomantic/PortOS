/**
 * Runtime scratch PortOS itself writes into an agent worktree.
 *
 * These files are pipeline state, never work product: the public-review harness
 * materializes a screened input bundle into the worktree it hands a reviewer
 * model, and nothing ever commits it. `git status` cannot tell that apart from a
 * half-finished feature, so a worktree holding ONLY scratch reads as "dirty with
 * uncommitted work" at every stage of the teardown chain — `removeWorktree`
 * preserved it, `reapMergedWorktrees` held it, repo-state verification filed a
 * recovery agent run against it, and branch-reconcile dispatched it to a
 * coordinator that came back "no real work product, a human should discard it".
 * Two `pr-reviewer` worktrees survived that chain indefinitely.
 *
 * Naming them here makes the classification deterministic, and
 * `classifyWorktreeDirt` (worktreeManager.js) subtracts them for every caller —
 * so the whole chain sees a clean tree rather than each consumer learning the
 * names. Kept in `lib/` (not beside the writer in `services/modelAbuseGuard.js`)
 * so the classifier can ask without importing that module's provider graph.
 *
 * Only the STATIC names live here. The completion sentinel is the same concept
 * but its name embeds a run id (`agentSentinel.js`'s `doneSentinelName(agentId)`),
 * and ignoring another run's sentinel would be wrong — so `removeWorktree` passes
 * that one through `classifyWorktreeDirt`'s per-call `ignoredPaths` instead.
 */

/** The screened input bundle handed to a public-review model. */
export const PUBLIC_REVIEW_INPUT_FILENAME = 'PORTOS_PUBLIC_REVIEW_INPUT.json';
/** Directory of read-only PR patches materialized alongside it. */
export const PUBLIC_REVIEW_PATCH_DIRNAME = '.portos-public-review';

/**
 * Worktree-relative paths (files or directory roots) that are PortOS runtime
 * scratch. A directory entry also covers everything under it.
 */
export const AGENT_SCRATCH_PATHS = [PUBLIC_REVIEW_INPUT_FILENAME, PUBLIC_REVIEW_PATCH_DIRNAME];

/**
 * Does this worktree-relative path sit at, or under, one of `roots`? Pure.
 *
 * The prefix half is why `classifyWorktreeDirt`'s `ignoredPaths` needed this
 * rather than a `Set.has`: git collapses an untracked directory to its root
 * (`.portos-public-review/`) but expands it to individual files under `-uall`,
 * and both spellings have to name the same thing.
 *
 * @param {string} path - worktree-relative path from `git status --porcelain`
 * @param {string[]} roots - file or directory-root paths
 * @returns {boolean}
 */
export function matchesScratchRoot(path, roots = []) {
  if (typeof path !== 'string' || !roots.length) return false;
  const strip = (value) => String(value ?? '').trim().replace(/\/+$/, '');
  const normalized = strip(path);
  if (!normalized) return false;
  // Both sides are stripped: `ignoredPaths: ['build/']` is the conventional way to
  // spell a directory, and matching it only in its slashless form would silently
  // ignore the option rather than fail loudly.
  return roots.some((root) => {
    const base = strip(root);
    return Boolean(base) && (normalized === base || normalized.startsWith(`${base}/`));
  });
}

/**
 * Is this worktree-relative path PortOS's own runtime scratch rather than work
 * product? Pure — `matchesScratchRoot` against the static list.
 * @param {string} path
 * @returns {boolean}
 */
export const isAgentScratchPath = (path) => matchesScratchRoot(path, AGENT_SCRATCH_PATHS);

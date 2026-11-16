/**
 * Runtime scratch PortOS itself writes into an agent worktree (pipeline state, never work product).
 *
 * `git status` cannot tell scratch from a half-finished feature, so a worktree holding ONLY scratch would read as dirty at
 * every teardown stage; `classifyWorktreeDirt` (worktreeManager.js) subtracts these names for every caller. Kept in `lib/`
 * so the classifier avoids importing the writer's provider graph. The pregate validation receipt
 * (scripts/lib/pregateReport.js, PREGATE_REPORT_PATH) is matched as that one exact file, never its cache directory.
 * Only STATIC names live here: the completion sentinel embeds a run id (`doneSentinelName(agentId)`), so `removeWorktree`
 * passes it via `classifyWorktreeDirt`'s per-call `ignoredPaths`.
 */

/** The screened input bundle handed to a public-review model. */
export const PUBLIC_REVIEW_INPUT_FILENAME = 'PORTOS_PUBLIC_REVIEW_INPUT.json';
/** Directory of read-only PR patches materialized alongside it. */
export const PUBLIC_REVIEW_PATCH_DIRNAME = '.portos-public-review';

/** Worktree-relative scratch paths (files or directory roots); a directory covers everything under it. */
export const AGENT_SCRATCH_PATHS = [PUBLIC_REVIEW_INPUT_FILENAME, PUBLIC_REVIEW_PATCH_DIRNAME];

/**
 * Does this worktree-relative path sit at, or under, one of `roots`? Pure. The prefix half matters because git collapses
 * an untracked directory to its root (`.portos-public-review/`) but expands it to files under `-uall`.
 *
 * @param {string} path - worktree-relative path from `git status --porcelain`
 * @param {string[]} roots - file or directory-root paths
 */
export function matchesScratchRoot(path, roots = []) {
  if (typeof path !== 'string' || !roots.length) return false;
  const strip = (value) => String(value ?? '').trim().replace(/\/+$/, '');
  const normalized = strip(path);
  if (!normalized) return false;
  // Both sides stripped: `ignoredPaths: ['build/']` is the conventional directory spelling and must not be silently ignored.
  return roots.some((root) => {
    const base = strip(root);
    return Boolean(base) && (normalized === base || normalized.startsWith(`${base}/`));
  });
}

/**
 * Is this worktree-relative path PortOS's own runtime scratch rather than work product?
 *
 * @param {string} path
 */
export const isAgentScratchPath = (path) => path === '.cache/pregate/report.json'
  || matchesScratchRoot(path, AGENT_SCRATCH_PATHS);

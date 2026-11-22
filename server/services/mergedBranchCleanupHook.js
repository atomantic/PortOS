/**
 * The merged-branch retirement `git.js`'s bulk cleanup delegates to, registered
 * at boot by `registerBootHooks()` (`services/bootHooks.js`).
 *
 * `cleanupMerged` lives in branch reconciliation, which statically imports
 * `git.js`; a lazy `import('./branchReconcile.js')` from `git.js` held both in
 * one CI-selection cycle (#12285, #17499). This leaf breaks that edge and must
 * import nothing. A suite exercising `deleteMergedBranches` registers a double.
 */
let cleanupMerged = null;

/**
 * @param {(repoPath: string, targetSha: string, branches: object[], options: object) => Promise<{ cleaned: string[], skipped: object[] }>} next
 */
export function registerMergedBranchCleanup(next) {
  cleanupMerged = next;
}

/** Throws when unregistered: deleting branches without the retirement gates is never a fallback. */
export function requireMergedBranchCleanup() {
  if (!cleanupMerged) throw new Error('Merged-branch cleanup is not registered (registerBootHooks() has not run)');
  return cleanupMerged;
}

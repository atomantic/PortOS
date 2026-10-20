import { forkLocalBranch, resolveTaskForkHead } from './forkHead.js';
import { isTruthyMeta } from './metadataFlags.js';
/**
 * Task target-branch metadata — one reader and one terminal-strip rule.
 *
 * A retry owns `existingBranch` as a short-lived resume pointer. A review-loop
 * follow-up instead owns `reviewLoopPRBranch`, which survives terminal cleanup so
 * it can continue to repair and merge the same PR. Older follow-ups may contain
 * both fields, so resolution remains backward compatible while new writers use
 * the single canonical review-loop key.
 */


/**
 * Resolve the branch a task must work on, or null when it should cut a fresh one.
 * The legacy `existingBranch` wins when present; review-loop follow-ups fall back
 * to their canonical PR-branch field.
 */
function rawTaskTargetBranch(metadata) {
  if (metadata?.existingBranch) return metadata.existingBranch;
  if (isTruthyMeta(metadata?.reviewLoopFollowUp) && metadata?.reviewLoopPRBranch) {
    return metadata.reviewLoopPRBranch;
  }
  return null;
}

/**
 * Does this metadata carry a retry-owned branch pointer that terminal cleanup
 * must clear? Review-loop follow-ups use `reviewLoopPRBranch` instead, so an
 * older duplicate `existingBranch` can be removed safely once a retry owns it.
 */
export function shouldStripTaskTargetBranch(metadata) {
  return !!metadata?.resumedFromAgentId;
}

/** Local checkout identity for ownership, recovery and cleanup. Retry pointers already name it. */
export function resolveTaskTargetBranch(metadata) {
  const branch = rawTaskTargetBranch(metadata);
  if (metadata?.existingBranch && metadata?.resumedFromAgentId) return branch;
  return forkLocalBranch(branch, resolveTaskForkHead(metadata));
}

/** Remote PR branch for fetching; a retry pointer stores the local namespaced branch. */
export function resolveTaskRemoteBranch(metadata) {
  const branch = rawTaskTargetBranch(metadata);
  const fork = resolveTaskForkHead(metadata);
  if (!branch || !fork || !metadata?.existingBranch || !metadata?.resumedFromAgentId) return branch;
  const localPrefix = forkLocalBranch('__branch__', fork).slice(0, -'__branch__'.length);
  return branch.startsWith(localPrefix) ? branch.slice(localPrefix.length) : branch;
}

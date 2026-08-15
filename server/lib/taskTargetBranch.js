/**
 * Task target-branch metadata — one reader and one terminal-strip rule.
 *
 * A retry owns `existingBranch` as a short-lived resume pointer. A review-loop
 * follow-up instead owns `reviewLoopPRBranch`, which survives terminal cleanup so
 * it can continue to repair and merge the same PR. Older follow-ups may contain
 * both fields, so resolution remains backward compatible while new writers use
 * the single canonical review-loop key.
 */

const isTruthyMetadataFlag = (value) => value === true || value === 'true';

/**
 * Resolve the branch a task must work on, or null when it should cut a fresh one.
 * The legacy `existingBranch` wins when present; review-loop follow-ups fall back
 * to their canonical PR-branch field.
 */
export function resolveTaskTargetBranch(metadata) {
  if (metadata?.existingBranch) return metadata.existingBranch;
  if (isTruthyMetadataFlag(metadata?.reviewLoopFollowUp) && metadata?.reviewLoopPRBranch) {
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

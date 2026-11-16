/**
 * `mergeQuotaBurnPatch(base, patch)` mirrors the server's quota-burn config merge so the Quota Burn
 * page can apply edits optimistically and batch debounced PUTs.
 */

/**
 * Merge a partial quota-burn config patch over a base, mirroring `saveQuotaBurnConfig` on the server: top-level and per-family keys merge and a family's `jobs` array REPLACES (an ordered list; a positional merge would make
 * reordering and deletion inexpressible). Used for optimistic local state and for folding successive edits into ONE pending body, so the client's view can't drift from what the server persists.
 */
export function mergeQuotaBurnPatch(base, patch) {
  const families = { ...(base?.families || {}) };
  for (const [id, familyPatch] of Object.entries(patch?.families || {})) {
    families[id] = { ...(families[id] || {}), ...familyPatch };
  }
  const merged = { ...(base || {}), ...(patch || {}) };
  // Omit an empty `families` rather than `families: {}`: a top-level-only edit should PUT exactly the key it changed.
  if (Object.keys(families).length) merged.families = families;
  else delete merged.families;
  return merged;
}

/**
 * Whether a step has already had its one dispatch: the client's mirror of the server's `jobIsSpent`, taking `ranAt` from the status feed. Gated on the step's OWN `runOnce` and read from the page's optimistic config: a completion
 * is kept after the checkbox is cleared, so ticking "run once" on a step that already ran must SHOW it as spent (with Re-arm) rather than drop it from the rotation. One definition because the row badge and the family card count both need it.
 */
export const quotaBurnJobIsSpent = (job, ranAt) => Boolean(job?.runOnce && ranAt);

import { QUOTA_BURN_UNLIMITED_DISPATCHES, isUnlimitedDispatchCap } from '../../../server/lib/quotaBurnDispatchCap.js';
export { isUnlimitedDispatchCap };
/** The `maxDispatchesPerWindow` "no cap" sentinel (the server default). */
export const UNLIMITED_DISPATCHES = QUOTA_BURN_UNLIMITED_DISPATCHES;

/**
 * What to PUT for a dispatch cap the user just typed. Anything below the minimum of 1 collapses to the sentinel: 0 isn't accepted by the PUT schema (the family switch already expresses "never burn"),
 * so stepping the spinner below 1 would 400 and take every coalesced edit with it.
 */
export const dispatchCapInput = (value) => (value < 1 ? UNLIMITED_DISPATCHES : value);


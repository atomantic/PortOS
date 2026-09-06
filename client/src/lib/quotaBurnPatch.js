/**
 * Merge a partial quota-burn config patch over a base, mirroring exactly what
 * `saveQuotaBurnConfig` does on the server: top-level and per-family keys merge,
 * and a family's `jobs` array REPLACES (it is an ordered list — a positional
 * merge would make reordering and deletion inexpressible).
 *
 * Used twice on the page, both for the same reason: the config form must reflect
 * a keystroke immediately while the PUT is debounced.
 *   1. Optimistic local state — apply the patch to the rendered config now.
 *   2. Pending-patch accumulation — fold successive edits into ONE body so the
 *      trailing PUT carries every change, not just the last field touched.
 *
 * Keeping it here (pure, shared) is what keeps the client's optimistic view from
 * drifting from what the server will actually persist.
 */
export function mergeQuotaBurnPatch(base, patch) {
  const families = { ...(base?.families || {}) };
  for (const [id, familyPatch] of Object.entries(patch?.families || {})) {
    families[id] = { ...(families[id] || {}), ...familyPatch };
  }
  const merged = { ...(base || {}), ...(patch || {}) };
  // Omit an empty `families` rather than sending `families: {}` — a
  // top-level-only edit (the master switch, the interval) should PUT exactly the
  // key it changed, so the request reads as what the user did.
  if (Object.keys(families).length) merged.families = families;
  else delete merged.families;
  return merged;
}

/**
 * Whether a step has already had its one dispatch — the client's mirror of the
 * server's `jobIsSpent`, taking the row's `ranAt` from the status feed instead
 * of the whole keyed ledger.
 *
 * Gated on the step's OWN `runOnce`, not on `ranAt` alone, and read from the
 * page's optimistic config rather than the server's copy: a completion is kept
 * even after the checkbox is cleared, so ticking "run once" on a step that
 * already ran must SHOW that it is spent (with Re-arm right there) instead of
 * silently dropping it out of the rotation until the next status read.
 *
 * One definition because two components need it — the row renders the badge and
 * the family card counts them — and a rule split across both drifts the first
 * time either changes.
 */
export const quotaBurnJobIsSpent = (job, ranAt) => Boolean(job?.runOnce && ranAt);

/**
 * `QUOTA_BURN_UNLIMITED_DISPATCHES` in `server/lib/quotaBurnConfig.js`: the
 * `maxDispatchesPerWindow` value that means the window is not counted at all,
 * and the default. Mirrored (not imported) for the same reason the merge above
 * is — the client cannot reach into `server/`.
 */
export const UNLIMITED_DISPATCHES = -1;

/** Mirrors the server's `isUnlimitedDispatchCap`: any negative cap means no cap. */
export const isUnlimitedDispatchCap = (cap) => Number(cap) < 0;

/**
 * What to PUT for a dispatch cap the user just typed.
 *
 * Anything below the real minimum of 1 collapses to the sentinel rather than
 * being sent as-is: 0 is not a value the PUT schema accepts (it would read as
 * "never burn", which the family switch already expresses), so stepping the
 * spinner down past 1 would otherwise 400 — taking every edit coalesced into
 * that body with it. -1 is the natural continuation of "fewer restrictions".
 */
export const dispatchCapInput = (value) => (value < 1 ? UNLIMITED_DISPATCHES : value);


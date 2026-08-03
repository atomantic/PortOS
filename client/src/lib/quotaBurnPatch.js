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

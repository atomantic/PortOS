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
 * Apply a catalog preset to a burn job, returning the next job.
 *
 * A preset is a TEMPLATE: its prompt and recommended flags are copied in, and
 * from then on the job owns them. Two things are deliberately preserved rather
 * than overwritten, because they are choices the preset cannot make:
 *   - `label` — only filled when blank, so applying a preset to a step the user
 *     named does not rename it.
 *   - `params.appId` — which managed app the work targets. Wiping it would turn
 *     "make this step a UX audit" into a silently unrunnable job whose only
 *     symptom is a status line at the bottom of the row.
 */
export function applyQuotaBurnPreset(job, preset) {
  if (!preset) return job;
  const { appId } = job?.params || {};
  return {
    ...job,
    label: job?.label?.trim() ? job.label : preset.label,
    jobType: preset.jobType || job?.jobType,
    params: { ...(job?.params || {}), ...(preset.params || {}), ...(appId ? { appId } : {}) },
  };
}

/**
 * A brand-new job seeded from a preset. `id` is passed in rather than minted
 * here so this stays pure (and so the caller keeps using whatever id scheme the
 * rest of its list uses).
 */
export function jobFromPreset(preset, { id, appId = null } = {}) {
  return applyQuotaBurnPreset({
    id, enabled: true, label: '', jobType: preset.jobType, model: null, providerId: null,
    params: appId ? { appId } : {},
  }, preset);
}

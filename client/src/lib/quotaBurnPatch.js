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
 *   - `runOnce` — whether this is one-shot or standing work. The presets are
 *     standing audits, but the user may have marked a step "run once" for their
 *     own reasons, and re-picking a preset must not quietly put it back into the
 *     rotation to spend quota on every lap.
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
    id, enabled: true, label: '', jobType: preset.jobType, model: null, providerId: null, effort: null,
    // Standing work, matching a hand-added step: an audit dimension is worth
    // re-running as the code changes.
    runOnce: false,
    params: appId ? { appId } : {},
  }, preset);
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
 * Whether a preset is already represented in a family's jobs list.
 * Matched by comparing the trimmed prompt text (or jobType + label for non-prompt presets).
 */
export function isPresetInJobs(preset, jobs = []) {
  if (!preset) return false;
  const presetPrompt = String(preset.params?.prompt || '').trim();
  if (presetPrompt) {
    return (jobs || []).some(
      (job) => String(job?.params?.prompt || '').trim() === presetPrompt,
    );
  }
  return (jobs || []).some(
    (job) => job?.jobType === preset.jobType && job?.label === preset.label,
  );
}

/**
 * Filter catalog presets to only those not currently in the given jobs list.
 */
export function getAvailablePresetsForJobs(presets = [], jobs = []) {
  return (presets || []).filter((preset) => !isPresetInJobs(preset, jobs));
}

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


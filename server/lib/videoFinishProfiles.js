/**
 * Video draft → delivery ("Finish") profiles (issue #3696).
 *
 * A *draft* model is a fast, low-step variant a user composes with; a
 * *delivery* model is the slower sibling that renders the same composition at
 * full quality. When the two share identical base weights, re-rendering the
 * draft's prompt + resolved seed + dials on the delivery model reproduces the
 * same composition instead of re-rolling it — that is the entire point of the
 * Finish action.
 *
 * The relationship is declared here (not inferred from names) and attached to
 * registry entries as `finishModelId` by `applyVideoFinishProfiles`, the same
 * load-time backfill pattern `applyVideoDisclosures` uses in
 * `lib/videoDisclosure.js`. Migration 238 makes it durable on disk for installs
 * that already persisted `data/media-models.json`.
 *
 * Rules this module exists to enforce:
 *   - Only genuinely compatible pairs are declared. "Compatible" means the
 *     same runtime, the same base `repo`, and the same `supportedModes` — the
 *     pair differs only in the step count / sampler / adaptor weights. A pair
 *     that merely sounds related (a distilled Q4 vs a bf16 build of a different
 *     checkpoint) is NOT declared: its seeds do not reproduce each other's
 *     composition, so "finishing" it would silently be a re-roll.
 *   - The graph is validated (`validateFinishProfileGraph`) so a typo fails
 *     loudly rather than surfacing as a Finish button that targets nothing.
 *     Invalid edges are stripped at load with a warning — a user-edited
 *     registry must never crash boot (`loadMediaModels` runs at import time).
 *
 * NOTE: the I2V lightning → full pair is deliberately NOT declared yet. Finish
 * currently only offers itself for fully reproducible text-to-video records
 * (image-conditioned drafts have no durable reference to re-render from), so an
 * I2V edge would be config that can never fire.
 */

/**
 * Shipped draft → delivery edges, keyed by the DRAFT entry id.
 *
 * `shippedRepo` is the fork-preservation guard (same contract as
 * `applyVideoDisclosures` / `backfillKvRepo`): the profile is only attached
 * while the entry still points at the repo the pair was established against. A
 * user who re-pointed `repo` at a fork keeps no Finish target rather than
 * inheriting a claim about weights we can no longer vouch for.
 */
export const VIDEO_FINISH_PROFILES = Object.freeze({
  // Wan 2.2 T2V A14B: the Lightning entry is the SAME repo at the SAME pinned
  // revision as the full entry — it differs only by the 4-step Seko LoRA
  // adaptor, a locked euler sampler, and guidance 1.0. Dropping the adaptor and
  // rendering the same seed at 20 steps is the canonical draft → delivery hop.
  wan22_t2v_a14b_lightning: Object.freeze({
    shippedRepo: 'AbstractFramework/wan2.2-t2v-a14b-diffusers-8bit',
    finishModelId: 'wan22_t2v_a14b',
  }),
});

const isEntry = (entry) => !!entry && typeof entry === 'object' && typeof entry.id === 'string';

/**
 * Attach `finishModelId` to shipped draft entries that don't already carry one.
 * Pure; returns a new array and never mutates the input entries.
 *
 * Preservation contract (mirrors migration 238):
 *   - `'finishModelId' in entry` → user/existing value wins (including `null`,
 *     the explicit "this draft has no delivery target" override).
 *   - entry id not shipped       → custom model, left as-is.
 *   - `repo` differs from shipped → forked weights, left as-is.
 */
export const applyVideoFinishProfiles = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isEntry(entry)) return entry;
    if ('finishModelId' in entry) return entry;
    const spec = VIDEO_FINISH_PROFILES[entry.id];
    if (!spec) return entry;
    if (spec.shippedRepo !== null && entry.repo !== spec.shippedRepo) return entry;
    return { ...entry, finishModelId: spec.finishModelId };
  });
};

/**
 * Validate every `finishModelId` edge in one platform's video model list.
 * Pure — returns an array of `{ id, finishModelId, reason }` problems (empty
 * when the graph is sound). Callers decide whether to warn-and-strip (load
 * path) or fail (the test that pins the shipped registry).
 *
 * Checked, in the order a typo is most likely to hit:
 *   - the value is a non-empty string
 *   - it is not a self-reference
 *   - the target exists in the SAME platform list (a delivery model the user
 *     deleted, or one that only exists on the other platform, is unusable)
 *   - the target is not itself a draft (no chains, and therefore no cycles —
 *     a chain would make "Finish" ambiguous about where it lands)
 *   - runtime, base `repo` and `supportedModes` match, i.e. the pair really is
 *     the same weights at a different step budget
 */
export const validateFinishProfileGraph = (list) => {
  if (!Array.isArray(list)) return [];
  const byId = new Map(list.filter(isEntry).map((e) => [e.id, e]));
  const problems = [];
  const fail = (id, finishModelId, reason) => problems.push({ id, finishModelId, reason });
  for (const entry of list) {
    if (!isEntry(entry)) continue;
    const target = entry.finishModelId;
    if (target === undefined || target === null) continue;
    if (typeof target !== 'string' || target.length === 0) {
      fail(entry.id, target, 'finishModelId must be a non-empty string');
      continue;
    }
    if (target === entry.id) {
      fail(entry.id, target, 'finishModelId points at itself');
      continue;
    }
    const to = byId.get(target);
    if (!to) {
      fail(entry.id, target, `finishModelId "${target}" is not a video model in this platform's list`);
      continue;
    }
    if (to.finishModelId !== undefined && to.finishModelId !== null) {
      fail(entry.id, target, `finishModelId "${target}" is itself a draft (chained finish targets are not supported)`);
      continue;
    }
    if (entry.runtime !== to.runtime) {
      fail(entry.id, target, `runtime mismatch (${entry.runtime || '?'} → ${to.runtime || '?'})`);
      continue;
    }
    if (entry.repo !== to.repo) {
      fail(entry.id, target, `base repo mismatch (${entry.repo || '?'} → ${to.repo || '?'})`);
      continue;
    }
    const fromModes = [...(entry.supportedModes || [])].sort().join(',');
    const toModes = [...(to.supportedModes || [])].sort().join(',');
    if (fromModes !== toModes) {
      fail(entry.id, target, `supportedModes mismatch (${fromModes || '?'} → ${toModes || '?'})`);
    }
  }
  return problems;
};

/**
 * Load-time guard: strip every invalid `finishModelId` from a video model list,
 * logging each one. A user-edited (or migration-stale) registry must not be
 * able to surface a Finish button that targets a model this install can't run,
 * and must not crash boot. Returns the input array unchanged when the graph is
 * sound, so the common path allocates nothing.
 */
export const sanitizeFinishProfiles = (list) => {
  const problems = validateFinishProfileGraph(list);
  if (problems.length === 0) return list;
  const bad = new Set(problems.map((p) => p.id));
  for (const p of problems) {
    console.log(`⚠️ media-models: dropping finishModelId on "${p.id}" — ${p.reason}`);
  }
  return list.map((entry) => {
    if (!isEntry(entry) || !bad.has(entry.id)) return entry;
    const { finishModelId, ...rest } = entry;
    return rest;
  });
};

/**
 * Resolve the delivery model a draft entry finishes into, scoped to the models
 * this install can actually run (`getVideoModels()` output — already filtered
 * for platform-broken entries). Returns the target entry, or `null` when the
 * draft declares no target or the target isn't available here.
 */
export const finishTargetForModel = (model, availableModels) => {
  const targetId = model?.finishModelId;
  if (typeof targetId !== 'string' || targetId.length === 0) return null;
  if (!Array.isArray(availableModels)) return null;
  return availableModels.find((m) => m?.id === targetId) || null;
};

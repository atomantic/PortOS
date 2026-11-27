/**
 * Video draft → delivery ("Finish") profiles (#3696). A *draft* model is a fast low-step variant; a *delivery* model is its slower sibling rendering the same composition at full quality.
 *
 * When they share base weights, re-rendering the draft's prompt + resolved seed + dials on the delivery model reproduces the composition instead of re-rolling it (the point of Finish). `VIDEO_FINISH_PROFILES` declares each draft entry id → `{ shippedRepo, finishModelId }` (declared, not inferred from names), only for pairs sharing runtime, base `repo` and `supportedModes` (differing in step count / sampler / adaptor weights). A pair that merely sounds related (distilled Q4 vs a bf16 build of a different checkpoint) is NOT declared: its seeds don't reproduce each other, so "finishing" would silently re-roll. `applyVideoFinishProfiles(list)` is the load-time backfill (twin of migration 238, same pattern as `applyVideoDisclosures` in `lib/videoDisclosure.js`; existing key wins, custom id skipped, forked `repo` skipped); `validateFinishProfileGraph(list)` returns graph problems (missing / self-referencing / chained target, runtime / repo / supportedModes mismatch); `sanitizeFinishProfiles(list)` warns + strips them at load so a typo never surfaces a Finish button targeting nothing and a user-edited registry never crashes boot (`loadMediaModels` runs at import time); `finishTargetForModel(model, availableModels)` resolves the delivery entry scoped to what this install can run.
 *
 * The I2V lightning → full pair is deliberately NOT declared: Finish only offers itself for fully reproducible text-to-video records (image-conditioned drafts have no durable reference), so an I2V edge could never fire.
 */

/** Shipped draft → delivery edges, keyed by the DRAFT entry id. `shippedRepo` is the fork-preservation guard (as `applyVideoDisclosures` / `backfillKvRepo`): attached only while the entry still points at the repo the pair was established against. */
export const VIDEO_FINISH_PROFILES = Object.freeze({
  // Wan 2.2 T2V A14B: the Lightning entry is the SAME repo and pinned revision as the full entry, differing only by the 4-step Seko LoRA adaptor, a locked euler sampler and guidance 1.0; dropping the adaptor at 20 steps is the canonical draft → delivery hop.
  wan22_t2v_a14b_lightning: Object.freeze({
    shippedRepo: 'AbstractFramework/wan2.2-t2v-a14b-diffusers-8bit',
    finishModelId: 'wan22_t2v_a14b',
  }),
});

const isEntry = (entry) => !!entry && typeof entry === 'object' && typeof entry.id === 'string';

/**
 * Attach `finishModelId` to shipped draft entries that don't already carry one. Pure; never mutates the input. Preservation contract (mirrors migration 238): `'finishModelId' in entry` wins (even `null`,
 * the explicit "no delivery target" override); unshipped ids (custom) and entries whose `repo` differs (forked weights) are left as-is.
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
 * Validate every `finishModelId` edge in one platform's video model list. Pure; returns `{ id, finishModelId, reason }` problems (empty when sound); callers warn-and-strip (load path) or fail (the shipped-registry test).
 * Checked: the value is a non-empty string; not a self-reference; the target exists in the SAME platform list; the target is not itself a draft (no chains, so no cycles and no ambiguity about where Finish lands);
 * runtime, base `repo` and `supportedModes` match (the same weights at a different step budget).
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

/** Load-time guard: strip every invalid `finishModelId`, logging each, so a user-edited or migration-stale registry can't surface a Finish button targeting a model this install can't run or crash boot. Returns the input unchanged when sound. */
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

/** Resolve the delivery model a draft finishes into, scoped to the models this install can run (`getVideoModels()` output, already filtered for platform-broken entries): the target entry, or `null`. */
export const finishTargetForModel = (model, availableModels) => {
  const targetId = model?.finishModelId;
  if (typeof targetId !== 'string' || targetId.length === 0) return null;
  if (!Array.isArray(availableModels)) return null;
  return availableModels.find((m) => m?.id === targetId) || null;
};

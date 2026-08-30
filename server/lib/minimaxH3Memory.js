/**
 * MiniMax H3 memory profiles (issue #5420).
 *
 * A *memory profile* is one runner-proven weight-placement recipe together with
 * the capacity it honestly needs: a host-RAM floor, and — on the CUDA lane — a
 * device-VRAM floor. H3 is the one video model in the catalog whose components
 * do not fit anywhere unassisted (66.3 GB transformer + 66.7 GB Qwen3-VL
 * conditioner at bf16), so "does this box have enough" is not a display detail
 * here: picking wrong costs a multi-hour load that OOMs at the far end.
 *
 * Before this table there were two independent, unenforced answers to that
 * question:
 *
 *   - the registry entry's single `memoryGb` number (128 MLX / 96 CUDA), which
 *     nothing checked at render time — it only ever rendered as a UI fact; and
 *   - a VRAM heuristic living inside `resolve_offload_profile()` in
 *     scripts/generate_minimax_h3_cuda.py, which picked a recipe from the
 *     card's nameplate VRAM, never failed closed below the smallest recipe's
 *     floor, and returned an explicitly pinned profile without checking the
 *     device could run it at all.
 *
 * This module is the single declaration both sides now read. **Every capacity
 * number below already existed in the codebase** — the CUDA tiers are the exact
 * thresholds hoisted out of that heuristic, and the host floors are the
 * entries' own `memoryGb`. The one new number is `MINIMAX_H3_HOST_RESERVE_GB`,
 * which is a policy reserve (headroom left for the OS and PortOS itself), not a
 * claim about the model.
 *
 * ## Why the profiles attach to entries rather than being looked up
 *
 * `applyMiniMaxH3MemoryProfiles` is the same load-time backfill the three
 * sibling decorators use (`applyVideoDisclosures`, `applyVideoFinishProfiles`,
 * `applyVideoSpeedProfiles`), so the client receives the table on the model it
 * already fetches — no second endpoint, and no client-side mirror of the
 * numbers to drift. It carries the same pin guard for the same reason a speed
 * profile does: a placement recipe is validated against ONE set of weights, so
 * an entry re-pointed at a fork or moved off the pinned revision keeps no
 * capacity claim we can no longer back.
 *
 * ## Fail closed, and only on a MEASURED shortfall
 *
 * `miniMaxH3MemoryError` refuses a render whose box cannot hold any declared
 * profile. It refuses only when the shortfall was actually measured: an unknown
 * `totalMemoryGb` is "not measured", which is NOT the same as zero, and must
 * not block a render on a host whose capacity probe simply returned nothing.
 * The runners re-check with their own view of the machine, so an unknown here
 * is a deferral rather than a bypass.
 *
 * Pure module: no I/O, no imports out to services.
 */

/**
 * Host RAM held back from the model's allocator, in GB.
 *
 * A render is not the only thing on the machine: PortOS itself, Postgres, the
 * client build and the OS all need to stay resident, and an H3 render that
 * consumes the last gigabyte takes the install down with it rather than
 * failing. This is a deliberate policy reserve — the only number in this module
 * that is not lifted from an existing runner-proven constant.
 *
 * It caps the ALLOCATOR (`apply_memory_limit` in scripts/generate_minimax_h3.py)
 * and is reported beside the requirement; it is deliberately NOT subtracted
 * before comparing against `minMemoryGb`. Those floors were hoisted from the
 * entries' `memoryGb`, which has always been a claim about TOTAL system memory,
 * so netting the reserve off first would silently move the 128 GB model onto a
 * 144 GB machine — refusing every box the entry was written for.
 */
export const MINIMAX_H3_HOST_RESERVE_GB = 16;

/**
 * The auto-selection request. Absence and `'auto'` are the same request, the
 * way `'quality'` and absence are for a speed profile: the runner sizes a
 * recipe from the hardware it can actually see.
 */
export const MINIMAX_H3_AUTO_PROFILE_ID = 'auto';

/**
 * Shipped profiles, keyed by registry entry id, best-first.
 *
 * `shippedRepo` / `shippedRevision` are the pin guards. Each profile:
 *
 *   id           stable key. On the CUDA lane this IS the `--offload-profile`
 *                value the runner takes, so the two cannot name a recipe
 *                differently (pinned by minimaxH3Memory.test.js).
 *   name         label for the UI
 *   description  one line stating what the recipe actually does
 *   minMemoryGb  TOTAL host-RAM floor — the same quantity the entry's
 *                `memoryGb` has always stated, not a post-reserve figure
 *   minVramGb    device-VRAM floor, or null when the device memory IS the host
 *                memory (Apple unified memory)
 *   unified      true when host and device memory are the same pool
 */
export const MINIMAX_H3_MEMORY_PROFILES = Object.freeze({
  // PipeNetwork's Apple-Silicon MLX port. ONE profile deliberately: the port
  // has a single placement (8-bit DiT plus the bf16 conditioner, all in unified
  // memory), and 128 GB is the figure the shipped entry has always stated. A
  // lower "compact" tier would need a measurement on real hardware that this
  // repo does not have, and a fabricated floor on a multi-hour render is worse
  // than no tier at all. Adding one later is pure data.
  minimax_h3_8bit: Object.freeze({
    shippedRepo: 'pipenetwork/MiniMax-H3-MLX-8bit',
    shippedRevision: '3ac52081470b0488921c3ec3ba84a39097bf2361',
    profiles: Object.freeze([
      Object.freeze({
        id: 'unified-8bit',
        name: 'Unified 8-bit',
        description: '8-bit quantized DiT with the bf16 Qwen3-VL conditioner, resident in unified memory.',
        minMemoryGb: 128,
        minVramGb: null,
        unified: true,
      }),
    ]),
  }),
  // diffusers' MiniMaxH3ModularPipeline on NVIDIA. The three recipes and their
  // thresholds are `resolve_offload_profile()`'s own, moved here so the server
  // can preflight them and the runner can fail closed on the same table instead
  // of silently returning the leanest recipe for a card that cannot run it.
  // The host floor is 96 GB on all three: at int8 roughly 75 GB of weights stay
  // resident in CPU memory for the whole render regardless of which recipe
  // streams them, and bf16's auto-CPU-offload holds a whole component there.
  minimax_h3_cuda: Object.freeze({
    shippedRepo: 'MiniMaxAI/MiniMax-H3',
    shippedRevision: '42ed227ee7df40d41602854ae760620d6eb651fe',
    profiles: Object.freeze([
      Object.freeze({
        id: 'bf16',
        name: 'bf16 with CPU offload',
        description: 'Unquantized components swapped by the components manager, with a 12 GB device reserve.',
        minMemoryGb: 96,
        // The floor for holding one bf16 component resident while the manager
        // swaps the other.
        minVramGb: 60,
        unified: false,
      }),
      Object.freeze({
        id: 'int8-stream',
        name: 'int8, streamed blocks',
        description: 'int8 weight-only quantization with block-level transformer offload streamed onto the card.',
        minMemoryGb: 96,
        // Below this a transformer block plus its activations stops fitting
        // beside the video VAE, and the leaf-level recipe takes over.
        minVramGb: 20,
        unified: false,
      }),
      Object.freeze({
        id: 'int8-lean',
        name: 'int8, leaf-level',
        description: 'int8 weight-only quantization with leaf-level offload for the transformer, conditioner and video VAE.',
        minMemoryGb: 96,
        // The runner documents this recipe as the 12-16 GB card path. Below it
        // nothing in the table fits, which is now an error rather than a
        // silently-returned recipe that OOMs after the load.
        minVramGb: 12,
        unified: false,
      }),
    ]),
  }),
});

const isEntry = (entry) => !!entry && typeof entry === 'object' && typeof entry.id === 'string';

const positiveNumber = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);

/**
 * Attach `memoryProfiles` to shipped entries that don't already carry the key.
 * Pure; returns a new array and never mutates the input entries.
 *
 * Preservation contract (mirrors migration 317 and the sibling decorators):
 *   - `'memoryProfiles' in entry` → user/existing value wins (including `null`
 *     or `[]`, the explicit "no declared profiles" override)
 *   - entry id not shipped → custom model, left as-is
 *   - `repo` or `revision` differs from the pin → left as-is
 */
export const applyMiniMaxH3MemoryProfiles = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isEntry(entry)) return entry;
    if ('memoryProfiles' in entry) return entry;
    const spec = MINIMAX_H3_MEMORY_PROFILES[entry.id];
    if (!spec) return entry;
    if (spec.shippedRepo !== null && entry.repo !== spec.shippedRepo) return entry;
    if (spec.shippedRevision !== null && entry.revision !== spec.shippedRevision) return entry;
    return { ...entry, memoryProfiles: spec.profiles.map((profile) => ({ ...profile })) };
  });
};

/**
 * The profiles a model declares, best-first, or `[]`.
 */
export const miniMaxH3MemoryProfiles = (model) => (
  Array.isArray(model?.memoryProfiles)
    ? model.memoryProfiles.filter((profile) => typeof profile?.id === 'string' && profile.id)
    : []
);

/**
 * Host RAM left for the model's allocator after the reserve, or `null` when
 * capacity wasn't measured. Reported and used to cap the allocator — NOT the
 * quantity profile floors are compared against (see the reserve's docblock).
 *
 * `null` is the sentinel for "not measured" and is deliberately distinct from
 * a measured small number — a capacity probe that returned nothing must not
 * read as a box with no memory.
 */
export const miniMaxH3UsableMemoryGb = (totalMemoryGb) => {
  const total = positiveNumber(totalMemoryGb);
  return total === null ? null : Math.max(0, total - MINIMAX_H3_HOST_RESERVE_GB);
};

/**
 * The best profile this box's total host memory can hold, plus what it was
 * measured against. VRAM is deliberately not considered here: the server has no
 * synchronous view of the device, and the runner — which does — re-selects on
 * the same table before it loads anything.
 *
 * @returns {{ profile, usableMemoryGb, totalMemoryGb }} with `profile: null`
 *   when the model declares none or nothing fits. `totalMemoryGb: null` means
 *   the host was not measured, in which case the best declared profile is
 *   returned unjudged for the runner to confirm.
 */
export const selectMiniMaxH3MemoryProfile = ({ model, totalMemoryGb } = {}) => {
  const profiles = miniMaxH3MemoryProfiles(model);
  const usableMemoryGb = miniMaxH3UsableMemoryGb(totalMemoryGb);
  const total = positiveNumber(totalMemoryGb);
  if (profiles.length === 0) return { profile: null, usableMemoryGb, totalMemoryGb: total };
  if (total === null) return { profile: profiles[0], usableMemoryGb, totalMemoryGb: total };
  const profile = profiles.find((candidate) => {
    const floor = positiveNumber(candidate.minMemoryGb);
    return floor === null || total >= floor;
  }) || null;
  return { profile, usableMemoryGb, totalMemoryGb: total };
};

/**
 * The smallest host-RAM floor any declared profile has, or `null`.
 */
const smallestHostFloorGb = (profiles) => profiles.reduce((smallest, profile) => {
  const floor = positiveNumber(profile.minMemoryGb);
  if (floor === null) return smallest;
  return smallest === null || floor < smallest ? floor : smallest;
}, null);

/**
 * Why this machine cannot run H3, or `null` when it can (or when capacity was
 * not measured, which defers to the runner rather than blocking).
 *
 * Returned as a plain `{ code, message }` rather than thrown so the caller
 * decides the boundary — the render path turns it into a `ServerError`, and a
 * status/readiness surface can render it as a fact.
 */
export const miniMaxH3MemoryDeclineReason = ({ model, modelId, totalMemoryGb } = {}) => {
  const profiles = miniMaxH3MemoryProfiles(model);
  if (profiles.length === 0) return null;
  const { profile, totalMemoryGb: measured } = selectMiniMaxH3MemoryProfile({ model, totalMemoryGb });
  if (measured === null || profile) return null;
  const floor = smallestHostFloorGb(profiles);
  const name = model?.name || modelId || model?.id || 'This model';
  return {
    code: 'MINIMAX_H3_MEMORY_INSUFFICIENT',
    message: `${name} needs at least ${floor} GB of memory for its smallest weight-placement profile. `
      + `This machine has ${Math.round(measured)} GB. `
      + `Render on a peer with more memory, or pick a smaller model.`,
  };
};

/**
 * Validate one platform's video list for memory-profile problems. Pure —
 * returns `{ id, profileId, reason }` rows (empty when sound). Same division of
 * labour as `validateSpeedProfileTable`: callers decide whether to
 * warn-and-strip (load path) or fail (the test pinning the shipped registry).
 *
 * Checked, in the order a hand-edit is most likely to break it:
 *   - `memoryProfiles` is an array (or absent)
 *   - every profile has a non-empty string id, unique within the entry
 *   - no profile claims the reserved auto id
 *   - `minMemoryGb` is a positive finite number — a NaN floor would make every
 *     comparison false and silently refuse every render
 *   - `minVramGb`, when present, is a positive finite number
 *   - profiles are ordered best-first by host floor, since selection takes the
 *     FIRST that fits and a mis-ordered table would hand a big box the leanest
 *     recipe
 */
export const validateMiniMaxH3MemoryProfileTable = (list) => {
  if (!Array.isArray(list)) return [];
  const problems = [];
  const fail = (id, profileId, reason) => problems.push({ id, profileId, reason });
  for (const entry of list) {
    if (!isEntry(entry)) continue;
    if (!('memoryProfiles' in entry) || entry.memoryProfiles == null) continue;
    if (!Array.isArray(entry.memoryProfiles)) {
      fail(entry.id, null, 'memoryProfiles must be an array');
      continue;
    }
    const seen = new Set();
    let previousFloor = null;
    let entryFailed = false;
    for (const profile of entry.memoryProfiles) {
      const pid = profile?.id;
      if (typeof pid !== 'string' || pid.length === 0) {
        fail(entry.id, pid ?? null, 'profile id must be a non-empty string');
        entryFailed = true;
        break;
      }
      if (pid === MINIMAX_H3_AUTO_PROFILE_ID) {
        fail(entry.id, pid, `"${MINIMAX_H3_AUTO_PROFILE_ID}" is the reserved auto-selection id`);
        entryFailed = true;
        break;
      }
      if (seen.has(pid)) {
        fail(entry.id, pid, `duplicate profile id "${pid}"`);
        entryFailed = true;
        break;
      }
      seen.add(pid);
      const floor = positiveNumber(profile.minMemoryGb);
      if (floor === null) {
        fail(entry.id, pid, 'minMemoryGb must be a positive number');
        entryFailed = true;
        break;
      }
      if (profile.minVramGb != null && positiveNumber(profile.minVramGb) === null) {
        fail(entry.id, pid, 'minVramGb must be a positive number when present');
        entryFailed = true;
        break;
      }
      if (previousFloor !== null && floor > previousFloor) {
        fail(entry.id, pid, 'memoryProfiles must be ordered best-first (non-increasing minMemoryGb)');
        entryFailed = true;
        break;
      }
      previousFloor = floor;
    }
    if (entryFailed) continue;
  }
  return problems;
};

/**
 * Load-time guard: strip every invalid `memoryProfiles` list, logging each
 * problem. A hand-edited registry must not be able to refuse every render with
 * a NaN floor, and must not crash boot (`loadMediaModels` runs at import time).
 * Returns the input array unchanged when the table is sound.
 */
export const sanitizeMiniMaxH3MemoryProfiles = (list) => {
  const problems = validateMiniMaxH3MemoryProfileTable(list);
  if (problems.length === 0) return list;
  const bad = new Set(problems.map((problem) => problem.id));
  for (const problem of problems) {
    console.log(`⚠️ media-models: dropping memoryProfiles on "${problem.id}" — ${problem.reason}`);
  }
  return list.map((entry) => {
    if (!isEntry(entry) || !bad.has(entry.id)) return entry;
    const { memoryProfiles: _dropped, ...rest } = entry;
    return rest;
  });
};

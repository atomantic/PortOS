/** Load-time normalization, compatibility backfills, and retirement of shipped media model entries. */

import { DEFAULT_REGISTRY, FASTMETAL_DOWNLOAD_SIZE_PROFILES, FLUX3_KLEIN_REVISIONS, MINIMAX_H3_OUTPUT_PROFILE } from './catalogDefaults.js';
import { FLUX2_REVISION_FIELDS } from './metadata.js';
import { isPlainObject } from '../objects.js';
import {
  LEGACY_VIDEO_KEYS,
  VIDEO_BUCKET_CUDA,
  VIDEO_BUCKETS,
  VIDEO_DEFAULT_KEYS,
  readVideoBucket,
  readVideoDefault,
} from '../mediaModelBuckets.js';
import { RUNNER_FAMILIES, flux2RepoRevision, diffusersRepoRevision } from '../runners.js';
import { applyVideoDisclosures } from '../videoDisclosure.js';
import { applyVideoFinishProfiles, sanitizeFinishProfiles } from '../videoFinishProfiles.js';
import { applyVideoSpeedProfiles, sanitizeSpeedProfiles } from '../videoSpeedProfiles.js';
import { applyMiniMaxH3MemoryProfiles, sanitizeMiniMaxH3MemoryProfiles } from '../minimaxH3Memory.js';
import { LTX25_AUDIO_PROFILE } from '../videoDurationProfiles.js';

const sameValues = (left, right) => (
  Array.isArray(left)
  && left.length === right.length
  && left.every((value, index) => value === right[index])
);

const upgradeMiniMaxH3DenoisingCountEntry = (entry, profile) => {
  if (!isPlainObject(entry) || entry.id !== profile.id || entry.repo !== profile.shippedRepo) return entry;
  // The MLX port treats `steps` as sigma-grid points, with the terminal zero
  // excluded from transformer evaluation. The old shipped value therefore
  // ran seven forwards, while the reference quality example uses nine grid
  // points for eight forwards. Preserve a hand-tuned sampler contract.
  const samplerIsLegacyShipped = entry.steps === profile.oldMlxSteps
    && (!Object.hasOwn(entry, 'guidance') || entry.guidance === 0)
    && (!Object.hasOwn(entry, 'samplerLocked') || entry.samplerLocked === true)
    && (!Object.hasOwn(entry, 'samplerNote') || entry.samplerNote === profile.oldMlxSamplerNote);
  return samplerIsLegacyShipped
    ? { ...entry, steps: profile.mlxSteps, samplerNote: profile.mlxSamplerNote }
    : entry;
};

export const upgradeMiniMaxH3DenoisingCount = (list) => {
  if (!Array.isArray(list)) return list;
  const profile = MINIMAX_H3_OUTPUT_PROFILE;
  return list.map((entry) => upgradeMiniMaxH3DenoisingCountEntry(entry, profile));
};

export const upgradeMiniMaxH3OutputControls = (list) => {
  if (!Array.isArray(list)) return list;
  const profile = MINIMAX_H3_OUTPUT_PROFILE;
  const withGeometry = list.map((entry) => {
    if (!isPlainObject(entry) || entry.id !== profile.id || entry.repo !== profile.shippedRepo) return entry;
    let next = entry;
    if (sameValues(next.frameOptions, profile.oldFrameOptions)) {
      next = { ...next, frameOptions: [...profile.frameOptions] };
    }
    if (!Object.hasOwn(next, 'defaultWidth') && !Object.hasOwn(next, 'defaultHeight')) {
      next = { ...next, defaultWidth: profile.defaultWidth, defaultHeight: profile.defaultHeight };
    }
    // The step and presets describe one geometry contract. If either side was
    // customized, preserve the pair rather than installing presets that may be
    // off-grid for the user's declared step (or vice versa).
    if (!Object.hasOwn(next, 'resolutionStep') && !Object.hasOwn(next, 'resolutionOptions')) {
      next = {
        ...next,
        resolutionStep: profile.resolutionStep,
        resolutionOptions: profile.resolutionOptions.map((preset) => ({ ...preset })),
      };
    }
    return next;
  });
  return upgradeMiniMaxH3DenoisingCount(withGeometry);
};

const upgradeFastMetalEntry = (entry, profile) => {
  if (!isPlainObject(entry) || entry.id !== profile.id || entry.repo !== profile.shippedRepo) return entry;
  let next = entry;
  // Only the untouched shipped string is rewritten — a user rename is theirs.
  if (next.name === profile.oldName) next = { ...next, name: profile.name };
  // The file list is additive and only lands on a row that declares none: an
  // entry already carrying `repoFiles` has a narrowing its owner chose.
  if (profile.repoFiles && !Object.hasOwn(next, 'repoFiles')) {
    next = { ...next, repoFiles: [...profile.repoFiles] };
  }
  // A row that persisted its disclosure before this correction keeps a stale
  // size that would now contradict the name beside it. applyVideoDisclosures
  // only fills an ABSENT block, so the stale one is corrected here — and only
  // when it still equals a value PortOS itself shipped.
  if (isPlainObject(next.disclosure)
    && profile.oldEstimatedDownloadGb.includes(next.disclosure.estimatedDownloadGb)) {
    next = {
      ...next,
      disclosure: { ...next.disclosure, estimatedDownloadGb: profile.estimatedDownloadGb },
    };
  }
  return next;
};

/**
 * Bring the shipped FastMetal rows onto the size their download actually pulls
 * — in the display name and in any stale persisted disclosure — and narrow the
 * 14B row off its duplicated `ema/` DiT.
 *
 * Load-time twin of migration 336: the registry cache is populated before
 * migrations execute, so the boot that runs the migration still needs this.
 */
export const upgradeFastMetalDownloadSizes = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => FASTMETAL_DOWNLOAD_SIZE_PROFILES.reduce(upgradeFastMetalEntry, entry));
};

const FASTH3_V2_MODE_REPO = 'FastVideo/FastVideo-FastH3-8-Step-V2';
const FASTH3_V2_MODE_REVISION = '3da2ddfe1954d9cda4c05b643dc0f26007a655c5';
const FASTH3_V2_MODE_IDS = new Set(['fasth3_v2_int8', 'fasth3_v2_int6']);

// The pinned MLX entry and pipeline have no image-conditioning API. Correct
// the exact erroneous shipped declaration while preserving repointed forks,
// custom IDs, and other explicit mode lists.
export const upgradeFastH3V2RuntimeModes = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isPlainObject(entry)
      || !FASTH3_V2_MODE_IDS.has(entry.id)
      || entry.repo !== FASTH3_V2_MODE_REPO
      || entry.revision !== FASTH3_V2_MODE_REVISION
      || JSON.stringify(entry.supportedModes) !== JSON.stringify(['text', 'image'])) return entry;
    return { ...entry, supportedModes: ['text'] };
  });
};

// Existing installs already persisted the shipped LTX-2.5 row before its A2V
// duration contract was declared. Backfill only the untouched pinned model and
// only absent keys: a user-repointed fork or an explicit local override remains
// authoritative. Migration 318 persists the same fields, while this load-time
// twin matters on the boot that runs the migration because the registry cache is
// populated before migrations execute.
export const upgradeLtx25AudioControls = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isPlainObject(entry)
      || entry.id !== LTX25_AUDIO_PROFILE.id
      || entry.repo !== LTX25_AUDIO_PROFILE.repo
      || entry.revision !== LTX25_AUDIO_PROFILE.revision) return entry;
    const missing = ['audioDurationDriven', 'frameStride', 'maxNumFrames']
      .filter((key) => !Object.hasOwn(entry, key));
    return missing.length === 0
      ? entry
      : { ...entry, ...Object.fromEntries(missing.map((key) => [key, LTX25_AUDIO_PROFILE[key]])) };
  });
};

// Merge user-edited registry over DEFAULT_REGISTRY so missing top-level keys
// (e.g. someone deletes `video` or saves `{}`) don't blow up consumers that
// assume `reg.video.mlx`. We also coerce array-shaped fields back to the
// defaults when the user's JSON is parseable but wrong-shape (e.g.
// `image: {}` or `video.mlx: "ltx"`) — otherwise getImageModels /
// getVideoModels / buildAppModels would throw at module import-time and
// take down server startup. If a user supplies a real array, that's their
// list, full stop — we don't deep-merge entries.
const arrayOrDefault = (v, fallback) => (Array.isArray(v) ? v : fallback);

// Pre-flux2 stored entries had `broken: 'macos'` and no `runner` field. Merge
// missing flux2 fields from DEFAULT_REGISTRY when an entry id matches a known
// flux2 model but is missing the runner discriminator. User overrides for
// other fields (custom name, steps, repo) are preserved.
const FLUX2_DEFAULTS_BY_ID = Object.fromEntries(
  DEFAULT_REGISTRY.image.filter((m) => m.runner === RUNNER_FAMILIES.FLUX2).map((m) => [m.id, m])
);

const upgradeImageEntries = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.id !== 'string') return entry;
    const seed = FLUX2_DEFAULTS_BY_ID[entry.id];
    // Only upgrade entries that DIDN'T set `runner` at all — a user who
    // explicitly chose a different runner for a known flux2 id (e.g. to
    // wire it up to a custom runner) keeps that override.
    if (!seed || entry.runner !== undefined) return entry;
    // Only strip `broken: 'macos'` (the legacy flag the upgrade is meant
    // to clear). Any other broken value the user added is intentional and
    // preserved.
    const { broken, ...rest } = entry;
    const merged = { ...seed, ...rest, runner: RUNNER_FAMILIES.FLUX2 };
    if (broken !== undefined && broken !== 'macos') merged.broken = broken;
    return merged;
  });
};

// IDs whose underlying pipeline is step-wise distilled (Flux Schnell, FLUX.2
// Klein, Z-Image-Turbo). For these models, classifier-free guidance is fixed
// internally and any user-supplied guidance scale is silently ignored — the
// diffusers runner literally prints "Guidance scale X is ignored for step-
// wise distilled models." into the log on every render. Surface this as an
// explicit flag on each registry entry so the UI can hide the Guidance input
// and the runners can skip passing the flag.
const CFG_DISABLED_IDS = new Set([
  'schnell',
  'flux2-klein-4b',
  'flux2-klein-9b',
  'flux2-klein-9b-bf16',
  'flux2-klein-4b-int8',
  'z-image-turbo-bf16',
  'z-image-turbo-quant',
  'ernie-image-turbo',
  'hidream-i1-fast',
]);

const backfillCfgDisabled = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.id !== 'string') return entry;
    if ('cfgDisabled' in entry) return entry; // user override (true OR false) wins
    if (!CFG_DISABLED_IDS.has(entry.id)) return entry;
    return { ...entry, cfgDisabled: true };
  });
};

// IDs whose underlying pipeline REQUIRES a source `image` arg (Qwen-Image-Edit
// loads QwenImageEditPipeline). A text-only render against one of these crashes
// deep inside diffusers, so the route rejects (and the UI gates) it up-front.
// Backfilled at load time — same pattern as cfgDisabled — so installs that
// stored their `qwen-image-edit` entry before this flag existed pick it up
// without a migration.
const EDIT_ONLY_IDS = new Set([
  'qwen-image-edit',
]);

const backfillEditOnly = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.id !== 'string') return entry;
    if ('editOnly' in entry) return entry; // user override (true OR false) wins
    if (!EDIT_ONLY_IDS.has(entry.id)) return entry;
    return { ...entry, editOnly: true };
  });
};

// Multi-reference editing on the bf16 path loads the `-kv` sibling repo. Map
// each id to the base repo it shipped with and the kv repo it should pair
// with. Existing installs stored their `flux2-klein-9b-bf16` entry before
// `kvRepo` existed, so backfill it at load (same pattern as
// cfgDisabled/editOnly) AND ship migration 064 for installs that have already
// persisted the registry.
//
// Fork-preservation: only backfill when the entry's `repo` still matches the
// shipped base repo. A user who pointed `repo` at a fork must NOT get the
// upstream kv sibling silently injected (reference renders would mix a custom
// base with the upstream KV repo) — this mirrors migration 064's guard. A
// user-set `kvRepo` (any value, including '') always wins: `'kvRepo' in entry`
// is the override signal.
const KV_REPO_BY_ID = {
  'flux2-klein-9b-bf16': {
    shippedRepo: 'black-forest-labs/FLUX.2-klein-9B',
    kvRepo: 'black-forest-labs/FLUX.2-klein-9B-kv',
  },
};

const backfillKvRepo = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.id !== 'string') return entry;
    if ('kvRepo' in entry) return entry; // user override wins
    const spec = KV_REPO_BY_ID[entry.id];
    if (!spec || entry.repo !== spec.shippedRepo) return entry; // unknown id or forked repo
    return { ...entry, kvRepo: spec.kvRepo };
  });
};

// Commit-pin backfill for persisted FLUX.2 entries: each `<x>Repo` gets its
// `<x>Revision` only while that repo is still a shipped one with a known pin,
// so a user fork is never clobbered and an explicit revision (including '') wins.
const backfillFlux2Revisions = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isPlainObject(entry) || entry.runner !== RUNNER_FAMILIES.FLUX2) return entry;
    let next = entry;
    for (const [repoKey, revKey] of FLUX2_REVISION_FIELDS) {
      if (revKey in entry) continue;
      const pin = typeof entry[repoKey] === 'string' ? flux2RepoRevision(entry[repoKey]) : null;
      if (pin) next = { ...next, [revKey]: pin };
    }
    return next;
  });
};

// Fork-safe commit-pin backfill for persisted FLUX.3 entries: the pin lands only
// while the repo is still a shipped one, and an explicit revision (including '') wins.
const backfillFlux3Revisions = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isPlainObject(entry) || entry.runner !== 'flux3' || 'revision' in entry) return entry;
    const pin = FLUX3_KLEIN_REVISIONS[entry.repo];
    return pin ? { ...entry, revision: pin } : entry;
  });
};

// Same fork-safe commit-pin backfill for persisted diffusers-runner entries
// (HiDream/Qwen/Z-Image/ERNIE): a revision lands only while the repo is still a
// shipped one with a known pin; an explicit revision (including '') wins.
const DIFFUSERS_RUNNERS = new Set([
  RUNNER_FAMILIES.HIDREAM, RUNNER_FAMILIES.QWEN, RUNNER_FAMILIES.Z_IMAGE, RUNNER_FAMILIES.ERNIE,
]);
const DIFFUSERS_REVISION_FIELDS = [
  ['repo', 'revision'],
  ['textEncoderRepo', 'textEncoderRevision'],
];

const backfillDiffusersRevisions = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isPlainObject(entry) || !DIFFUSERS_RUNNERS.has(entry.runner)) return entry;
    let next = entry;
    for (const [repoKey, revKey] of DIFFUSERS_REVISION_FIELDS) {
      if (revKey in entry) continue;
      const pin = typeof entry[repoKey] === 'string' ? diffusersRepoRevision(entry[repoKey]) : null;
      if (pin) next = { ...next, [revKey]: pin };
    }
    return next;
  });
};

// Append models that are genuinely new in this release (not in
// _shippedDefaults) to the user's list, while respecting deletions the user
// already made. Returns both the merged entry list and the newly-added ids so
// the caller can record them in _shippedDefaults. Used for both video and
// image lists — the deletion-survives-upgrade contract is identical.
//
// Semantics:
//   - id already in userList             → keep as-is (user customisations intact)
//   - id in shippedIds but not userList  → user explicitly deleted it; skip
//   - id NOT in shippedIds               → genuinely new built-in; add + record
const appendNewlyShippedEntries = (userList, defaultList, shippedIds) => {
  const safeList = Array.isArray(userList) ? userList : [];
  const safeDefaults = Array.isArray(defaultList) ? defaultList : [];
  const userIds = new Set(safeList.map((e) => e?.id).filter((id) => typeof id === 'string'));
  const result = [...safeList];
  const newlyShipped = [];
  for (const def of safeDefaults) {
    if (typeof def?.id !== 'string') continue;
    if (userIds.has(def.id)) continue;       // already present — keep user copy
    if (shippedIds.has(def.id)) continue;    // user deleted it; don't re-add
    result.push(def);
    newlyShipped.push(def.id);
  }
  return { entries: result, newlyShipped };
};
// Existing installs predate the `runtime` field on video entries — fill it
// with 'mlx_video' (the legacy default) for known-legacy ids so the
// dispatch in videoGen/local.js routes them through `python -m
// mlx_video.generate_av` rather than treating undefined as ltx2.
// 'ltx2_unified' is retired (see RETIRED_VIDEO_MODELS) but stays here: an
// install that re-pointed its entry at a fork keeps that entry, and it still
// needs the runtime backfill.
const LEGACY_MLX_VIDEO_IDS = new Set(['ltx2_unified', 'ltx23_unified', 'ltx23_distilled_q4']);
const backfillRuntime = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.id !== 'string') return entry;
    if (typeof entry.runtime === 'string' && entry.runtime.length > 0) return entry;
    if (LEGACY_MLX_VIDEO_IDS.has(entry.id)) return { ...entry, runtime: 'mlx_video' };
    return entry;
  });
};

// `ltx_video` is the legacy diffusers CUDA helper, not an MLX runtime. It
// shipped in the CUDA bucket before the bucket names made that mismatch
// obvious, so correct an untouched persisted entry during the same early load
// that still precedes migrations. A custom repo is deliberately left alone.
const upgradeLegacyCudaLtxRuntime = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => (
    isPlainObject(entry)
      && entry.id === 'ltx_video'
      && (entry.runtime === undefined || entry.runtime === 'mlx_video')
      && entry.repo === undefined
      ? { ...entry, runtime: 'cuda_video' }
      : entry
  ));
};

export const upgradeLtx25CudaMemoryFloor = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => (
    isPlainObject(entry)
      && entry.id === 'ltx25_cuda_distilled'
      && entry.repo === 'Lightricks/LTX-2.5'
      && entry.hardwareRequirements?.minMemoryGb === 32
      ? { ...entry, hardwareRequirements: { ...entry.hardwareRequirements, minMemoryGb: 64 } }
      : entry
  ));
};

// Built-in video models that were delivered to installs and have since been
// withdrawn. Dropping an id from DEFAULT_REGISTRY is NOT enough on its own: the
// user's persisted list is what the pickers read, and appendNewlyShippedEntries
// only ever adds. This is the load-time twin of the retirement migrations (247
// for ltx2_unified, 315 for hunyuan_video) — and it is the load-bearing half,
// because the registry is cached at import time, BEFORE bootstrapServices()
// runs migrations, and
// persistRegistry writes the whole cached object back on the next registry
// edit. Without this the migration's deletion is undone by the same boot that
// applied it.
//
// `replacement` repoints a `defaultMlx`/`defaultCuda` that named the
// retired model. getDefaultVideoModelId() would otherwise fall back to the
// first available entry, which is not necessarily the intended successor.
//
// Preservation guard mirrors backfillKvRepo: an entry whose `repo` no longer
// matches the shipped one is a fork the user pointed at deliberately, so it
// stays — that is also the escape hatch for anyone who wants a retired model
// back.
//
// Exported so the matching retirement migration can assert it froze the same
// id/repo/replacement — a typo in either copy would otherwise turn one half of
// the retirement into a silent no-op with every test still green.
export const RETIRED_VIDEO_MODELS = Object.freeze({
  ltx2_unified: Object.freeze({
    shippedRepo: 'notapalindrome/ltx2-mlx-av',
    replacement: 'ltx23_distilled_q4',
  }),
  hunyuan_video: Object.freeze({
    shippedRepo: 'tencent/HunyuanVideo',
    replacement: 'fastmetal_1_3b_qad',
  }),
});

const isRetired = (entry) => {
  if (!isPlainObject(entry) || typeof entry.id !== 'string') return false;
  const spec = RETIRED_VIDEO_MODELS[entry.id];
  // `spec &&` is load-bearing, not defensive: several entries (the Windows
  // `ltx_video`) carry no `repo` at all, and without the guard an absent spec
  // would compare `undefined === undefined` and retire every one of them.
  return Boolean(spec) && entry.repo === spec.shippedRepo;
};

const dropRetiredEntries = (list) => (
  Array.isArray(list) ? list.filter((entry) => !isRetired(entry)) : list
);

// The ordered load-time upgrade chain a video bucket's persisted entries run
// through before the apply*/sanitize* decorators in `videoEntries` touch them.
//
// This list IS the order. Every row is the same shape — a whole-list rewrite
// that only touches an entry still matching what PortOS itself shipped — so
// adding the next upgrader is appending a row rather than adding a paren level
// to one nested expression, and the ordering constraints below are stated where
// a reader — and the ordering guard in `mediaModels.test.js` — can see them,
// instead of being implied by nesting depth.
//
// `buckets` limits a row to the video buckets it applies to; a row without one
// runs for every bucket.
const VIDEO_REGISTRY_UPGRADES = Object.freeze([
  // FIRST, unconditionally: a withdrawn model has to leave before any later row
  // spends work on it, and before the apply* decorators would hand it a
  // disclosure, a Finish edge, or a speed profile on its way out.
  Object.freeze({ name: 'dropRetiredEntries', apply: dropRetiredEntries }),
  Object.freeze({ name: 'upgradeMiniMaxH3OutputControls', apply: upgradeMiniMaxH3OutputControls }),
  Object.freeze({ name: 'upgradeLtx25AudioControls', apply: upgradeLtx25AudioControls }),
  // MUST stay ahead of `applyVideoDisclosures`, which only fills an ABSENT
  // disclosure block: this row corrects the stale `estimatedDownloadGb` inside
  // an already-persisted one, and the decorator would never revisit it.
  Object.freeze({ name: 'upgradeFastMetalDownloadSizes', apply: upgradeFastMetalDownloadSizes }),
  Object.freeze({ name: 'upgradeFastH3V2RuntimeModes', apply: upgradeFastH3V2RuntimeModes }),
  Object.freeze({ name: 'backfillRuntime', apply: backfillRuntime }),
  // CUDA-only, and in this order: the legacy `ltx_video` row is repointed at the
  // `cuda_video` runtime first, then the LTX-2.5 memory floor is raised.
  Object.freeze({
    name: 'upgradeLegacyCudaLtxRuntime',
    apply: upgradeLegacyCudaLtxRuntime,
    buckets: [VIDEO_BUCKET_CUDA],
  }),
  Object.freeze({
    name: 'upgradeLtx25CudaMemoryFloor',
    apply: upgradeLtx25CudaMemoryFloor,
    buckets: [VIDEO_BUCKET_CUDA],
  }),
]);

// Exported for the ordering guard in mediaModels.test.js: the chain's
// order is load-bearing (see the constraints above), so a reorder has to be a
// deliberate edit to a named list rather than an invisible re-nesting.
export const VIDEO_REGISTRY_UPGRADE_NAMES = Object.freeze(
  VIDEO_REGISTRY_UPGRADES.map((upgrade) => upgrade.name),
);

// Run one bucket's persisted entries through the chain above.
const applyVideoRegistryUpgrades = (entries, bucket) => VIDEO_REGISTRY_UPGRADES.reduce(
  (list, { apply, buckets }) => (buckets && !buckets.includes(bucket) ? list : apply(list)),
  entries,
);

// Repoint a platform default that named a model this load just retired. Falls
// through to the original id when the successor isn't installed either — then
// getDefaultVideoModelId()'s "unknown default → first available" warning is the
// honest outcome, rather than naming a model this install doesn't have.
const resolveRetiredDefault = (configuredId, entries) => {
  const replacement = RETIRED_VIDEO_MODELS[configuredId]?.replacement;
  if (!replacement) return configuredId;
  if (entries.some((entry) => entry?.id === configuredId)) return configuredId; // fork kept it
  return entries.some((entry) => entry?.id === replacement) ? replacement : configuredId;
};

// Pre-ledger registries cannot tell an old deletion from an unseen built-in.
// Keep the #18668 catalog fixed here so absent baseline rows stay deleted
// and future catalog entries are delivered even on the first ledger bootstrap.
export const BOOTSTRAP_VIDEO_BASELINE_IDS = Object.freeze({
  mlx: Object.freeze([
    'ltx23_unified',
    'ltx23_distilled_q4',
    'ltx23_dgrauet_q4',
    'ltx23_dgrauet_q8',
    'ltx25_mlx_q8',
    'minimax_h3_8bit',
    'minimax_h3_6bit',
    'minimax_h3_4bit',
    'minimax_h3_ref2va_8bit',
    'wan22_ti2v_5b',
    'wan22_t2v_a14b',
    'wan22_i2v_a14b',
    'wan22_t2v_a14b_lightning',
    'wan22_i2v_a14b_lightning',
    'fastmetal_1_3b_qad',
    'fastmetal_5b_qad',
    'fastmetal_14b_qad',
    'fasth3_dense_datafree_int8',
    'fasth3_dense_datafree_int6',
    'fasth3_dense_datafree_int4',
    'fasth3_v2_int8',
    'fasth3_v2_int6',
    'fasth3_omni_int6',
    'fasth3_dense_datafree_mlx_int4',
  ]),
  cuda: Object.freeze([
    'ltx_video',
    'ltx25_cuda_distilled',
    'wan22_cuda_ti2v_5b',
    'minimax_h3_cuda',
  ]),
});

const bootstrapShippedIds = (userList, baselineIds) => {
  // An absent bucket gets all defaults, as on a fresh install.
  if (!Array.isArray(userList)) return new Set();
  const ids = new Set();
  for (const entry of userList) if (typeof entry?.id === 'string') ids.add(entry.id);
  for (const id of baselineIds) ids.add(id);
  return ids;
};

export const normalizeRegistry = (parsed) => {
  const safe = isPlainObject(parsed) ? parsed : {};
  const safeVideo = isPlainObject(safe.video) ? safe.video : {};

  // _shippedDefaults tracks which built-in ids have ever been delivered
  // to this install, so we can distinguish "user deleted it" from "genuinely
  // new in this release". Tracked separately for video (per-bucket) and
  // image (single list — image entries cover both buckets).
  const shippedVideo = isPlainObject(safe._shippedDefaults?.video) ? safe._shippedDefaults.video : null;
  const isVideoBootstrap = shippedVideo === null;

  // Every read goes through readVideoBucket / readVideoDefault so a registry
  // still keyed `macos` / `windows` (any install written before #4142) resolves
  // exactly as it did before. The OUTPUT below is canonical-only.
  const shippedIdsFor = (bucket) => (isVideoBootstrap
    ? bootstrapShippedIds(readVideoBucket(safeVideo, bucket), BOOTSTRAP_VIDEO_BASELINE_IDS[bucket])
    : new Set(arrayOrDefault(readVideoBucket(shippedVideo, bucket), [])));

  const shippedIds = Object.fromEntries(VIDEO_BUCKETS.map((b) => [b, shippedIdsFor(b)]));
  const bucketResults = Object.fromEntries(VIDEO_BUCKETS.map((bucket) => [bucket, appendNewlyShippedEntries(
    readVideoBucket(safeVideo, bucket),
    DEFAULT_REGISTRY.video[bucket],
    shippedIds[bucket],
  )]));

  const updatedShippedVideo = Object.fromEntries(VIDEO_BUCKETS.map((bucket) => [
    bucket, [...shippedIds[bucket], ...bucketResults[bucket].newlyShipped],
  ]));

  // Image upgrade path. Same shape as video, single list. The flux2 upgrade
  // (upgradeImageEntries) runs first so legacy `broken: 'macos'` entries get
  // promoted to runner-aware ones before the new-entry append step looks at
  // their ids. Skips bootstrap union when the image key was missing entirely
  // (treat as fresh install — let the new entries land).
  const shippedImage = isPlainObject(safe._shippedDefaults?.image) ? safe._shippedDefaults.image : null;
  const isImageBootstrap = shippedImage === null;
  const upgradedImage = backfillFlux3Revisions(backfillDiffusersRevisions(backfillFlux2Revisions(backfillKvRepo(backfillEditOnly(backfillCfgDisabled(
    upgradeImageEntries(arrayOrDefault(safe.image, DEFAULT_REGISTRY.image)),
  ))))));
  // Image bootstrap deliberately uses userIds ONLY (not union with defaults).
  // Image is getting `_shippedDefaults` for the first time in this release, so
  // there's no prior history of deletions to preserve via the union trick the
  // video side uses. Pre-existing installs will pick up the new built-ins
  // (z-image-turbo-*, etc.) on next boot. Subsequent loads use the persisted
  // list so user deletions stick.
  const upgradedImageIds = (Array.isArray(upgradedImage) ? upgradedImage : [])
    .map((e) => e?.id)
    .filter((id) => typeof id === 'string');
  const shippedImageIds = isImageBootstrap
    ? new Set(upgradedImageIds)
    : new Set(arrayOrDefault(shippedImage.list, []));
  const imageResult = appendNewlyShippedEntries(
    upgradedImage,
    DEFAULT_REGISTRY.image,
    shippedImageIds,
  );
  const updatedShippedImage = {
    list: [...shippedImageIds, ...imageResult.newlyShipped],
  };

  // VIDEO_REGISTRY_UPGRADES runs first: it is the ordered chain of load-time
  // twins of the registry migrations, and its own ordering constraints are
  // stated row by row up there.
  //
  // applyVideoDisclosures is the load-time twin of migration 237: installs
  // that persisted their registry before `disclosure` existed pick it up
  // here without waiting for the migration, and both paths share the same
  // preservation guards (user value wins, forked repo keeps Unknown). It only
  // fills an ABSENT block, which is why the upgrade chain — not a decorator —
  // is where a stale persisted disclosure gets corrected.
  // sanitizeFinishProfiles runs LAST (after the backfill and
  // after the user's own entries are merged in) so an edge that points at a
  // model this install deleted — or a hand-edited typo — is dropped with a
  // warning instead of surfacing a Finish button targeting nothing.
  const videoEntries = (entries, bucket) => {
    const upgraded = applyVideoRegistryUpgrades(entries, bucket);
    const decorated = sanitizeFinishProfiles(applyVideoFinishProfiles(applyVideoDisclosures(upgraded)));
    // applyVideoSpeedProfiles is the load-time twin of migration 295, and
    // sanitizeSpeedProfiles is its sibling of sanitizeFinishProfiles: a
    // hand-edited profile with a NaN step count would otherwise reach the
    // picker and spawn a broken render, so it is warned about and stripped.
    const withSpeed = sanitizeSpeedProfiles(applyVideoSpeedProfiles(decorated));
    // applyMiniMaxH3MemoryProfiles is the load-time twin of migration 317, and
    // its sanitizer the sibling of the two above: a hand-edited profile with a
    // NaN memory floor would otherwise make every capacity comparison false and
    // refuse H3 renders on a machine that can run them, so it is warned about
    // and stripped.
    return sanitizeMiniMaxH3MemoryProfiles(applyMiniMaxH3MemoryProfiles(withSpeed));
  };
  const normalizedBuckets = Object.fromEntries(
    VIDEO_BUCKETS.map((bucket) => [bucket, videoEntries(bucketResults[bucket].entries, bucket)]),
  );

  // Spread the user's own `video` keys but NOT the legacy bucket spellings: the
  // canonical keys below already carry those lists, and leaving both on the
  // object would persist two spellings of the same bucket into a file users
  // hand-edit — a later edit to the stale copy would silently do nothing.
  const carriedVideo = Object.fromEntries(
    Object.entries(safeVideo).filter(([key]) => !LEGACY_VIDEO_KEYS.includes(key)),
  );

  return {
    ...DEFAULT_REGISTRY,
    ...safe,
    image: imageResult.entries,
    textEncoders: arrayOrDefault(safe.textEncoders, DEFAULT_REGISTRY.textEncoders),
    video: {
      ...DEFAULT_REGISTRY.video,
      ...carriedVideo,
      ...normalizedBuckets,
      ...Object.fromEntries(VIDEO_BUCKETS.map((bucket) => [
        VIDEO_DEFAULT_KEYS[bucket],
        resolveRetiredDefault(
          readVideoDefault(safeVideo, bucket) ?? DEFAULT_REGISTRY.video[VIDEO_DEFAULT_KEYS[bucket]],
          normalizedBuckets[bucket],
        ),
      ])),
    },
    _shippedDefaults: {
      ...(safe._shippedDefaults || {}),
      video: updatedShippedVideo,
      image: updatedShippedImage,
    },
  };
};

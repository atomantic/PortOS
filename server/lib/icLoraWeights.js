// IC-LoRA weight registry for the local LTX-2 video runtime (issue #3100).
//
// Resolves each remix mode (`ic-control`, `ic-colorize`, `ic-ingredients`) of the registry table in
// `icLoraRegistry.js` (HF repo/filename, reference-count rule, per-weight `referenceDownscaleFactor` read from
// the weight's safetensors metadata, never assumed, and input surface `referenceKind`) to a local weight. Also
// owns `assertIcReferenceCount` / `describeIcReferenceRange`; the table itself is shared with the client form.
//
// Weights are NOT bundled; they ride the same cache-inspect / download / verify / repair surface as the model
// weights (see routes/videoGen.js). `resolveIcLoraWeight` returns a cached file path, else the HF repo id for
// ICLoraPipeline._resolve_lora_path to pull itself.
//
// That repo-id fallback is `snapshot_download(repo_id)`, which pulls the ENTIRE repo: fine for a single-weight
// repo, catastrophic for an aggregate mirror (`DeepBeepMeep/LTX-2` is ~708 GB). A spec whose chain includes
// such a repo (or a gated one) sets `requiresPreDownload`, and resolveIcLoraWeight then never emits a bare repo
// id. Ingredients' official repo is `gated: true` (anonymous resolve returns 401); the mirror is its un-gated path.

import { findCachedRepoFile } from './hfCache.js';
import { readSafetensorsHeader } from './safetensors.js';
import {
  IC_LORA_REMIX_BASE_MODEL, IC_LORA_MODES, IC_LORA_MODE_VALUES, isIcLoraMode, isRemixSpec,
  listIcLoraWeights, listIcLoraRemixModes, icResolutionIssue,
} from './icLoraRegistry.js';

// The registry table and its pure lookups live in the browser-safe leaf `icLoraRegistry.js` (the client form
// reads the same table); everything below adds adapter-compat rules and local cache resolution on top.
export {
  IC_LORA_REMIX_BASE_MODEL, IC_LORA_MODES, IC_LORA_MODE_VALUES, isIcLoraMode, listIcLoraWeights, listIcLoraRemixModes,
  icResolutionIssue,
};

/** Do not fuse an adapter trained for one model generation into another. */
export const icLoraSupportsRuntime = (spec, runtime) => (
  !!spec && ((spec.baseModel === 'ltx-2.3' && runtime === 'ltx2')
    || (spec.baseModel === 'ltx-2.5' && runtime === 'ltx25'))
);

export const icLoraFrameIssue = (spec, numFrames) => {
  if (spec?.mode !== 'ic-ingredients-25') return null;
  const frames = Number(numFrames);
  return Number.isInteger(frames) && frames >= 121 && (frames - 1) % 8 === 0
    ? null : 'LTX 2.5 References requires at least 121 frames on the 8n+1 frame grid.';
};

// `ic-control` (or bare `control`) -> the registry entry, else null. REMIX MODES ONLY: every caller is on the
// render path, where an upscale adapter must never be fused into the 2.3 remix pipeline. Provisioning callers
// use `icLoraSpecByKey`.
export const icLoraSpecForMode = (mode) => {
  if (typeof mode !== 'string' || !mode) return null;
  const id = mode.startsWith('ic-') ? mode.slice(3) : mode;
  const spec = IC_LORA_MODES[id] || null;
  return isRemixSpec(spec) ? spec : null;
};

// The stable identifier a weight is addressed by outside the render path: its remix mode, else its registry id
// (keeps `/ic-loras/ic-control/download` URLs unchanged).
export const icLoraWeightKey = (spec) => (spec ? (spec.mode || spec.id) : null);

// Resolve ANY registered weight by `icLoraWeightKey` (or bare id), for the provisioning endpoints.
export const icLoraSpecByKey = (key) => {
  if (typeof key !== 'string' || !key) return null;
  const direct = listIcLoraWeights().find((spec) => icLoraWeightKey(spec) === key);
  if (direct) return direct;
  const id = key.startsWith('ic-') ? key.slice(3) : key;
  return IC_LORA_MODES[id] || null;
};

// Every addressable weight key, for the routes' "expected one of" error.
export const IC_LORA_WEIGHT_KEYS = Object.freeze(listIcLoraWeights().map(icLoraWeightKey));

// Whether this weight must be located by its EXACT (repo, filename, revision) rather than a repo-wide cache
// verdict: a mirror reports `cached` off any unrelated resident weight, and a pinned revision must not accept
// another commit's snapshot. Both also make an unscoped integrity walk wrong.
export const icLoraProbesExactFile = (spec) => !!(spec && (spec.mirrorRepo || spec.revision || spec.requiresPreDownload));

// Every IC-LoRA HF repo, for the integrity scan. Mirror repos are EXCLUDED: an unscoped scan would stat (and
// under `deep`, hash) every unrelated weight in the 708 GB mirror; its weight is verified via
// icLoraWeightCandidates instead.
export const icLoraRepos = () => listIcLoraWeights().map((m) => m.repo);

// Every (repo, filename) a spec's weight can come from, official repo first, then the un-gated mirror; shared by
// the cache probe and the download endpoint.
export const icLoraWeightCandidates = (spec) => {
  if (!spec) return [];
  const candidates = [{
    repo: spec.repo, filename: spec.filename, revision: spec.revision || null, mirror: false,
  }];
  if (spec.mirrorRepo) {
    candidates.push({
      repo: spec.mirrorRepo,
      filename: spec.mirrorFilename || spec.filename,
      // The pin belongs to the OFFICIAL repo's history; mirrors stay unpinned.
      revision: null,
      mirror: true,
    });
  }
  return candidates;
};

// "exactly 1" / "2-8": one wording and bounds for the route, arg builder and Python helper flags.
export const describeIcReferenceRange = (spec) => (
  spec.minReferences === spec.maxReferences
    ? `exactly ${spec.minReferences}`
    : `${spec.minReferences}-${spec.maxReferences}`
);

// Throw when `count` violates the weight's reference contract. `fail` builds the caller's error (the route's
// ServerError vs the worker's plain one) so message and bounds stay single-sourced.
export const assertIcReferenceCount = (spec, count, fail) => {
  if (count >= spec.minReferences && count <= spec.maxReferences) return;
  throw fail(
    `${spec.label} mode needs ${describeIcReferenceRange(spec)} reference ${spec.referenceKind}(s); got ${count}.`,
  );
};

/**
 * The reference downscale factor a spec's DOWNLOADED weight actually declares, read from the same
 * `__metadata__.reference_downscale_factor` the MLX pipeline reads.
 *
 * Returns `{ factor, measured }`; `measured` is true only for a value read off a real local file. Otherwise it
 * falls back to the registry value, which may be `null`; absent and "declared 1" are never coerced together.
 */
export const readIcLoraReferenceDownscaleFactor = async (spec) => {
  const declared = typeof spec?.referenceDownscaleFactor === 'number' ? spec.referenceDownscaleFactor : null;
  const cached = spec ? await findCachedIcLoraWeight(spec) : null;
  if (!cached) return { factor: declared, measured: false };
  const header = await readSafetensorsHeader(cached.path);
  const raw = header?.__metadata__?.reference_downscale_factor;
  const factor = Number.parseInt(raw, 10);
  // An absent key is a real measurement of "no rule" (pipeline reads 1); an unreadable header is not.
  if (!header) return { factor: declared, measured: false };
  return Number.isInteger(factor) && factor >= 1
    ? { factor, measured: true }
    : { factor: 1, measured: true };
};

// Locate a spec's weight in the local HF cache: pins the EXACT filename inside the newest snapshot instead of
// letting the pipeline glob-pick among a multi-weight repo's `.safetensors`. Returns the resolved candidate
// (`{ path, repo, filename, mirror }`) or null.
export const findCachedIcLoraWeight = async (spec) => {
  for (const candidate of icLoraWeightCandidates(spec)) {
    // findCachedRepoFile, NOT inspectModelCache, which stats every weight in the snapshot (hundreds of GB for the
    // mirror); this resolves one filename, inside the pinned revision when the spec pins one.
    const path = await findCachedRepoFile(candidate.repo, candidate.filename, {
      revision: candidate.revision,
    });
    if (path) return { ...candidate, path };
  }
  return null;
};

// Resolve the weight to hand the Python helper: a real cached file, else the bare repo id (downloaded by
// ICLoraPipeline._resolve_lora_path via `snapshot_download`). The fallback is SUPPRESSED for
// `requiresPreDownload` specs (gated repo 401s mid-render; mirror is ~708 GB), returning `path: null` so the
// caller fails fast with "download the weight first".
//
// Returns `{ path, cached, spec, repo? }`; `cached` is true only for a real local file, so callers can warn that
// an un-cached weight means a silent multi-hundred-MB pull at render time.
export const resolveIcLoraWeightSpec = async (spec) => {
  if (!spec) return null;
  const cached = await findCachedIcLoraWeight(spec);
  if (cached) return { path: cached.path, cached: true, spec, repo: cached.repo };
  if (spec.requiresPreDownload) return { path: null, cached: false, spec };
  return { path: spec.repo, cached: false, spec };
};

export const resolveIcLoraWeight = async (mode) => resolveIcLoraWeightSpec(icLoraSpecForMode(mode));

// The provisioning/upscale-flow counterpart: resolves ANY registered weight (remix or not) by `icLoraWeightKey`.
export const resolveIcLoraWeightByKey = async (key) => resolveIcLoraWeightSpec(icLoraSpecByKey(key));

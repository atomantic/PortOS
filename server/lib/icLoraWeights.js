// IC-LoRA weight registry for the local LTX-2 video runtime (issue #3100).
//
// Single source of truth mapping each remix mode (`ic-control`, `ic-colorize`, `ic-ingredients`) to its HF
// repo/filename, reference-count rule, per-weight `referenceDownscaleFactor` (read from the weight's
// safetensors metadata, never assumed) and input surface (`referenceKind`). Also owns
// `assertIcReferenceCount` / `describeIcReferenceRange` and `icResolutionIssue`. Mirrored to
// `client/src/lib/videoGenParams.js`; `icLoraWeights.parity.test.js` diffs the two.
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

// The base model the legacy MLX `ICLoraPipeline` remix path is pinned to. Never fuse an LTX 2.5 adapter into
// the 2.3 pipeline: it accepts it without erroring and produces garbage.
export const IC_LORA_REMIX_BASE_MODEL = 'ltx-2.3';

// One entry per registered IC-LoRA weight. `minReferences`/`maxReferences` are the weight's contract: the
// Python helper receives them as flags (never a second hardcoded table).
//
// `baseModel` (LTX release the adapter was trained against) and `mode` (PortOS remix mode, `null` for a
// non-remix weight such as the upscaler) are INDEPENDENT gates: `listIcLoraRemixModes` requires both.
// `revision` pins the HF commit; `null` means unpinned (the 2.3 weights).
//
// `referenceDownscaleFactor`: the IC encoder divides the reference by it and requires OUTPUT height/width
// divisible by it, so the route can reject a bad resolution up-front. It is PER-WEIGHT and must be READ from the
// weight's `__metadata__`, never copied from a sibling: Union-Control ships 2, the Colorizer 1.
//
// MIRRORED fields (label/description/referenceKind/uploadLabel/counts/factor) are duplicated in
// client/src/lib/videoGenParams.js and diffed by icLoraWeights.parity.test.js. Remix modes only; a non-remix
// weight has no form surface.
export const IC_LORA_MODES = Object.freeze({
  control: Object.freeze({
    id: 'control',
    mode: 'ic-control',
    baseModel: 'ltx-2.3',
    revision: null,
    label: 'Control',
    description: 'Structure + motion from a control clip',
    // Drives the panel's upload copy + `accept` filter.
    uploadLabel: 'Upload a control clip (depth / pose / edges)',
    repo: 'Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control',
    filename: 'ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors',
    // ~654 MB, for the download badge's size estimate.
    sizeBytes: 654 * 1024 * 1024,
    // Read from the weight's safetensors `__metadata__.reference_downscale_factor`.
    referenceDownscaleFactor: 2,
    minReferences: 1,
    maxReferences: 1,
    referenceKind: 'video',
  }),
  colorize: Object.freeze({
    id: 'colorize',
    mode: 'ic-colorize',
    baseModel: 'ltx-2.3',
    revision: null,
    label: 'Colorize',
    description: 'Color restored onto a black-and-white clip',
    uploadLabel: 'Upload a B&W clip to restore',
    // Community-published (DoctorDiffusion), un-gated.
    repo: 'DoctorDiffusion/LTX-2.3-IC-LoRA-Colorizer',
    filename: 'LTX-2.3-22b-IC-LoRA-Colorizer-0.9.safetensors',
    // ~312 MiB, for the download badge's size estimate.
    sizeBytes: 312 * 1024 * 1024,
    // `__metadata__` says "1": the Colorizer conditions on a FULL-resolution reference, so no divisibility rule
    // (icResolutionIssue short-circuits at factor <= 1). Do not "align" it to 2.
    referenceDownscaleFactor: 1,
    minReferences: 1,
    maxReferences: 1,
    referenceKind: 'video',
  }),
  ingredients: Object.freeze({
    id: 'ingredients',
    mode: 'ic-ingredients',
    baseModel: 'ltx-2.3',
    revision: null,
    label: 'Ingredients',
    description: 'A scene recomposed from 2-8 reference stills (characters, props, settings)',
    uploadLabel: 'Upload a reference still (character / prop / setting)',
    repo: 'Lightricks/LTX-2.3-22b-IC-LoRA-Ingredients',
    filename: 'ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors',
    // From the HF `x-linked-size` header.
    sizeBytes: 1_308_778_338,
    // `__metadata__` says "1" (read via HTTP Range over the header): full-resolution references, no divisibility rule.
    referenceDownscaleFactor: 1,
    // 2-8 stills. A wrong count yields plausible-looking garbage, so it is enforced at every layer (route,
    // icLoraArgs, and the Python helper via --ic-min/max-references).
    minReferences: 2,
    maxReferences: 8,
    // Stills, not clips; drives the panel's `accept` filter and the route's gallery-image resolution.
    referenceKind: 'image',
    // Official repo is gated (license + HF token); surfaced in the UI instead of a bare 401. The mirror is the un-gated path.
    gated: true,
    // Un-gated fallback: the ~708 GB aggregate mirror, so it may ONLY be fetched single-file (`--only <filename>`).
    mirrorRepo: 'DeepBeepMeep/LTX-2',
    mirrorFilename: 'ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors',
    // Suppresses resolveIcLoraWeight's bare-repo-id fallback: `snapshot_download` of the gated repo 401s
    // mid-render and of the mirror pulls 708 GB. The user pre-downloads the single file first.
    requiresPreDownload: true,
  }),
  'ingredients-25': Object.freeze({
    id: 'ingredients-25',
    mode: 'ic-ingredients-25',
    baseModel: 'ltx-2.5',
    revision: null,
    label: 'LTX 2.5 References',
    description: 'Keep characters, props and locations consistent with a reference sheet',
    uploadLabel: 'Choose a character, prop or location reference',
    repo: 'Lightricks/LTX-2.5-22b-IC-LoRA-Ingredients',
    filename: 'ltx-2.5-22b-ic-lora-ingredients-0.9.safetensors',
    // Measured from the official file.
    sizeBytes: 1_308_787_472,
    referenceDownscaleFactor: 1,
    minReferences: 1,
    maxReferences: 8,
    referenceKind: 'image',
    gated: true,
    requiresPreDownload: true,
  }),
  // NOT a remix mode (`mode: null`) and not on the remix base model: the 2x Pixel Spatial Upscaler adapter for
  // LTX-2.5, reached from the video upscale flow (#6502). Registered here to share the provisioning surface.
  'pixel-upscale': Object.freeze({
    id: 'pixel-upscale',
    mode: null,
    baseModel: 'ltx-2.5',
    label: 'Pixel Spatial Upscaler',
    description: '2x reference-conditioned upscale that synthesizes detail (LTX-2.5)',
    uploadLabel: 'Upscale an existing clip',
    repo: 'Lightricks/LTX-2.5-22b-IC-LoRA-Pixel-Spatial-Upscaler',
    filename: 'ltx-2.5-22b-ic-lora-pixel-spatial-upscaler-x2-1.0.safetensors',
    // Pinned so an install can't resolve a different commit's weight out of an older snapshot.
    revision: '5863fdef3eaa8b2d69fa22e259a1d75fede215dd',
    // Exact, from the repo's blob listing. Do not round it.
    sizeBytes: 327_322_640,
    // DECLARED factor "2", read from `__metadata__` at the pinned revision (#6512). The entry was `null`
    // while the file was gated and unopenable. `readIcLoraReferenceDownscaleFactor` still measures the real
    // file when an install holds it, so a re-pinned weight is measured rather than trusted.
    referenceDownscaleFactor: 2,
    minReferences: 1,
    maxReferences: 1,
    referenceKind: 'video',
    // Gated (license + HF token). Deliberately NO mirror: #6502 rules out third-party release mirrors.
    gated: true,
    // Suppresses the bare-repo-id fallback: a gated repo id would 401 deep inside a render.
    requiresPreDownload: true,
  }),
});

// Every registered spec: the PROVISIONING surface (download / verify / repair / cache probe), including
// non-remix weights. Keeps the container shape private.
export const listIcLoraWeights = () => Object.values(IC_LORA_MODES);

// A render mode must name a supported LTX generation.
const isRemixSpec = (spec) => !!spec?.mode && ['ltx-2.3', 'ltx-2.5'].includes(spec.baseModel);

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

export const listIcLoraRemixModes = () => listIcLoraWeights().filter(isRemixSpec);

// PortOS `mode` values that route to the IC-LoRA pipeline; the route enum is derived from the registry.
export const IC_LORA_MODE_VALUES = Object.freeze(
  listIcLoraRemixModes().map((m) => m.mode),
);

export const isIcLoraMode = (mode) => typeof mode === 'string' && IC_LORA_MODE_VALUES.includes(mode);

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

// The IC encoder downscales the reference by `referenceDownscaleFactor`, so OUTPUT dimensions must divide
// evenly by it; returns a human message when they don't, else null. Mirrored client-side. A `null`/absent factor
// is UNKNOWN, not 1: guessing would reject valid resolutions or pass ones the pipeline refuses mid-render.
export const icResolutionIssue = (spec, width, height) => {
  const scale = spec?.referenceDownscaleFactor;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 1) return null;
  if (Number(width) % scale === 0 && Number(height) % scale === 0) return null;
  return `${spec.label} mode needs a resolution divisible by ${scale} (its reference encoder downscales by ${scale}); got ${width}×${height}.`;
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

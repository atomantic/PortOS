// IC-LoRA weight registry for the local LTX-2 video runtime (issue #3100).
//
// The `ltx2` runtime already ships `ltx_pipelines_mlx.ic_lora.ICLoraPipeline`
// — a two-stage pipeline that conditions generation on a *reference video*
// channel with an IC ("In-Context") LoRA fused into Stage 1. Which capability
// you get is entirely a function of WHICH IC-LoRA weight is fused, so this
// module is the single source of truth mapping a PortOS remix mode
// (`ic-control`, …) to its weight, HF repo, reference-count rule, and the
// resolution constraint the weight's metadata imposes.
//
// Weights are NOT bundled — each is a separate multi-hundred-MB HF pull, so
// they ride the same cache-inspect / download-SSE / verify / repair surface as
// the model weights themselves (see routes/videoGen.js). `resolveIcLoraWeight`
// returns a local cached file path when present and falls back to the HF repo
// id, which ICLoraPipeline._resolve_lora_path resolves on its own — so a render
// still works if the user skipped the explicit pre-download (it just stalls
// silently on the pull instead of showing progress).
//
// The repo-id fallback is NOT universally safe: `_resolve_lora_path` implements
// it as `snapshot_download(repo_id)`, which pulls the ENTIRE repo. That's fine
// for a single-weight repo (Control, Colorize) and catastrophic for an aggregate
// mirror — `DeepBeepMeep/LTX-2` carries every LTX weight in one ~708 GB repo. A
// spec whose chain includes such a repo sets `requiresPreDownload`, and
// resolveIcLoraWeight then refuses to emit a bare repo id at all (see below).
//
// Gating: Control and Colorize are un-gated. Ingredients' official Lightricks
// repo is gated (`gated: "auto"` — an anonymous resolve returns 401 GatedRepo),
// so `gated: true` marks it and the mirror provides an un-gated path for users
// without an HF token.

import { findCachedRepoFile } from './hfCache.js';
import { readSafetensorsHeader } from './safetensors.js';

// The base model the MLX `ICLoraPipeline` remix path is pinned to. A weight
// whose `baseModel` is anything else is registered here for PROVISIONING only —
// it rides the same download/verify/repair surface, but it must never reach the
// render-mode enum, because fusing a 2.5 adapter into the 2.3 pipeline loads
// without erroring and produces garbage rather than a clean failure.
export const IC_LORA_REMIX_BASE_MODEL = 'ltx-2.3';

// One entry per registered IC-LoRA weight. `minReferences`/`maxReferences` are
// the weight's contract: the Python helper receives them as flags (never a
// second hardcoded table) so this registry stays the single source of truth
// across both languages.
//
// `baseModel` is which LTX release the adapter was trained against, and
// `mode` is the PortOS remix mode it is offered as — `null` for a weight that
// is not a remix mode at all (the Pixel Spatial Upscaler is an upscale
// adapter, reached from the upscale flow rather than the render form). The two
// fields are INDEPENDENT gates: `listIcLoraRemixModes` requires both.
//
// `revision` pins the HF commit the weight is fetched and cache-resolved at.
// `null` means unpinned — the historical behavior for the 2.3 weights, which
// resolve out of whatever snapshot the install happens to hold.
//
// `referenceDownscaleFactor` is informational (the pipeline reads the real
// value from the weight's safetensors metadata): the IC encoder divides the
// reference clip by it, and it requires the OUTPUT height/width to be
// divisible by that factor — so surfacing it lets the route reject a bad
// resolution up-front instead of failing deep inside the pipeline. It is
// PER-WEIGHT and must be READ from the weight's `__metadata__`, never copied
// from a sibling entry: Union-Control ships 2, the Colorizer ships 1.
//
// The MIRRORED fields (label/description/referenceKind/uploadLabel/the counts/
// the factor) are duplicated in client/src/lib/videoGenParams.js so the form can
// validate pre-submit; icLoraWeights.parity.test.js diffs the two so a change
// here can't silently leave the client accepting what the server rejects. That
// mirror covers REMIX MODES only — a non-remix weight has no form surface, so
// mirroring it would ship a field the client never reads.
export const IC_LORA_MODES = Object.freeze({
  control: Object.freeze({
    id: 'control',
    mode: 'ic-control',
    baseModel: 'ltx-2.3',
    revision: null,
    label: 'Control',
    description: 'Structure + motion from a control clip',
    // Drives the panel's upload copy + `accept` filter, so a new mode needs no
    // component change to describe its own input (see referenceKind).
    uploadLabel: 'Upload a control clip (depth / pose / edges)',
    repo: 'Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control',
    filename: 'ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors',
    // ~654 MB — used for the download badge's size estimate before the pull.
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
    // Community-published (DoctorDiffusion), not Lightricks — un-gated all the
    // same, so it rides the identical download/verify surface.
    repo: 'DoctorDiffusion/LTX-2.3-IC-LoRA-Colorizer',
    filename: 'LTX-2.3-22b-IC-LoRA-Colorizer-0.9.safetensors',
    // ~312 MiB (327 MB) — used for the download badge's size estimate.
    sizeBytes: 312 * 1024 * 1024,
    // Read from the weight's safetensors `__metadata__.reference_downscale_factor`,
    // which is "1" here — the Colorizer conditions on a FULL-resolution reference
    // rather than Union-Control's halved one, so it imposes no divisibility rule
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
    // 1_308_778_338 bytes, read from the HF `x-linked-size` header — not a guess.
    sizeBytes: 1_308_778_338,
    // Read from the weight's safetensors `__metadata__.reference_downscale_factor`
    // (fetched with an HTTP Range request over the header region, so no 1.3 GB
    // download was needed to confirm it): "1". Like the Colorizer this weight
    // conditions on FULL-resolution references and imposes no divisibility rule.
    referenceDownscaleFactor: 1,
    // The weight's contract: 2-8 reference stills. A wrong count yields
    // plausible-looking garbage rather than an error, so it's enforced at every
    // layer (route, icLoraArgs, and the Python helper via --ic-min/max-references).
    minReferences: 2,
    maxReferences: 8,
    // Images, not clips — Ingredients recomposes a scene from stills. Drives the
    // panel's `accept` filter and the route's gallery-image resolution.
    referenceKind: 'image',
    // The official Lightricks repo is gated (accept the license + supply an HF
    // token), so surface that in the UI instead of letting the download fail
    // with a bare 401. The mirror below is the un-gated path.
    gated: true,
    // Un-gated fallback for users without an HF token. This repo is the ~708 GB
    // `DeepBeepMeep/LTX-2` aggregate mirror, so it may ONLY ever be fetched
    // single-file (`--only <filename>`) — see requiresPreDownload.
    mirrorRepo: 'DeepBeepMeep/LTX-2',
    mirrorFilename: 'ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors',
    // Suppresses resolveIcLoraWeight's bare-repo-id fallback. Handing either
    // repo id to ICLoraPipeline._resolve_lora_path would `snapshot_download` it:
    // the official one is gated (401 mid-render) and the mirror is 708 GB. The
    // user must pre-download the weight through PortOS' single-file path first.
    requiresPreDownload: true,
  }),
  // NOT a remix mode (`mode: null`) and NOT on the remix base model — the
  // Pixel Spatial Upscaler is a 2x reference-conditioned upscale adapter for
  // LTX-2.5, reached from the video upscale flow (#6502) rather than the render
  // form. It is registered here so it rides the one provisioning surface every
  // other IC weight uses.
  'pixel-upscale': Object.freeze({
    id: 'pixel-upscale',
    mode: null,
    baseModel: 'ltx-2.5',
    label: 'Pixel Spatial Upscaler',
    description: '2x reference-conditioned upscale that synthesizes detail (LTX-2.5)',
    uploadLabel: 'Upscale an existing clip',
    repo: 'Lightricks/LTX-2.5-22b-IC-LoRA-Pixel-Spatial-Upscaler',
    filename: 'ltx-2.5-22b-ic-lora-pixel-spatial-upscaler-x2-1.0.safetensors',
    // Pinned so an install can't silently resolve a different commit's weight
    // out of an older snapshot. Read from the HF repo metadata on 2026-09-07.
    revision: '5863fdef3eaa8b2d69fa22e259a1d75fede215dd',
    // Exact, from the repo's blob listing — not an estimate. Do not round it.
    sizeBytes: 327_322_640,
    // Read from the weight's safetensors `__metadata__.reference_downscale_factor`
    // — "2" — on 2026-09-07, off the file at the pinned revision above
    // (sha256 984851b769ea2bcb4c9e0a239a7676239e42c6a6001ddc69943b41ff0b283c1d),
    // on an install that had accepted the license (#6512). The model card
    // states the same value. The entry was `null` until then precisely because
    // the file is gated and nothing in this repo could open it; the value here
    // is the DECLARED one, and `readIcLoraReferenceDownscaleFactor` below still
    // reads the real file whenever an install holds it, so a re-pinned weight
    // that changes its factor is measured rather than trusted.
    referenceDownscaleFactor: 2,
    // The clip being upscaled is the single reference.
    minReferences: 1,
    maxReferences: 1,
    referenceKind: 'video',
    // Gated: the model card 401s anonymously and the weight needs an accepted
    // license plus an HF token. There is deliberately NO mirror — #6502 rules
    // out adopting a third-party release mirror or side-stepping the terms.
    gated: true,
    // Suppresses resolveIcLoraWeight's bare-repo-id fallback: handing a gated
    // repo id to a pipeline's own resolver produces a 401 deep inside a render
    // instead of an actionable "download the weight first" error.
    requiresPreDownload: true,
  }),
});

// Every registered spec, in declaration order — the PROVISIONING surface
// (download / verify / repair / cache probe), which covers weights that are not
// remix modes. Consumers use this instead of reaching into IC_LORA_MODES
// directly so the container shape stays private.
export const listIcLoraWeights = () => Object.values(IC_LORA_MODES);

// A weight is offered as a render remix mode only if it both carries a `mode`
// value and targets the base model the remix pipeline is pinned to. A weight
// failing either test is still provisioned, just never rendered with.
const isRemixSpec = (spec) => !!spec?.mode && spec.baseModel === IC_LORA_REMIX_BASE_MODEL;

export const listIcLoraRemixModes = () => listIcLoraWeights().filter(isRemixSpec);

// PortOS `mode` values that route to the IC-LoRA pipeline. Every entry is
// `ic-<id>` so a single prefix test identifies the family, and the route enum
// stays a closed list derived from the registry (never hand-maintained).
export const IC_LORA_MODE_VALUES = Object.freeze(
  listIcLoraRemixModes().map((m) => m.mode),
);

export const isIcLoraMode = (mode) => typeof mode === 'string' && IC_LORA_MODE_VALUES.includes(mode);

// `ic-control` → the registry entry, or null for anything else. Accepts the
// bare id (`control`) too so callers that already stripped the prefix work.
//
// REMIX MODES ONLY. Every caller is on the render path, where resolving a
// non-remix weight would let an upscale adapter be fused into the 2.3 remix
// pipeline. Provisioning callers, which legitimately need the whole registry,
// use `icLoraSpecByKey` instead.
export const icLoraSpecForMode = (mode) => {
  if (typeof mode !== 'string' || !mode) return null;
  const id = mode.startsWith('ic-') ? mode.slice(3) : mode;
  const spec = IC_LORA_MODES[id] || null;
  return isRemixSpec(spec) ? spec : null;
};

// The stable identifier a weight is addressed by outside the render path — the
// remix mode when it has one, else its registry id. This is what the models
// status payload reports and what the download/repair routes take as a param,
// so an existing client URL (`/ic-loras/ic-control/download`) is unchanged.
export const icLoraWeightKey = (spec) => (spec ? (spec.mode || spec.id) : null);

// Resolve ANY registered weight by its `icLoraWeightKey`, for the provisioning
// endpoints. Also accepts a bare registry id so a caller that already stripped
// the `ic-` prefix works, matching icLoraSpecForMode's tolerance.
export const icLoraSpecByKey = (key) => {
  if (typeof key !== 'string' || !key) return null;
  const direct = listIcLoraWeights().find((spec) => icLoraWeightKey(spec) === key);
  if (direct) return direct;
  const id = key.startsWith('ic-') ? key.slice(3) : key;
  return IC_LORA_MODES[id] || null;
};

// Every addressable weight key, for the "expected one of …" error the
// provisioning routes raise on an unknown param.
export const IC_LORA_WEIGHT_KEYS = Object.freeze(listIcLoraWeights().map(icLoraWeightKey));

// Whether this weight must be located by its EXACT (repo, filename, revision)
// rather than by a repo-wide cache verdict. True for a mirrored spec (the
// aggregate mirror reports `cached` off any unrelated resident weight) and for
// a revision-pinned spec (a repo-wide check would happily accept a different
// commit's snapshot). Both cases also make an unscoped integrity walk wrong.
export const icLoraProbesExactFile = (spec) => !!(spec && (spec.mirrorRepo || spec.revision));

// Every IC-LoRA HF repo, for the integrity-scan / status surface. The mirror
// repos are deliberately EXCLUDED: an unscoped integrity scan walks each repo's
// whole snapshot, and for the 708 GB aggregate mirror that means stat-ing (and
// under `deep`, hashing) every unrelated weight the user happens to have. The
// weight we care about there is verified via icLoraWeightCandidates instead.
export const icLoraRepos = () => listIcLoraWeights().map((m) => m.repo);

// Every (repo, filename) pair a spec's weight can legitimately come from, in
// preference order: the official repo first, then the un-gated mirror. Shared by
// the cache probe and the download endpoint so "where does this weight live?" has
// exactly one answer.
export const icLoraWeightCandidates = (spec) => {
  if (!spec) return [];
  const candidates = [{
    repo: spec.repo, filename: spec.filename, revision: spec.revision || null, mirror: false,
  }];
  if (spec.mirrorRepo) {
    candidates.push({
      repo: spec.mirrorRepo,
      filename: spec.mirrorFilename || spec.filename,
      // The pinned revision belongs to the OFFICIAL repo's history; a mirror is
      // a different repository whose commits have nothing to do with it, so
      // pinning it there would resolve nothing. Mirrors stay unpinned.
      revision: null,
      mirror: true,
    });
  }
  return candidates;
};

// "exactly 1" / "2-8" — the human phrasing of a spec's reference-count rule.
// Lives here so the route and the arg builder can't word (or bound) it
// differently, and so the Python helper's flags come from one place.
export const describeIcReferenceRange = (spec) => (
  spec.minReferences === spec.maxReferences
    ? `exactly ${spec.minReferences}`
    : `${spec.minReferences}-${spec.maxReferences}`
);

// Throw when `count` violates the weight's reference contract. `fail` builds the
// caller's error (the route needs a ServerError with its own staging cleanup
// already done; the worker needs a plain one), so the MESSAGE and the BOUNDS
// stay single-sourced even though the throw sites differ.
export const assertIcReferenceCount = (spec, count, fail) => {
  if (count >= spec.minReferences && count <= spec.maxReferences) return;
  throw fail(
    `${spec.label} mode needs ${describeIcReferenceRange(spec)} reference ${spec.referenceKind}(s); got ${count}.`,
  );
};

// The IC encoder downscales the reference by `referenceDownscaleFactor`, which
// requires the OUTPUT dimensions to divide evenly by it. Returns a human message
// when they don't, else null. Mirrored client-side (icResolutionIssue in
// client/src/lib/videoGenParams.js) so the form can warn before submit.
// A `null`/absent factor is UNKNOWN, not 1 — the weight's metadata hasn't been
// read yet (a gated file nobody with accepted terms has opened). Both resolve
// to "assert no rule", but they must stay distinguishable: guessing a factor
// here would either reject valid resolutions or green-light ones the pipeline
// will refuse deep inside a render.
export const icResolutionIssue = (spec, width, height) => {
  const scale = spec?.referenceDownscaleFactor;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 1) return null;
  if (Number(width) % scale === 0 && Number(height) % scale === 0) return null;
  return `${spec.label} mode needs a resolution divisible by ${scale} (its reference encoder downscales by ${scale}); got ${width}×${height}.`;
};

/**
 * The reference downscale factor a spec's DOWNLOADED weight actually declares.
 *
 * `referenceDownscaleFactor` on the registry entry is what this repo could
 * verify when the entry was written; for a gated weight that is `null`. This
 * reads the truth off the file an install holds — the same
 * `__metadata__.reference_downscale_factor` the MLX pipeline itself reads
 * (`iclora_utils.read_lora_reference_downscale_factor`) — so the resolution
 * rule can be stated before a render commits to it.
 *
 * Returns `{ factor, measured }`: `measured` is true only when the value came
 * off a real local file. When nothing is cached (or the header is unreadable)
 * it falls back to the registry value, which may itself be `null` — absent and
 * "declared 1" must stay distinguishable, so this never coerces one into the
 * other.
 */
export const readIcLoraReferenceDownscaleFactor = async (spec) => {
  const declared = typeof spec?.referenceDownscaleFactor === 'number' ? spec.referenceDownscaleFactor : null;
  const cached = spec ? await findCachedIcLoraWeight(spec) : null;
  if (!cached) return { factor: declared, measured: false };
  const header = await readSafetensorsHeader(cached.path);
  const raw = header?.__metadata__?.reference_downscale_factor;
  const factor = Number.parseInt(raw, 10);
  // The key is absent on a weight that imposes no rule, which the pipeline
  // reads as 1 — so an absent key is a real measurement of "no rule", while an
  // unreadable header is not a measurement at all.
  if (!header) return { factor: declared, measured: false };
  return Number.isInteger(factor) && factor >= 1
    ? { factor, measured: true }
    : { factor: 1, measured: true };
};

// Locate a spec's weight in the local HF cache. Walks every candidate (official
// repo, then the un-gated mirror) and pins the EXACT filename inside the newest
// snapshot rather than letting the pipeline glob-pick among several
// `.safetensors` in a multi-weight repo — which for the aggregate mirror would
// pick an arbitrary unrelated LTX weight. Returns the resolved candidate
// (`{ path, repo, filename, mirror }`) or null when nothing is cached.
export const findCachedIcLoraWeight = async (spec) => {
  for (const candidate of icLoraWeightCandidates(spec)) {
    // findCachedRepoFile, NOT inspectModelCache: the latter recursively walks and
    // stats every weight in the snapshot, which for the aggregate mirror means
    // hundreds of GB of unrelated files. This resolves the one filename directly,
    // inside the PINNED revision's snapshot when the spec pins one.
    const path = await findCachedRepoFile(candidate.repo, candidate.filename, {
      revision: candidate.revision,
    });
    if (path) return { ...candidate, path };
  }
  return null;
};

// Resolve the weight to hand the Python helper. Prefers a real cached file (via
// findCachedIcLoraWeight), then falls back to the bare repo id — which
// ICLoraPipeline._resolve_lora_path downloads itself via `snapshot_download`.
//
// That fallback is SUPPRESSED for a `requiresPreDownload` spec. `snapshot_download`
// pulls the whole repo, and for Ingredients both candidates make that unacceptable:
// the official repo is gated (a 401 deep inside the render) and the mirror is the
// ~708 GB `DeepBeepMeep/LTX-2` aggregate, which would fill the user's disk. Those
// specs return `path: null` so the caller fails fast with a "download the weight
// first" error instead.
//
// Returns `{ path, cached, spec, repo? }`: `cached` is true only when a real local
// file was found, so callers can warn the user that an un-cached weight means a
// silent multi-hundred-MB pull at render time.
export const resolveIcLoraWeightSpec = async (spec) => {
  if (!spec) return null;
  const cached = await findCachedIcLoraWeight(spec);
  if (cached) return { path: cached.path, cached: true, spec, repo: cached.repo };
  if (spec.requiresPreDownload) return { path: null, cached: false, spec };
  return { path: spec.repo, cached: false, spec };
};

export const resolveIcLoraWeight = async (mode) => resolveIcLoraWeightSpec(icLoraSpecForMode(mode));

// The provisioning/upscale-flow counterpart: resolves ANY registered weight by
// its `icLoraWeightKey`, including weights that are not remix modes. Same return
// shape, so a caller outside the render path reads one contract.
export const resolveIcLoraWeightByKey = async (key) => resolveIcLoraWeightSpec(icLoraSpecByKey(key));

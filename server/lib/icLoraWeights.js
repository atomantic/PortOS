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

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { inspectModelCache } from './hfCache.js';

// One entry per shipped remix mode. `minReferences`/`maxReferences` are the
// weight's contract: the Python helper receives them as flags (never a second
// hardcoded table) so this registry stays the single source of truth across
// both languages.
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
// here can't silently leave the client accepting what the server rejects.
export const IC_LORA_MODES = Object.freeze({
  control: Object.freeze({
    id: 'control',
    mode: 'ic-control',
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
});

// Every registered spec, in declaration order. Consumers use this instead of
// reaching into IC_LORA_MODES directly so the container shape stays private.
export const listIcLoraWeights = () => Object.values(IC_LORA_MODES);

// PortOS `mode` values that route to the IC-LoRA pipeline. Every entry is
// `ic-<id>` so a single prefix test identifies the family, and the route enum
// stays a closed list derived from the registry (never hand-maintained).
export const IC_LORA_MODE_VALUES = Object.freeze(
  Object.values(IC_LORA_MODES).map((m) => m.mode),
);

export const isIcLoraMode = (mode) => typeof mode === 'string' && IC_LORA_MODE_VALUES.includes(mode);

// `ic-control` → the registry entry, or null for anything else. Accepts the
// bare id (`control`) too so callers that already stripped the prefix work.
export const icLoraSpecForMode = (mode) => {
  if (typeof mode !== 'string' || !mode) return null;
  const id = mode.startsWith('ic-') ? mode.slice(3) : mode;
  return IC_LORA_MODES[id] || null;
};

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
  const candidates = [{ repo: spec.repo, filename: spec.filename, mirror: false }];
  if (spec.mirrorRepo) {
    candidates.push({
      repo: spec.mirrorRepo,
      filename: spec.mirrorFilename || spec.filename,
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
export const icResolutionIssue = (spec, width, height) => {
  const scale = spec?.referenceDownscaleFactor ?? 1;
  if (scale <= 1) return null;
  if (Number(width) % scale === 0 && Number(height) % scale === 0) return null;
  return `${spec.label} mode needs a resolution divisible by ${scale} (its reference encoder downscales by ${scale}); got ${width}×${height}.`;
};

// Locate a spec's weight in the local HF cache. Walks every candidate (official
// repo, then the un-gated mirror) and pins the EXACT filename inside the newest
// snapshot rather than letting the pipeline glob-pick among several
// `.safetensors` in a multi-weight repo — which for the aggregate mirror would
// pick an arbitrary unrelated LTX weight. Returns the resolved candidate
// (`{ path, repo, filename, mirror }`) or null when nothing is cached.
export const findCachedIcLoraWeight = async (spec) => {
  for (const candidate of icLoraWeightCandidates(spec)) {
    const { snapshotPath } = await inspectModelCache(candidate.repo);
    if (!snapshotPath) continue;
    const exact = join(snapshotPath, candidate.filename);
    // `existsSync` FOLLOWS symlinks, so a dangling snapshot link left by an
    // interrupted download reports false here — the same "is it really resident?"
    // question inspectModelCache asks of a whole snapshot.
    if (existsSync(exact)) return { ...candidate, path: exact };
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
export const resolveIcLoraWeight = async (mode) => {
  const spec = icLoraSpecForMode(mode);
  if (!spec) return null;
  const cached = await findCachedIcLoraWeight(spec);
  if (cached) return { path: cached.path, cached: true, spec, repo: cached.repo };
  if (spec.requiresPreDownload) return { path: null, cached: false, spec };
  return { path: spec.repo, cached: false, spec };
};

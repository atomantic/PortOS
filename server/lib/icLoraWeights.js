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
// All registered weights are un-gated (no HF token required).

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
// resolution up-front instead of failing deep inside the pipeline.
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
    referenceDownscaleFactor: 2,
    minReferences: 1,
    maxReferences: 1,
    referenceKind: 'video',
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

// Every IC-LoRA HF repo, for the integrity-scan / status surface.
export const icLoraRepos = () => listIcLoraWeights().map((m) => m.repo);

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

// Resolve the weight to hand the Python helper. Prefers the exact filename
// inside the newest HF cache snapshot (so we pin the file rather than letting
// the pipeline glob-pick among several `.safetensors` in a multi-weight repo),
// then any cached snapshot path for the repo, and finally the bare repo id —
// which ICLoraPipeline downloads itself.
//
// Returns `{ path, cached }`: `cached` is true only when a real local file was
// found, so callers can warn the user that an un-cached weight means a silent
// multi-hundred-MB pull at render time.
export const resolveIcLoraWeight = async (mode) => {
  const spec = icLoraSpecForMode(mode);
  if (!spec) return null;
  const { snapshotPath } = await inspectModelCache(spec.repo);
  if (snapshotPath) {
    const exact = join(snapshotPath, spec.filename);
    if (existsSync(exact)) return { path: exact, cached: true, spec };
  }
  return { path: spec.repo, cached: false, spec };
};

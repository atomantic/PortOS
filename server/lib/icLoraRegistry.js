/**
 * IC-LoRA weight registry data for the LTX video runtimes: the remix-mode table and its pure lookups (`icResolutionIssue`).
 *
 * ONE definition, imported by `server/lib/icLoraWeights.js` (which adds the HF-cache resolution that reaches `node:fs`) and re-exported to the browser by `client/src/lib/videoGenParams.js`, so the render form validates against the same labels, reference bounds and downscale factors the route enforces. No imports, so the browser bundle can load it. The weight repo / filename / size fields ride along but the client never resolves a weight path.
 */

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
// The client re-exports the remix subset (`listIcLoraRemixModes`) as its form registry; a non-remix weight has no form surface.
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
export const isRemixSpec = (spec) => !!spec?.mode && ['ltx-2.3', 'ltx-2.5'].includes(spec.baseModel);

export const listIcLoraRemixModes = () => listIcLoraWeights().filter(isRemixSpec);

// PortOS `mode` values that route to the IC-LoRA pipeline; the route enum is derived from the registry.
export const IC_LORA_MODE_VALUES = Object.freeze(
  listIcLoraRemixModes().map((m) => m.mode),
);

export const isIcLoraMode = (mode) => typeof mode === 'string' && IC_LORA_MODE_VALUES.includes(mode);

// The IC encoder downscales the reference by `referenceDownscaleFactor`, so OUTPUT dimensions must divide
// evenly by it; returns a human message when they don't, else null. A `null`/absent factor
// is UNKNOWN, not 1: guessing would reject valid resolutions or pass ones the pipeline refuses mid-render.
export const icResolutionIssue = (spec, width, height) => {
  const scale = spec?.referenceDownscaleFactor;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 1) return null;
  if (Number(width) % scale === 0 && Number(height) % scale === 0) return null;
  return `${spec.label} mode needs a resolution divisible by ${scale} (its reference encoder downscales by ${scale}); got ${width}×${height}.`;
};


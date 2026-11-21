import { existsSync } from 'fs';
import { basename, join, resolve as resolvePath, sep as PATH_SEP } from 'path';
import { PATHS, resolveImageInputPath } from '../../lib/fileUtils.js';
import { usesMossSwift } from '../../lib/imageRuntimeRemedies.js';
import { weaveLoraTriggers } from '../../lib/loraTriggers.js';
import { provenanceForRender } from '../../lib/assetProvenance.js';
import { carriedPromptAdditions, promptAddition, sentPromptRecord } from '../../lib/modelInput.js';
import { readTriggerWordsByFilename } from '../loras.js';
import { MOSS_MANIFEST } from './mossRuntime.js';

// Clamp 0..1 with a finite-fallback — Math.max/min preserve NaN, so a
// corrupt sidecar value like Number('bad') would slip through and end up
// serialized into metadata / the CLI flag. `null` here means "no strength
// sent" (init-image), which the args builder already gates on; for refs
// we fall back to 1.0 (full influence).
const clampStrength01 = (raw, fallback) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
};

function resolveSidecarLoras({ loraFilenames, loraPaths, loraExists }) {
  // The new client-side surface sends `loraFilenames` (basenames only); the
  // server resolves them against PATHS.loras. `loraPaths` is kept as a
  // back-compat input for old gallery sidecars that stored absolute paths
  // pre-refactor — both go through the same resolve+prefix-check.
  const lorasRoot = resolvePath(PATHS.loras) + PATH_SEP;
  const candidates = [
    ...loraFilenames.map((f) => (typeof f === 'string' ? join(PATHS.loras, basename(f)) : null)),
    ...loraPaths,
  ];
  return candidates.filter((p) => {
    if (!p || typeof p !== 'string') return false;
    const resolved = resolvePath(p);
    if (!resolved.startsWith(lorasRoot)) return false;
    return loraExists(resolved);
  });

}

function resolveSidecarImages({ initImagePath, initImageStrength, referenceImagePaths, referenceImageStrengths, resolveInputPath }) {
  // i2i: defense in depth — the route already validated a fresh request,
  // but an old sidecar replay can carry a stale absolute path outside the
  // approved image roots. resolveInputPath accepts gallery + image-refs
  // + visual templates — the latter so the universe-builder reference-sheet
  // renderer can use a shipped layout template as the init-image anchor.
  const validInitImagePath = (initImagePath && typeof initImagePath === 'string')
    ? resolveInputPath(initImagePath)
    : null;
  const validInitImageStrength = validInitImagePath && initImageStrength != null
    ? clampStrength01(initImageStrength, null)
    : null;
  // Multi-reference: re-anchor each path through resolveInputPath so a
  // sidecar replay can't sneak a path outside the approved image roots into
  // the runner. Accepts gallery + image-refs + visual templates — the gallery
  // path lets a canon portrait (e.g. character.primaryImageRef) flow in as a
  // multi-ref input. Pair each path with its strength BEFORE filtering so a
  // rejected entry doesn't shift the strength array — otherwise the surviving
  // path would inherit the wrong slot's strength.
  const rawRefPaths = Array.isArray(referenceImagePaths) ? referenceImagePaths : [];
  const validReferences = rawRefPaths
    .map((p, i) => {
      const resolved = typeof p === 'string' ? resolveInputPath(p) : null;
      if (!resolved) return null;
      const rawStrength = referenceImageStrengths?.[i];
      const strength = rawStrength != null ? clampStrength01(rawStrength, 1.0) : 1.0;
      return { path: resolved, strength };
    })
    .filter(Boolean);
  const validReferenceImagePaths = validReferences.map((r) => r.path);
  const validReferenceImageStrengths = validReferences.map((r) => r.strength);
  return { validInitImagePath, validInitImageStrength, validReferenceImagePaths, validReferenceImageStrengths };
}

/**
 * Build the resolved/validated render parameters + sidecar `meta` object for a
 * generation job. Factored out of `generateImage` so the resolution rules
 * (seed/steps/guidance defaults, LoRA prefix-check, init/reference path
 * re-anchoring, strength clamping) are unit-testable without spawning Python
 * or touching the gallery filesystem.
 *
 * Filesystem touch-points are injected so the function stays pure:
 * - `resolveInputPath(rawPath)` — re-anchors an init/reference path against the
 *   approved image roots; returns the validated absolute path or `null`
 *   (production passes `resolveImageInputPath`).
 * - `loraExists(absPath)` — whether a prefix-checked LoRA path exists on disk
 *   (production passes `existsSync`).
 * - `loraTriggerWords` — `{ [loraBasename]: string[] }` read from the LoRA
 *   sidecars by `generateImage`, so the trigger-word weave (#4665) needs no I/O
 *   of its own.
 *
 * `meta` is the exact object `generateImage` persists as the `<jobId>.metadata.json`
 * sidecar AND spreads into the in-memory job + activeJob snapshots, so the
 * shape returned here is the contract the gallery/Remix flow reads back.
 */
export function buildSidecarMeta({
  jobId,
  model,
  prompt,
  negativePrompt = '',
  modelId,
  width,
  height,
  steps,
  guidance,
  seed,
  quantize,
  loraFilenames = [],
  loraPaths = [],
  loraScales = [],
  // LoRA trigger-word weaving (#4665). `loraTriggerWords` maps a LoRA basename
  // to its sidecar `triggerWords` array; `generateImage` reads the sidecars and
  // passes the map so this stays pure. Keyed rather than positional because the
  // valid-LoRA order is only known after the prefix-check below.
  loraTriggerWords = null,
  // License map keyed by LoRA basename, read from sidecars by generateImage
  // so this stays pure. Missing entries stamp license: null (unknown).
  loraLicenses = null,
  // The labeled additions the composer put around the user's text (lib/modelInput.js).
  promptAdditions = [],
  initImagePath = null,
  initImageStrength = null,
  referenceImagePaths = [],
  referenceImageStrengths = [],
  visualConditioning = null,
  // SynthID-defeat regen lineage. When `regenOf` is set, this render is a
  // post-hoc round-trip of an existing gallery image through local FLUX
  // img2img (issue #912) — stamp the source filename as `cleanedFrom` (so the
  // lightbox variant toggle groups the regen under its source the same way a
  // cleaned copy is) plus explicit `regenerated`/`regenSteps`/`regenStrength`/
  // `regenModelId` so the sidecar lineage stays honest about how it was made.
  regenOf = null,
  resolveInputPath,
  loraExists,
  now = () => new Date().toISOString(),
}) {
  const filename = `${jobId}.png`;
  const actualSeed = seed != null && seed !== '' ? Number(seed) : Math.floor(Math.random() * 2147483647);
  const actualSteps = steps ? Number(steps) : model.steps;
  // Step-wise distilled models (Schnell / FLUX.2 Klein / Z-Image-Turbo) ignore
  // any guidance scale > 1.0 internally; passing a real value just produces a
  // "Guidance scale X is ignored for step-wise distilled models." warning on
  // every render. Clamp to ≤1.0 (rather than hard-pin to 1.0) so registry
  // entries that intentionally use 0.0 — e.g. Flux.1 Schnell, where the mflux
  // runner historically *omits* --guidance entirely on 0 — keep their existing
  // behavior. The clamp keeps FLUX.2 / Z-Image / ERNIE quiet while leaving
  // sub-1.0 values (including 0.0) untouched.
  const requestedGuidance = guidance != null && guidance !== '' ? Number(guidance) : model.guidance;
  const actualGuidance = model.cfgDisabled
    ? Math.min(1.0, Number.isFinite(requestedGuidance) ? requestedGuidance : 1.0)
    : requestedGuidance;
  const validLoras = resolveSidecarLoras({ loraFilenames, loraPaths, loraExists });

  // Store loraFilenames (basenames) in the sidecar going forward — that's
  // what the new client API uses for remix. Keep `loraPaths` populated too
  // so older code paths reading the sidecar don't break.
  const validLoraFilenames = validLoras.map((p) => basename(p));
  const { validInitImagePath, validInitImageStrength, validReferenceImagePaths, validReferenceImageStrengths } =
    resolveSidecarImages({ initImagePath, initImageStrength, referenceImagePaths, referenceImageStrengths, resolveInputPath });
  // `referenceImageStrengths` is honored end-to-end: the FLUX.2 runner installs
  // a Flux2KVLayerCache.store + _flux2_kv_causal_attention patch that scales
  // each reference's V slice by the corresponding strength (1.0 = upstream
  // baseline, 0.0 = ignored). Mirrors the Python sidecar's `referenceStrengths`.
  const meta = { id: jobId, prompt, negativePrompt, modelId, seed: actualSeed, width: Number(width), height: Number(height), steps: actualSteps, guidance: actualGuidance, quantize, filename, loraFilenames: validLoraFilenames, loraPaths: validLoras, loraScales, initImageFilename: validInitImagePath ? basename(validInitImagePath) : null, initImageStrength: validInitImageStrength, referenceImageFilenames: validReferenceImagePaths.map((p) => basename(p)), referenceImageStrengths: validReferenceImageStrengths, ...(visualConditioning ? { visualConditioning } : {}), createdAt: now() };
  // Regen lineage (issue #912). `regenOf` is the source gallery filename this
  // render was generated from. We reuse the existing `cleanedFrom` field so the
  // lightbox's `computeImageVariantGroup` groups the regen under its source with
  // zero changes to the grouping key, and add explicit regen* fields so the
  // sidecar honestly records that the per-pixel watermark was overwritten by a
  // fresh sampling pass rather than stripped. `regenStrength`/`regenSteps`/
  // `regenModelId` mirror the resolved render params (not the raw inputs) so a
  // replayed/clamped value is what's recorded.
  // Only stamp the lineage when the init image actually resolved — if the
  // source path was rejected/missing, this render degraded to txt2img and is
  // NOT a regen of anything, so claiming `regenerated: true` would be a lie.
  if (typeof regenOf === 'string' && regenOf && validInitImagePath) {
    meta.cleanedFrom = regenOf;
    meta.regenerated = true;
    // Explicit method so consumers never infer it by absence — the CPU path
    // stamps 'light-spatial', this GPU round-trip stamps 'flux'.
    meta.regenMethod = 'flux';
    meta.regenStrength = validInitImageStrength;
    meta.regenSteps = actualSteps;
    meta.regenModelId = modelId;
  }
  // Weave each selected LoRA's activation token into the prompt that actually
  // reaches the runner (#4665). Provenance stays honest: `meta.prompt` remains
  // the user's own text, so a Remix re-derives triggers from whatever LoRAs are
  // selected at THAT time instead of compounding this render's clause. The
  // render-time text and what was added are recorded alongside it, and only when
  // something was actually appended — an un-woven render's sidecar stays
  // byte-identical to every sidecar written before this feature.
  const { prompt: wovenPrompt, added: addedTriggerWords } = weaveLoraTriggers(
    prompt,
    validLoraFilenames.map((f) => loraTriggerWords?.[f]),
  );
  const renderPrompt = addedTriggerWords.length ? wovenPrompt : prompt;
  if (addedTriggerWords.length) {
    meta.renderPrompt = renderPrompt;
    meta.addedTriggerWords = addedTriggerWords;
  }
  Object.assign(meta, sentPromptRecord({
    sentPrompt: renderPrompt, sentNegativePrompt: negativePrompt, carried: carriedPromptAdditions({ promptAdditions }),
    added: [promptAddition('lora-triggers', 'LoRA trigger words', addedTriggerWords.join(', '))],
  }));
  // Stamp the licenses known at THIS render. A later re-read of the LoRA
  // sidecar or model card must not rewrite what was true when the pixels
  // were made (#5638). Unknown stays null.
  meta.provenance = provenanceForRender({
    model: {
      id: modelId,
      name: model?.name || modelId,
      license: usesMossSwift(model) ? 'apache-2.0' : model?.license,
      repo: usesMossSwift(model) ? MOSS_MANIFEST.repo : model?.repo,
      disclosure: model?.disclosure,
    },
    loras: validLoraFilenames.map((filename) => ({
      filename,
      ...(loraLicenses?.[filename] || {}),
    })),
    capturedAt: meta.createdAt,
  });
  return {
    meta,
    renderPrompt,
    addedTriggerWords,
    actualSeed,
    actualSteps,
    actualGuidance,
    validLoras,
    validInitImagePath,
    validInitImageStrength,
    validReferenceImagePaths,
    validReferenceImageStrengths,
  };
}

/**
 * Resolve where a render's PNG + sidecar go (issue #2264). Pure so the
 * gallery-vs-temp branch is unit-testable without spawning a render.
 *
 * - No `outputTarget` (the default, every existing caller) → the gallery dir
 *   with a sidecar written — the lightbox/regenerate/gen behavior, untouched.
 * - `outputTarget.dir` (the Image Cleaner's temp render) → that dir, and
 *   `skipSidecar` (defaulting true for a non-gallery dir) suppresses the
 *   `<jobId>.metadata.json` write + the gallery `completed` index/federate hooks.
 *
 * A gallery-dir target always keeps its sidecar even if `skipSidecar` was
 * passed — a gallery citizen without a sidecar would be an un-remixable orphan.
 */
export function resolveOutputPlacement(outputTarget) {
  const target = outputTarget && typeof outputTarget === 'object' ? outputTarget : null;
  const outputDir = target?.dir && typeof target.dir === 'string' ? target.dir : PATHS.images;
  const isGallery = outputDir === PATHS.images;
  // Non-gallery renders default to no sidecar; a gallery render always writes one.
  const skipSidecar = isGallery ? false : (target?.skipSidecar !== false);
  return { outputDir, skipSidecar, isGallery };
}

/**
 * What the local runner would receive for this prompt — the LoRA trigger weave
 * included — as the compose preview's record (#11317). Same buildSidecarMeta
 * the render calls.
 */
export async function localSentPrompt({ model, modelId, prompt = '', negativePrompt = '', loraFilenames = [], loraPaths = [], promptAdditions = [] }) {
  const loraTriggerWords = await readTriggerWordsByFilename([...loraFilenames, ...loraPaths]);
  const { meta } = buildSidecarMeta({
    jobId: 'preview', model: model || { id: modelId }, prompt, negativePrompt, modelId,
    loraFilenames, loraPaths, loraTriggerWords, promptAdditions,
    resolveInputPath: resolveImageInputPath, loraExists: existsSync,
  });
  return sentPromptRecord({ sentPrompt: meta.sentPrompt, sentNegativePrompt: meta.sentNegativePrompt, carried: meta.promptAdditions || [] });
}

/**
 * Image Gen — Local provider (Apple Silicon mflux / Windows diffusers).
 *
 * Spawns a Python child process to generate Flux images. HF model weights
 * stream into the user's standard HF cache (`~/.cache/huggingface/`) — PortOS
 * doesn't override HF_HOME. Generated images land in `data/images/<jobId>.png`
 * with a sidecar metadata JSON so the gallery and Remix flow can recover
 * prompt/seed/steps.
 *
 * Progress comes back via the imageGenEvents bus (Socket.IO bridge) and over
 * a per-job SSE stream so EventSource consumers (the Imagine page) get the
 * raw status text mflux prints to stderr.
 */

import { spawn } from 'child_process';
import sharp from 'sharp';
import { writeFile, readFile, readdir, stat, unlink, rm, mkdtemp } from 'fs/promises';
import { existsSync, watch as fsWatch } from 'fs';
import { join, dirname, resolve as resolvePath, sep as PATH_SEP, basename } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { atomicWrite, assertSafeFilename, detectImageFormat, ensureDir, listDirectoryByExtension, PATHS, safeJSONParse, resolveGalleryImage, resolveImageInputPath, tryReadFile } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { autoCleanGeneratedImage } from '../../lib/imageClean.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay, PYTHON_NOISE_RE } from '../../lib/sseUtils.js';
import { resolveFlux2Python, FLUX2_VENV_DEFAULT } from '../../lib/pythonSetup.js';
import { hfTokenEnv } from '../../lib/hfToken.js';
import { extractGatedRepo } from '../../lib/hfErrors.js';
import { safeChildProcessEnv } from '../../lib/processEnv.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { IMAGE_GEN_MODE } from './modes.js';
import { computePixelDelta } from './regen.js';

const IS_WIN = process.platform === 'win32';

import { getImageModels, isFlux2, isZImage, isErnie, isHiDream, isQwen } from '../../lib/mediaModels.js';
import { usesDiffusersRunner, flux2Bf16BaseRepo } from '../../lib/runners.js';

// Read the registry lazily — callers below hit getImageModels() at request
// time. A prior `IMAGE_MODELS = Object.fromEntries(getImageModels()...)`
// snapshot lived here but fired loadMediaModels() at import time, breaking
// any test that mocks PATHS.data to a non-writable path.
export const listImageModels = () => getImageModels();

// Per-job clients: jobId -> { clients, status, meta, broadcast }
const jobs = new Map();
let activeProcess = null;
// Snapshot of the currently-running job for /api/image-gen/active so the UI
// can rehydrate prompt + settings + progress + last-rendered frame after
// navigating away. Cleared on completion / error / cancel.
let activeJob = null;

export const getActiveJob = () => activeJob;

export const attachSseClient = (jobId, res) => attachSse(jobs, jobId, res);

export const cancel = () => {
  if (!activeProcess) return false;
  const proc = activeProcess;
  // KEEP activeProcess + activeJob set until proc.on('close') clears them.
  // Otherwise BUSY immediately allows a new generation while the SIGTERM'd
  // mflux child is still running, and we lose the handle for a follow-up
  // SIGKILL. The `activeProcess === proc` guard escalates only when this is
  // still the tracked child (mflux can ignore SIGTERM mid-tensor-op).
  killWithEscalation(proc, { label: 'image child', stillRunning: () => activeProcess === proc });
  return true;
};

export const buildArgs = ({ pythonPath, model, prompt, negativePrompt, width, height, steps, guidance, seed, quantize, outputPath, loraPaths = [], loraScales = [], stepwiseDir, initImagePath, initImageStrength, referenceImagePaths = [], referenceImageStrengths = [] }) => {
  const modelId = model?.id;
  if (usesDiffusersRunner(model)) {
    const runnerLabel = isErnie(model) ? 'ERNIE' : isHiDream(model) ? 'HiDream' : isQwen(model) ? 'Qwen' : 'Z-Image';
    const errCode = isErnie(model)
      ? 'IMAGE_GEN_ERNIE_MISCONFIGURED'
      : isHiDream(model)
        ? 'IMAGE_GEN_HIDREAM_MISCONFIGURED'
        : isQwen(model)
          ? 'IMAGE_GEN_QWEN_MISCONFIGURED'
          : 'IMAGE_GEN_Z_IMAGE_MISCONFIGURED';
    if (!model.repo) {
      throw new ServerError(
        `${runnerLabel} model "${modelId}" is missing the 'repo' field in data/media-models.json`,
        { status: 500, code: errCode },
      );
    }
    // Z-Image / ERNIE / HiDream / Qwen all reuse the FLUX.2 venv (same
    // diffusers + torch stack, no extra setup). Same not-installed error code
    // so the UI's existing "run setup" CTA fires for any of these runners.
    const torchPython = resolveFlux2Python();
    if (!torchPython) {
      throw new ServerError(
        `Image-gen torch venv not found. Run \`INSTALL_FLUX2=1 bash scripts/setup-image-video.sh\` to bootstrap it (expected at ${FLUX2_VENV_DEFAULT}). FLUX.2, Z-Image, ERNIE, HiDream, and Qwen share this venv.`,
        { status: 400, code: 'IMAGE_GEN_FLUX2_NOT_INSTALLED' },
      );
    }
    const scriptPath = join(PATHS.root, 'scripts', 'z_image_turbo.py');
    const args = [
      scriptPath,
      '--model', modelId,
      '--repo', model.repo,
      '--prompt', prompt,
      '--height', String(height),
      '--width', String(width),
      '--steps', String(steps),
      '--guidance', String(guidance ?? 1.0),
      '--seed', String(seed),
      '--output', outputPath,
    ];
    if (negativePrompt) args.push('--negative-prompt', negativePrompt);
    if (initImagePath) args.push('--image-path', initImagePath);
    if (initImagePath && initImageStrength != null) args.push('--image-strength', String(initImageStrength));
    if (stepwiseDir) args.push('--stepwise-image-output-dir', stepwiseDir);
    if (loraPaths?.length) args.push('--lora-paths', ...loraPaths);
    if (loraScales?.length) args.push('--lora-scales', ...loraScales.map(String));
    if (model.pipelineClass) args.push('--pipeline-class', String(model.pipelineClass));
    if (model.usePromptEnhancer) args.push('--use-pe');
    // HiDream needs a 4th text encoder loaded separately (Llama-3.1-8B) —
    // the Diffusers HiDreamImagePipeline expects `text_encoder_4` /
    // `tokenizer_4` kwargs at from_pretrained() time. The runner script
    // branches on these flags; Z-Image / ERNIE / Qwen leave them unset.
    if (model.textEncoderRepo) args.push('--text-encoder-repo', String(model.textEncoderRepo));
    if (model.textEncoderClass) args.push('--text-encoder-class', String(model.textEncoderClass));
    if (model.tokenizerClass) args.push('--tokenizer-class', String(model.tokenizerClass));
    return { bin: torchPython, args };
  }
  if (isFlux2(model)) {
    if (!model.repo) {
      throw new ServerError(
        `FLUX.2 model "${modelId}" is missing the 'repo' field in data/media-models.json`,
        { status: 500, code: 'IMAGE_GEN_FLUX2_MISCONFIGURED' },
      );
    }
    let repo = model.repo;
    let quantization = model.quantization || 'sdnq';
    let { tokenizerRepo, basePipelineRepo, kvRepo } = model;
    let refImagePaths = referenceImagePaths;
    let refImageStrengths = referenceImageStrengths;
    // LoRA + quantized base is incompatible: PEFT can't inject an adapter into
    // SDNQ/int8-quantized Linear layers, and the runner swallows the failure
    // into a base render (lora_utils.apply_loras), so the LoRA silently does
    // nothing. The adapter was trained against the bf16 base anyway — route the
    // render onto it.
    if (loraPaths?.length && quantization !== 'none') {
      const bf16 = flux2Bf16BaseRepo(model);
      if (!bf16) {
        throw new ServerError(
          `Can't render a LoRA on "${modelId}" — a LoRA needs a bf16 FLUX.2 base and the size variant couldn't be resolved`,
          { status: 400, code: 'IMAGE_GEN_LORA_NEEDS_BF16' },
        );
      }
      console.log(`🎚️  flux2 LoRA render → routing ${modelId} (${quantization}) onto bf16 base ${bf16}`);
      repo = bf16;
      quantization = 'none';
      tokenizerRepo = null;
      basePipelineRepo = null;
      // Multi-reference editing needs the `-kv` sibling repo, which the bf16
      // LoRA route doesn't load (and the 4B variant has none). Drop the refs so
      // the LoRA render proceeds as txt2img/i2i instead of the runner hard-
      // failing on the missing kv pipeline — the LoRA is the primary intent
      // when one is attached. i2i (single init image) is unaffected.
      kvRepo = null;
      if (refImagePaths?.length) {
        console.log(`⚠️ flux2 LoRA render dropped ${refImagePaths.length} reference image(s) — multi-ref editing isn't supported on the bf16 LoRA route`);
        refImagePaths = [];
        refImageStrengths = [];
      }
    }
    if (quantization !== 'sdnq' && quantization !== 'int8' && quantization !== 'none') {
      throw new ServerError(
        `FLUX.2 model "${modelId}" has unsupported quantization "${quantization}" (supported: sdnq, int8, none)`,
        { status: 500, code: 'IMAGE_GEN_FLUX2_MISCONFIGURED' },
      );
    }
    if (quantization === 'sdnq' && !tokenizerRepo) {
      throw new ServerError(
        `FLUX.2 SDNQ model "${modelId}" requires 'tokenizerRepo' (the gated base repo for the tokenizer)`,
        { status: 500, code: 'IMAGE_GEN_FLUX2_MISCONFIGURED' },
      );
    }
    if (quantization === 'int8' && !basePipelineRepo) {
      throw new ServerError(
        `FLUX.2 Int8 model "${modelId}" requires 'basePipelineRepo' (the gated base repo for VAE/scheduler)`,
        { status: 500, code: 'IMAGE_GEN_FLUX2_MISCONFIGURED' },
      );
    }
    // quantization=none uses model.repo directly (gated base repo). No
    // sibling-repo flag required, but the repo must be the gated base.
    const flux2Python = resolveFlux2Python();
    if (!flux2Python) {
      throw new ServerError(
        `FLUX.2 venv not found. Run \`INSTALL_FLUX2=1 bash scripts/setup-image-video.sh\` to bootstrap it (expected at ${FLUX2_VENV_DEFAULT}).`,
        { status: 400, code: 'IMAGE_GEN_FLUX2_NOT_INSTALLED' },
      );
    }
    const scriptPath = join(PATHS.root, 'scripts', 'flux2_macos.py');
    // No --metadata flag: local.js's proc.on('close') already writes the
    // canonical sidecar at <jobId>.metadata.json after a successful exit.
    // Letting the runner write its own would duplicate work and the JS
    // sidecar would clobber any flux2-specific fields anyway.
    const args = [
      scriptPath,
      '--model', modelId,
      '--quantization', quantization,
      '--repo', repo,
      '--prompt', prompt,
      '--height', String(height),
      '--width', String(width),
      '--steps', String(steps),
      '--guidance', String(guidance ?? 0),
      '--seed', String(seed),
      '--output', outputPath,
    ];
    if (tokenizerRepo) args.push('--tokenizer-repo', tokenizerRepo);
    if (basePipelineRepo) args.push('--base-pipeline-repo', basePipelineRepo);
    // bf16 multi-reference editing loads the `-kv` sibling repo (whose
    // transformer is tuned for reference editing) instead of `repo`.
    // The runner only uses --kv-repo when --reference-images is also present;
    // the plain text/i2i bf16 path stays on the base repo.
    if (kvRepo) args.push('--kv-repo', kvRepo);
    if (negativePrompt) args.push('--negative-prompt', negativePrompt);
    if (initImagePath) args.push('--image-path', initImagePath);
    if (initImagePath && initImageStrength != null) args.push('--image-strength', String(initImageStrength));
    // Multi-reference editing for FLUX.2. When the path list is non-empty,
    // scripts/flux2_macos.py loads Flux2KleinKVPipeline (instead of the
    // single-image Flux2KleinPipeline) and passes the refs as image=[PIL...].
    // The route always emits parallel referenceImageStrengths (defaulting to
    // 1.0 per ref); the runner honors them per-reference via a runtime patch
    // on Flux2KVLayerCache.store + _flux2_kv_causal_attention.
    if (refImagePaths?.length) {
      args.push('--reference-images', ...refImagePaths);
      if (refImageStrengths?.length) {
        args.push('--reference-strengths', ...refImageStrengths.map(String));
      }
    }
    if (stepwiseDir) args.push('--stepwise-image-output-dir', stepwiseDir);
    if (loraPaths?.length) args.push('--lora-paths', ...loraPaths);
    if (loraScales?.length) args.push('--lora-scales', ...loraScales.map(String));
    return { bin: flux2Python, args };
  }

  if (IS_WIN) {
    // imagine_win.py does not implement i2i — silently drop the init-image
    // args here so the request still produces a normal txt2img result rather
    // than failing argparse with "unrecognized arguments".
    const scriptPath = join(PATHS.root, 'scripts', 'imagine_win.py');
    return {
      bin: pythonPath,
      args: [scriptPath, '--model', modelId, '--prompt', prompt, '--height', String(height), '--width', String(width), '--steps', String(steps), '--seed', String(seed), '--quantize', String(quantize), '--output', outputPath, '--metadata',
        ...(guidance > 0 ? ['--guidance', String(guidance)] : []),
        ...(negativePrompt ? ['--negative-prompt', negativePrompt] : []),
        ...(loraPaths.length ? ['--lora-paths', ...loraPaths] : []),
        ...(loraScales.length ? ['--lora-scales', ...loraScales.map(String)] : []),
      ],
    };
  }
  const bin = join(dirname(pythonPath), 'mflux-generate');
  const args = ['--model', modelId, '--prompt', prompt, '--height', String(height), '--width', String(width), '--steps', String(steps), '--seed', String(seed), '--quantize', String(quantize), '--output', outputPath, '--metadata'];
  if (guidance > 0) args.push('--guidance', String(guidance));
  if (negativePrompt) args.push('--negative-prompt', negativePrompt);
  if (loraPaths.length) args.push('--lora-paths', ...loraPaths);
  if (loraScales.length) args.push('--lora-scales', ...loraScales.map(String));
  if (initImagePath) args.push('--image-path', initImagePath);
  if (initImagePath && initImageStrength != null) args.push('--image-strength', String(initImageStrength));
  // mflux writes one PNG per step here as it diffuses; we watch the dir and
  // stream the latest frame back to the client as `currentImage` for the
  // live-preview area.
  if (stepwiseDir) args.push('--stepwise-image-output-dir', stepwiseDir);
  return { bin, args };
};

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
  initImagePath = null,
  initImageStrength = null,
  referenceImagePaths = [],
  referenceImageStrengths = [],
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
  // The new client-side surface sends `loraFilenames` (basenames only); the
  // server resolves them against PATHS.loras. `loraPaths` is kept as a
  // back-compat input for old gallery sidecars that stored absolute paths
  // pre-refactor — both go through the same resolve+prefix-check.
  const lorasRoot = resolvePath(PATHS.loras) + PATH_SEP;
  const candidates = [
    ...loraFilenames.map((f) => (typeof f === 'string' ? join(PATHS.loras, basename(f)) : null)),
    ...loraPaths,
  ];
  const validLoras = candidates.filter((p) => {
    if (!p || typeof p !== 'string') return false;
    const resolved = resolvePath(p);
    if (!resolved.startsWith(lorasRoot)) return false;
    return loraExists(resolved);
  });

  // Store loraFilenames (basenames) in the sidecar going forward — that's
  // what the new client API uses for remix. Keep `loraPaths` populated too
  // so older code paths reading the sidecar don't break.
  const validLoraFilenames = validLoras.map((p) => basename(p));
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
  // `referenceImageStrengths` is honored end-to-end: the FLUX.2 runner installs
  // a Flux2KVLayerCache.store + _flux2_kv_causal_attention patch that scales
  // each reference's V slice by the corresponding strength (1.0 = upstream
  // baseline, 0.0 = ignored). Mirrors the Python sidecar's `referenceStrengths`.
  const meta = { id: jobId, prompt, negativePrompt, modelId, seed: actualSeed, width: Number(width), height: Number(height), steps: actualSteps, guidance: actualGuidance, quantize, filename, loraFilenames: validLoraFilenames, loraPaths: validLoras, loraScales, initImageFilename: validInitImagePath ? basename(validInitImagePath) : null, initImageStrength: validInitImageStrength, referenceImageFilenames: validReferenceImagePaths.map((p) => basename(p)), referenceImageStrengths: validReferenceImageStrengths, createdAt: now() };
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
  return {
    meta,
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

export async function generateImage({ pythonPath, prompt = '', negativePrompt = '', modelId = 'dev', width = 1024, height = 1024, steps, guidance, seed, quantize = '8', loraFilenames = [], loraPaths = [], loraScales = [], initImagePath = null, initImageStrength = null, referenceImagePaths = [], referenceImageStrengths = [], jobId: providedJobId = null, cleanC2PA = false, denoise = false, regenOf = null, upscaleTo = null }) {
  // Empty prompt is allowed: img2img / edit / unconditional renders are driven
  // by the init image (or run unconditionally), so text isn't required. The
  // mflux/diffusers runners accept an empty `--prompt` — the regen pass (#912)
  // has always relied on this for minimal-mutation, watermark-overwriting img2img.
  // Single-flight is enforced by the mediaJobQueue worker upstream. Direct
  // callers that bypass the queue must not run two concurrent renders — the
  // activeProcess handle below would be clobbered and cancel() would orphan
  // the first child.
  // loadMediaModels memoizes — on-disk edits to data/media-models.json still
  // need a server restart to apply. Don't re-check model.broken here:
  // getImageModels() already filtered current-platform entries; an extra
  // check would also reject entries broken on the OTHER platform (e.g.
  // 'windows' on a macOS box).
  const model = getImageModels().find((m) => m.id === modelId);
  if (!model) throw new ServerError(`Unknown or unsupported model: ${modelId}`, { status: 400, code: 'VALIDATION_ERROR' });
  // Both flux2 and z-image runners resolve their own Python via the FLUX.2
  // venv — only the legacy mflux/imagine_win path needs the user-configured
  // Settings > Image Gen pythonPath.
  if (!isFlux2(model) && !usesDiffusersRunner(model) && !pythonPath) {
    throw new ServerError('Python path not configured — set it in Settings > Image Gen', { status: 400, code: 'IMAGE_GEN_NOT_CONFIGURED' });
  }
  // FLUX.2 and Z-Image runners now load LoRAs via diffusers'
  // pipe.load_lora_weights — but only LoRAs trained against the matching
  // base model will produce sensible output. The LoRA picker UI uses the
  // sidecar's `runnerFamily` field to filter; we don't enforce here so a
  // user can deliberately experiment with off-family weights and see what
  // happens (the runner will surface a shape-mismatch error from diffusers).

  await ensureDir(PATHS.images);
  await ensureDir(PATHS.loras);

  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.png`;
  const outputPath = join(PATHS.images, filename);
  const {
    meta,
    actualSeed,
    actualSteps,
    actualGuidance,
    validLoras,
    validInitImagePath,
    validInitImageStrength,
    validReferenceImagePaths,
    validReferenceImageStrengths,
  } = buildSidecarMeta({
    jobId,
    model,
    prompt,
    negativePrompt,
    modelId,
    width,
    height,
    steps,
    guidance,
    seed,
    quantize,
    loraFilenames,
    loraPaths,
    loraScales,
    initImagePath,
    initImageStrength,
    referenceImagePaths,
    referenceImageStrengths,
    regenOf,
    resolveInputPath: resolveImageInputPath,
    loraExists: existsSync,
  });
  const job = { ...meta, clients: [], status: 'running' };
  jobs.set(jobId, job);

  // Per-job stepwise output dir under the OS temp dir. mflux writes one PNG
  // per inference step here; we watch and stream the latest as `currentImage`.
  const stepwiseDir = await mkdtemp(join(tmpdir(), 'portos-stepwise-'));

  const { bin, args } = buildArgs({ pythonPath, model, prompt, negativePrompt, width: Number(width), height: Number(height), steps: actualSteps, guidance: actualGuidance, seed: actualSeed, quantize, outputPath, loraPaths: validLoras, loraScales, stepwiseDir, initImagePath: validInitImagePath, initImageStrength: validInitImageStrength, referenceImagePaths: validReferenceImagePaths, referenceImageStrengths: validReferenceImageStrengths });

  console.log(`🎨 Generating image [${jobId.slice(0, 8)}] local: ${modelId} ${width}x${height} steps=${actualSteps}`);
  imageGenEvents.emit('started', { generationId: jobId, totalSteps: actualSteps });
  activeJob = { ...meta, generationId: jobId, totalSteps: actualSteps, step: 0, progress: 0, currentImage: null, mode: IMAGE_GEN_MODE.LOCAL };

  const proc = spawn(bin, args, { env: safeChildProcessEnv(await hfTokenEnv()), stdio: ['ignore', 'pipe', 'pipe'] });
  activeProcess = proc;
  // Spawn ENOENT (missing/non-executable pythonPath) fires BOTH 'error' and
  // 'close' on Node — without this guard, a typo'd pythonPath emits two
  // 'failed' events to imageGenEvents and two SSE error frames to the
  // client. The mediaJobQueue's terminate() is idempotent on the first, but
  // the duplicate noise still confuses anything else listening. Track
  // whether we've finalized so the close handler can detect "already
  // handled" and skip the second emit.
  let finalized = false;
  proc.on('error', (err) => {
    if (finalized) return;
    finalized = true;
    job.status = 'error';
    const reason = `Failed to spawn ${bin}: ${err.message}`;
    console.log(`❌ Image generation spawn error [${jobId.slice(0, 8)}]: ${reason}`);
    broadcastSse(job, { type: 'error', error: reason });
    imageGenEvents.emit('failed', { generationId: jobId, error: reason });
    activeProcess = null;
    activeJob = null;
    rm(stepwiseDir, { recursive: true, force: true }).catch(() => {});
    closeJobAfterDelay(jobs, jobId);
  });

  // Watch the stepwise output dir for new PNGs. When a new file appears,
  // base64-encode the latest one and emit it as `currentImage`. fs.watch
  // fires multiple times per write — keep a single in-flight read and a
  // pending flag so we always get the *latest* frame without piling up reads.
  let watcher = null;
  let reading = false;
  let pendingFrame = false;
  const processLatestFrame = async () => {
    if (reading) { pendingFrame = true; return; }
    reading = true;
    try {
      // Sort by mtime, not filename. mflux names files like `step_1.png` …
      // `step_20.png` (no zero-padding), so alphabetical sort puts `step_2`
      // *after* `step_19` and we'd render an early-step latent (mostly noise)
      // instead of the latest. Also drop mflux's `seed_*_composite.png` —
      // it writes that grid right after every step, so its mtime always wins
      // the "latest" race and the user would see a growing thumbnail strip
      // instead of the live diffusion frame.
      const names = (await readdir(stepwiseDir)).filter((f) => f.endsWith('.png') && !f.includes('composite'));
      const stats = await Promise.all(names.map(async (n) => {
        const s = await stat(join(stepwiseDir, n)).catch(() => null);
        return s ? { n, mtimeMs: s.mtimeMs } : null;
      }));
      const latest = stats.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.n;
      if (latest) {
        const buf = await readFile(join(stepwiseDir, latest));
        const currentImage = buf.toString('base64');
        if (activeJob && activeJob.generationId === jobId) activeJob.currentImage = currentImage;
        imageGenEvents.emit('progress', { generationId: jobId, currentImage });
      }
    } catch (err) {
      // Partial PNG mid-write or stepwise dir gone after cancel — common,
      // don't spam, but surface the message so a stalled preview is debuggable.
      console.log(`⚠️ Frame read error [${jobId.slice(0, 8)}]: ${err?.message}`);
    }
    reading = false;
    if (pendingFrame) { pendingFrame = false; processLatestFrame(); }
  };
  try {
    watcher = fsWatch(stepwiseDir, (event) => {
      if (event === 'rename') processLatestFrame();
    });
  } catch { /* if watch fails, we still get final image — degrade gracefully */ }

  // Bounded tail of recent stderr — only the last ~64KB is kept, since the
  // failure path only uses the trailing 10 lines for context. Without this
  // bound a noisy backend (HF download progress, deprecation warnings)
  // would grow this buffer for the full duration of a long render.
  const STDERR_TAIL_BYTES = 64 * 1024;
  let stderrBuffer = '';
  // Returns true when the line drove a progress event (so the pm2-log echo
  // below skips it — progress bars are spammy and already visible in the UI).
  // Status / debug / error lines fall through to console.log so a stuck render
  // (model download, HF auth probe, weight load) shows up in pm2 logs instead
  // of vanishing into the SSE channel only the browser ever sees.
  // Phase tracking. Lifecycle events from the runner (STAGE:download-pipeline,
  // STAGE:inference, etc.) flip the phase so the UI can show "Downloading
  // model weights" instead of misleading "step 0/8" while HF pulls multi-GB
  // shards. Inference progress events also tag themselves with the current
  // phase so the client knows whether `step/total` reflects download chunks
  // (out of N safetensors files) or actual generation steps.
  let currentPhase = 'starting';
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || PYTHON_NOISE_RE.test(trimmed)) return true;
    // Heartbeat — any non-noise line resets the queue's idle watchdog so
    // first-run multi-GB HF downloads don't trip the timeout when
    // tqdm is slow to update during connection-establishment.
    imageGenEvents.emit('activity', { generationId: jobId });

    if (trimmed.startsWith('STAGE:')) {
      const rest = trimmed.slice(6); // strip 'STAGE:'
      const colon = rest.indexOf(':');
      const stage = colon === -1 ? rest : rest.slice(0, colon);
      const detail = colon === -1 ? '' : rest.slice(colon + 1);
      currentPhase = stage;
      broadcastSse(job, { type: 'stage', stage, detail });
      return true;
    }

    const m = trimmed.match(/(\d+)%\|.*?(\d+)\/(\d+)/);
    if (m) {
      const pct = parseInt(m[1], 10) / 100;
      const step = parseInt(m[2], 10);
      const total = parseInt(m[3], 10);
      broadcastSse(job, { type: 'progress', progress: pct, message: trimmed, phase: currentPhase });
      // Only forward to imageGenEvents (which drives the UI step counter)
      // when we're actually in the inference phase — download tqdm bars
      // count safetensors files, not diffusion steps.
      if (currentPhase === 'inference') {
        imageGenEvents.emit('progress', { generationId: jobId, progress: pct, step, totalSteps: total });
        if (activeJob && activeJob.generationId === jobId) {
          activeJob.progress = pct; activeJob.step = step; activeJob.totalSteps = total;
        }
      }
      return true;
    }
    broadcastSse(job, { type: 'status', message: trimmed });
    return false;
  };

  const shortId = jobId.slice(0, 8);
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrBuffer += text;
    if (stderrBuffer.length > STDERR_TAIL_BYTES) {
      stderrBuffer = stderrBuffer.slice(-STDERR_TAIL_BYTES);
    }
    for (const line of text.split(/[\n\r]+/)) {
      const trimmed = line.trim();
      if (!handleLine(line) && trimmed) console.log(`🐍 [${shortId}] ${trimmed}`);
    }
  });
  proc.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split(/[\n\r]+/)) {
      const trimmed = line.trim();
      if (!handleLine(line) && trimmed) console.log(`🐍-out [${shortId}] ${trimmed}`);
    }
  });

  proc.on('close', async (code, signal) => {
    // Guard against the spawn-ENOENT path where 'error' already finalized
    // the job. Node fires 'error' THEN 'close' (with code -2/null signal)
    // for a missing binary, and re-running the failure path here would
    // emit a second 'failed' event + second SSE error frame.
    if (finalized) return;
    finalized = true;
    activeProcess = null;
    activeJob = null;
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
    rm(stepwiseDir, { recursive: true, force: true }).catch(() => {});
    if (code !== 0) {
      job.status = 'error';
      const reason = signal ? `Killed by signal ${signal}` : `Exit code ${code}`;
      // Extract a structured user-error if the runner emitted one
      // (USER_ERROR:gated_repo:black-forest-labs/FLUX.2-klein-9B), and find
      // the matching `❌ …` prose line that follows it. Fall back to the last
      // 10 stderr lines if no structured error was emitted (unknown crash).
      const lines = stderrBuffer.split('\n').map((l) => l.trim()).filter(Boolean);
      const structIdx = lines.findIndex((l) => l.startsWith('USER_ERROR:'));
      let userMessage = null;
      let userKind = null;
      let userRepo = null;
      if (structIdx >= 0) {
        // Split with limit=2 so a kind containing colons can't shred the repo.
        const [kind, ...rest] = lines[structIdx].slice('USER_ERROR:'.length).split(':');
        userKind = kind;
        userRepo = rest.join(':') || null;
        const proseIdx = lines.findIndex((l, i) => i > structIdx && l.startsWith('❌'));
        userMessage = proseIdx >= 0 ? lines[proseIdx].replace(/^❌\s*/, '') : null;
      }
      // Heuristic detection for non-USER_ERROR failures we can still
      // surface actionably. mflux's entry-point shim breaks when a partial
      // package upgrade leaves user-site at the right version number but
      // with stale file layout — Python imports the wrong `mflux/` first.
      // Easier to spot at the source than to teach the user to read pip diffs.
      if (!userMessage) {
        const mfluxBroken = lines.some((l) => /ModuleNotFoundError: No module named 'mflux\.models\.flux\.cli'/.test(l));
        if (mfluxBroken) {
          userKind = 'mflux_install_corrupted';
          userMessage = 'Your mflux install is corrupted (entry-point shim and package layout out of sync). Repair with: `pip uninstall -y mflux && pip install --user --force-reinstall --no-cache-dir --no-deps mflux`. If you use conda, run the same in your conda env\'s pip.';
        }
      }
      // Legacy mflux-generate is a pre-built binary, so it doesn't emit the
      // structured USER_ERROR markers the flux2/z-image Python runners use.
      // Match the raw huggingface_hub stack instead — `GatedRepoError` or the
      // "Cannot access gated repo for url …/<owner>/<name>/…" prose. Extract
      // the repo so the UI banner can link the user straight to the license
      // page (and we set kind=gated_repo so the client knows to surface the
      // token-entry form).
      if (!userMessage) {
        const gatedText = lines.join('\n');
        // Classify as gated ONLY on a gated-specific signal — extractGatedRepo
        // matches any huggingface.co/<owner>/<repo> URL, so a non-gated failure
        // (404, network error) that merely prints a HF URL must NOT be turned
        // into a misleading license-request flow. Extract the repo for the link
        // only after the gated signal is confirmed.
        const hasGatedError = /GatedRepoError|Access to model .* is restricted|Cannot access gated repo/i.test(gatedText);
        if (hasGatedError) {
          userKind = 'gated_repo';
          userRepo = extractGatedRepo(gatedText);
          const repoText = userRepo || 'the model';
          userMessage = `Access to ${repoText} is gated. Accept the license at https://huggingface.co/${userRepo || '<repo>'} and paste your HuggingFace token into Image Gen settings, then retry.`;
        }
      }
      const tail = lines.slice(-10).join('\n');
      const errorText = userMessage
        ? `${userMessage}\n\n(diagnostic) ${reason}`
        : `Generation failed: ${reason}\n${tail}`;
      console.log(`❌ Image generation failed [${jobId.slice(0, 8)}]: ${userMessage || reason}`);
      job.error = userMessage || reason;
      job.errorKind = userKind;
      job.errorRepo = userRepo;
      broadcastSse(job, { type: 'error', error: errorText, kind: userKind, repo: userRepo });
      // Propagate the friendly message (not the raw "Exit code 1") to the
      // job queue so its `failed` log line and future SSE replays carry it.
      imageGenEvents.emit('failed', { generationId: jobId, error: userMessage || reason });
    } else {
      job.status = 'complete';
      // Large-source regen (issue #912): the render ran at a clamped FLUX-sane
      // resolution. Upscale the result back to the requested delivery size so
      // the watermark-free copy matches the original's resolution. `meta.width/
      // height` currently hold the render dims; record those as render* and
      // promote the delivered dims so the gallery shows the real file size.
      const targetW = Math.round(Number(upscaleTo?.width));
      const targetH = Math.round(Number(upscaleTo?.height));
      if (targetW > 0 && targetH > 0 && (targetW !== meta.width || targetH !== meta.height)) {
        const resized = await sharp(outputPath)
          .resize(targetW, targetH, { fit: 'fill', kernel: 'lanczos3' })
          // compressionLevel 6 (sharp default) — near-identical size to 9 but
          // markedly faster, and this re-encode is on the render-completion path.
          .png({ compressionLevel: 6 })
          .toBuffer()
          .catch((err) => { console.warn(`⚠️ Regen upscale failed for ${filename}: ${err?.message || err}`); return null; });
        if (resized) {
          await writeFile(outputPath, resized).catch(() => {});
          meta.renderWidth = meta.width;
          meta.renderHeight = meta.height;
          meta.width = targetW;
          meta.height = targetH;
          console.log(`🔍 Upscaled regen [${jobId.slice(0, 8)}] ${meta.renderWidth}x${meta.renderHeight} → ${targetW}x${targetH}`);
        }
      }
      // Regen fidelity (issue #912): for a regen pass, measure how much the
      // delivered image actually changed vs. the source so the sidecar records
      // the *realized* delta, not just the requested strength. Catches the
      // mflux strength-0.0 footgun, silent txt2img fallbacks, and over-mutation.
      // Best-effort — a decode failure just skips the stamp.
      if (regenOf && validInitImagePath) {
        const delta = await computePixelDelta(validInitImagePath, outputPath).catch(() => null);
        if (delta) {
          meta.regenPixelDeltaPct = delta.pixelDeltaPct;
          meta.regenPsnr = delta.psnr;
          console.log(`📐 Regen fidelity [${jobId.slice(0, 8)}]: ${delta.pixelDeltaPct}% changed, PSNR ${delta.psnr}dB`);
        }
      }
      // Sidecar: persist a metadata record next to the PNG so the gallery
      // and Remix flow can recover prompt/seed/steps even if mflux's own
      // --metadata sidecar lives at a slightly different filename shape.
      const sidecar = join(PATHS.images, `${jobId}.metadata.json`);
      await atomicWrite(sidecar, meta).catch(() => {});
      // Cleaners run BEFORE the SSE complete + completed events so subscribers
      // see the cleaned bytes. Local FLUX renders never carry C2PA chunks so
      // cleanC2PA is a no-op on local — denoise is the only mode that does
      // anything here.
      await autoCleanGeneratedImage({ cleanC2PA, denoise, pngPath: outputPath, sidecarPath: sidecar, mode: IMAGE_GEN_MODE.LOCAL });
      console.log(`✅ Image generated [${jobId.slice(0, 8)}]: ${filename}`);
      const result = { filename, seed: actualSeed, path: `/data/images/${filename}` };
      broadcastSse(job, { type: 'complete', result });
      // Include `seed` so /sdapi/v1/txt2img can surface the actual seed used
      // (mflux generates a random one if the client didn't pass one).
      imageGenEvents.emit('completed', { generationId: jobId, path: `/data/images/${filename}`, filename, seed: actualSeed });
    }
    closeJobAfterDelay(jobs, jobId);
  });

  return { jobId, filename, path: `/data/images/${filename}`, generationId: jobId, mode: IMAGE_GEN_MODE.LOCAL, model: modelId, seed: actualSeed };
}

// Validate a gallery filename: PNG-only, basename only, no path separators.
// Delegates to the shared `assertSafeFilename` helper in fileUtils.js.
// Substring `..` is allowed (e.g. `my..render.png` is fine) because the
// helper only rejects the exact-string traversal cases.
// `requiredMessage` preserves the original "Invalid filename" wording for
// the missing-input case so existing client error-message expectations
// (and the previously-shipped error-middleware contract) don't shift.
export function assertGalleryFilename(filename) {
  assertSafeFilename(filename, {
    extensions: ['.png'],
    subject: 'filename',
    requiredMessage: 'Invalid filename',
  });
}

// Returns `{ path, metadata }`. `path` is the resolved sidecar location, or
// the preferred Portos location on miss — callers writing back land at the
// canonical path automatically.
export async function readImageSidecar(filename) {
  const portosSidecar = join(PATHS.images, filename.replace('.png', '.metadata.json'));
  const altSidecar = join(PATHS.images, `${filename}.metadata.json`);
  for (const path of [portosSidecar, altSidecar]) {
    const raw = await tryReadFile(path);
    if (raw != null) return { path, metadata: safeJSONParse(raw, {}) };
  }
  return { path: portosSidecar, metadata: {} };
}

// Cap on uploaded gallery image bytes (decoded). Headshots and similar
// uploads never need more than a few MB; this is a defense-in-depth ceiling so
// a hand-crafted request can't write an arbitrarily large file into the
// gallery dir. The Authors page caps its own headshot upload well below this.
const MAX_GALLERY_UPLOAD_BYTES = 16 * 1024 * 1024;
// Cap decoded pixels too: a small compressed payload can still decode to a huge
// canvas (decompression bomb), so the byte ceiling alone isn't enough. Mirrors
// the cleaner's guard (lib/imageClean.js MAX_PIXELS) — sharp throws past it.
const MAX_GALLERY_UPLOAD_PIXELS = 96 * 1000 * 1000;

/**
 * Persist user-uploaded image bytes (base64) into the gallery dir under
 * `data/images/` so the file rides the existing `image` peer-sync asset path
 * (a record pointing at `/data/images/<f>` ships its bytes to peers; a
 * `/api/uploads/<f>` path does not). The payload is sniffed by magic bytes —
 * the client-supplied name/extension is not trusted — and a non-image is
 * rejected with a 400, then re-encoded to **PNG** so the saved file is a
 * first-class gallery citizen: it lists in `/image-gen/gallery` and deletes via
 * `deleteImage`, both of which only manage `.png`. Returns the bare gallery
 * filename and its `/data/images/` mount path for the caller to store.
 *
 * @param {string} base64Data - Raw base64 (no data: URI prefix) image bytes
 * @returns {Promise<{ filename: string, path: string }>}
 */
export async function saveUploadedGalleryImage(base64Data) {
  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.length === 0) {
    throw new ServerError('Empty image upload', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (buffer.length > MAX_GALLERY_UPLOAD_BYTES) {
    throw new ServerError(`Image exceeds maximum size of ${MAX_GALLERY_UPLOAD_BYTES / 1024 / 1024}MB`, { status: 400, code: 'FILE_TOO_LARGE' });
  }
  const detected = detectImageFormat(buffer);
  if (!detected) {
    throw new ServerError('Unsupported image format (expected PNG, JPEG, WebP, or GIF)', { status: 400, code: 'UNSUPPORTED_IMAGE' });
  }
  // Normalize to PNG so the gallery's PNG-only list/delete paths manage it.
  // `.rotate()` with no args bakes in EXIF orientation before the metadata is
  // dropped, so a camera-JPEG portrait isn't saved sideways/upside-down.
  const png = await sharp(buffer, { limitInputPixels: MAX_GALLERY_UPLOAD_PIXELS }).rotate().png().toBuffer();
  const filename = `upload-${randomUUID().slice(0, 8)}.png`;
  await ensureDir(PATHS.images);
  await writeFile(join(PATHS.images, filename), png);
  console.log(`📥 Saved uploaded gallery image: ${filename} (${(png.length / 1024).toFixed(0)}KB PNG, from ${detected.mime})`);
  return { filename, path: `/data/images/${filename}` };
}

export async function listGallery() {
  if (!existsSync(PATHS.images)) return [];
  // requireRegularFile:false preserves the original gallery behavior — it
  // never checked isFile(), only dropped on stat failure. listLoras /
  // listMusicLibrary do filter directories; mirroring that here would be a
  // behavior change.
  const items = await listDirectoryByExtension(PATHS.images, {
    extensions: ['.png'],
    requireRegularFile: false,
    mapEntry: async (f, _fullPath, s) => {
      const { metadata } = await readImageSidecar(f);
      return {
        filename: f,
        path: `/data/images/${f}`,
        createdAt: metadata.createdAt || s.birthtime.toISOString(),
        ...metadata,
      };
    },
  });
  return items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function deleteImage(filename) {
  assertGalleryFilename(filename);
  await unlink(join(PATHS.images, filename)).catch(() => {});
  await unlink(join(PATHS.images, filename.replace('.png', '.metadata.json'))).catch(() => {});
  await unlink(join(PATHS.images, `${filename}.metadata.json`)).catch(() => {});
  console.log(`🗑️ Deleted image: ${filename}`);
  return { ok: true };
}

export async function setImageHidden(filename, hidden) {
  assertGalleryFilename(filename);
  const { path: sidecarPath, metadata } = await readImageSidecar(filename);
  metadata.hidden = !!hidden;
  await atomicWrite(sidecarPath, metadata);
  return { ok: true, hidden: metadata.hidden };
}

// Returns just `{ filename, name }` — clients send `filename` back in the
// generate payload's `loraFilenames` and the server resolves it against
// PATHS.loras. Avoids leaking absolute server paths into the API surface.
//
// Distinct from `services/loras.js#listLoras` which returns the rich
// Civitai-aware shape (civitai, runnerFamily, triggerWords, etc.) for the
// `/api/loras` manager UI. The two used to share the name `listLoras`;
// rename here makes the shape distinction explicit so a future caller
// can't import the wrong one and silently lose `civitai`/`runnerFamily`.
export async function listLoraFilenames() {
  await ensureDir(PATHS.loras);
  const files = await readdir(PATHS.loras).catch(() => []);
  return files.filter((f) => f.endsWith('.safetensors')).map((f) => ({
    filename: f,
    name: f.replace(/^lora-/, '').replace(/\.safetensors$/, ''),
  }));
}

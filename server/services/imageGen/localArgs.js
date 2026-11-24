import { dirname, join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { assertFlux2InputsCompatible } from '../../lib/flux2Inputs.js';
import { FLUX2_VENV_DEFAULT, resolveFlux2Python } from '../../lib/pythonSetup.js';
import { usesFlux3, usesMinimaxH3Image, usesMossSwift } from '../../lib/imageRuntimeRemedies.js';
import { flux2Bf16BaseRepo, flux2RepoRevision, isErnie, isFlux2, isHiDream, isQwen, usesDiffusersRunner } from '../../lib/runners.js';
import { flux3RenderArgs } from './flux3Runtime.js';
import { minimaxH3ImageRenderArgs } from './minimaxH3ImageRuntime.js';
import { mossRenderArgs } from './mossRuntime.js';

const diffusersRenderArgs = ({ model, prompt, negativePrompt, width, height, steps, guidance, seed, outputPath, loraPaths = [], loraScales = [], stepwiseDir, initImagePath, initImageStrength, referenceImagePaths = [] }) => {
  const modelId = model?.id;
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
  const scriptPath = join(PATHS.root, 'scripts', 'ml', 'z_image_turbo.py');
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
  if (model.pipelineClass === 'QwenImage21Pipeline') {
    if (referenceImagePaths.length + (initImagePath ? 1 : 0) > 10) {
      throw new ServerError('Qwen Image 2.1 accepts at most 10 input images', { status: 400, code: 'TOO_MANY_INPUT_IMAGES' });
    }
    if (referenceImagePaths.length) args.push('--reference-images', ...referenceImagePaths);
  }
  if (negativePrompt) args.push('--negative-prompt', negativePrompt);
  if (initImagePath) args.push('--image-path', initImagePath);
  if (initImagePath && initImageStrength != null) args.push('--image-strength', String(initImageStrength));
  if (stepwiseDir) args.push('--stepwise-image-output-dir', stepwiseDir);
  if (loraPaths?.length) args.push('--lora-paths', ...loraPaths);
  if (loraScales?.length) args.push('--lora-scales', ...loraScales.map(String));
  if (model.revision) args.push('--revision', String(model.revision));
  if (model.pipelineClass) args.push('--pipeline-class', String(model.pipelineClass));
  if (model.usePromptEnhancer) args.push('--use-pe');
  // HiDream needs a 4th text encoder loaded separately (Llama-3.1-8B) —
  // the Diffusers HiDreamImagePipeline expects `text_encoder_4` /
  // `tokenizer_4` kwargs at from_pretrained() time. The runner script
  // branches on these flags; Z-Image / ERNIE / Qwen leave them unset.
  if (model.textEncoderRepo) args.push('--text-encoder-repo', String(model.textEncoderRepo));
  if (model.textEncoderRepo && model.textEncoderRevision) args.push('--text-encoder-revision', String(model.textEncoderRevision));
  if (model.textEncoderClass) args.push('--text-encoder-class', String(model.textEncoderClass));
  if (model.tokenizerClass) args.push('--tokenizer-class', String(model.tokenizerClass));
  return { bin: torchPython, args, providerInputs: {
    initImagePath: initImagePath || null,
    referenceImagePaths: model.pipelineClass === 'QwenImage21Pipeline' ? referenceImagePaths : [],
  } };
};

// Resolves the repo / quantization / sibling repos / reference images FLUX.2
// actually renders with. A LoRA reroutes a quantized base onto bf16.
const flux2LoraRoute = (model, { loraPaths, referenceImagePaths, referenceImageStrengths }) => {
  const modelId = model?.id;
  let repo = model.repo;
  let quantization = model.quantization || 'sdnq';
  let { tokenizerRepo, basePipelineRepo, kvRepo, revision, tokenizerRevision, basePipelineRevision, kvRevision } = model;
  const refImagePaths = referenceImagePaths;
  const refImageStrengths = referenceImageStrengths;
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
    // Pin the rerouted base too; the quantized entry's revisions belong to other repos.
    revision = flux2RepoRevision(bf16);
    tokenizerRevision = null;
    basePipelineRevision = null;
    kvRevision = null;
    quantization = 'none';
    tokenizerRepo = null;
    basePipelineRepo = null;
    // The rerouted base has no KV sibling; references were refused up front.
    kvRepo = null;
  }
  return { repo, quantization, tokenizerRepo, basePipelineRepo, kvRepo, revision, tokenizerRevision, basePipelineRevision, kvRevision, refImagePaths, refImageStrengths };
};

const flux2RenderArgs = (model, inputs) => {
  const { prompt, negativePrompt, width, height, steps, guidance, seed, outputPath, loraPaths = [], loraScales = [], stepwiseDir, initImagePath, initImageStrength } = inputs;
  const modelId = model?.id;
  assertFlux2InputsCompatible(model, {
    hasInitImage: Boolean(initImagePath), referenceCount: inputs.referenceImagePaths?.length || 0,
    loraCount: loraPaths.length,
  });
  if (!model.repo) {
    throw new ServerError(
      `FLUX.2 model "${modelId}" is missing the 'repo' field in data/media-models.json`,
      { status: 500, code: 'IMAGE_GEN_FLUX2_MISCONFIGURED' },
    );
  }
  const { repo, quantization, tokenizerRepo, basePipelineRepo, kvRepo, revision, tokenizerRevision, basePipelineRevision, kvRevision, refImagePaths, refImageStrengths } = flux2LoraRoute(model, inputs);
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
  const scriptPath = join(PATHS.root, 'scripts', 'ml', 'flux2_macos.py');
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
  // Immutable commit pins (absent on user forks, which float on their own revision).
  if (revision) args.push('--revision', revision);
  if (tokenizerRepo) args.push('--tokenizer-repo', tokenizerRepo);
  if (tokenizerRepo && tokenizerRevision) args.push('--tokenizer-revision', tokenizerRevision);
  if (basePipelineRepo) args.push('--base-pipeline-repo', basePipelineRepo);
  if (basePipelineRepo && basePipelineRevision) args.push('--base-pipeline-revision', basePipelineRevision);
  // bf16 multi-reference editing loads the `-kv` sibling repo (whose
  // transformer is tuned for reference editing) instead of `repo`.
  // The runner only uses --kv-repo when --reference-images is also present;
  // the plain text/i2i bf16 path stays on the base repo.
  if (kvRepo) args.push('--kv-repo', kvRepo);
  if (kvRepo && kvRevision) args.push('--kv-revision', kvRevision);
  if (negativePrompt) args.push('--negative-prompt', negativePrompt);
  if (initImagePath) args.push('--image-path', initImagePath);
  if (initImagePath && initImageStrength != null) args.push('--image-strength', String(initImageStrength));
  // Multi-reference editing for FLUX.2. When the path list is non-empty,
  // scripts/ml/flux2_macos.py loads Flux2KleinKVPipeline (instead of the
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
  return { bin: flux2Python, args, providerInputs: { initImagePath: initImagePath || null, referenceImagePaths: refImagePaths } };
};

// imagine_win.py does not implement i2i — silently drop the init-image
// args so the request still produces a normal txt2img result rather
// than failing argparse with "unrecognized arguments".
const mfluxWindowsArgs = ({ pythonPath, model, prompt, negativePrompt, width, height, steps, guidance, seed, quantize, outputPath, loraPaths = [], loraScales = [] }) => {
  const scriptPath = join(PATHS.root, 'scripts', 'ml', 'imagine_win.py');
  return {
    bin: pythonPath,
    providerInputs: { initImagePath: null, referenceImagePaths: [] },
    args: [scriptPath, '--model', model?.id, '--prompt', prompt, '--height', String(height), '--width', String(width), '--steps', String(steps), '--seed', String(seed), '--quantize', String(quantize), '--output', outputPath, '--metadata',
      ...(guidance > 0 ? ['--guidance', String(guidance)] : []),
      ...(negativePrompt ? ['--negative-prompt', negativePrompt] : []),
      ...(loraPaths.length ? ['--lora-paths', ...loraPaths] : []),
      ...(loraScales.length ? ['--lora-scales', ...loraScales.map(String)] : []),
    ],
  };
};

const mfluxArgs = ({ pythonPath, model, prompt, negativePrompt, width, height, steps, guidance, seed, quantize, outputPath, loraPaths = [], loraScales = [], stepwiseDir, initImagePath, initImageStrength }) => {
  const bin = join(dirname(pythonPath), 'mflux-generate');
  const args = ['--model', model?.id, '--prompt', prompt, '--height', String(height), '--width', String(width), '--steps', String(steps), '--seed', String(seed), '--quantize', String(quantize), '--output', outputPath, '--metadata'];
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
  return { bin, args, providerInputs: { initImagePath: initImagePath || null, referenceImagePaths: [] } };
};

export const buildArgs = ({ loraPaths = [], loraScales = [], referenceImagePaths = [], referenceImageStrengths = [], platform = process.platform, ...rest }) => {
  const inputs = { ...rest, loraPaths, loraScales, referenceImagePaths, referenceImageStrengths };
  const { model } = inputs;
  if (usesFlux3(model)) return flux3RenderArgs(inputs);
  if (usesMinimaxH3Image(model)) return minimaxH3ImageRenderArgs(inputs);
  if (usesMossSwift(model)) return mossRenderArgs(inputs);
  if (usesDiffusersRunner(model)) return diffusersRenderArgs(inputs);
  if (isFlux2(model)) return flux2RenderArgs(model, inputs);
  if (platform === 'win32') return mfluxWindowsArgs(inputs);
  return mfluxArgs(inputs);
};

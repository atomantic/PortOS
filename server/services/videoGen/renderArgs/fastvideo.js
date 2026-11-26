import { ServerError } from '../../../lib/errorHandler.js';
import {
  FASTVIDEO_VENV_PYTHON,
  FASTVIDEO_HELPER_SCRIPT,
  FASTVIDEO_REPO_DIR,
  FASTVIDEO_MLX_CHECKPOINT_DIR,
  FASTVIDEO_PROMPT_CACHE_DIR,
  assertByovRuntimeInstalled,
} from '../runtimes.js';
import { assertRenderModeContract } from '../modeContract.js';

// Which FastVideo entry script a `fastvideo` row renders through. The runtime
// is shared (one venv, one checkout, one progress protocol) but the entry
// scripts are not interchangeable: FastMetal drives the distilled Wan exports
// through mlx_wan_prompt_to_video.py, while FastH3 drives a pre-quantized MLX
// DiT through mlx_fasth3.py, which has no --fps/--guidance/--negative-prompt
// /--image-path and is text-to-video-with-audio only.
//
// Read off the registry entry rather than matched against an id list here, so
// a peer-synced or user-added FastH3 row routes correctly without an edit to
// this file — the same "execution facts live on the entry" convention
// `samplerLocked` and `supportedModes` already use. An absent/unknown value
// means FastMetal, which is what every pre-#5860 row is.
export const FASTVIDEO_FAMILIES = Object.freeze(['fastmetal', 'fastmetal5b', 'fasth3', 'fasth3omni']);
export const fastvideoFamily = (model) =>
  (FASTVIDEO_FAMILIES.includes(model?.fastvideoFamily) ? model.fastvideoFamily
    : model?.repo === 'FastVideo/FastMetal-5B-QAD' ? 'fastmetal5b' : 'fastmetal');

// FastVideo publishes FastH3 as a bf16 diffusers snapshot whose DiT sits under
// `transformer/`, but mlx_fasth3.py loads a pre-quantized `mlx_h3_dit`
// directory instead. A row that names one of these formats is pointing at that
// upstream snapshot and wants the helper to run FastVideo's own converter once;
// a row that omits it already ships the quantized DiT beside its model root.
// Mirrors MLX_DIT_FORMATS in scripts/ml/generate_fastvideo.py, itself the
// converter's own format list. Kept in sync by hand — the helper's argparse
// `choices=` is the enforcement; this list is what lets the server reject a
// bad value before queueing a render.
export const FASTVIDEO_MLX_FORMATS = Object.freeze(['int8', 'int6', 'int4']);
export const fastvideoMlxFormat = (model) =>
  (FASTVIDEO_MLX_FORMATS.includes(model?.fastvideoMlxFormat) ? model.fastvideoMlxFormat : null);

// Build args for the FastVideo MLX helper on Apple Silicon.
export const buildFastVideoArgs = ({
  model, fastvideoModelPath, fastvideoOmniAssets, referenceImagePaths, referenceVideoPaths, referenceAudioPaths, prompt, negativePrompt, width, height,
  numFrames, fps, steps, guidance, seed, sourceImagePath, lastImagePath, mode, outputPath,
}) => {
  assertByovRuntimeInstalled('fastvideo');
  assertRenderModeContract({ model, mode, sourceImagePath, lastImagePath });
  const family = fastvideoFamily(model);
  if (family === 'fasth3' && sourceImagePath) {
    throw new ServerError('FastH3 MLX does not support first-frame conditioning.', {
      status: 400, code: 'VIDEO_MODE_UNSUPPORTED',
    });
  }
  const modelRoot = fastvideoModelPath || model.repo;
  const args = [
    FASTVIDEO_HELPER_SCRIPT,
    '--repo-dir', FASTVIDEO_REPO_DIR,
    '--family', family,
    '--model-root', modelRoot,
    '--prompt', prompt,
    '--width', String(width),
    '--height', String(height),
    '--num-frames', String(numFrames),
    '--fps', String(fps),
    '--steps', String(steps),
    '--guidance', String(guidance ?? 1.0),
    '--seed', String(seed),
    '--output', outputPath,
  ];
  // Two FastH3 checkpoint layouts, and the row is what distinguishes them.
  // An upstream FastVideo snapshot carries the bf16 DiT under `transformer/`
  // and declares a target format, so the helper converts once and owns the
  // resulting path — passing --mlx-checkpoint here would pin the wrong
  // directory. A repack that already ships `mlx_h3_dit.safetensors` beside the
  // vae/audio_vae/text_encoder/tokenizer IS its own checkpoint, and says so
  // explicitly rather than leaning on the helper's default-to-model-root.
  if (family === 'fasth3') {
    if (model.fastvideoVsa === true) args.push('--vsa');
    // Conditioning is half the wall clock of a render and recomputes identical
    // embeddings every time, so every FastH3 row reuses one cache.
    args.push('--prompt-cache-dir', FASTVIDEO_PROMPT_CACHE_DIR);
    const mlxFormat = fastvideoMlxFormat(model);
    if (mlxFormat) args.push('--mlx-format', mlxFormat, '--mlx-checkpoint-cache-dir', FASTVIDEO_MLX_CHECKPOINT_DIR);
    else args.push('--mlx-checkpoint', modelRoot);
  }
  // FastH3 Omni: the same convert-once-then-cache shape as the V2 rows, plus
  // the composed model root's other components. The input image is the FIRST
  // ordered reference, followed by the extra gallery stills.
  if (family === 'fasth3omni') {
    if (!fastvideoOmniAssets || !fastvideoModelPath) {
      throw new ServerError(`${model.name} is missing its downloaded weights.`, { status: 400, code: 'FASTVIDEO_OMNI_WEIGHTS_NOT_CACHED' });
    }
    const mlxFormat = fastvideoMlxFormat(model);
    if (!mlxFormat) throw new ServerError(`${model.name} needs a fastvideoMlxFormat.`, { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' });
    args.push(
      '--prompt-cache-dir', FASTVIDEO_PROMPT_CACHE_DIR,
      '--mlx-format', mlxFormat, '--mlx-checkpoint-cache-dir', FASTVIDEO_MLX_CHECKPOINT_DIR,
      '--omni-base-root', fastvideoOmniAssets.baseRoot,
      '--vae-decoder', fastvideoOmniAssets.vaeDecoder,
      '--vae-encoder', fastvideoOmniAssets.vaeEncoder,
    );
    for (const path of referenceImagePaths || []) args.push('--reference-image', path);
    for (const path of referenceVideoPaths || []) args.push('--reference-video', path);
    for (const path of referenceAudioPaths || []) args.push('--reference-audio', path);
  }
  if (negativePrompt) args.push('--negative-prompt', negativePrompt);
  if (sourceImagePath) args.push('--image', sourceImagePath);
  return { bin: FASTVIDEO_VENV_PYTHON, args };
};

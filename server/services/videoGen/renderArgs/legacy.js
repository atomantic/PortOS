import { join } from 'path';
import { PATHS } from '../../../lib/fileUtils.js';

const AV_LORA_HELPER_SCRIPT = join(PATHS.root, 'scripts', 'ml', 'generate_av_lora.py');

export const buildLegacyArgs = ({
  pythonPath, modelId, model, prompt, negativePrompt, width, height, numFrames, fps, steps,
  guidance, seed, sourceImagePath, lastImagePath, mode, imageStrength, disableAudio, outputPath,
  textEncoderRepo, tiling, loras, hasLoras, usesWindowsHelper,
}) => {
  // Every BYOV runtime has declined above; the remaining declared CUDA runtime
  // is the legacy LTX-Video 0.9.5 diffusers wrapper.
  if (usesWindowsHelper) {
    const scriptPath = join(PATHS.root, 'scripts', 'ml', 'generate_win.py');
    const args = [scriptPath, '--model', modelId, '--prompt', prompt, '--height', String(height), '--width', String(width), '--num-frames', String(numFrames), '--fps', String(fps), '--steps', String(steps), '--guidance', String(guidance), '--seed', String(seed), '--output', outputPath];
    if (negativePrompt) args.push('--negative-prompt', negativePrompt);
    if (sourceImagePath) args.push('--image', sourceImagePath);
    if (lastImagePath) args.push('--last-image', lastImagePath);
    return { bin: pythonPath, args };
  }
  // Flags shared by the bare `mlx_video.generate_av` CLI and the LoRA wrapper
  // (scripts/ml/generate_av_lora.py forwards these untouched to generate_av.main()).
  const flags = [
    '--prompt', prompt,
    '--height', String(height),
    '--width', String(width),
    '--num-frames', String(numFrames),
    '--seed', String(seed),
    '--fps', String(fps),
    '--steps', String(steps),
    '--cfg-scale', String(guidance),
    '--output-path', outputPath,
    '--model-repo', model.repo,
    '--text-encoder-repo', textEncoderRepo,
    '--tiling', tiling,
  ];
  if (negativePrompt) flags.push('--negative-prompt', negativePrompt);
  if (disableAudio) flags.push('--no-audio');

  // Pick a single conditioning image and frame index. mlx_video.generate_av
  // accepts only one --image so true FFLF (both keyframes) isn't supported;
  // when only a last image was supplied for FFLF, we condition the LAST
  // latent frame instead. --image-frame-idx is a LATENT index — LTX
  // compression is `1 + (videoFrames - 1) / 8`, so passing a raw video
  // frame count silently fails the conditioning shape check.
  let condImage = sourceImagePath;
  let condFrameIdx = null;
  if (mode === 'fflf' && lastImagePath && !sourceImagePath) {
    condImage = lastImagePath;
    condFrameIdx = Math.max(0, Math.floor((Number(numFrames) - 1) / 8));
  } else if (mode === 'fflf' && lastImagePath && sourceImagePath) {
    console.log(`⚠️ FFLF requested but mlx_video CLI only supports single-frame conditioning — last image ignored`);
  }
  if (condImage) {
    flags.push('--image', condImage);
    if (condFrameIdx != null) flags.push('--image-frame-idx', String(condFrameIdx));
    // --image-strength uses mask = 1.0 - strength: 1.0 preserves the source
    // latent, 0.0 fully denoises (= T2V). mlx_video's help text describes
    // this inverted. Omit when no caller value so mlx_video's default (1.0)
    // applies.
    if (imageStrength != null) flags.push('--image-strength', String(imageStrength));
  }

  // LoRA renders on a capable LTX-2.x mlx_video model go through the wrapper,
  // which merges the LoRA deltas into the transformer before running
  // generate_av.main(). `--user-loras` carries the resolved {path,strength}
  // pairs — the same JSON shape buildLtx2Args emits for the dgrauet runtime.
  if (hasLoras) {
    return {
      bin: pythonPath,
      args: [AV_LORA_HELPER_SCRIPT, ...flags, '--user-loras', JSON.stringify(loras.map((l) => ({ path: l.path, strength: l.strength })))],
    };
  }
  return { bin: pythonPath, args: ['-m', 'mlx_video.generate_av', ...flags] };
};

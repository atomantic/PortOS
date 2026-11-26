import { ServerError } from '../../../lib/errorHandler.js';
import {
  WAN22_VENV_PYTHON,
  WAN22_HELPER_SCRIPT,
  WAN22_CUDA_VENV_PYTHON,
  WAN22_CUDA_HELPER_SCRIPT,
  assertByovRuntimeInstalled,
} from '../runtimes.js';
import { assertRenderModeContract } from '../modeContract.js';

// Build args for the pinned MLX-Gen Wan CLI. The helper itself never downloads:
// all base + profile weights must already be present through the UI flow.
export const buildWan22Args = ({ model, wanModelPath, wanRequiredWeights, prompt, negativePrompt, width, height, numFrames, fps, steps, guidance, seed, sourceImagePath, mode, outputPath }) => {
  assertByovRuntimeInstalled('wan22');
  const requestedMode = mode || (sourceImagePath ? 'image' : 'text');
  assertRenderModeContract({ model, mode, sourceImagePath });
  const args = [
    WAN22_HELPER_SCRIPT,
    '--model-repo', wanModelPath,
    '--prompt', prompt,
    '--width', String(width),
    '--height', String(height),
    '--num-frames', String(numFrames),
    '--fps', String(fps),
    '--steps', String(steps),
    '--guidance', String(guidance ?? 5.0),
    '--seed', String(seed),
    '--output', outputPath,
  ];
  if (negativePrompt) args.push('--negative-prompt', negativePrompt);
  if (model.guidance2 != null) args.push('--guidance-2', String(model.guidance2));
  if (model.flowShift != null) args.push('--flow-shift', String(model.flowShift));
  if (model.solver) args.push('--solver', model.solver);
  // The contract above already rejected image mode without a source.
  if (requestedMode === 'image') args.push('--image', sourceImagePath);
  for (const weight of wanRequiredWeights) {
    args.push('--lora-path', weight.path);
    args.push('--lora-target-role', weight.role);
  }
  return { bin: WAN22_VENV_PYTHON, args };
};

export const buildWan22CudaArgs = ({ model, wanModelPath, prompt, negativePrompt, width, height, numFrames, fps, steps, guidance, seed, sourceImagePath, mode, outputPath }) => {
  assertByovRuntimeInstalled('wan22_cuda');
  assertRenderModeContract({ model, mode, sourceImagePath });
  if (!model?.repo || !model?.revision || !wanModelPath) {
    throw new ServerError(
      `Wan 2.2 CUDA model "${model?.id || 'unknown'}" is missing its pinned snapshot.`,
      { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' },
    );
  }
  const args = [
    WAN22_CUDA_HELPER_SCRIPT,
    '--model-repo', model.repo,
    '--model-revision', model.revision,
    '--prompt', prompt,
    '--width', String(width),
    '--height', String(height),
    '--num-frames', String(numFrames),
    '--fps', String(fps),
    '--steps', String(steps),
    '--guidance', String(guidance ?? 5),
    '--seed', String(seed),
    '--output', outputPath,
  ];
  if (negativePrompt) args.push('--negative-prompt', negativePrompt);
  return { bin: WAN22_CUDA_VENV_PYTHON, args };
};

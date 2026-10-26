import { ServerError } from '../../lib/errorHandler.js';
import { assertA2vLoraStageRequest, isDefaultA2vLoraStages } from '../../lib/videoLoraStageValidation.js';

export { assertA2vLoraStageRequest } from '../../lib/videoLoraStageValidation.js';

export async function validateA2vLoraStages(options) {
  assertA2vLoraStageRequest(options);
  if (isDefaultA2vLoraStages(options.strengths)) return;
  const { resolveA2vLoraStageCapable } = await import('./runtimes.js');
  if (!await resolveA2vLoraStageCapable(options.model.runtime, { fresh: true })) {
    throw new ServerError('The installed LTX MLX runtime did not pass the motion/refine LoRA capability check. Repair its pinned runtime or reset both multipliers to 1.',
      { status: 400, code: 'A2V_LORA_STAGES_UNSUPPORTED' });
  }
}

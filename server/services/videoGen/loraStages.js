import { ServerError } from '../../lib/errorHandler.js';
import { a2vLoraStageStrengthsSchema, isDefaultA2vLoraStages } from '../../lib/videoLoraStageValidation.js';
import { resolveA2vLoraStageCapable } from './runtimes.js';

export function assertA2vLoraStageRequest({ strengths, model, mode, backend = 'local', hasLoras }) {
  if (strengths != null && !a2vLoraStageStrengthsSchema.safeParse(strengths).success) {
    throw new ServerError('A2V LoRA stage strengths must be two finite multipliers in [0, 1].', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (isDefaultA2vLoraStages(strengths)) return;
  if (backend !== 'local' || mode !== 'a2v' || !['ltx2', 'ltx25'].includes(model?.runtime) || !hasLoras) {
    throw new ServerError('Per-stage user LoRA strengths require local LTX MLX audio-to-video with a selected LoRA. Choose a compatible model and mode, or reset both multipliers to 1.',
      { status: 400, code: 'A2V_LORA_STAGES_UNSUPPORTED' });
  }
}

export async function validateA2vLoraStages(options) {
  assertA2vLoraStageRequest(options);
  if (isDefaultA2vLoraStages(options.strengths)) return;
  if (!await resolveA2vLoraStageCapable(options.model.runtime, { fresh: true })) {
    throw new ServerError('The installed LTX MLX runtime did not pass the motion/refine LoRA capability check. Repair its pinned runtime or reset both multipliers to 1.',
      { status: 400, code: 'A2V_LORA_STAGES_UNSUPPORTED' });
  }
}

import { z } from 'zod';
import { ServerError } from './errorHandler.js';

export const a2vLoraStageStrengthsSchema = z.tuple([
  z.number().finite().min(0).max(1), z.number().finite().min(0).max(1),
]);

export const isDefaultA2vLoraStages = (value) => value == null
  || (Array.isArray(value) && value.length === 2 && value.every((v) => v === 1));

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

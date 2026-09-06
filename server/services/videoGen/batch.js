import { randomInt, randomUUID } from 'node:crypto';
import { ServerError } from '../../lib/errorHandler.js';

export const MAX_VIDEO_BATCH_SIZE = 20;
const MAX_SEED = 2 ** 32 - 1;

// Only runtimes whose pipeline retains reusable weights without stage-specific
// in-place fusion may promise warm batching. Never infer this from a model name.
export const supportsWarmVideoBatch = (model) => model?.runtime === 'minimax_h3';

export function validateVideoBatch(params, model) {
  const count = Number(params.batchSize ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > MAX_VIDEO_BATCH_SIZE) {
    throw new ServerError(`Batch size must be an integer from 1 to ${MAX_VIDEO_BATCH_SIZE}.`, { status: 400, code: 'VIDEO_BATCH_INVALID' });
  }
  if (count === 1) return;
  if (!supportsWarmVideoBatch(model) || (params.backend && params.backend !== 'local') || params.mediaProviderPeerId) {
    throw new ServerError('Warm video batches require a local MiniMax H3 MLX model.', { status: 400, code: 'VIDEO_BATCH_UNSUPPORTED' });
  }
  if (Number(params.chunks ?? 1) > 1 || params.musicVideo || params.fableLoom) {
    throw new ServerError('A render batch produces separate videos. Use a single render for chained clips or scene delivery.', { status: 400, code: 'VIDEO_BATCH_CONFLICT' });
  }
  if (params.seed != null && params.seed !== '') {
    const seed = Number(params.seed);
    if (!Number.isSafeInteger(seed) || seed < 0 || seed + count - 1 > MAX_SEED) {
      throw new ServerError(`The batch seeds must stay between 0 and ${MAX_SEED}. Lower the starting seed or batch size.`, { status: 400, code: 'VIDEO_BATCH_SEED_RANGE' });
    }
  }
}

export function planVideoBatch({ jobId, batchSize, seed }) {
  const random = seed == null || seed === '';
  return Array.from({ length: batchSize }, (_, index) => ({
    id: index === 0 ? jobId : randomUUID(),
    filename: index === 0 ? `${jobId}.mp4` : `${jobId}-${index + 1}.mp4`,
    seed: random ? randomInt(0, MAX_SEED + 1) : Number(seed) + index,
    index,
  }));
}

/** Retained checkpoint inspection and character-to-inference-adapter lookup. */
import { request } from './apiCore.js';

export const listLoraTrainingCheckpoints = (runId, options = {}) =>
  request(`/lora-training/runs/${runId}/checkpoints`, options);


export const getCharacterLoras = ({ entryId, ingredientId } = {}, { silent = false } = {}) => {
  const params = new URLSearchParams();
  if (entryId) params.set('entryId', entryId);
  if (ingredientId) params.set('ingredientId', ingredientId);
  return request(`/loras/by-character?${params.toString()}`, { silent });
};

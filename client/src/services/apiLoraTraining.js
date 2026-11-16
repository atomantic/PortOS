/**
 *  Retained checkpoint inspection and character-to-inference-adapter lookup.
 */
import { request } from './apiCore.js';

export const listLoraTrainingCheckpoints = (runId, options = {}) =>
  request(`/lora-training/runs/${runId}/checkpoints`, options);


export const getCharacterLoras = ({ entryId, ingredientId } = {}, { silent = false } = {}) => {
  const params = new URLSearchParams();
  if (entryId) params.set('entryId', entryId);
  if (ingredientId) params.set('ingredientId', ingredientId);
  return request(`/loras/by-character?${params.toString()}`, { silent });
};

// Retired-training storage (allowlisted server-side; the caller names an operation id, never a path).
export const getRetiredDataInventory = (options = {}) =>
  request('/data-maintenance', { silent: true, hostControlOptional: true, ...options });
export const deleteRetiredData = (operationId) =>
  request(`/data-maintenance/${encodeURIComponent(operationId)}`, { method: 'DELETE' });

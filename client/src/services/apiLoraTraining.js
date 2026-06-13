/**
 * Character LoRA training API — datasets (/api/lora-datasets), training
 * runs (/api/lora-training), and the character→LoRA link lookup
 * (/api/loras/by-character).
 */

import { request } from './apiCore.js';

// ---- Datasets ----

export const listLoraDatasets = (filters = {}) => {
  const params = new URLSearchParams();
  for (const key of ['universeId', 'entryId', 'ingredientId']) {
    if (filters[key]) params.set(key, filters[key]);
  }
  const qs = params.toString();
  return request(`/lora-datasets${qs ? `?${qs}` : ''}`);
};

export const createLoraDataset = ({ universeId, entryId, triggerWord }, { silent = false } = {}) =>
  request('/lora-datasets', {
    method: 'POST',
    body: JSON.stringify({ universeId, entryId, ...(triggerWord ? { triggerWord } : {}) }),
    silent,
  });

export const getLoraDataset = (id) => request(`/lora-datasets/${id}`);

export const patchLoraDataset = (id, patch) =>
  request(`/lora-datasets/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const deleteLoraDataset = (id) => request(`/lora-datasets/${id}`, { method: 'DELETE' });

// `files` is a FileList/array — field names image1…image10 per the route.
export const uploadLoraDatasetImages = (id, files) => {
  const form = new FormData();
  [...files].slice(0, 10).forEach((file, i) => form.append(`image${i + 1}`, file));
  return request(`/lora-datasets/${id}/images`, { method: 'POST', body: form });
};

// Import existing gallery images (basenames) into the dataset.
export const importLoraDatasetGalleryImages = (id, filenames) =>
  request(`/lora-datasets/${id}/import-gallery`, {
    method: 'POST', body: JSON.stringify({ filenames }),
  });

export const generateLoraDatasetImages = (id, options = {}) =>
  request(`/lora-datasets/${id}/generate`, { method: 'POST', body: JSON.stringify(options) });

export const sliceLoraDatasetRefSheet = (id, { variant, cols, rows } = {}) =>
  request(`/lora-datasets/${id}/slice-reference-sheet`, {
    method: 'POST',
    body: JSON.stringify({ ...(variant ? { variant } : {}), ...(cols ? { cols } : {}), ...(rows ? { rows } : {}) }),
  });

export const startLoraCaptionRun = (id, options = {}) =>
  request(`/lora-datasets/${id}/caption`, { method: 'POST', body: JSON.stringify(options) });

export const updateLoraDatasetImageCaption = (id, imageId, caption) =>
  request(`/lora-datasets/${id}/images/${imageId}`, {
    method: 'PATCH', body: JSON.stringify({ caption }),
  });

export const deleteLoraDatasetImage = (id, imageId) =>
  request(`/lora-datasets/${id}/images/${imageId}`, { method: 'DELETE' });

// ---- Training runs ----

export const getLoraTrainingStatus = () => request('/lora-training/status');

export const startLoraTrainingRun = ({ datasetId, baseModelId, name, params }) =>
  request('/lora-training/runs', {
    method: 'POST',
    body: JSON.stringify({ datasetId, baseModelId, ...(name ? { name } : {}), ...(params ? { params } : {}) }),
  });

export const listLoraTrainingRuns = (filters = {}) => {
  const params = new URLSearchParams();
  for (const key of ['status', 'characterId', 'datasetId', 'limit']) {
    if (filters[key]) params.set(key, filters[key]);
  }
  const qs = params.toString();
  return request(`/lora-training/runs${qs ? `?${qs}` : ''}`);
};

export const getLoraTrainingRun = (runId) => request(`/lora-training/runs/${runId}`);

export const cancelLoraTrainingRun = (runId) =>
  request(`/lora-training/runs/${runId}/cancel`, { method: 'POST' });

// Checkpoints for a finished run — each with step, loss, preview thumbnail,
// and which one is currently deployed. Drives the manual checkpoint picker.
export const listLoraTrainingCheckpoints = (runId) =>
  request(`/lora-training/runs/${runId}/checkpoints`);

// Mid-training sample timeline (step + thumbnail URL) — seeds the live
// progress gallery so a reload mid-run shows every sample rendered so far.
export const listLoraTrainingSamples = (runId) =>
  request(`/lora-training/runs/${runId}/samples`);

// Promote a checkpoint to be the deployed LoRA (re-extracts that step's
// adapter and overwrites the run's registered .safetensors in place).
export const promoteLoraTrainingCheckpoint = (runId, step, { silent = false } = {}) =>
  request(`/lora-training/runs/${runId}/promote-checkpoint`, {
    method: 'POST', body: JSON.stringify({ step }), silent,
  });

export const deleteLoraTrainingRun = (runId, { deleteLora = false } = {}) =>
  request(`/lora-training/runs/${runId}${deleteLora ? '?deleteLora=true' : ''}`, { method: 'DELETE' });

// ---- Character → trained-LoRA link ----

export const getCharacterLoras = ({ entryId, ingredientId } = {}, { silent = false } = {}) => {
  const params = new URLSearchParams();
  if (entryId) params.set('entryId', entryId);
  if (ingredientId) params.set('ingredientId', ingredientId);
  return request(`/loras/by-character?${params.toString()}`, { silent });
};

/**
 * LoRA training API — datasets (/api/lora-datasets), training
 * runs (/api/lora-training), and the character→LoRA link lookup
 * (/api/loras/by-character).
 */

import { request } from './apiCore.js';

// ---- Datasets ----

export const listLoraDatasets = (filters = {}) => {
  const params = new URLSearchParams();
  for (const key of ['universeId', 'entryKind', 'entryId', 'ingredientId']) {
    if (filters[key]) params.set(key, filters[key]);
  }
  const qs = params.toString();
  return request(`/lora-datasets${qs ? `?${qs}` : ''}`);
};

export const createLoraDataset = ({
  universeId, entryKind = 'characters', entryId, triggerWord,
}, { silent = false } = {}) =>
  request('/lora-datasets', {
    method: 'POST',
    body: JSON.stringify({
      universeId, entryKind, entryId, ...(triggerWord ? { triggerWord } : {}),
    }),
    silent,
  });

export const getLoraDataset = (id) => request(`/lora-datasets/${id}`);

// Server-derived variation axes (expressions/outfits for characters; lighting/
// settings for objects & places) — seeds the generate-batch override chips.
export const getLoraDatasetVariationAxes = (id, options = {}) =>
  request(`/lora-datasets/${id}/variation-axes`, options);

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

// `useVision` (default true) lets a vision model propose a bounding box per
// figure; the fixed cols×rows grid is the fallback (and what `useVision: false`
// forces). When omitted, the server auto-resolves a vision model.
export const sliceLoraDatasetRefSheet = (id, { variant, cols, rows, useVision } = {}) =>
  request(`/lora-datasets/${id}/slice-reference-sheet`, {
    method: 'POST',
    body: JSON.stringify({
      ...(variant ? { variant } : {}),
      ...(cols ? { cols } : {}),
      ...(rows ? { rows } : {}),
      ...(useVision === false ? { useVision: false } : {}),
    }),
  });

export const startLoraCaptionRun = (id, options = {}) =>
  request(`/lora-datasets/${id}/caption`, { method: 'POST', body: JSON.stringify(options) });

export const updateLoraDatasetImageCaption = (id, imageId, caption) =>
  request(`/lora-datasets/${id}/images/${imageId}`, {
    method: 'PATCH', body: JSON.stringify({ caption }),
  });

export const deleteLoraDatasetImage = (id, imageId) =>
  request(`/lora-datasets/${id}/images/${imageId}`, { method: 'DELETE' });

// Strip the identity fragments shared across most captions so the trigger token
// learns the character (issue #1320). Returns { dataset, removedFragments, updatedImages }.
export const stripLoraDatasetSharedCaptionFragments = (id) =>
  request(`/lora-datasets/${id}/strip-shared-fragments`, { method: 'POST' });

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

// Resume a failed/canceled run from its latest checkpoint — continues the same
// run (new job, same run id) so the trainer picks up its saved optimizer state.
export const resumeLoraTrainingRun = (runId, { silent = false } = {}) =>
  request(`/lora-training/runs/${runId}/resume`, { method: 'POST', silent });

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

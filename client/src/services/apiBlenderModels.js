/**
 * API client for Blender Models: records, the src/ workspace, builds, publishing and the published GLB.
 *
 * A Blender model is operator-authored Blender Python (`src/model.py`) that PortOS builds into checked,
 * versioned GLB builds (docs/features/blender-models.md). A build answers 202 and runs in the background;
 * `blender-model:changed` (useModelLifecycle with `blender: true`) invalidates the record as it moves.
 */

import { request } from './apiCore.js';

const base = (id) => `/blender-models/${encodeURIComponent(id)}`;
const json = (method, body, options) => ({ method, body: JSON.stringify(body ?? {}), ...options });

export const listBlenderModels = (options) => request('/blender-models', options);

export const getBlenderModel = (id, options) => request(base(id), options);

export const createBlenderModel = (input, options) => request('/blender-models', json('POST', input, options));

export const updateBlenderModel = (id, patch, options) => request(base(id), json('PATCH', patch, options));

export const deleteBlenderModel = (id, options) => request(base(id), { method: 'DELETE', ...options });

// Copies the shipped starter src/model.py; 409 once the model has one.
export const scaffoldBlenderModel = (id, options) => request(`${base(id)}/workspace`, json('POST', { template: 'starter' }, options));

export const listBlenderModelFiles = (id, options) => request(`${base(id)}/files`, options);

export const readBlenderModelFile = (id, path, options) =>
  request(`${base(id)}/file?path=${encodeURIComponent(path)}`, options);

export const writeBlenderModelFile = (id, path, content, options) =>
  request(`${base(id)}/file`, json('PUT', { path, content }, options));

export const deleteBlenderModelFile = (id, path, options) =>
  request(`${base(id)}/file?path=${encodeURIComponent(path)}`, { method: 'DELETE', ...options });

// `quality` is 'draft' or 'full'. Needs Blender in Trusted local mode (409 otherwise).
export const buildBlenderModel = (id, quality, options) =>
  request(`${base(id)}/builds`, json('POST', quality ? { quality } : {}, options));

export const cancelBlenderModelBuild = (id, buildId, options) =>
  request(`${base(id)}/builds/${encodeURIComponent(buildId)}/cancel`, json('POST', {}, options));

export const openBlenderModelBuild = (id, buildId, options) =>
  request(`${base(id)}/builds/${encodeURIComponent(buildId)}/open`, json('POST', {}, options));

// Only a completed build without error findings can be published.
export const publishBlenderModelBuild = (id, buildId, options) =>
  request(`${base(id)}/publish`, json('POST', { buildId }, options));

const readBuildFile = (id, buildId, name, options) =>
  request(`${base(id)}/builds/${encodeURIComponent(buildId)}/files/${encodeURIComponent(name)}`, options);

export const getBlenderModelBuildReport = (id, buildId, options) => readBuildFile(id, buildId, 'report.json', options);

export const getBlenderModelBuildLog = (id, buildId, options) => readBuildFile(id, buildId, 'build.log', { responseType: 'text', ...options });

// model.glb, model.blend, report.json or build.log of one build, for a viewer, a download link or fetch().
export const blenderModelBuildFileUrl = (id, buildId, name) =>
  `/api${base(id)}/builds/${encodeURIComponent(buildId)}/files/${encodeURIComponent(name)}`;

const reviewBase = (id, buildId) => `${base(id)}/builds/${encodeURIComponent(buildId)}/review`;

// Renders the fixed views and saved cameras of a completed build again. Needs Blender in Trusted local mode (409 otherwise).
export const renderBlenderModelReview = (id, buildId, options) => request(reviewBase(id, buildId), json('POST', {}, options));

export const cancelBlenderModelReview = (id, buildId, options) => request(`${reviewBase(id, buildId)}/cancel`, json('POST', {}, options));

export const getBlenderModelReviewLog = (id, buildId, options) => request(`${reviewBase(id, buildId)}/review.log`, { responseType: 'text', ...options });

// `<view>-<look>.png` or `sheet-<look>.jpg`; `version` (the review's renderedAt) keeps a re-render from showing a cached image.
export const blenderModelReviewFileUrl = (id, buildId, name, version) => `/api${reviewBase(id, buildId)}/${encodeURIComponent(name)}?v=${encodeURIComponent(version)}`;

export const addBlenderModelCamera = (id, camera, options) => request(`${base(id)}/cameras`, json('POST', camera, options));

export const updateBlenderModelCamera = (id, cameraId, patch, options) => request(`${base(id)}/cameras/${encodeURIComponent(cameraId)}`, json('PATCH', patch, options));

export const removeBlenderModelCamera = (id, cameraId, options) => request(`${base(id)}/cameras/${encodeURIComponent(cameraId)}`, { method: 'DELETE', ...options });

export const addBlenderModelDifference = (id, difference, options) => request(`${base(id)}/differences`, json('POST', difference, options));

// Closing (`status` fixed or accepted) records `buildId`, or the newest completed build.
export const updateBlenderModelDifference = (id, differenceId, patch, options) =>
  request(`${base(id)}/differences/${encodeURIComponent(differenceId)}`, json('PATCH', patch, options));

export const removeBlenderModelDifference = (id, differenceId, options) =>
  request(`${base(id)}/differences/${encodeURIComponent(differenceId)}`, { method: 'DELETE', ...options });

// The published build's GLB (model/gltf-binary).
export const blenderModelAssetUrl = (id) => `/api${base(id)}/asset`;

const referenceBase = (id, referenceId) => `${base(id)}/references/${encodeURIComponent(referenceId)}`;

// Where reference images start from: `{ ingredientId?, images?, size?, imageMode?, imageModelId? }`.
export const updateBlenderModelReferenceSource = (id, patch, options) => request(`${base(id)}/reference-source`, json('PATCH', patch, options));

export const addBlenderModelCloseup = (id, mechanism, options) => request(`${base(id)}/references`, json('POST', { mechanism }, options));

export const removeBlenderModelCloseup = (id, referenceId, options) => request(referenceBase(id, referenceId), { method: 'DELETE', ...options });

// Built by the code that sends it; queues nothing. `refusal` says why a render would be refused.
export const previewBlenderModelReference = (id, referenceId, body, options) => request(`${referenceBase(id, referenceId)}/preview`, json('POST', body, options));

export const renderBlenderModelReference = (id, referenceId, words, options) => request(`${referenceBase(id, referenceId)}/render`, json('POST', { words }, options));

// Puts an existing library image up for review instead of rendering one.
export const attachBlenderModelReferenceImage = (id, referenceId, filename, options) => request(`${referenceBase(id, referenceId)}/images`, json('POST', { filename }, options));

export const reviewBlenderModelReference = (id, referenceId, imageId, body, options) =>
  request(`${referenceBase(id, referenceId)}/images/${encodeURIComponent(imageId)}/review`, json('POST', body, options));

export const createBlenderModelPartsBrief = (id, options) => request(`${base(id)}/parts-brief`, json('POST', {}, options));

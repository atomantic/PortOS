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

// The published build's GLB (model/gltf-binary).
export const blenderModelAssetUrl = (id) => `/api${base(id)}/asset`;

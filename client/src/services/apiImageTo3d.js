import { request } from './apiCore.js';

// Image-to-3D (the /media/3d page): the selectable targets (TRELLIS.2, …)
// annotated with host availability + install status, plus the per-image model
// records that drive create → render → preview → download.

export const getImageTo3dTargets = (options) => request('/image-to-3d/targets', options);

export const listImageTo3dModels = (options) => request('/image-to-3d/models', options);

export const getImageTo3dModel = (id, options) =>
  request(`/image-to-3d/models/${encodeURIComponent(id)}`, options);

// Create a record from a gallery image; the server kicks off the on-device render
// immediately (status → generating), so poll getImageTo3dModel until ready/failed.
export const createImageTo3dModel = (input, options) =>
  request('/image-to-3d/models', {
    method: 'POST',
    body: JSON.stringify(input),
    ...options,
  });

// Re-run the render for an existing record (status → generating again).
export const generateImageTo3dModel = (id, options) =>
  request(`/image-to-3d/models/${encodeURIComponent(id)}/generate`, {
    method: 'POST',
    ...options,
  });

export const deleteImageTo3dModel = (id, options) =>
  request(`/image-to-3d/models/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    ...options,
  });

// Direct GLB download endpoint (Content-Disposition attachment). The record's
// `assetPath` (the static `/data/image-to-3d/<id>/model.glb` mount) is what the
// GlbViewer renders; this URL is for an explicit "download the file" action.
export const imageTo3dAssetUrl = (id) =>
  `/api/image-to-3d/models/${encodeURIComponent(id)}/asset`;

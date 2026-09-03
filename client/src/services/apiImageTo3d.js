import { request } from './apiCore.js';

// Image-to-3D (the /3d page): the selectable targets (TRELLIS.2, …)
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
// `input` carries the optional per-run knobs ({ steps, seed, keyBackground,
// subjectScale, … }) — they apply to this run only: absent steps → the pipeline
// default, absent seed → the server rolls a fresh random one, absent keyBackground →
// no keying, absent subjectScale → the source keeps its own framing.
export const generateImageTo3dModel = (id, input = {}, options) =>
  request(`/image-to-3d/models/${encodeURIComponent(id)}/generate`, {
    method: 'POST',
    body: JSON.stringify(input),
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

// The decoder's pre-decimation mesh, as written by upstream `generate.py` next to
// the GLB. A separate endpoint rather than a query on `asset` because it is a
// different artifact: plain `v`/`f` OBJ with no UVs, normals or material, often
// several hundred MB, and absent on renders that never wrote the sidecar (a plain
// 404 — not a sign the record is broken). The GLB stays the thing the viewer loads.
export const imageTo3dFullMeshUrl = (id) =>
  `/api/image-to-3d/models/${encodeURIComponent(id)}/full-mesh`;

// The stored AR Quick Look artifact, served `inline` as `model/vnd.usdz+zip` —
// the exact header pair Safari requires before it will open an `<a rel="ar">`
// target in AR. Deliberately NOT the record's static `usdzPath`: that mount
// leaves the content type to mime lookup, and this contract is the feature.
export const imageTo3dUsdzUrl = (id) =>
  `/api/image-to-3d/models/${encodeURIComponent(id)}/usdz`;

// Persist a USDZ the VIEWER produced (three's USDZExporter over the scene it has
// already decoded — PortOS ships no USD toolchain). Raw bytes, not JSON: the
// explicit content type overrides apiCore's `application/json` default so the
// server's `express.raw` parser claims the body.
export const uploadImageTo3dUsdz = (id, bytes, options) =>
  request(`/image-to-3d/models/${encodeURIComponent(id)}/usdz`, {
    method: 'POST',
    body: bytes,
    headers: { 'Content-Type': 'model/vnd.usdz+zip' },
    ...options,
  });

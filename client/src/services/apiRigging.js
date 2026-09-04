import { request } from './apiCore.js';

// Character rigging: the read-only readiness answer for this install's Blender
// runtime. `refresh` forces a re-probe past the server's short-lived memo — use it
// only for an explicit recheck, never on mount.

export const getRiggingReadiness = ({ refresh = false, ...options } = {}) =>
  request(`/rigging/readiness${refresh ? '?refresh=1' : ''}`, options);

// Auto-skin a rendered image-to-3D mesh. Runs INLINE (minutes of local Blender CPU) and
// resolves with the updated model record, so a refusal arrives as an error carrying the
// measured sentence — "automatic weighting left 4.2% of vertices unweighted, ceiling is
// 0.5%" — rather than a generic failure the user cannot act on. `input` may carry the
// advanced overrides (`skeletonHint`, `weldDistance`, `unweightedCeiling`).
export const rigImageTo3dModel = (id, input = {}, options) =>
  request(`/rigging/models/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify(input),
    ...options,
  });

// The animation clips this install has locally (user-dropped GLB files), plus which
// CoS states they cover. Read-only and cheap — safe to call on every rigged-record view.
export const listRiggingClips = (options) => request('/rigging/clips', options);

// Retarget one locally-held clip onto a model's published rig. `mode: 'diagnostic'`
// (the server default) measures the proposed head-zone cleanup and motion without
// writing anything; `mode: 'write'` applies the same proposal and may refuse if it is
// over cap. Resolves with the updated model record — a refusal arrives as an error
// carrying the server's measured sentence, same contract as `rigImageTo3dModel`.
export const retargetImageTo3dModel = (id, input = {}, options) =>
  request(`/rigging/models/${encodeURIComponent(id)}/retarget`, {
    method: 'POST',
    body: JSON.stringify(input),
    ...options,
  });

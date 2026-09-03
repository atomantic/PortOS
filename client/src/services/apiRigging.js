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

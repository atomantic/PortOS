import { request } from './apiCore.js';

// Sprite Manager (issue #2895, phase 1): record list/detail, production-asset
// import, and the few user-managed record fields. `options` lets a caller
// suppress request()'s auto-toast with `{ silent: true }` when it owns its own
// error UI.

export const listSpriteRecords = (options = {}) => request('/sprites', options);
export const getSpriteRecord = (id, options = {}) => request(`/sprites/${encodeURIComponent(id)}`, options);
export const updateSpriteRecord = (id, patch, options = {}) => request(`/sprites/${encodeURIComponent(id)}`, {
  method: 'PATCH', body: JSON.stringify(patch), ...options,
});
export const deleteSpriteRecord = (id, options = {}) => request(`/sprites/${encodeURIComponent(id)}`, {
  method: 'DELETE', ...options,
});

// Import approved production assets from a source pipeline checkout.
// Returns { results: [...perSubject], totals }.
export const importSprites = (body, options = {}) => request('/sprites/import', {
  method: 'POST', body: JSON.stringify(body), ...options,
});

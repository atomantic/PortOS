import { request } from './apiCore.js';

// Sprite Manager: record list/detail + production-asset import (#2895), and
// the phase-2 reference workflow — create characters, queue main/anchor
// candidate renders, lock reviewed candidates (#2896). `options` lets a
// caller suppress request()'s auto-toast with `{ silent: true }` when it owns
// its own error UI.

export const listSpriteRecords = (options = {}) => request('/sprites', options);
export const getSpriteRecord = (id, options = {}) => request(`/sprites/${encodeURIComponent(id)}`, options);

export const createSpriteRecord = (body, options = {}) => request('/sprites', {
  method: 'POST', body: JSON.stringify(body), ...options,
});

export const updateSpriteRecord = (id, patch, options = {}) => request(`/sprites/${encodeURIComponent(id)}`, {
  method: 'PATCH', body: JSON.stringify(patch), ...options,
});

// Import approved production assets from a source pipeline checkout.
// Returns { results: [...perSubject], totals }.
export const importSprites = (body, options = {}) => request('/sprites/import', {
  method: 'POST', body: JSON.stringify(body), ...options,
});

// Queue one reference candidate render. `referenceImageFile` (main target
// only) switches the POST to multipart so the design reference uploads with
// the fields. Returns { jobId, mode, target, anchorId }.
export const generateSpriteReference = (id, { referenceImageFile, ...fields }, options = {}) => {
  let body;
  if (referenceImageFile) {
    body = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null && value !== '') body.append(key, value);
    }
    body.append('referenceImage', referenceImageFile);
  } else {
    body = JSON.stringify(fields);
  }
  return request(`/sprites/${encodeURIComponent(id)}/reference/generate`, { method: 'POST', body, ...options });
};

// Freeze a reviewed candidate as the main reference or a directional anchor.
// Returns the updated { manifest, candidates } reference set.
export const lockSpriteReference = (id, body, options = {}) => request(`/sprites/${encodeURIComponent(id)}/reference/lock`, {
  method: 'POST', body: JSON.stringify(body), ...options,
});

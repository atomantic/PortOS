import { request } from './apiCore.js';

// Quota Burn — the install-level burn plan (one loop in PortOS; jobs may target
// managed apps). Every wrapper takes an optional `options` so callers with their
// own error UI can pass `{ silent: true }` per the toasting convention.

// Plan + live status (quota cards, per-job pending counts, recent runs).
// `refresh` re-scrapes provider usage instead of reading the cache.
export const getQuotaBurn = (refresh = false, options) =>
  request(`/quota-burn${refresh ? '?refresh=1' : ''}`, options);

// Job-type catalog + the app / universe / render-backend options its params pick from.
export const getQuotaBurnCatalog = (options) => request('/quota-burn/catalog', options);

// Partial merge: top-level and per-family keys merge, a family's `jobs` replaces.
export const saveQuotaBurn = (patch, options) => request('/quota-burn', {
  method: 'PUT',
  body: JSON.stringify(patch),
  ...options,
});

// Evaluate now. `{ familyId, jobId, force }` runs one named job past the
// window/reserve/cap gates; no body behaves like a scheduled tick.
export const runQuotaBurn = (body = {}, options) => request('/quota-burn/run', {
  method: 'POST',
  body: JSON.stringify(body),
  ...options,
});

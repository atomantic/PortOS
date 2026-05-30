import { request } from './apiCore.js';

// Creative Ingredients Catalog API surface. Every helper takes an optional
// `options` second arg so callers with their own `.catch` toast can pass
// `{ silent: true }` per the project convention (avoids double-toast).
//
// All path params are URL-encoded — refId and refKind in particular flow
// from arbitrary record ids and could contain `/`, `?`, `#`, or `%`. The
// list-query params already round-trip through URLSearchParams which encodes.

const enc = encodeURIComponent;

export const getCatalogStats = (options) => request('/catalog/stats', options);

// --- Scraps -------------------------------------------------------------

export const createCatalogScrap = (body = {}, options) =>
  request('/catalog/scraps', { method: 'POST', body: JSON.stringify(body), ...options });

export const listCatalogScraps = ({ limit, offset, ...options } = {}) => {
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  return request(`/catalog/scraps${params.toString() ? `?${params}` : ''}`, options);
};

export const getCatalogScrap = (id, options) => request(`/catalog/scraps/${enc(id)}`, options);

export const updateCatalogScrap = (id, patch, options) =>
  request(`/catalog/scraps/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(patch), ...options });

export const deleteCatalogScrap = (id, options) =>
  request(`/catalog/scraps/${enc(id)}`, { method: 'DELETE', ...options });

export const extractFromCatalogScrap = (id, body = {}, options) =>
  request(`/catalog/scraps/${enc(id)}/extract`, { method: 'POST', body: JSON.stringify(body), ...options });

export const commitCatalogScrapDraft = (id, accepted, options) =>
  request(`/catalog/scraps/${enc(id)}/commit`, { method: 'POST', body: JSON.stringify({ accepted }), ...options });

// --- Ingredients --------------------------------------------------------

export const listCatalogIngredients = ({ type, tag, q, limit, offset, ...options } = {}) => {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (tag) params.set('tag', tag);
  if (q) params.set('q', q);
  if (limit) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  return request(`/catalog/ingredients${params.toString() ? `?${params}` : ''}`, options);
};

export const getCatalogIngredient = (id, options) =>
  request(`/catalog/ingredients/${enc(id)}`, options);

export const createCatalogIngredient = (body = {}, options) =>
  request('/catalog/ingredients', { method: 'POST', body: JSON.stringify(body), ...options });

export const updateCatalogIngredient = (id, patch, options) =>
  request(`/catalog/ingredients/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(patch), ...options });

export const deleteCatalogIngredient = (id, options) =>
  request(`/catalog/ingredients/${enc(id)}`, { method: 'DELETE', ...options });

// --- Linking (catalog ↔ universe/series/work) ---------------------------

export const linkCatalogIngredient = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/link`, { method: 'POST', body: JSON.stringify(body), ...options });

export const unlinkCatalogIngredient = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/link`, { method: 'DELETE', body: JSON.stringify(body), ...options });

export const listCatalogIngredientsForRef = (refKind, refId, options) =>
  request(`/catalog/refs/${enc(refKind)}/${enc(refId)}/ingredients`, options);

// --- Admin --------------------------------------------------------------

export const backfillCatalogEmbeddings = ({ limit, ...options } = {}) =>
  request('/catalog/embeddings/backfill', { method: 'POST', body: JSON.stringify({ limit }), ...options });

export const rerunCatalogMigration = ({ force, ...options } = {}) =>
  request('/catalog/migration/rerun', { method: 'POST', body: JSON.stringify({ force }), ...options });

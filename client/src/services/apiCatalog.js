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

// --- Alternate ingest sources (url / file / voice) ----------------------
// Each returns { scrap, draft } — the same shape as extractFromCatalogScrap —
// so CatalogIngest can drop straight into its review phase.

export const ingestCatalogUrl = (body = {}, options) =>
  request('/catalog/ingest/url', { method: 'POST', body: JSON.stringify(body), ...options });

export const ingestCatalogFile = (body = {}, options) =>
  request('/catalog/ingest/file', { method: 'POST', body: JSON.stringify(body), ...options });

export const ingestCatalogVoice = (body = {}, options) =>
  request('/catalog/ingest/voice', { method: 'POST', body: JSON.stringify(body), ...options });

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

// Batched detail hydration — one request for ingredient + refs + sources +
// relations + revisions + media + missingMedia, used by the detail page's
// initial load in place of five separate calls.
export const getCatalogIngredientDetails = (id, options) =>
  request(`/catalog/ingredients/${enc(id)}/details`, options);

// --- Tags (canonical taxonomy) ------------------------------------------

// Autocomplete over the canonical catalog_tags table. `q` is an optional
// prefix/substring filter; absent returns the most-recently-created tags.
export const listCatalogTags = ({ q, limit, ...options } = {}) => {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (limit) params.set('limit', String(limit));
  return request(`/catalog/tags${params.toString() ? `?${params}` : ''}`, options);
};

export const createCatalogIngredient = (body = {}, options) =>
  request('/catalog/ingredients', { method: 'POST', body: JSON.stringify(body), ...options });

export const updateCatalogIngredient = (id, patch, options) =>
  request(`/catalog/ingredients/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(patch), ...options });

export const deleteCatalogIngredient = (id, options) =>
  request(`/catalog/ingredients/${enc(id)}`, { method: 'DELETE', ...options });

// --- Revision history ---------------------------------------------------

export const listCatalogIngredientRevisions = (id, { limit, offset, ...options } = {}) => {
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  return request(`/catalog/ingredients/${enc(id)}/revisions${params.toString() ? `?${params}` : ''}`, options);
};

export const restoreCatalogIngredientRevision = (id, revisionId, body = {}, options) =>
  request(`/catalog/ingredients/${enc(id)}/revisions/${enc(revisionId)}/restore`, {
    method: 'POST', body: JSON.stringify(body), ...options,
  });

// --- Linking (catalog ↔ universe/series/work) ---------------------------

export const linkCatalogIngredient = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/link`, { method: 'POST', body: JSON.stringify(body), ...options });

export const unlinkCatalogIngredient = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/link`, { method: 'DELETE', body: JSON.stringify(body), ...options });

export const listCatalogIngredientsForRef = (refKind, refId, options) =>
  request(`/catalog/refs/${enc(refKind)}/${enc(refId)}/ingredients`, options);

// --- Relations (ingredient ↔ ingredient) --------------------------------

export const listCatalogIngredientRelations = (id, options) =>
  request(`/catalog/ingredients/${enc(id)}/relations`, options);

export const linkCatalogIngredientRelation = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/relations`, { method: 'POST', body: JSON.stringify(body), ...options });

export const unlinkCatalogIngredientRelation = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/relations`, { method: 'DELETE', body: JSON.stringify(body), ...options });

// --- Media attachments (portrait / reference / audio / video / document) ---

export const listCatalogIngredientMedia = (id, options) =>
  request(`/catalog/ingredients/${enc(id)}/media`, options);

export const listCatalogIngredientMissingMedia = (id, options) =>
  request(`/catalog/ingredients/${enc(id)}/media/missing`, options);

export const attachCatalogIngredientMedia = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/media`, { method: 'POST', body: JSON.stringify(body), ...options });

export const setCatalogIngredientPortrait = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/media/portrait`, { method: 'POST', body: JSON.stringify(body), ...options });

export const detachCatalogIngredientMedia = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/media`, { method: 'DELETE', body: JSON.stringify(body), ...options });

// --- Bulk import / export ----------------------------------------------

export const bulkImportCatalogIngredients = (body, options) =>
  request('/catalog/bulk-import', { method: 'POST', body: JSON.stringify(body), ...options });

// Returns the raw bundle text/JSON; the caller is responsible for triggering
// a browser download (typically by constructing a Blob and clicking an
// anchor). For programmatic use (round-trip ingest), the JSON form is the
// canonical shape.
export const exportCatalogSlice = ({ refKind, refId, format = 'json' } = {}, options) => {
  const params = new URLSearchParams({ refKind, refId, format });
  return request(`/catalog/export?${params}`, { responseType: 'text', ...options });
};

// --- Admin --------------------------------------------------------------

export const backfillCatalogEmbeddings = ({ limit, ...options } = {}) =>
  request('/catalog/embeddings/backfill', { method: 'POST', body: JSON.stringify({ limit }), ...options });

export const rerunCatalogMigration = ({ force, ...options } = {}) =>
  request('/catalog/migration/rerun', { method: 'POST', body: JSON.stringify({ force }), ...options });

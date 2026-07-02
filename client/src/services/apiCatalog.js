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

// Faceted counts (#1762) driving the filter dropdowns + album headers:
// { types, universes, series, tags, unlinkedCount, orphanedCount, total }.
export const getCatalogFacets = (options) => request('/catalog/facets', options);

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

// --- Alternate ingest sources (url / file / voice / brain) --------------
// Each returns { scrap, draft } — the same shape as extractFromCatalogScrap —
// so CatalogIngest can drop straight into its review phase.

export const ingestCatalogUrl = (body = {}, options) =>
  request('/catalog/ingest/url', { method: 'POST', body: JSON.stringify(body), ...options });

export const ingestCatalogFile = (body = {}, options) =>
  request('/catalog/ingest/file', { method: 'POST', body: JSON.stringify(body), ...options });

export const ingestCatalogVoice = (body = {}, options) =>
  request('/catalog/ingest/voice', { method: 'POST', body: JSON.stringify(body), ...options });

// Brain → catalog bridge: ingest an existing brain record by { brainType, brainId }.
export const ingestCatalogBrain = (body = {}, options) =>
  request('/catalog/ingest/brain', { method: 'POST', body: JSON.stringify(body), ...options });

// --- Ingredients --------------------------------------------------------

export const listCatalogIngredients = ({ type, tag, q, refKind, refId, unlinked, orphaned, limit, offset, ...options } = {}) => {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (tag) params.set('tag', tag);
  if (q) params.set('q', q);
  // Album/facet filters (#1762). refKind/refId are a pair; unlinked/orphaned are
  // the "Raw"/"Orphaned" album views — mutually exclusive with each other and
  // with the ref filter (the server rejects combining them).
  if (refKind && refId) {
    params.set('refKind', refKind);
    params.set('refId', refId);
  } else if (unlinked) {
    params.set('unlinked', 'true');
  } else if (orphaned) {
    params.set('orphaned', 'true');
  }
  if (limit) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  return request(`/catalog/ingredients${params.toString() ? `?${params}` : ''}`, options);
};

// Batch fetch ingredients by id (max 50 server-side) — used by the Story
// Builder remix handoff to hydrate the catalog ingredients the user selected.
// The `ids` filter rides the normal paged list endpoint, which returns the
// `{ items, nextOffset }` envelope ordered created_at DESC; this unwraps to a
// plain array AND re-orders it to the requested `ids` so chips + seed read in
// the user's selection order (mirroring the server's resolveCatalogIngredients).
// Empty/falsy ids are dropped before the request.
export const listCatalogIngredientsByIds = async (ids = [], options) => {
  const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
  const params = new URLSearchParams();
  params.set('ids', list.join(','));
  const res = await request(`/catalog/ingredients?${params}`, options);
  const items = Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
  const byId = new Map(items.map((ing) => [ing.id, ing]));
  return list.map((id) => byId.get(id)).filter(Boolean);
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

// Upload a raw file (base64 + MIME) onto an ingredient; server picks the media
// kind + library dir from the MIME and returns the attached media row.
export const uploadCatalogIngredientMediaFile = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/media/upload`, { method: 'POST', body: JSON.stringify(body), ...options });

// Attach a recorded voice memo (base64 WAV) — server transcribes via Whisper and
// returns `{ media, transcript }`.
export const recordCatalogIngredientVoiceMemo = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/media/voice`, { method: 'POST', body: JSON.stringify(body), ...options });

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

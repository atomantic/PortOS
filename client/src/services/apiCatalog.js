import { request } from './apiCore.js';
import { fetchByIds, normalizeIds } from './apiBatch.js';

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

// --- Stories (storyboards, music videos, series) ------------------------

export const listCatalogStories = (type, options) =>
  request(`/catalog/stories?${new URLSearchParams({ type })}`, options);

export const draftCatalogStoryMember = (body, options) =>
  request('/catalog/stories/draft', { method: 'POST', body: JSON.stringify(body), ...options });

export const joinCatalogStory = (kind, id, ingredientId, options) =>
  request(`/catalog/stories/${enc(kind)}/${enc(id)}/members`, { method: 'POST', body: JSON.stringify({ ingredientId }), ...options });

// A music video's subjects with their linked record or a suggested one (same
// name, the age form "(17)" names); linking sets or clears ingredientId + form.
export const listVideoSubjectLinks = (projectId, type, options) =>
  request(`/catalog/stories/music-video/${enc(projectId)}/subjects${type ? `?${new URLSearchParams({ type })}` : ''}`, options);

export const linkVideoSubjects = (projectId, links, options) =>
  request(`/catalog/stories/music-video/${enc(projectId)}/subjects/link`, { method: 'POST', body: JSON.stringify({ links }), ...options });

// --- Scraps -------------------------------------------------------------

export const createCatalogScrap = (body = {}, options) =>
  request('/catalog/scraps', { method: 'POST', body: JSON.stringify(body), ...options });

export const extractFromCatalogScrap = (id, body = {}, options) =>
  request(`/catalog/scraps/${enc(id)}/extract`, { method: 'POST', body: JSON.stringify(body), ...options });

export const pruneCatalogScrap = (id, body, options) =>
  request(`/catalog/scraps/${enc(id)}/prune`, { method: 'POST', body: JSON.stringify(body), ...options });

// `universeRef` (+ optional `role`) binds every committed ingredient to that
// universe — the "Catalogue into" select on CatalogIngest (#7615). Omitted
// when the caller passes 'unassigned' (the "no universe" choice), reproducing
// prior behavior exactly (source link only, no homing ref).
// `relationships` forwards explicit grounded graph relationships (including [] for structured drafts).
// `creativeNoteIds` names the Brain inbox notes this scrap came from; the server
// stamps them consumed in the same request as the commit (#9943).
export const commitCatalogScrapDraft = (id, accepted, { universeRef, role, relationships, operationKey, creativeNoteIds, ...options } = {}, maybeRelationships) => {
  const rels = maybeRelationships !== undefined ? maybeRelationships : relationships;
  return request(`/catalog/scraps/${enc(id)}/commit`, {
    method: 'POST',
    body: JSON.stringify({
      accepted,
      ...(operationKey ? { operationKey } : {}),
      ...(creativeNoteIds?.length ? { creativeNoteIds } : {}),
      ...(universeRef ? { universeRef, ...(role ? { role } : {}) } : {}),
      ...(rels !== undefined ? { relationships: rels } : {}),
    }),
    ...options,
  });
};

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

export const listCatalogIngredients = ({ type, tag, q, refKind, refId, unlinked, orphaned, scrapId, limit, offset, ...options } = {}) => {
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
  // Source-scrap filter (#7617) — "everything extracted from this piece".
  // Orthogonal to the album filters above, so it composes with them.
  if (scrapId) params.set('scrapId', scrapId);
  if (limit) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  return request(`/catalog/ingredients${params.toString() ? `?${params}` : ''}`, options);
};

// Batch fetch ingredients by id (max 50 server-side) — used by the Story
// Builder remix handoff to hydrate the catalog ingredients the user selected.
// `fetchByIds` handles the shared `?ids=` mechanics (dedupe, empty-list
// short-circuit, `{ items }` envelope unwrap); the extra step here is
// re-ordering to the requested `ids` — the paged list returns created_at DESC,
// and chips + seed must read in the user's selection order (mirroring the
// server's resolveCatalogIngredients).
export const listCatalogIngredientsByIds = async (ids = [], options) => {
  const list = normalizeIds(ids);
  const items = await fetchByIds('/catalog/ingredients', list, options);
  const byId = new Map(items.map((ing) => [ing.id, ing]));
  return list.map((id) => byId.get(id)).filter(Boolean);
};

// Full detail is the compatibility default. Library profiles request the lean
// profile projection; media is fetched separately on its first visible tab.
export const getCatalogIngredientDetails = (id, { view, ...options } = {}) =>
  request(`/catalog/ingredients/${enc(id)}/details${view ? `?view=${enc(view)}` : ''}`, options);

export const getCatalogIngredientCards = async (ids = [], options) => {
  const list = normalizeIds(ids);
  const items = [];
  for (let offset = 0; offset < list.length; offset += 50) {
    const batch = list.slice(offset, offset + 50);
    const response = await request(`/catalog/ingredient-cards?${new URLSearchParams({ ids: batch.join(',') })}`, options);
    if (!Array.isArray(response?.items) || response.items.some(item => !item || !batch.includes(item.id)
      || !item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload))) {
      throw new Error('Catalog card context response is unavailable');
    }
    items.push(...response.items);
  }
  return items;
};

export const setCatalogIngredientLock = (id, locked, options) =>
  request(`/catalog/ingredients/${enc(id)}/lock`, { method: 'PATCH', body: JSON.stringify({ locked }), ...options });

export const getCatalogUniverseContext = (id, options) =>
  request(`/catalog/ingredients/${enc(id)}/universe-context`, options);

export const setCatalogUniverseOwner = (id, universeId, options) =>
  request(`/catalog/ingredients/${enc(id)}/owner`, { method: 'PUT', body: JSON.stringify({ universeId }), ...options });

export const forkCatalogIngredient = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/fork`, { method: 'POST', body: JSON.stringify(body), ...options });

export const listCatalogRelatedImages = (id, { limit = 24, offset = 0, ...options } = {}) => {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return request(`/catalog/ingredients/${enc(id)}/related-images?${params}`, options);
};

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

// What a character's family adds to an image render (labeled additions + relatives' images).
export const getCatalogFamilyContext = (id, options) =>
  request(`/catalog/ingredients/${enc(id)}/family-context`, options);

export const linkCatalogIngredientRelation = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/relations`, { method: 'POST', body: JSON.stringify(body), ...options });

export const unlinkCatalogIngredientRelation = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/relations`, { method: 'DELETE', body: JSON.stringify(body), ...options });

// --- Media attachments (portrait / reference / audio / video / document) ---

export const listCatalogIngredientMedia = (id, options) =>
  request(`/catalog/ingredients/${enc(id)}/media`, options);

export const attachCatalogIngredientMedia = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/media`, { method: 'POST', body: JSON.stringify(body), ...options });

export const setCatalogIngredientPortrait = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/media/portrait`, { method: 'POST', body: JSON.stringify(body), ...options });

// Attach a just-rendered image; the server picks portrait vs reference and
// returns `{ media, kind, attached }` (attached:false when already filed).
export const attachCatalogIngredientGeneratedImage = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/media/generated`, { method: 'POST', body: JSON.stringify(body), ...options });

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

// --- Reference sheets ---------------------------------------------------
// Sheet kinds a record's type offers ({ variants: [{ id, label, description }] }),
// the exact prompt a render would send ({ preview: { sentPrompt, … } }), and the
// render itself ({ jobId, variant, delegatedTo }). `body` is { variant, ...overrides }.

export const listCatalogSheetVariants = (id, options) =>
  request(`/catalog/ingredients/${enc(id)}/sheets/variants`, options);

export const previewCatalogSheet = (id, body = {}, options) =>
  request(`/catalog/ingredients/${enc(id)}/sheets/preview`, { method: 'POST', body: JSON.stringify(body), ...options });

export const renderCatalogSheet = (id, body = {}, options) =>
  request(`/catalog/ingredients/${enc(id)}/sheets`, { method: 'POST', body: JSON.stringify(body), ...options });
// Remove a universe-canon sheet, bound to the file shown; returns
// `{ filename, pointers, updatedAt }`.
export const removeCatalogPointerSheet = (id, variant, filename, options) =>
  request(`/catalog/ingredients/${enc(id)}/sheets/pointer?variant=${enc(variant)}&filename=${enc(filename)}`, { method: 'DELETE', ...options });

// --- Bulk import / export ----------------------------------------------

export const bulkImportCatalogIngredients = (body, options) =>
  request('/catalog/bulk-import', { method: 'POST', body: JSON.stringify(body), ...options });

export const rerunCatalogMigration = ({ force, ...options } = {}) =>
  request('/catalog/migration/rerun', { method: 'POST', body: JSON.stringify({ force }), ...options });

// Casting › Import from music videos: the dry run, then the reviewed decisions.
export const previewMusicVideoCastImport = (options) => request('/catalog/import/music-videos', options);
export const commitMusicVideoCastImport = (selections, options) =>
  request('/catalog/import/music-videos', { method: 'POST', body: JSON.stringify({ selections }), ...options });

export const previewCatalogMerge = (body, options) =>
  request('/catalog/ingredients/merge', { method: 'POST', body: JSON.stringify({ ...body, dryRun: true }), ...options });
export const applyCatalogMerge = (body, options) =>
  request('/catalog/ingredients/merge', { method: 'POST', body: JSON.stringify({ ...body, dryRun: false }), ...options });
export const listCatalogMergeHistory = (id, { limit = 10, offset = 0, ...options } = {}) => {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return request(`/catalog/ingredients/${enc(id)}/merge-history?${params}`, options);
};
export const getCatalogMergeReceipt = (id, options) =>
  request(`/catalog/ingredient-merges/${enc(id)}`, options);
export const recoverCatalogMerge = (id, options) =>
  request(`/catalog/ingredient-merges/${enc(id)}/recover`, { method: 'POST', body: '{}', ...options });

// --- Casting reference library (variant / tags / render-guide flag) ---
export const updateCatalogIngredientMediaLibrary = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/media/library`, { method: 'PATCH', body: JSON.stringify(body), ...options });

export const refineCatalogMedia = (id, body, { preview = false, ...options } = {}) =>
  request(`/catalog/ingredients/${enc(id)}/media/refine${preview ? '/compose' : ''}`, { method: 'POST', body: JSON.stringify(body), ...options });

// Casting > Design: provider-written face lines, then one round of takes.
export const spreadCatalogDesign = (id, body, { preview = false, ...options } = {}) =>
  request(`/catalog/ingredients/${enc(id)}/design/spread${preview ? '/compose' : ''}`, { method: 'POST', body: JSON.stringify(body), ...options });

export const renderCatalogDesign = (id, body, { preview = false, ...options } = {}) =>
  request(`/catalog/ingredients/${enc(id)}/design/render${preview ? '/compose' : ''}`, { method: 'POST', body: JSON.stringify(body), ...options });

export const attachCatalogIngredientMediaFromMoodBoard = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/media/from-mood-board`, { method: 'POST', body: JSON.stringify(body), ...options });

// Place greybox: AI draft (preview only), save/clear, and shot capture as a
// tagged reference image. See docs/plans/2026-10-25-place-greybox.md.
export const draftCatalogGreybox = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/greybox/draft`, { method: 'POST', body: JSON.stringify(body), ...options });

// What a draft would send, composed by the server; calls no provider.
export const previewCatalogGreyboxPrompt = (id, body, options) =>
  request(`/catalog/ingredients/${enc(id)}/greybox/prompt`, { method: 'POST', body: JSON.stringify(body), ...options });

// `greybox: null` removes the place's greybox.
export const saveCatalogGreybox = (id, greybox, { source, ...options } = {}) =>
  request(`/catalog/ingredients/${enc(id)}/greybox`, { method: 'PUT', body: JSON.stringify({ greybox, ...(source ? { source } : {}) }), ...options });

export const captureCatalogGreyboxShot = (id, shotId, dataBase64, options) =>
  request(`/catalog/ingredients/${enc(id)}/greybox/shots/${enc(shotId)}/capture`, { method: 'POST', body: JSON.stringify({ dataBase64 }), ...options });

export const refineCatalogDraft = (id, body, { preview = false, ...options } = {}) =>
  request(`/catalog/ingredients/${enc(id)}/refine${preview ? '/compose' : ''}`, { method: 'POST', body: JSON.stringify(body), ...options });

export const renderCatalogGreyboxShot = (id, shotId, options) =>
  request(`/catalog/ingredients/${enc(id)}/greybox/shots/${enc(shotId)}/render`, { method: 'POST', body: JSON.stringify({}), ...options });

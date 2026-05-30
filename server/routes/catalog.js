// Creative Ingredients Catalog HTTP routes, mounted at /api/catalog. Backs
// the Catalog page, Ingest workflow, picker integrations, and peer sync.

import { Router } from 'express';
import * as catalogDB from '../services/catalogDB.js';
import * as catalogSync from '../services/catalogSync.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  catalogScrapCreateSchema,
  catalogScrapPatchSchema,
  catalogIngredientCreateSchema,
  catalogIngredientPatchSchema,
  catalogIngredientLinkSchema,
  catalogIngredientQuerySchema,
  catalogScrapCommitSchema,
  catalogSyncEnvelopeSchema,
  catalogExtractRequestSchema,
  catalogEmbeddingsBackfillSchema,
  catalogMigrationRerunSchema,
} from '../lib/catalogValidation.js';
import { embedIngredient, embedBatch, ingredientEmbedSeed } from '../services/embeddings.js';
import { extractIngredients } from '../services/catalogExtraction.js';
import { migrateBibleToCatalog } from '../scripts/migrateBibleToCatalog.js';
import { PORTOS_SCHEMA_VERSIONS } from '../lib/schemaVersions.js';

const router = Router();

router.get('/stats', asyncHandler(async (req, res) => {
  res.json(await catalogDB.getCatalogStats());
}));

router.get('/scraps', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  res.json(await catalogDB.listScraps({ limit, offset }));
}));

router.get('/scraps/:id', asyncHandler(async (req, res) => {
  const scrap = await catalogDB.getScrap(req.params.id);
  if (!scrap) throw new ServerError('Scrap not found', { status: 404 });
  const sources = await catalogDB.listSourcesForScrap(scrap.id);
  res.json({ ...scrap, sources });
}));

router.post('/scraps', asyncHandler(async (req, res) => {
  validateRequest(catalogScrapCreateSchema, req.body);
  // Scrap embedding was previously generated on create but never read — there is no
  // semantic-search route or "find similar scraps" UI. Removed pending a search endpoint
  // that justifies the LLM round-trip; the catalog_scraps.embedding column remains for
  // future backfill (and peer sync still accepts embeddings from peers that have them).
  const scrap = await catalogDB.createScrap({
    title: req.body.title,
    rawText: req.body.rawText,
    sourceKind: req.body.sourceKind,
    metadata: req.body.metadata,
  });
  res.status(201).json({ scrap });
}));

router.patch('/scraps/:id', asyncHandler(async (req, res) => {
  validateRequest(catalogScrapPatchSchema, req.body);
  const updated = await catalogDB.updateScrap(req.params.id, req.body);
  if (!updated) throw new ServerError('Scrap not found', { status: 404 });
  res.json(updated);
}));

router.delete('/scraps/:id', asyncHandler(async (req, res) => {
  await catalogDB.deleteScrap(req.params.id);
  res.status(204).end();
}));

router.post('/scraps/:id/extract', asyncHandler(async (req, res) => {
  validateRequest(catalogExtractRequestSchema, req.body || {});
  const scrap = await catalogDB.getScrap(req.params.id);
  if (!scrap) throw new ServerError('Scrap not found', { status: 404 });
  const draft = await extractIngredients({
    rawText: scrap.rawText,
    scrapId: scrap.id,
    providerOverride: req.body?.providerOverride,
  });
  res.json({ scrap, draft });
}));

router.post('/scraps/:id/commit', asyncHandler(async (req, res) => {
  validateRequest(catalogScrapCommitSchema, req.body);
  const scrap = await catalogDB.getScrap(req.params.id);
  if (!scrap) throw new ServerError('Scrap not found', { status: 404 });

  // Embed all drafts in parallel (concurrency-4 inside embedBatch) before
  // sequentially writing — LLM round-trips dominate, DB inserts don't.
  const seeds = req.body.accepted.map((d) => ingredientEmbedSeed(d));
  const embeds = await embedBatch(seeds);

  const created = [];
  for (let i = 0; i < req.body.accepted.length; i++) {
    const draft = req.body.accepted[i];
    const e = embeds[i];
    const ing = await catalogDB.createIngredient({
      type: draft.type,
      name: draft.name,
      payload: draft.payload || {},
      tags: draft.tags || [],
      embedding: e?.embedding ?? null,
      embeddingModel: e?.model ?? null,
    });
    await catalogDB.linkIngredientToSource(ing.id, scrap.id, draft.span || null);
    created.push(ing);
  }

  res.status(201).json({ scrap, ingredients: created });
}));

router.get('/ingredients', asyncHandler(async (req, res) => {
  const params = validateRequest(catalogIngredientQuerySchema, req.query);
  res.json(await catalogDB.listIngredients({
    type: params.type,
    tag: params.tag,
    query: params.q,
    limit: params.limit ?? 50,
    offset: params.offset ?? 0,
  }));
}));

router.get('/ingredients/:id', asyncHandler(async (req, res) => {
  const ing = await catalogDB.getIngredient(req.params.id);
  if (!ing) throw new ServerError('Ingredient not found', { status: 404 });
  const [refs, sources] = await Promise.all([
    catalogDB.listRefsForIngredient(req.params.id),
    catalogDB.listSourcesForIngredient(req.params.id),
  ]);
  // Detail UI doesn't render the 768-float embedding (~6KB stringified).
  // Strip unless `?includeEmbedding=true` — sync/export consumers can opt in.
  const includeEmbedding = req.query.includeEmbedding === 'true';
  const { embedding, ...rest } = ing;
  res.json({
    ...(includeEmbedding ? { ...rest, embedding } : rest),
    refs,
    sources,
  });
}));

router.post('/ingredients', asyncHandler(async (req, res) => {
  validateRequest(catalogIngredientCreateSchema, req.body);
  const ing = await catalogDB.createIngredient({
    type: req.body.type,
    name: req.body.name,
    payload: req.body.payload || {},
    tags: req.body.tags || [],
    ...(await embedIngredient(req.body)),
  });
  res.status(201).json(ing);
}));

router.patch('/ingredients/:id', asyncHandler(async (req, res) => {
  validateRequest(catalogIngredientPatchSchema, req.body);
  // Re-embed only when name or payload changes — tag-only edits skip embed.
  let embeddingPatch = {};
  if (req.body.name !== undefined || req.body.payload !== undefined) {
    const current = await catalogDB.getIngredient(req.params.id);
    if (!current) throw new ServerError('Ingredient not found', { status: 404 });
    embeddingPatch = await embedIngredient({
      name: req.body.name ?? current.name,
      payload: req.body.payload ?? current.payload,
    });
  }
  const updated = await catalogDB.updateIngredient(req.params.id, { ...req.body, ...embeddingPatch });
  if (!updated) throw new ServerError('Ingredient not found', { status: 404 });
  res.json(updated);
}));

router.delete('/ingredients/:id', asyncHandler(async (req, res) => {
  await catalogDB.deleteIngredient(req.params.id);
  res.status(204).end();
}));

router.post('/ingredients/:id/link', asyncHandler(async (req, res) => {
  validateRequest(catalogIngredientLinkSchema, req.body);
  await catalogDB.linkIngredientToRef(req.params.id, req.body.refKind, req.body.refId, req.body.role);
  res.status(201).json({ success: true });
}));

router.delete('/ingredients/:id/link', asyncHandler(async (req, res) => {
  validateRequest(catalogIngredientLinkSchema, req.body);
  await catalogDB.unlinkIngredientFromRef(req.params.id, req.body.refKind, req.body.refId, req.body.role);
  res.status(204).end();
}));

router.get('/ingredients/:id/refs', asyncHandler(async (req, res) => {
  res.json(await catalogDB.listRefsForIngredient(req.params.id));
}));

router.get('/refs/:refKind/:refId/ingredients', asyncHandler(async (req, res) => {
  res.json(await catalogDB.listIngredientsForRef(req.params.refKind, req.params.refId));
}));

router.get('/sync', asyncHandler(async (req, res) => {
  // The four `sync_sequence` columns are independent — accept either
  // `?since=N` (uniform; only meaningful on the first pull where everyone's
  // at 0) or `?since[scraps]=A&since[ingredients]=B&...` for subsequent
  // pulls.
  //
  // Express 5 defaults `query parser` to `simple` (Node's querystring),
  // which leaves `since[scraps]=10` as a flat key `'since[scraps]': '10'`
  // instead of nesting it. We reconstruct the per-kind object ourselves so
  // the documented bracket protocol survives regardless of parser config —
  // otherwise peers would silently keep pulling page 1 and loop on hasMore.
  const sinceRaw = req.query.since;
  let since;
  if (sinceRaw && typeof sinceRaw === 'object' && !Array.isArray(sinceRaw)) {
    since = sinceRaw;
  } else {
    const bracket = {};
    for (const [k, v] of Object.entries(req.query)) {
      const m = /^since\[([a-z]+)\]$/.exec(k);
      if (!m) continue;
      // Node's `simple` parser collapses repeated keys into an array; take
      // the last value (HTTP convention) instead of dropping the cursor on
      // the floor and resetting to '0'.
      const value = Array.isArray(v) ? v[v.length - 1] : v;
      if (typeof value === 'string') bracket[m[1]] = value;
    }
    if (Object.keys(bracket).length > 0) {
      since = bracket;
    } else {
      // Reject arrays (`?since=1&since=2`) — coerce to '0' rather than letting
      // them silently re-pull the whole sync log.
      since = (typeof sinceRaw === 'string' && /^\d+$/.test(sinceRaw)) ? sinceRaw : '0';
    }
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
  const changes = await catalogSync.getChangesSince(since, limit);
  res.json({
    ...changes,
    portosMeta: { schemaVersions: { catalog: PORTOS_SCHEMA_VERSIONS.catalog } },
  });
}));

router.post('/sync/apply', asyncHandler(async (req, res) => {
  validateRequest(catalogSyncEnvelopeSchema, req.body);
  // applyRemoteChanges throws CatalogSyncVersionMismatchError (status 412)
  // when the peer is ahead on the `catalog` schema; centralized error
  // middleware translates `err.status` to the HTTP response.
  const stats = await catalogSync.applyRemoteChanges(req.body);
  res.json(stats);
}));

router.post('/embeddings/backfill', asyncHandler(async (req, res) => {
  validateRequest(catalogEmbeddingsBackfillSchema, req.body || {});
  const limit = Math.min(Math.max(parseInt(req.body?.limit, 10) || 50, 1), 200);

  // When `includeStale` is true, also re-embed rows whose stored
  // embedding_model differs from the current settings model — catches the
  // "user switched provider/model and old vectors are in the wrong space"
  // case. Resolved server-side so the client doesn't have to know the
  // current settings.
  let staleModel = null;
  if (req.body?.includeStale === true) {
    const { getEmbeddingsConfig } = await import('../services/embeddings.js');
    const cfg = await getEmbeddingsConfig();
    staleModel = cfg.model || null;
  }

  const { items: todo } = await catalogDB.listIngredients({
    limit,
    offset: 0,
    embeddingMissing: !staleModel,
    staleEmbeddingModel: staleModel,
  });

  const seeds = todo.map((i) => ingredientEmbedSeed(i));
  const embeds = await embedBatch(seeds);

  let embedded = 0;
  let failed = 0;
  for (let i = 0; i < todo.length; i++) {
    const e = embeds[i];
    if (e?.embedding) {
      await catalogDB.updateIngredient(todo[i].id, {
        embedding: e.embedding,
        embeddingModel: e.model,
      });
      embedded++;
    } else {
      failed++;
    }
  }

  res.json({ processed: todo.length, embedded, failed, staleModel });
}));

// Re-run the bible→catalog backfill. Idempotent by design (entries that have
// already been promoted are skipped; embedded entries that carry a foreign
// ingredient id are reconciled into the local catalog with that explicit id).
// Pass `{ force: true }` to ignore the marker file when troubleshooting a
// stuck install — without force the marker gates the walk and the endpoint
// just reports the prior stats.
router.post('/migration/rerun', asyncHandler(async (req, res) => {
  validateRequest(catalogMigrationRerunSchema, req.body || {});
  const result = await migrateBibleToCatalog({ force: req.body?.force === true });
  res.json(result);
}));

export default router;

// Creative Ingredients Catalog HTTP routes, mounted at /api/catalog. Backs
// the Catalog page, Ingest workflow, picker integrations, and peer sync.

import { Router } from 'express';
import * as catalogDB from '../services/catalogDB.js';
import * as catalogSync from '../services/catalogSync.js';
import { resolveRefs, listDanglingRefs } from '../services/catalogRefResolver.js';
import { projectToCanon } from '../services/catalogCanonProjection.js';
import { withTransaction } from '../lib/db.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  catalogScrapCreateSchema,
  catalogScrapPatchSchema,
  catalogIngredientCreateSchema,
  catalogIngredientPatchSchema,
  catalogIngredientLinkSchema,
  catalogRelationLinkSchema,
  catalogMediaAttachSchema,
  catalogMediaDetachSchema,
  catalogPortraitSetSchema,
  catalogIngredientQuerySchema,
  catalogTagQuerySchema,
  catalogScrapCommitSchema,
  catalogSyncEnvelopeSchema,
  catalogExtractRequestSchema,
  catalogEmbeddingsBackfillSchema,
  catalogMigrationRerunSchema,
  catalogBulkImportSchema,
  catalogExportQuerySchema,
  catalogRevisionQuerySchema,
  catalogRevisionRestoreSchema,
  catalogUrlIngestSchema,
  catalogFileIngestSchema,
  catalogVoiceIngestSchema,
  catalogBrainIngestSchema,
  catalogUserTypeSchema,
  catalogUserTypesSettingsSchema,
  REF_KINDS,
} from '../lib/catalogValidation.js';
import { getActiveCatalogTypes, setUserCatalogTypes } from '../lib/catalogTypes.js';
import { readUserTypes as readUserTypeSlice, writeUserTypes } from '../services/catalogUserTypes/store.js';
import { parseBulkPayload, bundleToMarkdown, toYamlString } from '../lib/catalogBulkParsers.js';
import { resolveImageInputPath } from '../lib/fileUtils.js';
import { embedIngredient, embedBatch, ingredientEmbedSeed } from '../services/embeddings.js';
import { extractIngredientsForScrap } from '../services/catalogExtraction.js';
import { ingestFromUrl, ingestFromFile, ingestFromVoice, ingestFromBrain } from '../services/catalogIngestSources.js';
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
  // Chunk long pastes into a parent + N child rows (short inputs stay a single
  // row). The response still returns the PARENT scrap, so the client flow is
  // unchanged — extraction (POST /scraps/:id/extract) transparently unions the
  // children.
  const scrap = await catalogDB.createChunkedScrap({
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
  // Extraction runs on the PARENT scrap (it unions across its child chunks).
  // A request against a child row is a client bug — reject rather than extract
  // a single chunk in isolation and silently lose the rest of the corpus.
  if (scrap.parentScrapId) {
    throw new ServerError('extract runs on the parent scrap, not a chunk', { status: 400 });
  }
  const draft = await extractIngredientsForScrap({
    scrapId: scrap.id,
    providerOverride: req.body?.providerOverride,
  });
  res.json({ scrap, draft });
}));

// --- Alternate ingest sources (url / file / voice) ----------------------
// Each creates a scrap with a typed `source_kind`, runs the SAME extraction
// pipeline as the paste flow (emitting the same catalog:extract:progress
// frames), and returns `{ scrap, draft }` so the client review phase is
// identical regardless of how the text arrived.

router.post('/ingest/url', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogUrlIngestSchema, req.body);
  const result = await ingestFromUrl(body);
  res.status(201).json(result);
}));

router.post('/ingest/file', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogFileIngestSchema, req.body);
  const result = await ingestFromFile(body);
  res.status(201).json(result);
}));

router.post('/ingest/voice', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogVoiceIngestSchema, req.body);
  const result = await ingestFromVoice(body);
  res.status(201).json(result);
}));

// Brain → catalog bridge: ingest an existing brain record (idea/memory/etc.)
// through the same extraction pipeline so it lands on the identical review phase.
router.post('/ingest/brain', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogBrainIngestSchema, req.body);
  const result = await ingestFromBrain(body);
  res.status(201).json(result);
}));

router.post('/scraps/:id/commit', asyncHandler(async (req, res) => {
  validateRequest(catalogScrapCommitSchema, req.body);
  const scrap = await catalogDB.getScrap(req.params.id);
  if (!scrap) throw new ServerError('Scrap not found', { status: 404 });

  // Embed all drafts in parallel (concurrency-4 inside embedBatch) before
  // sequentially writing — LLM round-trips dominate, DB inserts don't. Embeds
  // stay OUTSIDE the transaction: they're network round-trips to the provider,
  // not DB writes, and a half-embedded batch is fine (failed embeds just land
  // as null `embedding` on the row, same as today).
  const seeds = req.body.accepted.map((d) => ingredientEmbedSeed(d));
  const embeds = await embedBatch(seeds);

  // Wrap the per-draft loop in a transaction so a mid-loop failure (DB
  // timeout, future unique-constraint violation, span shape error) rolls back
  // the whole batch instead of leaving some ingredients persisted without
  // their source-link rows.
  const created = await withTransaction(async (client) => {
    const out = [];
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
      }, { client, source: 'extract' });
      await catalogDB.linkIngredientToSource(ing.id, scrap.id, draft.span || null, { client });
      out.push(ing);
    }
    return out;
  });

  res.status(201).json({ scrap, ingredients: created });
}));

// Tag-picker autocomplete. `?q=` does a prefix-then-substring match on the
// canonical tag labels; absent `q` returns the most-recently-created tags.
router.get('/tags', asyncHandler(async (req, res) => {
  const params = validateRequest(catalogTagQuerySchema, req.query);
  res.json(await catalogDB.listTags({ q: params.q, limit: params.limit ?? 20 }));
}));

router.get('/ingredients', asyncHandler(async (req, res) => {
  const params = validateRequest(catalogIngredientQuerySchema, req.query);
  res.json(await catalogDB.listIngredients({
    ids: params.ids,
    type: params.type,
    tag: params.tag,
    query: params.q,
    refKind: params.refKind,
    refId: params.refId,
    unlinked: params.unlinked === true,
    orphaned: params.orphaned === true,
    limit: params.limit ?? 50,
    offset: params.offset ?? 0,
  }));
}));

// Faceted counts for the Catalog filter dropdowns + album headers (#1762):
// type/universe/series/tag facets plus the unlinked ("Raw") and orphaned bucket
// counts, in one round-trip. Live universes/series only.
router.get('/facets', asyncHandler(async (_req, res) => {
  res.json(await catalogDB.getCatalogFacets());
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

// Batched detail hydration: ONE round-trip for everything the detail page loads
// on mount — refs + sources + relations + revisions + media + missing-media —
// replacing five separate client requests. Post-mutation refreshes still hit the
// granular endpoints (revisions / media) so a single attach or restore doesn't
// re-pull the whole record. Embedding is stripped like the single-ingredient
// route (opt in with `?includeEmbedding=true`).
router.get('/ingredients/:id/details', asyncHandler(async (req, res) => {
  const ing = await catalogDB.getIngredient(req.params.id);
  if (!ing) throw new ServerError('Ingredient not found', { status: 404 });
  const [refs, sources, relations, revisions, media, missingMedia] = await Promise.all([
    // Live refs only (#1812): the detail page's "Appears in" panel must not
    // render a chip deep-linking to a soft-deleted universe/series/CD target.
    // The orphan stays recoverable via the Catalog "Orphaned" album.
    catalogDB.listLiveRefsForIngredient(req.params.id),
    catalogDB.listSourcesForIngredient(req.params.id),
    catalogDB.listRelationsForIngredient(req.params.id),
    catalogDB.listIngredientRevisions(req.params.id, { limit: 50 }),
    catalogDB.listMediaForIngredient(req.params.id),
    catalogDB.getMissingMediaForIngredient(req.params.id),
  ]);
  const includeEmbedding = req.query.includeEmbedding === 'true';
  const { embedding, ...rest } = ing;
  res.json({
    ingredient: includeEmbedding ? { ...rest, embedding } : rest,
    refs,
    sources,
    relations,                                 // { outbound, inbound }
    revisions: Array.isArray(revisions?.items) ? revisions.items : [],
    media,                                      // array of attachments
    missingMedia,                               // array of { mediaKey, ... }
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
  // `source`/`actor` are revision-history metadata, not ingredient columns —
  // strip them from the DB patch and forward as the revision context instead.
  const { source, actor, ...fieldPatch } = req.body;
  // Re-embed only when name or payload changes — tag-only edits skip embed.
  let embeddingPatch = {};
  if (fieldPatch.name !== undefined || fieldPatch.payload !== undefined) {
    const current = await catalogDB.getIngredient(req.params.id);
    if (!current) throw new ServerError('Ingredient not found', { status: 404 });
    embeddingPatch = await embedIngredient({
      name: fieldPatch.name ?? current.name,
      payload: fieldPatch.payload ?? current.payload,
    });
  }
  const updated = await catalogDB.updateIngredient(
    req.params.id,
    { ...fieldPatch, ...embeddingPatch },
    { source, actor },
  );
  if (!updated) throw new ServerError('Ingredient not found', { status: 404 });
  res.json(updated);
  // Fan the catalog edit into every linked universe's embedded canon entry so
  // the two stores of record never diverge. Best-effort fire-and-forget: it
  // runs AFTER the response and is outside-request-lifecycle-style fan-out, so
  // it MUST be try/catch-guarded — an uncaught rejection here (a universe write
  // failing) would otherwise crash the process with no `next(err)` to bubble to.
  // A name/payload change is the only thing the cache mirrors; a tag-only edit
  // (or embedding-only) skips the projection.
  if (fieldPatch.name !== undefined || fieldPatch.payload !== undefined) {
    projectToCanon(req.params.id, updated).catch((err) => {
      console.error(`🔁 catalog→canon projection failed for ${req.params.id}: ${err.message}`);
    });
  }
}));

// Revision history for one ingredient (newest first). Local audit trail — see
// catalog_ingredient_revisions in init-db.sql; not federated.
router.get('/ingredients/:id/revisions', asyncHandler(async (req, res) => {
  const params = validateRequest(catalogRevisionQuerySchema, req.query);
  // 404 the history when the ingredient itself is gone, so the UI doesn't
  // render an empty list for a deleted/never-existed id.
  const ing = await catalogDB.getIngredient(req.params.id);
  if (!ing) throw new ServerError('Ingredient not found', { status: 404 });
  res.json(await catalogDB.listIngredientRevisions(req.params.id, {
    limit: params.limit ?? 50,
    offset: params.offset ?? 0,
  }));
}));

// Restore a prior revision: re-applies its name/payload/tags via
// updateIngredient (which itself records a NEW revision for the restore, so the
// restore is auditable and itself reversible). The restored revision must
// belong to the path ingredient.
router.post('/ingredients/:id/revisions/:revisionId/restore', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogRevisionRestoreSchema, req.body || {});
  const revision = await catalogDB.getIngredientRevision(req.params.revisionId);
  if (!revision || revision.ingredientId !== req.params.id) {
    throw new ServerError('Revision not found', { status: 404 });
  }
  // Restore the revision's payload verbatim, INCLUDING its captured
  // `payload.schemaVersion`. `updateIngredient` writes payload as-is and does
  // NOT re-stamp the version (only create/revive do), so the marker must match
  // the restored *shape*: a v1-era revision keeps v1, and the boot-time
  // `migrateCatalogPayload` upgrades it to current iff it's behind. Stripping
  // the marker (→ absent → treated as v1) or forcing it to current would
  // mislabel the restored shape and mis-drive that migration.
  const restoredPayload = revision.payload || {};
  const embeddingPatch = await embedIngredient({ name: revision.name, payload: restoredPayload });
  const updated = await catalogDB.updateIngredient(
    req.params.id,
    { name: revision.name, payload: restoredPayload, tags: revision.tags, ...embeddingPatch },
    { source: body.source || 'user', actor: body.actor },
  );
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

// Resolver (#1018): does this (refKind, refId) target a LIVE app-native record?
// Pairs with the ingredients list above so a caller rendering "everything
// related to this universe/series/issue/work" can also tell whether the target
// itself still exists. Read-only, local — no FK, by design (D3 of #999).
router.get('/refs/:refKind/:refId/resolve', asyncHandler(async (req, res) => {
  const [resolved] = await resolveRefs([{ refKind: req.params.refKind, refId: req.params.refId }]);
  res.json(resolved);
}));

// Integrity surface (#1018): every LIVE ref whose target record no longer
// resolves (deleted, or never arrived after a federated ref). Mirrors the media
// `metadata-missing` check — a dangling ref isn't an error (the target may sync
// in later), just a report. `count` is handy for a badge.
router.get('/refs/dangling', asyncHandler(async (req, res) => {
  const dangling = await listDanglingRefs();
  res.json({ count: dangling.length, dangling });
}));

// --- Ingredient↔ingredient relations -----------------------------------

router.get('/ingredients/:id/relations', asyncHandler(async (req, res) => {
  const ing = await catalogDB.getIngredient(req.params.id);
  if (!ing) throw new ServerError('Ingredient not found', { status: 404 });
  res.json(await catalogDB.listRelationsForIngredient(req.params.id));
}));

router.post('/ingredients/:id/relations', asyncHandler(async (req, res) => {
  validateRequest(catalogRelationLinkSchema, req.body);
  if (req.params.id === req.body.toId) {
    throw new ServerError('Cannot relate an ingredient to itself', { status: 400 });
  }
  // Both ends must exist — FK would reject anyway, but a 404 reads cleaner
  // than a raw FK violation and matches the link route's failure surface.
  const [from, to] = await Promise.all([
    catalogDB.getIngredient(req.params.id),
    catalogDB.getIngredient(req.body.toId),
  ]);
  if (!from) throw new ServerError('Ingredient not found', { status: 404 });
  if (!to) throw new ServerError('Related ingredient not found', { status: 404 });
  await catalogDB.linkIngredientRelation(req.params.id, req.body.toId, req.body.kind);
  res.status(201).json({ success: true });
}));

router.delete('/ingredients/:id/relations', asyncHandler(async (req, res) => {
  validateRequest(catalogRelationLinkSchema, req.body);
  await catalogDB.unlinkIngredientRelation(req.params.id, req.body.toId, req.body.kind);
  res.status(204).end();
}));

// --- Ingredient media attachments ---------------------------------------
// `media_key` is a reference into the media library (data/images + history
// sidecar); the catalog never stores the bytes. The attach/portrait routes
// reject a key that doesn't resolve against the local IMAGE library with a 422
// so a typo can't persist a permanently-broken reference. Federated keys that
// don't resolve are tolerated (they ride in via sync) and surface on the
// integrity endpoint instead — that's a different code path that never throws.
//
// Only image kinds resolve against the gallery today; audio/video/document
// keys have no library resolver yet, so they skip the existence guard.
const IMAGE_MEDIA_KINDS = new Set(['portrait', 'reference']);

router.get('/ingredients/:id/media', asyncHandler(async (req, res) => {
  const ing = await catalogDB.getIngredient(req.params.id);
  if (!ing) throw new ServerError('Ingredient not found', { status: 404 });
  res.json(await catalogDB.listMediaForIngredient(req.params.id));
}));

// Integrity surface: media keys on this ingredient that don't resolve against
// the local library (typically arrived via federation before their asset did).
router.get('/ingredients/:id/media/missing', asyncHandler(async (req, res) => {
  const ing = await catalogDB.getIngredient(req.params.id);
  if (!ing) throw new ServerError('Ingredient not found', { status: 404 });
  res.json({ missing: await catalogDB.getMissingMediaForIngredient(req.params.id) });
}));

router.post('/ingredients/:id/media', asyncHandler(async (req, res) => {
  validateRequest(catalogMediaAttachSchema, req.body);
  const ing = await catalogDB.getIngredient(req.params.id);
  if (!ing) throw new ServerError('Ingredient not found', { status: 404 });
  // Only IMAGE kinds resolve against the gallery today, so only they get the
  // existence guard — attaching an audio/video/document key (no library
  // resolver yet) stores the reference without a 422. The integrity endpoint
  // mirrors this scoping when reporting missing assets.
  if (IMAGE_MEDIA_KINDS.has(req.body.kind) && !resolveImageInputPath(req.body.mediaKey)) {
    throw new ServerError(`Media key "${req.body.mediaKey}" not found in the media library`, { status: 422 });
  }
  const media = await catalogDB.attachMedia(req.params.id, req.body.mediaKey, req.body.kind, {
    role: req.body.role ?? null,
    caption: req.body.caption ?? null,
  });
  res.status(201).json(media);
}));

router.post('/ingredients/:id/media/portrait', asyncHandler(async (req, res) => {
  validateRequest(catalogPortraitSetSchema, req.body);
  const ing = await catalogDB.getIngredient(req.params.id);
  if (!ing) throw new ServerError('Ingredient not found', { status: 404 });
  if (!resolveImageInputPath(req.body.mediaKey)) {
    throw new ServerError(`Media key "${req.body.mediaKey}" not found in the media library`, { status: 422 });
  }
  const media = await catalogDB.setPortraitMedia(req.params.id, req.body.mediaKey, {
    role: req.body.role ?? null,
    caption: req.body.caption ?? null,
  });
  res.status(201).json(media);
}));

router.delete('/ingredients/:id/media', asyncHandler(async (req, res) => {
  validateRequest(catalogMediaDetachSchema, req.body);
  await catalogDB.detachMedia(req.params.id, req.body.mediaKey, req.body.kind);
  res.status(204).end();
}));

// Bulk-create ingredients from a markdown / CSV / JSON dump — no LLM round
// trip, unlike the scrap → extract → commit path. The whole batch commits
// or rolls back together so a malformed entry can't leave the catalog
// half-populated.
router.post('/bulk-import', asyncHandler(async (req, res) => {
  validateRequest(catalogBulkImportSchema, req.body);
  const { format, payload, defaults = {} } = req.body;

  // Parse → normalize → per-entry Zod validate BEFORE we open a transaction.
  // Reject the whole batch on any invalid entry; report the first failure
  // with its index so the user can fix the source file.
  let parsed;
  try {
    parsed = parseBulkPayload(format, payload);
  } catch (err) {
    throw new ServerError(`Bulk import parse failed: ${err.message}`, { status: 400 });
  }

  const defaultTags = Array.isArray(defaults.tags) ? defaults.tags : [];
  // Per-row role from an export bundle (`roleForExportedRef`) rides as a
  // non-enumerable field on each parsed entry; capture it alongside the
  // Zod-validated shape so we can stamp each ref link with its original role.
  const entries = [];
  const perRowRoles = [];
  // Round-tripped scraps (markdown `### Scraps`) ride as a non-enumerable
  // `entry.scraps` sibling — captured here alongside the Zod-validated shape so
  // they can be persisted as catalog_scraps rows in the same transaction below.
  const perRowScraps = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    // Merge default tags onto each row (dedup), then validate the full
    // per-row shape against the same schema the single-create endpoint uses.
    const mergedTags = Array.from(new Set([...(entry.tags || []), ...defaultTags]));
    const result = catalogIngredientCreateSchema.safeParse({ ...entry, tags: mergedTags });
    if (!result.success) {
      const msg = result.error.issues?.[0]?.message || result.error.message;
      throw new ServerError(`Bulk import entry ${i} invalid: ${msg}`, { status: 400 });
    }
    entries.push(result.data);
    perRowRoles.push(typeof entry.roleForExportedRef === 'string' ? entry.roleForExportedRef : null);
    perRowScraps.push(Array.isArray(entry.scraps) ? entry.scraps : []);
  }

  // Optional ref-links: same shape as the /link route, applied once per
  // created ingredient inside the same transaction. Explicit `defaults.*Ref`
  // overrides win; when none are supplied but the payload was an export
  // bundle, fall back to the bundle's own `ref` so a re-imported slice keeps
  // its slice membership (otherwise the import is invisible to
  // listIngredientsForRef and to future slice exports).
  const REF_FIELD_TO_KIND = { universeRef: 'universe', seriesRef: 'series', issueRef: 'issue', workRef: 'work' };
  const refTargets = [];
  for (const [field, kind] of Object.entries(REF_FIELD_TO_KIND)) {
    if (defaults[field]) refTargets.push({ refKind: kind, refId: defaults[field] });
  }
  // Validate the bundle's own ref against the same allow-list + id cap the
  // /link route enforces (z.enum(REF_KINDS), refId max 120), so a hand-edited
  // or foreign export bundle can't insert a dead ref row whose kind no
  // listIngredientsForRef ever reads.
  if (refTargets.length === 0 && parsed.bundleRef
      && REF_KINDS.includes(parsed.bundleRef.kind)
      && String(parsed.bundleRef.id).length > 0
      && String(parsed.bundleRef.id).length <= 120) {
    refTargets.push({ refKind: parsed.bundleRef.kind, refId: parsed.bundleRef.id });
  }

  // Embed every entry in parallel BEFORE the transaction — matches the
  // scrap-commit path (line 100). Network round-trips dominate; keeping
  // them outside the DB transaction means a slow embed provider can't
  // hold a Postgres write lock open. Failed embeds land as null `embedding`
  // and the embeddings/backfill endpoint can fill them in later.
  const seeds = entries.map((e) => ingredientEmbedSeed(e));
  const embeds = await embedBatch(seeds);

  let scrapsCreated = 0;
  const created = await withTransaction(async (client) => {
    const out = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const e = embeds[i];
      const ing = await catalogDB.createIngredient({
        type: entry.type,
        name: entry.name,
        payload: entry.payload || {},
        tags: entry.tags || [],
        embedding: e?.embedding ?? null,
        embeddingModel: e?.model ?? null,
      }, { client });
      // Stamp ref links inside the same transaction so a mid-batch failure
      // rolls back the link rows alongside their ingredients. Role precedence:
      // explicit `defaults.role` > the bundle row's own `roleForExportedRef` >
      // a `bulk-<kind>` fallback.
      for (const target of refTargets) {
        // perRowRoles[i] rides as non-enumerable (un-Zod'd) metadata, so cap it
        // to the /link schema's 64-char limit — a foreign bundle's oversized
        // role would otherwise hit the role VARCHAR(64) constraint and surface
        // as a 500 mid-transaction instead of a clean bulk-import rejection.
        const role = (defaults.role || perRowRoles[i] || `bulk-${target.refKind}`).slice(0, 64);
        await client.query(
          `INSERT INTO catalog_ingredient_refs (ingredient_id, ref_kind, ref_id, role)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (ingredient_id, ref_kind, ref_id, role) DO UPDATE
             SET deleted = false, deleted_at = NULL`,
          [ing.id, target.refKind, target.refId, role],
        );
      }
      // Persist any round-tripped scraps as catalog_scraps rows + source links
      // in the same transaction, so they roll back with the ingredient on a
      // mid-batch failure. Only markdown imports carry scraps today; JSON/CSV
      // rows have an empty list. No embedding is generated for an imported scrap
      // (the ingredient already carries the searchable embedding) — the scrap is
      // provenance, not a separate search target.
      for (const s of perRowScraps[i]) {
        if (!s || typeof s.rawText !== 'string' || !s.rawText.trim()) continue;
        const scrap = await catalogDB.createScrap({
          rawText: s.rawText,
          sourceKind: (typeof s.sourceKind === 'string' && s.sourceKind.trim() ? s.sourceKind.trim() : 'import').slice(0, 32),
          metadata: { importedVia: 'bulk-import', format },
        }, { client });
        await catalogDB.linkIngredientToSource(ing.id, scrap.id, null, { client });
        scrapsCreated++;
      }
      out.push({ id: ing.id, type: ing.type, name: ing.name });
    }
    return out;
  });

  // Parser warnings (today: unrecognized markdown type headings) ride
  // back on the response so the user notices typos like `## Plce: …`.
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  console.log(`📥 Catalog bulk import: ${format} → ${created.length} ingredient(s)${scrapsCreated ? `, ${scrapsCreated} scrap(s)` : ''}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
  res.status(201).json({ created, count: created.length, scrapsCreated, warnings });
}));

// Export one ref slice (universe/series/issue/work) as a portable bundle.
// JSON is the canonical round-trip format; markdown + YAML are convenience
// outputs. Each ingredient carries its `media` attachments (media-key
// references, not bytes — the importer matches keys against its own library).
// Relations are still absent (their table predates a portable shape); when
// they ship the export helper will include them without a payload-shape break
// (the consumer treats unknown keys as passthrough).
router.get('/export', asyncHandler(async (req, res) => {
  const params = validateRequest(catalogExportQuerySchema, req.query);
  const format = params.format || 'json';
  const bundle = await catalogDB.exportSliceForRef(params.refKind, params.refId);
  const baseName = `catalog-${params.refKind}-${params.refId}`.replace(/[^A-Za-z0-9._-]+/g, '_');
  if (format === 'markdown') {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.md"`);
    res.send(bundleToMarkdown(bundle));
    return;
  }
  if (format === 'yaml') {
    res.setHeader('Content-Type', 'application/yaml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.yaml"`);
    res.send(toYamlString(bundle));
    return;
  }
  // json (default)
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${baseName}.json"`);
  res.send(JSON.stringify(bundle, null, 2));
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

// --- User-defined ingredient types --------------------------------------
// User types live in PostgreSQL (`catalog_user_types`, #1001 — formerly the
// settings.json `catalogUserTypes` slice) and merge into the active type
// registry. These routes are the CRUD surface the Settings → Catalog tab
// drives. Every mutating route persists through the catalogUserTypes store AND
// calls `setUserCatalogTypes` so the in-process registry refreshes without a
// restart. The GET returns the FULL active registry (system + user) normalized
// for the client merge, with each entry's `system` flag.

// Read the persisted user-type slice as a plain array (tolerates absent/junk).
const readUserTypes = async () => {
  const list = await readUserTypeSlice();
  return Array.isArray(list) ? list : [];
};

router.get('/types', asyncHandler(async (req, res) => {
  // Active registry (system first, then user). Each entry already carries
  // `system`, `label`, `primaryContentKey`, `snippetFallbackKeys`, and (for
  // user types) the `fields` list the generic editor renders.
  res.json({ types: getActiveCatalogTypes() });
}));

// Strip any client-supplied sync-control fields and stamp a fresh server-side
// `updatedAt` — the LWW federation merge relies on this timestamp being set by
// the writer, never trusted from the client. Clears any tombstone so a write
// always revives (an edit newer than a delete wins).
const stampUserType = (body) => {
  const { deletedAt: _d, updatedAt: _u, ...rest } = body;
  return { ...rest, updatedAt: new Date().toISOString(), deletedAt: null };
};

router.post('/types', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogUserTypeSchema, req.body);
  const current = await readUserTypes();
  // A LIVE type with this id already exists → conflict. A tombstoned id (or a
  // fresh id) is fine: POST revives the tombstone / creates anew, replacing the
  // slot in place so the unique-id invariant holds.
  const idx = current.findIndex((t) => t.id === body.id);
  if (idx !== -1 && !current[idx].deletedAt) {
    throw new ServerError(`Catalog type "${body.id}" already exists`, { status: 409 });
  }
  const stamped = stampUserType(body);
  const next = idx === -1
    ? [...current, stamped]
    : current.map((t, i) => (i === idx ? stamped : t));
  // Validate the whole slice (unique-id + system-collision refinements) before
  // persisting — a system-id collision (e.g. "character") is rejected here.
  validateRequest(catalogUserTypesSettingsSchema, next);
  await writeUserTypes(next);
  setUserCatalogTypes(next);
  console.log(`🧩 Catalog: added user type "${body.id}"`);
  res.status(201).json({ types: getActiveCatalogTypes() });
}));

router.patch('/types/:id', asyncHandler(async (req, res) => {
  // Merge the path id onto the body so a partial PATCH still validates as a
  // full user-type (id is immutable — the path wins over any body id).
  const merged = validateRequest(catalogUserTypeSchema, { ...req.body, id: req.params.id });
  const current = await readUserTypes();
  // Editing a tombstoned (deleted) type is a 404 — it must be re-created via POST.
  const idx = current.findIndex((t) => t.id === req.params.id && !t.deletedAt);
  if (idx === -1) throw new ServerError(`Catalog type "${req.params.id}" not found`, { status: 404 });
  const next = [...current];
  next[idx] = stampUserType(merged);
  validateRequest(catalogUserTypesSettingsSchema, next);
  await writeUserTypes(next);
  setUserCatalogTypes(next);
  console.log(`🧩 Catalog: updated user type "${req.params.id}"`);
  res.json({ types: getActiveCatalogTypes() });
}));

router.delete('/types/:id', asyncHandler(async (req, res) => {
  const current = await readUserTypes();
  const idx = current.findIndex((t) => t.id === req.params.id && !t.deletedAt);
  if (idx === -1) throw new ServerError(`Catalog type "${req.params.id}" not found`, { status: 404 });
  // Refuse to delete a type that still has ingredients of that type unless the
  // caller explicitly forces it (`?force=true`) — otherwise those rows become
  // orphaned (their `type` no longer resolves in the active registry, so the
  // detail page falls back to the generic 'idea' editor and the type filter
  // drops them). force=true deletes the definition anyway; the rows survive
  // and just render under the fallback editor.
  const force = req.query.force === 'true';
  if (!force) {
    const { items } = await catalogDB.listIngredients({ type: req.params.id, limit: 1 });
    if (items.length > 0) {
      throw new ServerError(
        `Catalog type "${req.params.id}" has ingredients — pass ?force=true to delete it anyway`,
        { status: 409, code: 'CATALOG_TYPE_IN_USE' },
      );
    }
  }
  // Soft-delete: KEEP the entry with a `deletedAt` tombstone (and a fresh
  // `updatedAt`) so the deletion federates to peers via the catalogTypes sync
  // block. A physical removal would let a peer that still has the definition
  // resurrect it on the next pull. setUserCatalogTypes filters tombstones out
  // of the active registry, so the type disappears from the UI immediately.
  const deletedAt = new Date().toISOString();
  const next = current.map((t, i) => (
    i === idx ? { ...t, deletedAt, updatedAt: deletedAt } : t
  ));
  validateRequest(catalogUserTypesSettingsSchema, next);
  await writeUserTypes(next);
  setUserCatalogTypes(next);
  console.log(`🧩 Catalog: deleted user type "${req.params.id}"${force ? ' (forced)' : ''}`);
  res.json({ types: getActiveCatalogTypes() });
}));

export default router;

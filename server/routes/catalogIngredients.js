/** Query, edit, link and merge catalog ingredients and maintain their embeddings. */

import { getCatalogIdentityAccess } from '../services/catalogDB/identityAccess.js';
import { Router } from 'express';
import * as catalogDB from '../services/catalog/catalogDB.js';
import { catalogEvents } from '../services/catalog/catalogEvents.js';
import { resolveRefs } from '../services/catalog/catalogRefResolver.js';
import { projectToCanon } from '../services/catalog/catalogCanonProjection.js';
import { withTransaction } from '../lib/db.js';
import { changedMusicVideoDescriptionOverLimit, MUSIC_VIDEO_SUBJECT_DESCRIPTION_MAX } from '../lib/musicVideo/musicVideoSubjectLimits.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  catalogIngredientCreateRouteSchema, catalogIngredientPatchSchema, catalogIngredientLinkSchema,
  catalogRelationLinkSchema, catalogIngredientQuerySchema, catalogIngredientDetailQuerySchema,
  catalogIngredientCardsQuerySchema, catalogIngredientLockSchema, catalogTagQuerySchema,
  catalogEmbeddingsBackfillSchema, catalogRevisionQuerySchema, catalogRelatedImagesQuerySchema,
  catalogRevisionRestoreSchema, catalogBatchMediaQuerySchema, catalogMergeSchema,
  catalogMergeHistoryQuerySchema, catalogMergeRecoverSchema, catalogIncludeEmbeddingQuerySchema,
} from '../lib/catalog/catalogValidation.js';
import { resolveImageInputPath } from '../lib/fileUtils.js';
import { embedIngredient, embedBatch, ingredientEmbedSeed, getEmbeddingsConfig } from '../services/embeddings.js';
import { MAX_CAST_GUIDES } from '../lib/catalog/catalogMediaLibrary.js';
import { catalogFamilyRenderContext, familyImagesAddition } from '../services/catalog/catalogFamily.js';
import { resolveGalleryImage } from '../lib/pathSafety.js';
import {
  getPrimitiveContext, createOwnedPrimitive, withUserCreatedLock, addPrimitiveToUniverse,
  removePrimitiveFromUniverse,
} from '../services/catalog/catalogPrimitives.js';

const router = Router();

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
    scrapId: params.scrapId,
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

router.get('/ingredient-cards', asyncHandler(async (req, res) => {
  const { ids } = validateRequest(catalogIngredientCardsQuerySchema, req.query);
  res.json({ items: await catalogDB.getIngredientCards(ids) });
}));

router.patch('/ingredients/:id/lock', asyncHandler(async (req, res) => {
  const { locked } = validateRequest(catalogIngredientLockSchema, req.body);
  const updated = await catalogDB.setIngredientLock(req.params.id, locked);
  if (!updated) throw new ServerError('Ingredient not found', { status: 404 });
  await projectToCanon(updated.id, updated);
  catalogEvents.emit('primitive-changed', { ingredientId: updated.id });
  res.json(updated);
}));

// One request for the media of N ingredients ({ [id]: media[] }); registered before /:id so "media" is not read as an id.
router.get('/ingredients/media', asyncHandler(async (req, res) => {
  const { ids } = validateRequest(catalogBatchMediaQuerySchema, req.query);
  const byId = await catalogDB.listMediaForIngredients(ids);
  res.json(Object.fromEntries(ids.map((id) => [id, byId.get(id) ?? []])));
}));

router.get('/ingredients/:id', asyncHandler(async (req, res) => {
  const { includeEmbedding: includeEmbeddingRaw } = validateRequest(catalogIncludeEmbeddingQuerySchema, req.query);
  const ing = await catalogDB.getIngredient(req.params.id);
  if (!ing) throw new ServerError('Ingredient not found', { status: 404 });
  const [refs, sources] = await Promise.all([
    catalogDB.listRefsForIngredient(req.params.id),
    catalogDB.listSourcesForIngredient(req.params.id),
  ]);
  // Detail UI doesn't render the 768-float embedding (~6KB stringified).
  // Strip unless `?includeEmbedding=true` — sync/export consumers can opt in.
  const includeEmbedding = includeEmbeddingRaw === 'true';
  const { embedding, ...rest } = ing;
  res.json({
    ...(includeEmbedding ? { ...rest, embedding } : rest),
    refs,
    sources,
  });
}));

// Full detail remains the compatibility default. Profile and media projections
// let library editors render before history, images and prose usage are read.
router.get('/ingredients/:id/details', asyncHandler(async (req, res) => {
  const projection = validateRequest(catalogIngredientDetailQuerySchema, req.query);
  const ing = await catalogDB.getIngredient(req.params.id);
  if (!ing) throw new ServerError('Ingredient not found', { status: 404 });
  if (projection.view === 'media') {
    const media = await catalogDB.listMediaForIngredient(req.params.id);
    return res.json({ media, missingMedia: await catalogDB.getMissingMediaForIngredient(req.params.id, { media }) });
  }
  const full = projection.view === 'full';
  const [context, sources, relations, revisions, media, sharedIdentity, coverMedia] = await Promise.all([
    getPrimitiveContext(req.params.id, { includeDerived: full }),
    catalogDB.listSourcesForIngredient(req.params.id),
    catalogDB.listRelationsForIngredient(req.params.id),
    full ? catalogDB.listIngredientRevisions(req.params.id, { limit: 50 }) : null,
    full ? catalogDB.listMediaForIngredient(req.params.id) : null,
    getCatalogIdentityAccess(req.params.id),
    full ? null : catalogDB.getIngredientMediaCover(req.params.id),
  ]);
  const siblingsByScrap = await catalogDB.listSiblingIngredientsBySource(req.params.id, sources.map((source) => source.scrapId));
  const sourcesWithSiblings = sources.map((source) => ({ ...source, siblings: siblingsByScrap.get(source.scrapId) || [] }));
  const { embedding, ...rest } = ing;
  res.json({
    ingredient: projection.includeEmbedding === 'true' ? { ...rest, embedding } : rest,
    sharedIdentity, refs: context.refs, universeContext: context,
    sources: sourcesWithSiblings, relations,
    ...(!full ? { coverMedia } : {}),
    ...(full ? { revisions: Array.isArray(revisions?.items) ? revisions.items : [], media,
      missingMedia: await catalogDB.getMissingMediaForIngredient(req.params.id, { media }) } : {}),
  });
}));

// Lazy, bounded provenance lookup for the detail page's References tab.
router.get('/ingredients/:id/related-images', asyncHandler(async (req, res) => {
  const pagination = validateRequest(catalogRelatedImagesQuerySchema, req.query);
  const ingredient = await catalogDB.getIngredient(req.params.id);
  if (!ingredient) throw new ServerError('Ingredient not found', { status: 404 });
  const media = await catalogDB.listMediaForIngredient(ingredient.id);
  const { listRelatedImages } = await import('../services/catalog/catalogRelatedImages.js');
  res.json(await listRelatedImages(ingredient, media, pagination));
}));

// Merge is preview-first and never unlocks either record.
router.post('/ingredients/merge', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogMergeSchema, req.body);
  const { mergeIngredients } = await import('../services/catalogDB/merge.js');
  res.json(await mergeIngredients(body));
}));

router.get('/ingredients/:id/merge-history', asyncHandler(async (req, res) => {
  const params = validateRequest(catalogMergeHistoryQuerySchema, req.query);
  const { getIngredientMergeHistory } = await import('../services/catalogDB/merge.js');
  res.json(await getIngredientMergeHistory(req.params.id, params));
}));

router.get('/ingredient-merges/:id', asyncHandler(async (req, res) => {
  const { getIngredientMergeReceipt } = await import('../services/catalogDB/merge.js');
  res.json(await getIngredientMergeReceipt(req.params.id));
}));

router.post('/ingredient-merges/:id/recover', asyncHandler(async (req, res) => {
  validateRequest(catalogMergeRecoverSchema, req.body ?? {});
  const { recoverIngredientMerge } = await import('../services/catalogDB/merge.js');
  res.json(await recoverIngredientMerge(req.params.id));

}));

router.post('/ingredients', asyncHandler(async (req, res) => {
  const { relations = [], ...body } = validateRequest(catalogIngredientCreateRouteSchema, req.body);
  // Preserve the missing-relative response before embedding or writing.
  const relatives = await Promise.all(relations.map((r) => catalogDB.getIngredient(r.toId)));
  if (relatives.some((r) => !r || r.deleted)) throw new ServerError('A related record no longer exists', { status: 404, code: 'NOT_FOUND' });
  const input = {
    type: body.type,
    name: body.name,
    payload: body.payload || {},
    tags: body.tags || [],
    ...(await embedIngredient(body)),
  };
  let ing;
  if (body.universeId) {
    ing = await createOwnedPrimitive(input, body.universeId, body.operationKey, relations);
  } else if (relations.length) {
    ing = await withTransaction(async (client) => {
      const ingredient = await catalogDB.createIngredient(withUserCreatedLock(input), { client });
      for (const { toId, kind } of relations) await catalogDB.linkIngredientRelation(ingredient.id, toId, kind, { client });
      return ingredient;
    });
  } else {
    ing = await catalogDB.createIngredient(withUserCreatedLock(input));
  }
  res.status(201).json(ing);
  catalogEvents.emit('primitive-changed', { ingredientId: ing.id });
}));

router.patch('/ingredients/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogIngredientPatchSchema, req.body);
  // `source`/`actor` are revision-history metadata, not ingredient columns —
  // strip them from the DB patch and forward as the revision context instead.
  const { source, actor, ...fieldPatch } = body;
  // Re-embed only when name or payload changes — tag-only edits skip embed.
  let embeddingPatch = {};
  if (fieldPatch.name !== undefined || fieldPatch.payload !== undefined) {
    const current = await catalogDB.getIngredient(req.params.id);
    if (!current) throw new ServerError('Ingredient not found', { status: 404 });
    if (fieldPatch.payload !== undefined && ['character', 'place', 'object'].includes(current.type)) {
      const violation = changedMusicVideoDescriptionOverLimit(current.type, current.payload, fieldPatch.payload);
      if (violation && (await catalogDB.listRefsForIngredient(req.params.id)).some((ref) => ref.refKind === 'music-video')) {
        throw new ServerError(`A description used by a music video holds at most ${MUSIC_VIDEO_SUBJECT_DESCRIPTION_MAX.toLocaleString('en-US')} characters; this one has ${violation.length.toLocaleString('en-US')}. Shorten it before saving.`, { status: 400, code: 'DESCRIPTION_TOO_LONG' });
      }
    }
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
  catalogEvents.emit('primitive-changed', { ingredientId: updated.id });
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
  const identityIds = await catalogDB.getIngredientIdentityIds(req.params.id);
  if (!revision || !identityIds.includes(revision.ingredientId)) {
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
  catalogEvents.emit('primitive-changed', { ingredientId: updated.id });
  // A restore changes the same mirrored name/payload fields as an ordinary
  // PATCH, so refresh every linked universe after the Catalog write succeeds.
  // Keep this best-effort and post-response: the restore is already durable,
  // and a failed universe cache update must not turn it into a failed request
  // or escape as an unhandled rejection.
  projectToCanon(req.params.id, updated).catch((err) => {
    console.error(`🔁 catalog→canon projection failed for ${req.params.id}: ${err.message}`);
  });
}));

router.delete('/ingredients/:id', asyncHandler(async (req, res) => {
  const refs = await catalogDB.listRefsForIngredient(req.params.id);
  const targets = await resolveRefs(refs);
  // Resolution describes targets only. Keep the association's role for the
  // ownership exemption rather than discarding it with the bounded projection.
  if (refs.some((ref, index) => targets[index]?.resolved && !(ref.refKind === 'universe' && ref.role === 'owner'))) {
    throw new ServerError('Remove this primitive from its containers before deleting it. Ownership and media can be kept.', { status: 409, code: 'CATALOG_PRIMITIVE_IN_USE' });
  }
  await catalogDB.deleteIngredient(req.params.id);
  res.status(204).end();
}));

router.post('/ingredients/:id/link', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogIngredientLinkSchema, req.body);
  if (body.refKind === 'universe') {
    if (body.role === 'owner') throw new ServerError('Use the explicit ownership action', { status: 409 });
    res.status(201).json(await addPrimitiveToUniverse(req.params.id, body.refId, body.role));
    return;
  }
  await catalogDB.linkIngredientToRef(req.params.id, body.refKind, body.refId, body.role);
  res.status(201).json({ success: true });
}));

router.delete('/ingredients/:id/link', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogIngredientLinkSchema, req.body);
  if (body.refKind === 'universe' && body.role === 'owner') throw new ServerError('Ownership is separate from container membership', { status: 409 });
  if (body.refKind === 'universe' && body.role.startsWith('canon-')) {
    await removePrimitiveFromUniverse(req.params.id, body.refId, body.role);
    res.status(204).end();
    return;
  }
  await catalogDB.unlinkIngredientFromRef(req.params.id, body.refKind, body.refId, body.role);
  res.status(204).end();
}));

router.get('/refs/:refKind/:refId/ingredients', asyncHandler(async (req, res) => {
  res.json(await catalogDB.listIngredientsForRef(req.params.refKind, req.params.refId));
}));

// --- Ingredient↔ingredient relations -----------------------------------

// What a character's family adds to an image render: one labeled addition per
// relative plus each relative's top canonical image (see catalogFamily.js).
router.get('/ingredients/:id/family-context', asyncHandler(async (req, res) => {
  const ing = await catalogDB.getIngredient(req.params.id);
  if (!ing) throw new ServerError('Ingredient not found', { status: 404 });
  if (ing.type !== 'character') return res.json({ additions: [], images: [], imagesAddition: null });
  const { additions, candidates } = await catalogFamilyRenderContext(ing.id, ing.name);
  // Same resolution the generate route applies to named references, so a pick
  // here can never fail that render as missing.
  const images = candidates.filter(({ filename }) => resolveGalleryImage(filename) || resolveImageInputPath(filename))
    .slice(0, MAX_CAST_GUIDES).map(({ filename, source, relative }) => ({ filename, source, relative }));
  res.json({ additions, images, imagesAddition: familyImagesAddition(ing.name, images.map((image) => image.relative)) });
}));

router.get('/ingredients/:id/relations', asyncHandler(async (req, res) => {
  const ing = await catalogDB.getIngredient(req.params.id);
  if (!ing) throw new ServerError('Ingredient not found', { status: 404 });
  res.json(await catalogDB.listRelationsForIngredient(req.params.id));
}));

router.post('/ingredients/:id/relations', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogRelationLinkSchema, req.body);
  if (req.params.id === body.toId) {
    throw new ServerError('Cannot relate an ingredient to itself', { status: 400 });
  }
  // Both ends must exist — FK would reject anyway, but a 404 reads cleaner
  // than a raw FK violation and matches the link route's failure surface.
  const [from, to] = await Promise.all([
    catalogDB.getIngredient(req.params.id),
    catalogDB.getIngredient(body.toId),
  ]);
  if (!from) throw new ServerError('Ingredient not found', { status: 404 });
  if (!to) throw new ServerError('Related ingredient not found', { status: 404 });
  await catalogDB.linkIngredientRelation(req.params.id, body.toId, body.kind);
  res.status(201).json({ success: true });
}));

router.delete('/ingredients/:id/relations', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogRelationLinkSchema, req.body);
  await catalogDB.unlinkIngredientRelation(req.params.id, body.toId, body.kind);
  res.status(204).end();
}));

router.post('/embeddings/backfill', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogEmbeddingsBackfillSchema, req.body || {});
  const limit = body.limit ?? 50;

  // A disabled provider makes embedBatch skip every row; refuse up front so the
  // caller sees an actionable error instead of `failed: N`.
  const cfg = await getEmbeddingsConfig();
  if (cfg.provider === 'none') {
    throw new ServerError('Embeddings are disabled. Choose a provider in Settings → Embeddings before backfilling.', {
      status: 400,
      code: 'EMBEDDINGS_DISABLED',
    });
  }

  // When `includeStale` is true, also re-embed rows whose stored
  // embedding_model differs from the current settings model — catches the
  // "user switched provider/model and old vectors are in the wrong space"
  // case. Resolved server-side so the client doesn't have to know the
  // current settings.
  const staleModel = body.includeStale === true ? (cfg.model || null) : null;

  const { items: todo } = await catalogDB.listIngredients({
    limit,
    offset: 0,
    embeddingMissing: !staleModel,
    staleEmbeddingModel: staleModel,
    skipDecorations: true,
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

export default router;

/** Ingest scraps and catalog bundles, export reference slices and import music-video cast. */

import { Router } from 'express';
import { isDeepStrictEqual } from 'node:util';
import * as catalogDB from '../services/catalog/catalogDB.js';
import { withTransaction } from '../lib/db.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  catalogScrapCreateSchema, catalogScrapCommitSchema, catalogExtractRequestSchema,
  catalogPruneRequestSchema, catalogMigrationRerunSchema, catalogMusicVideoImportSchema,
  catalogBulkImportSchema, catalogBulkEntrySchema, catalogExportQuerySchema,
  catalogUrlIngestSchema, catalogFileIngestSchema, catalogVoiceIngestSchema,
  catalogBrainIngestSchema, REF_KINDS,
} from '../lib/catalog/catalogValidation.js';
import { paginationQuerySchema, parsePagination } from '../lib/queryValidation.js';
import { parseBulkPayload, bundleToMarkdown, toYamlString } from '../lib/catalog/catalogBulkParsers.js';
import { embedBatch, ingredientEmbedSeed } from '../services/embeddings.js';
import { extractIngredientsForScrap } from '../services/catalog/catalogExtraction.js';
import { ingestFromUrl, ingestFromFile, ingestFromVoice, ingestFromBrain } from '../services/catalog/catalogIngestSources.js';
import { migrateBibleToCatalog } from '../scripts/migrateBibleToCatalog.js';
import { previewCatalogCastImport, commitCatalogCastImport } from '../services/musicVideo/catalogCast.js';

const router = Router();

router.get('/scraps', asyncHandler(async (req, res) => {
  const { limit, offset } = parsePagination(validateRequest(paginationQuerySchema, req.query), { defaultLimit: 50, maxLimit: 200 });
  res.json(await catalogDB.listScraps({ limit, offset }));
}));

router.post('/scraps', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogScrapCreateSchema, req.body);
  // Scrap embedding was previously generated on create but never read — there is no
  // semantic-search route or "find similar scraps" UI. Removed pending a search endpoint
  // that justifies the LLM round-trip; the catalog_scraps.embedding column remains for
  // future backfill (and peer sync still accepts embeddings from peers that have them).
  // Chunk long pastes into a parent + N child rows (short inputs stay a single
  // row). The response still returns the PARENT scrap, so the client flow is
  // unchanged — extraction (POST /scraps/:id/extract) transparently unions the
  // children.
  const scrap = await catalogDB.createChunkedScrap({
    title: body.title,
    rawText: body.rawText,
    sourceKind: body.sourceKind,
    metadata: body.metadata,
  });
  res.status(201).json({ scrap });
}));

router.post('/scraps/:id/extract', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogExtractRequestSchema, req.body || {});
  const scrap = await catalogDB.getScrap(req.params.id);
  if (!scrap) throw new ServerError('Scrap not found', { status: 404 });
  // Extraction plans from the complete PARENT source against the chosen model.
  // A request against a child row is a client bug — reject rather than extract
  // a single chunk in isolation and silently lose the rest of the corpus.
  if (scrap.parentScrapId) {
    throw new ServerError('extract runs on the parent scrap, not a chunk', { status: 400 });
  }
  const draft = await extractIngredientsForScrap({
    scrapId: scrap.id,
    providerOverride: body.providerOverride,
    modelOverride: body.modelOverride,
  });
  res.json({ scrap, draft });
}));

router.post('/scraps/:id/prune', asyncHandler(async (req, res) => {
  const options = validateRequest(catalogPruneRequestSchema, req.body);
  const scrap = await catalogDB.getScrap(req.params.id);
  if (!scrap) throw new ServerError('Scrap not found', { status: 404 });
  if (scrap.parentScrapId) throw new ServerError('Prune the parent scrap, not a chunk', { status: 400 });
  const { pruneCatalogBabble } = await import('../services/catalog/catalogPrune.js');
  const draft = await pruneCatalogBabble({ rawText: scrap.rawText, ...options });
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
  const body = validateRequest(catalogScrapCommitSchema, req.body);
  const scrap = await catalogDB.getScrap(req.params.id);
  if (!scrap) throw new ServerError('Scrap not found', { status: 404 });

  // Source notes are stamped consumed in THIS request — on a replay too, so a
  // retry that follows a crash between the commit and the stamp heals it. A
  // stamp failure fails the request; the retry (same key) replays the receipt
  // rather than committing again, which is why the commit is safe to leave in
  // place when the stamp below it fails.
  const consumeSourceNotes = async () => {
    if (!body.creativeNoteIds) return;
    const { markInboxSentToCatalog } = await import('../services/brain.js');
    await markInboxSentToCatalog(body.creativeNoteIds);
  };

  if (body.operationKey) {
    const replay = await catalogDB.getScrapCommitReceipt({ ...body, scrapId: scrap.id });
    if (replay) {
      await consumeSourceNotes();
      return res.status(201).json({ scrap, ingredients: replay });
    }
  }

  // Embed all drafts in parallel (concurrency-4 inside embedBatch) before
  // sequentially writing — LLM round-trips dominate, DB inserts don't. Embeds
  // stay OUTSIDE the transaction: they're network round-trips to the provider,
  // not DB writes, and a half-embedded batch is fine (failed embeds just land
  // as null `embedding` on the row, same as today).
  const seeds = body.accepted.map((d) => ingredientEmbedSeed(d));
  const embeds = await embedBatch(seeds);

  const created = await catalogDB.commitScrap({
    scrapId: scrap.id,
    ...(body.operationKey ? { operationKey: body.operationKey } : {}),
    accepted: body.accepted,
    ...(body.relationships !== undefined ? { relationships: body.relationships } : {}),
    embeds,
    universeRef: body.universeRef,
    role: body.role,
  });

  await consumeSourceNotes();
  res.status(201).json({ scrap, ingredients: created });
}));

// Bulk-create ingredients from a markdown / CSV / JSON dump — no LLM round
// trip, unlike the scrap → extract → commit path. The whole batch commits
// or rolls back together so a malformed entry can't leave the catalog
// half-populated.
router.post('/bulk-import', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogBulkImportSchema, req.body);
  const { format, payload, defaults = {} } = body;

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
  // Explicitly validate the non-enumerable JSON/markdown metadata too.
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    // Merge default tags onto each row (dedup), then validate the full
    // per-row shape against the same schema the single-create endpoint uses.
    const mergedTags = Array.from(new Set([...(entry.tags || []), ...defaultTags]));
    const result = catalogBulkEntrySchema.safeParse({
      ...entry, tags: mergedTags, id: entry.id, scraps: entry.scraps, media: entry.media,
    });
    if (!result.success) {
      const msg = result.error.issues?.[0]?.message || result.error.message;
      throw new ServerError(`Bulk import entry ${i} invalid: ${msg}`, { status: 400 });
    }
    entries.push(result.data);
    perRowRoles.push(typeof entry.roleForExportedRef === 'string' ? entry.roleForExportedRef : null);
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

  const ingredientIds = [...new Set(entries.map(entry => entry.id).filter(Boolean))];
  const scrapIds = [...new Set(entries.flatMap(entry =>
    (entry.scraps || []).filter(scrap => scrap.id && scrap.rawText.trim()).map(scrap => scrap.id)))];
  let scrapsCreated = 0;
  const created = await withTransaction(async (client) => {
    // Serialize retries even when their explicit ingredient/scrap IDs do not
    // exist yet. The transaction releases this lock on commit or rollback.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('catalog-bulk-import'))");
    // Only a creator's explicit choice establishes ownership. Export bundle
    // references remain provenance; existing identities retain their owner.
    if (defaults.universeRef) {
      const { rows } = await client.query('SELECT id FROM universes WHERE id = $1 AND deleted = false FOR SHARE', [defaults.universeRef]);
      if (!rows.length) throw new ServerError('Owning universe not found', { status: 404 });
    }
    const ingredients = new Map();
    const mergedIds = new Set();
    const scraps = new Map();
    if (ingredientIds.length) {
      const { rows } = await client.query(
        'SELECT id, type, deleted FROM catalog_ingredients WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE',
        [ingredientIds],
      );
      for (const row of rows) ingredients.set(row.id, row);
      // Read receipts after locking the ingredient rows so a merge that just
      // committed is visible to the new statement's snapshot.
      const merges = await client.query(
        'SELECT source_id FROM catalog_ingredient_merges WHERE source_id = ANY($1::text[]) AND restored_at IS NULL',
        [rows.map(row => row.id)],
      );
      for (const row of merges.rows) mergedIds.add(row.source_id);
    }
    if (scrapIds.length) {
      const { rows } = await client.query(
        `SELECT id, deleted, raw_text AS "rawText", title, source_kind AS "sourceKind", metadata
         FROM catalog_scraps WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
        [scrapIds],
      );
      for (const row of rows) scraps.set(row.id, row);
    }
    const out = [];
    const refLinks = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const e = embeds[i];
      const existing = ingredients.get(entry.id);
      if (mergedIds.has(entry.id)) {
        throw new ServerError('Imported ingredient ID is merged into another record; recover the merge or import the canonical ID', {
          status: 409, code: 'CATALOG_MERGE_CONFLICT',
        });
      }
      if (existing && (existing.deleted || existing.type !== entry.type)) {
        throw new ServerError('Imported ingredient ID is deleted or has a different type', { status: 409 });
      }
      const values = {
        id: entry.id,
        type: entry.type,
        name: entry.name,
        payload: entry.payload || {},
        tags: entry.tags || [],
        embedding: e?.embedding ?? null,
        embeddingModel: e?.model ?? null,
      };
      const ing = existing
        ? await catalogDB.updateIngredient(entry.id, values, { client })
        : await catalogDB.createIngredient(values, { client });
      if (!existing && entry.id) ingredients.set(entry.id, { type: ing.type, deleted: false });
      if (!existing && defaults.universeRef) await catalogDB.linkIngredientToRef(ing.id, 'universe', defaults.universeRef, 'owner', { client });
      for (const media of entry.media || []) {
        await catalogDB.attachMedia(ing.id, media.mediaKey, media.kind, { ...media, client });
      }
      // Stamp ref links inside the same transaction so a mid-batch failure
      // rolls back the link rows alongside their ingredients. Role precedence:
      // explicit `defaults.role` > the bundle row's own `roleForExportedRef` >
      // a `bulk-<kind>` fallback.
      for (const target of refTargets) {
        // perRowRoles[i] rides as non-enumerable (un-Zod'd) metadata, so cap it
        // to the /link schema's 64-char limit — a foreign bundle's oversized
        // role would otherwise hit the role VARCHAR(64) constraint and surface
        // as a 500 mid-transaction instead of a clean bulk-import rejection.
        const importedRole = (defaults.role || perRowRoles[i] || `bulk-${target.refKind}`).slice(0, 64);
        // A portable bundle's old owner is evidence, not a destination choice.
        // Fresh explicit ownership was written above; existing owners survive.
        const role = target.refKind === 'universe' && importedRole === 'owner' ? 'imported-owner' : importedRole;
        refLinks.push({ ingredientId: ing.id, refKind: target.refKind, refId: target.refId, role });
      }
      // Preserve shared scrap identity. ID-less additions to an identified
      // ingredient deduplicate by text/source, so retrying an edited bundle
      // does not create new provenance on each attempt.
      for (const s of entry.scraps || []) {
        if (!s.rawText.trim()) continue;
        const sourceKind = s.sourceKind || 'import';
        const existingScrap = s.id
          ? scraps.get(s.id)
          : entry.id
            ? (await client.query(
              `SELECT s.id, s.deleted, s.raw_text AS "rawText", s.title, s.source_kind AS "sourceKind", s.metadata
               FROM catalog_scraps s
               JOIN catalog_ingredient_sources src ON src.scrap_id = s.id
               WHERE src.ingredient_id = $1 AND s.raw_text = $2
                 AND s.source_kind = $3 AND s.deleted = false LIMIT 1`,
              [ing.id, s.rawText, sourceKind],
            )).rows[0]
            : null;
        if (existingScrap?.deleted) {
          throw new ServerError('Imported scrap ID is deleted', { status: 409 });
        }
        // Scraps can be shared by several ingredients: importing one slice
        // must neither overwrite their provenance nor silently ignore edits.
        if (existingScrap && (
          existingScrap.rawText !== s.rawText
          || (s.title !== undefined && existingScrap.title !== s.title)
          || (s.sourceKind !== undefined && existingScrap.sourceKind !== s.sourceKind)
          || (s.metadata !== undefined && !isDeepStrictEqual(existingScrap.metadata, s.metadata))
        )) {
          throw new ServerError('Imported scrap ID has different content; use a new scrap ID for edited provenance', { status: 409 });
        }
        const scrap = existingScrap || await catalogDB.createScrap({
          ...s, sourceKind,
          metadata: s.metadata || { importedVia: 'bulk-import', format },
        }, { client });
        await catalogDB.linkIngredientToSource(ing.id, scrap.id, null, { client, preserveExisting: true });
        if (!existingScrap) {
          if (s.id) scraps.set(s.id, scrap);
          scrapsCreated++;
        }
      }
      out.push({ id: ing.id, type: ing.type, name: ing.name });
    }
    if (refLinks.length) {
      // A bundle may repeat an explicit ID. PostgreSQL allows each conflict
      // key to be affected only once per INSERT.
      await client.query(
        `INSERT INTO catalog_ingredient_refs (ingredient_id, ref_kind, ref_id, role)
         SELECT DISTINCT ingredient_id, ref_kind, ref_id, role
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS links(ingredient_id, ref_kind, ref_id, role)
         ON CONFLICT (ingredient_id, ref_kind, ref_id, role) DO UPDATE
           SET deleted = false, deleted_at = NULL`,
        [refLinks.map(link => link.ingredientId), refLinks.map(link => link.refKind),
          refLinks.map(link => link.refId), refLinks.map(link => link.role)],
      );
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

// Re-run the bible→catalog backfill. Idempotent by design (entries that have
// already been promoted are skipped; embedded entries that carry a foreign
// ingredient id are reconciled into the local catalog with that explicit id).
// Pass `{ force: true }` to ignore the marker file when troubleshooting a
// stuck install — without force the marker gates the walk and the endpoint
// just reports the prior stats.
router.post('/migration/rerun', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogMigrationRerunSchema, req.body || {});
  const result = await migrateBibleToCatalog({ force: body.force === true });
  res.json(result);
}));

// Music video cast import: every video's cast, sets and props not yet in the
// catalog, each with a proposed create/link (dry run), then the reviewed
// decisions applied. Deterministic ids make a repeated commit a no-op.
router.get('/import/music-videos', asyncHandler(async (req, res) => {
  res.json({ projects: await previewCatalogCastImport() });
}));

router.post('/import/music-videos', asyncHandler(async (req, res) => {
  const { selections } = validateRequest(catalogMusicVideoImportSchema, req.body || {});
  res.json(await commitCatalogCastImport(selections));
}));

export default router;

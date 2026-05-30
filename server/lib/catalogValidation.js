/**
 * Zod validation schemas for the Creative Ingredients Catalog routes.
 *
 * Domain-namespaced (imported as `catalogValidation.X` from the lib barrel)
 * so cross-domain identifier collisions never bite. The route handler in
 * server/routes/catalog.js uses `validateRequest(schema, body)` against these.
 *
 * Payload shapes for character/place/object intentionally accept the
 * server/lib/storyBible.js field set verbatim — backfilled and freshly
 * ingested records produce identical rows on the wire.
 */

import { z } from 'zod';
import { BIBLE_LIMITS } from './storyBible.js';

export const INGREDIENT_TYPES = Object.freeze([
  'character',
  'place',
  'object',
  'idea',
  'scene',
  'concept',
]);

export const REF_KINDS = Object.freeze([
  'universe',
  'series',
  'issue',
  'work',
  'creative-director',
]);

const tag = z.string().trim().min(1).max(BIBLE_LIMITS.TAG_MAX);
const tags = z.array(tag).max(BIBLE_LIMITS.TAGS_PER_ENTRY_MAX).optional();

// `payload` is a JSONB blob — the route accepts arbitrary content because the
// six ingredient types have very different shapes. We cap the round-tripped
// size at the JSON.stringify length to keep a single user accident from
// landing a 50-MB blob in the catalog. The extraction service is responsible
// for shape correctness; the schema only enforces the boundary.
const payload = z.record(z.string(), z.unknown())
  .refine((p) => JSON.stringify(p).length <= 200_000, {
    message: 'payload exceeds 200KB JSON size cap',
  })
  .optional();

export const catalogScrapCreateSchema = z.object({
  title: z.string().trim().max(300).optional().nullable(),
  rawText: z.string().min(1).max(2_000_000),
  sourceKind: z.enum(['paste', 'brain-bridge', 'importer-handoff', 'manual']).optional(),
  metadata: payload,
}).strict();

export const catalogScrapPatchSchema = catalogScrapCreateSchema.partial();

export const catalogIngredientCreateSchema = z.object({
  type: z.enum(INGREDIENT_TYPES),
  name: z.string().trim().min(1).max(BIBLE_LIMITS.NAME_MAX),
  payload,
  tags,
}).strict();

export const catalogIngredientPatchSchema = z.object({
  name: z.string().trim().min(1).max(BIBLE_LIMITS.NAME_MAX).optional(),
  payload,
  tags,
}).strict();

export const catalogIngredientQuerySchema = z.object({
  type: z.enum(INGREDIENT_TYPES).optional(),
  tag: tag.optional(),
  q: z.string().trim().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
}).strict();

export const catalogIngredientLinkSchema = z.object({
  refKind: z.enum(REF_KINDS),
  refId: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(64),
}).strict();

export const catalogScrapCommitSchema = z.object({
  accepted: z.array(catalogIngredientCreateSchema.extend({
    // Optional source-span hint (server forwards as-is to linkIngredientToSource).
    span: z.record(z.string(), z.unknown()).optional(),
  })).min(0).max(200),
}).strict();

// /scraps/:id/extract — optional provider override (e.g., force a specific
// LLM provider for this extraction). Empty body is valid.
export const catalogExtractRequestSchema = z.object({
  providerOverride: z.string().trim().min(1).max(64).optional(),
}).strict();

// /embeddings/backfill — re-embed up to `limit` rows. By default only fills
// rows where embedding IS NULL; pass `includeStale: true` to also re-embed
// rows whose stored `embedding_model` differs from the current settings
// model (used after a provider/model switch to refresh the vector space).
export const catalogEmbeddingsBackfillSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  includeStale: z.boolean().optional(),
}).strict();

// /migration/rerun — pass `force: true` to ignore the marker file.
export const catalogMigrationRerunSchema = z.object({
  force: z.boolean().optional(),
}).strict();

// Sync envelope shape — used by POST /api/catalog/sync/apply when a peer
// forwards changes pulled from another instance. Each kind is optional so
// callers can apply a partial envelope (e.g. ingredients-only).
//
// Read-path caps MIRROR the create-path caps above: rawText 2MB, payload
// 200KB JSON-stringified, name ≤ NAME_MAX, tags count/length. The create
// path can't be the only line of defense — a peer running an older / forked
// PortOS that skipped its own validation could otherwise push an unbounded
// blob through here. The receiver enforces its own size contract.
const isoDate = z.string().min(1);
const syncEmbedding = z.array(z.number()).max(4096).optional().nullable();
const syncPayload = z.unknown().optional().refine(
  (p) => p === undefined || p === null || (typeof p === 'object' && JSON.stringify(p).length <= 200_000),
  { message: 'payload exceeds 200KB JSON size cap' },
);
const syncMetadata = syncPayload;
const syncTags = z.array(z.string().max(BIBLE_LIMITS.TAG_MAX))
  .max(BIBLE_LIMITS.TAGS_PER_ENTRY_MAX)
  .optional();

export const catalogSyncScrapSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().max(300).nullable().optional(),
  rawText: z.string().max(2_000_000),
  sourceKind: z.string().max(32).optional(),
  metadata: syncMetadata,
  embedding: syncEmbedding,
  embeddingModel: z.string().max(100).nullable().optional(),
  originInstanceId: z.string().max(64).nullable().optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
  deleted: z.boolean().optional(),
  deletedAt: z.string().nullable().optional(),
  syncSequence: z.string().optional(),
}).passthrough();

export const catalogSyncIngredientSchema = z.object({
  id: z.string().min(1).max(80),
  type: z.enum(INGREDIENT_TYPES),
  name: z.string().max(BIBLE_LIMITS.NAME_MAX),
  payload: syncPayload,
  tags: syncTags,
  embedding: syncEmbedding,
  embeddingModel: z.string().max(100).nullable().optional(),
  originInstanceId: z.string().max(64).nullable().optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
  deleted: z.boolean().optional(),
  deletedAt: z.string().nullable().optional(),
  syncSequence: z.string().optional(),
}).passthrough();

export const catalogSyncSourceSchema = z.object({
  ingredientId: z.string().max(80),
  scrapId: z.string().max(80),
  // span shape isn't strictly typed (`{ start, end }` today, may grow); cap
  // its JSON size so a peer can't push a 50MB "span" blob.
  span: z.unknown().optional().refine(
    (p) => p === undefined || p === null || JSON.stringify(p).length <= 10_000,
    { message: 'span exceeds 10KB JSON size cap' },
  ),
  extractedAt: isoDate,
  syncSequence: z.string().optional(),
}).passthrough();

export const catalogSyncRefSchema = z.object({
  ingredientId: z.string().max(80),
  refKind: z.string().max(32),
  refId: z.string().max(120),
  role: z.string().max(64),
  createdAt: isoDate,
  syncSequence: z.string().optional(),
}).passthrough();

// Receiver may receive `portosMeta.schemaVersions.catalog` for the version
// gate; the rest of portosMeta is informational. We accept arbitrary keys
// inside portosMeta with passthrough but cap its size at 4KB to deny a peer
// stuffing junk through the metadata escape hatch.
const portosMeta = z.object({
  portosVersion: z.string().max(64).optional(),
  schemaVersions: z.record(z.string(), z.number().int()).optional(),
}).passthrough().refine(
  (m) => JSON.stringify(m).length <= 4_000,
  { message: 'portosMeta exceeds 4KB size cap' },
).optional();

export const catalogSyncEnvelopeSchema = z.object({
  scraps: z.array(catalogSyncScrapSchema).max(5_000).optional(),
  ingredients: z.array(catalogSyncIngredientSchema).max(5_000).optional(),
  sources: z.array(catalogSyncSourceSchema).max(20_000).optional(),
  refs: z.array(catalogSyncRefSchema).max(20_000).optional(),
  portosMeta,
}).passthrough();

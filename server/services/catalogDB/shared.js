/**
 * Creative Ingredients Catalog — shared leaf module.
 *
 * Row→object mappers, id-minters, the bible-payload sanitizer, revision
 * constants, and the cross-seam HOMING SQL fragments used by both the
 * ingredient list filters and the facets bucket counts. This is the acyclic
 * leaf: every other `catalogDB/*` seam imports from here, nothing here imports
 * from a sibling seam. See the `catalogDB.js` barrel for the full layout.
 */

import { randomUUID } from 'crypto';
import { pgvectorToArray } from '../../lib/db.js';
import { ingredientIdPrefix } from '../../lib/catalogTypes.js';
import { sanitizeCharacter, sanitizePlace, sanitizeObject } from '../../lib/storyBible.js';

// Story-bible sanitizers keyed by catalog type, for the registry
// `extractionShape: 'bible'` types ONLY (character/place/object). The catalog
// payload is the bible-entry shape MINUS the columns the row owns (id / name /
// timestamps) — so we sanitize a synthetic entry `{ name, ...payload }`,
// preserve timestamps, and strip the control fields back out before persist.
// Scoped strictly to bible types: idea/scene/concept AND user-defined types
// pass through untouched (running a user type's payload through a storyBible
// sanitizer would silently drop every field it doesn't recognize).
export const BIBLE_SANITIZERS = Object.freeze({
  character: sanitizeCharacter,
  place: sanitizePlace,
  object: sanitizeObject,
});

// Control fields the sanitizer stamps onto an entry that are NOT part of the
// catalog `payload` (the row owns id/name/timestamps as columns). Stripped from
// the sanitized entry so the stored payload stays shape-stable across the
// catalog↔canon projection round-trip.
const SANITIZED_NON_PAYLOAD_KEYS = ['id', 'name', 'createdAt', 'updatedAt'];

/**
 * Run a bible-type ingredient payload through its storyBible sanitizer so the
 * structured array editors (color palette / stats / aliases) can't land
 * malformed rows and the projection round-trip is shape-stable. Returns the
 * sanitized payload (control fields stripped). Non-bible types (idea/scene/
 * concept, user-defined) return their payload UNCHANGED. `preserveTimestamps`
 * keeps the sanitizer from minting fresh ids/timestamps on an existing row.
 */
export function sanitizeBiblePayload(type, name, payload) {
  const sanitizer = BIBLE_SANITIZERS[type];
  if (!sanitizer) return payload && typeof payload === 'object' ? payload : {};
  const entry = { ...(payload && typeof payload === 'object' ? payload : {}), name: String(name || '').trim() };
  const sane = sanitizer(entry, { preserveTimestamps: true });
  if (!sane) return payload && typeof payload === 'object' ? payload : {};
  const out = { ...sane };
  for (const k of SANITIZED_NON_PAYLOAD_KEYS) delete out[k];
  // The storyBible sanitizer only emits known bible fields, so it drops
  // `schemaVersion`. Preserve the incoming marker (createIngredient re-stamps
  // it anyway; updateIngredient writes payload verbatim, and the restore route
  // relies on the marker round-tripping) so a bible payload keeps its shape
  // version through the sanitize pass.
  if (payload && typeof payload === 'object' && payload.schemaVersion !== undefined) {
    out.schemaVersion = payload.schemaVersion;
  }
  return out;
}

export function newIngredientId(type) {
  return `cat-${ingredientIdPrefix(type)}-${randomUUID()}`;
}

export function newScrapId() {
  return `cat-scrap-${randomUUID()}`;
}

export function newRevisionId() {
  return `cat-rev-${randomUUID()}`;
}

// Cap on how many revision rows we keep per ingredient. Configurable via
// CATALOG_REVISION_RETENTION (env) so an install that wants a deeper audit
// trail can raise it; default 50 bounds unbounded growth from AI refine loops
// or rapid manual edits. A non-positive / non-numeric value falls back to 50.
export const CATALOG_REVISION_RETENTION = (() => {
  const raw = parseInt(process.env.CATALOG_REVISION_RETENTION, 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 50;
})();

// The four revision sources, mirrored from the DB CHECK constraint. 'user' is
// the default (manual detail-page edit); 'extract' for ingest commits, 'refine'
// for AI refinement passes, 'sync' for peer-apply changes.
export const REVISION_SOURCES = new Set(['user', 'extract', 'refine', 'sync']);


export function rowToScrap(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    rawText: row.raw_text,
    sourceKind: row.source_kind,
    metadata: row.metadata || {},
    embedding: row.embedding ? pgvectorToArray(row.embedding) : null,
    embeddingModel: row.embedding_model,
    originInstanceId: row.origin_instance_id,
    chunkIndex: row.chunk_index ?? 0,
    parentScrapId: row.parent_scrap_id ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    deleted: !!row.deleted,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    syncSequence: String(row.sync_sequence),
  };
}

export function rowToIngredient(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    payload: row.payload || {},
    tags: row.tags || [],
    embedding: row.embedding ? pgvectorToArray(row.embedding) : null,
    embeddingModel: row.embedding_model,
    originInstanceId: row.origin_instance_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    deleted: !!row.deleted,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    syncSequence: String(row.sync_sequence),
  };
}

export function rowToRef(row) {
  if (!row) return null;
  return {
    ingredientId: row.ingredient_id,
    refKind: row.ref_kind,
    refId: row.ref_id,
    role: row.role,
    createdAt: row.created_at.toISOString(),
    deleted: !!row.deleted,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    syncSequence: String(row.sync_sequence),
  };
}

export function rowToRelation(row) {
  if (!row) return null;
  return {
    fromId: row.from_id,
    toId: row.to_id,
    kind: row.kind,
    createdAt: row.created_at.toISOString(),
    deleted: !!row.deleted,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    syncSequence: String(row.sync_sequence),
  };
}

export function rowToMedia(row) {
  if (!row) return null;
  return {
    ingredientId: row.ingredient_id,
    mediaKey: row.media_key,
    kind: row.kind,
    role: row.role ?? null,
    caption: row.caption ?? null,
    createdAt: row.created_at.toISOString(),
    deleted: !!row.deleted,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    syncSequence: String(row.sync_sequence),
  };
}

export function rowToSource(row) {
  if (!row) return null;
  return {
    ingredientId: row.ingredient_id,
    scrapId: row.scrap_id,
    span: row.span,
    extractedAt: row.extracted_at.toISOString(),
    syncSequence: String(row.sync_sequence),
  };
}

export function rowToTag(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    description: row.description ?? null,
    color: row.color ?? null,
    parentId: row.parent_id ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    syncSequence: String(row.sync_sequence),
  };
}

export function rowToRevision(row) {
  if (!row) return null;
  return {
    id: row.id,
    ingredientId: row.ingredient_id,
    name: row.name,
    payload: row.payload || {},
    tags: row.tags || [],
    source: row.source,
    actor: row.actor ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

// Ref kinds that "home" an ingredient — i.e. drive the linked / unlinked (Raw) /
// orphaned bucket classification + the Orphaned album. universe/series define
// album membership; creative-director joined this set in #1812 so a CD project's
// soft-delete surfaces its ex-cast as orphaned (recoverable) rather than leaving
// dangling chips. issue/work refs CONSUME ingredients but don't home them, so
// they stay out. Each kind soft-deletes its target (`deleted = FALSE` =
// live in REF_TARGET_TABLES, catalogRefResolver.js).
export const HOMING_REF_KINDS = ['universe', 'series', 'creative-director'];
export const HOMING_REF_KINDS_SQL = HOMING_REF_KINDS.map((k) => `'${k}'`).join(', ');

// EXISTS predicate (over the `r` alias) that the named ref points at a LIVE
// target of its kind. One source of truth for both HAS_LIVE_HOMING_REF and the
// facets bucket's live_count FILTER — keep the two call sites in sync by reusing
// this rather than re-inlining the per-kind clauses.
export const liveHomingTargetSql = (r) => `(
       (${r}.ref_kind = 'universe'          AND EXISTS (SELECT 1 FROM universes u                  WHERE u.id = ${r}.ref_id AND u.deleted = false))
    OR (${r}.ref_kind = 'series'            AND EXISTS (SELECT 1 FROM pipeline_series s            WHERE s.id = ${r}.ref_id AND s.deleted = false))
    OR (${r}.ref_kind = 'creative-director' AND EXISTS (SELECT 1 FROM creative_director_projects p WHERE p.id = ${r}.ref_id AND p.deleted = false)))`;

// SQL predicate matching ingredients that have at least one LIVE homing ref
// (target row still resolves).
export const HAS_LIVE_HOMING_REF = `EXISTS (
    SELECT 1 FROM catalog_ingredient_refs r
     WHERE r.ingredient_id = catalog_ingredients.id AND r.deleted = false
       AND ${liveHomingTargetSql('r')})`;

// At least one homing ref row exists (live OR dangling) — distinguishes
// "orphaned" (has a ref, none resolve) from "unlinked" (no ref at all).
export const HAS_ANY_HOMING_REF = `EXISTS (
    SELECT 1 FROM catalog_ingredient_refs r
     WHERE r.ingredient_id = catalog_ingredients.id AND r.deleted = false
       AND r.ref_kind IN (${HOMING_REF_KINDS_SQL}))`;

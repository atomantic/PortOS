/**
 * Catalog Federation Sync Service
 *
 * Peer-to-peer sync for the Creative Ingredients Catalog. Mirrors
 * server/services/memorySync.js but the envelope carries seven kinds
 * (scraps, ingredients, sources, refs, relations, tags, media) because the
 * catalog is a multi-table relational store, not a single flat row set. The
 * `media` rows carry a `media_key` REFERENCE into the receiver's own library
 * (never the bytes); an unresolved key surfaces via the metadata-missing
 * integrity endpoint rather than failing the apply.
 *
 * Pull protocol:
 *   GET /api/catalog/sync?since[scraps]=A&since[ingredients]=B&...&since[media]=G&limit=100
 *   → { scraps[], ingredients[], sources[], refs[], relations[], tags[], media[], maxSequences, hasMore }
 *
 * The BIGSERIAL `sync_sequence` columns are INDEPENDENT — a row at
 * sources.sync_sequence=50 isn't comparable to ingredients.sync_sequence=50.
 * The receiver therefore tracks one cursor per kind and `since` is `{ scraps,
 * ingredients, sources, refs, relations }`. A scalar `?since=N` is still accepted for
 * back-compat / one-shot pulls and is applied uniformly to all four kinds.
 * `hasMore` is true when ANY of the four tables had more than `limit` rows
 * past its respective cursor — drain by re-pulling with the maxSequences from
 * the previous response.
 *
 * Apply: receiver POSTs the envelope to /api/catalog/sync/apply. Conflict
 * resolution is LWW on `updated_at` for ingredient/scrap rows; source/ref
 * rows are tuple-unique and idempotent on conflict. Each row is wrapped in
 * its own try/catch so one malformed row can't poison the whole batch.
 */

import {
  getScrapChangesSince,
  getIngredientChangesSince,
  getSourceChangesSince,
  getRefChangesSince,
  getRelationChangesSince,
  getTagChangesSince,
  getMediaChangesSince,
  getMaxSequences,
  upsertScrapFromPeer,
  upsertIngredientFromPeer,
  upsertSourceFromPeer,
  upsertRefFromPeer,
  upsertRelationFromPeer,
  upsertTagFromPeer,
  upsertMediaFromPeer,
} from './catalogDB.js';
import { compareSchemaVersions, PORTOS_SCHEMA_VERSIONS } from '../lib/schemaVersions.js';

const CURSOR_KEYS = ['scraps', 'ingredients', 'sources', 'refs', 'relations', 'tags', 'media'];

// Normalize `since` (scalar string OR per-kind object) into a `{ scraps,
// ingredients, sources, refs }` cursor map. Scalar form is uniform across
// kinds — fine for the first pull (everyone starts at '0'); subsequent pulls
// MUST use the per-kind form returned in `maxSequences` or rows on a less-
// active table get silently filtered out forever.
function normalizeCursors(since) {
  if (since && typeof since === 'object' && !Array.isArray(since)) {
    return Object.fromEntries(CURSOR_KEYS.map((k) => {
      const v = since[k];
      return [k, typeof v === 'string' && /^\d+$/.test(v) ? v : '0'];
    }));
  }
  const scalar = typeof since === 'string' && /^\d+$/.test(since) ? since : '0';
  return Object.fromEntries(CURSOR_KEYS.map((k) => [k, scalar]));
}

export async function getChangesSince(since = '0', limit = 100) {
  const cursors = normalizeCursors(since);
  const [scraps, ingredients, sources, refs, relations, tags, media] = await Promise.all([
    getScrapChangesSince(cursors.scraps, limit),
    getIngredientChangesSince(cursors.ingredients, limit),
    getSourceChangesSince(cursors.sources, limit),
    getRefChangesSince(cursors.refs, limit),
    getRelationChangesSince(cursors.relations, limit),
    getTagChangesSince(cursors.tags, limit),
    getMediaChangesSince(cursors.media, limit),
  ]);

  const hasMore =
    scraps.hasMore || ingredients.hasMore || sources.hasMore || refs.hasMore ||
    relations.hasMore || tags.hasMore || media.hasMore;

  // Per-kind cursor advance — fall back to the inbound cursor so the next pull
  // doesn't move backward on a quiet kind.
  const maxOf = (items, fallback) =>
    items.length > 0 ? items[items.length - 1].syncSequence : fallback;

  // True per-table maxima, INDEPENDENT of the inbound cursor. `maxSequences`
  // (below) falls back to the inbound cursor on a quiet kind, so it can't be
  // used to detect a peer rebuild/restore — it would just echo the caller's
  // cursor. `tableMaxSequences` reports the real MAX(sync_sequence) so the
  // receiver can spot `savedCursor > tableMax` and rewind. One cheap MAX query.
  const tableMaxSequences = await getMaxSequences();

  return {
    scraps: scraps.items,
    ingredients: ingredients.items,
    sources: sources.items,
    refs: refs.items,
    relations: relations.items,
    tags: tags.items,
    media: media.items,
    maxSequences: {
      scraps:      maxOf(scraps.items,      cursors.scraps),
      ingredients: maxOf(ingredients.items, cursors.ingredients),
      sources:     maxOf(sources.items,     cursors.sources),
      refs:        maxOf(refs.items,        cursors.refs),
      relations:   maxOf(relations.items,   cursors.relations),
      tags:        maxOf(tags.items,        cursors.tags),
      media:       maxOf(media.items,       cursors.media),
    },
    tableMaxSequences,
    hasMore,
  };
}

export class CatalogSyncVersionMismatchError extends Error {
  constructor(diff) {
    super(`catalog sync rejected: sender ahead on ${diff.ahead.map((g) => `${g.category} (v${g.senderV} vs v${g.receiverV})`).join(', ')}`);
    this.name = 'CatalogSyncVersionMismatchError';
    this.code = 'CATALOG_SCHEMA_VERSION_AHEAD';
    this.status = 412;
    this.diff = diff;
  }
}

export async function applyRemoteChanges(envelope = {}) {
  // Schema-version gate: a peer running a newer `catalog` schema would push
  // forward-shaped data this install can't safely interpret. Match the
  // memorySync pattern — reject ahead-mismatches with a 412.
  const senderVersions = envelope?.portosMeta?.schemaVersions || {};
  const diff = compareSchemaVersions(senderVersions, PORTOS_SCHEMA_VERSIONS);
  const aheadOnCatalog = diff.ahead.filter((g) => g.category === 'catalog');
  if (aheadOnCatalog.length > 0) {
    throw new CatalogSyncVersionMismatchError({ ahead: aheadOnCatalog, behind: [] });
  }

  const stats = {
    scraps: { inserted: 0, updated: 0, skipped: 0, failed: 0 },
    ingredients: { inserted: 0, updated: 0, skipped: 0, failed: 0 },
    sources: { applied: 0, failed: 0 },
    refs: { applied: 0, failed: 0 },
    relations: { applied: 0, failed: 0 },
    tags: { inserted: 0, updated: 0, skipped: 0, failed: 0 },
    media: { applied: 0, failed: 0 },
    errors: [],
  };

  const recordFailure = (kind, id, err) => {
    stats.errors.push({ kind, id: id || null, message: err?.message || String(err) });
    console.error(`❌ catalog sync ${kind} ${id || '?'} failed: ${err?.message || err}`);
  };

  // Tags first — they carry a `parent_id` self-FK (handled by the parent-less
  // retry in upsertTagFromPeer) and are referenced by the freeform tag arrays
  // on ingredients, so we want the canonical rows present before the ingredient
  // rows land. They have no FK to scraps/ingredients, so ordering is otherwise
  // free. Each row in its own try/catch.
  for (const tag of envelope.tags || []) {
    try {
      const res = await upsertTagFromPeer(tag);
      if (!res.applied) stats.tags.skipped++;
      else if (res.isInsert) stats.tags.inserted++;
      else stats.tags.updated++;
    } catch (err) {
      stats.tags.failed++;
      recordFailure('tag', tag?.id, err);
    }
  }

  // Scraps next (sources FK to BOTH so we want the parents present before
  // the join rows land). Each row in its own try/catch — one malformed row
  // must NOT abort the rest of the envelope.
  for (const scrap of envelope.scraps || []) {
    try {
      const res = await upsertScrapFromPeer(scrap);
      if (!res.applied) stats.scraps.skipped++;
      else if (res.isInsert) stats.scraps.inserted++;
      else stats.scraps.updated++;
    } catch (err) {
      stats.scraps.failed++;
      recordFailure('scrap', scrap?.id, err);
    }
  }

  for (const ing of envelope.ingredients || []) {
    try {
      const res = await upsertIngredientFromPeer(ing);
      if (!res.applied) stats.ingredients.skipped++;
      else if (res.isInsert) stats.ingredients.inserted++;
      else stats.ingredients.updated++;
    } catch (err) {
      stats.ingredients.failed++;
      recordFailure('ingredient', ing?.id, err);
    }
  }

  for (const src of envelope.sources || []) {
    try {
      await upsertSourceFromPeer(src);
      stats.sources.applied++;
    } catch (err) {
      stats.sources.failed++;
      recordFailure('source', `${src?.ingredientId}↔${src?.scrapId}`, err);
    }
  }

  for (const ref of envelope.refs || []) {
    try {
      await upsertRefFromPeer(ref);
      stats.refs.applied++;
    } catch (err) {
      stats.refs.failed++;
      recordFailure('ref', `${ref?.ingredientId}/${ref?.refKind}/${ref?.refId}`, err);
    }
  }

  // Relations FK BOTH ids to catalog_ingredients, so they land after the
  // ingredient upserts above (same envelope ordering rationale as sources).
  for (const rel of envelope.relations || []) {
    try {
      await upsertRelationFromPeer(rel);
      stats.relations.applied++;
    } catch (err) {
      stats.relations.failed++;
      recordFailure('relation', `${rel?.fromId}/${rel?.kind}/${rel?.toId}`, err);
    }
  }

  // Media rows FK ingredient_id to catalog_ingredients, so they land after the
  // ingredient upserts. The `media_key` is a REFERENCE into the receiver's own
  // library — we store the key regardless of whether the asset is present
  // locally; a missing asset surfaces later via the metadata-missing integrity
  // endpoint, NOT as an apply failure (otherwise a slow asset transfer would
  // drop the attachment metadata entirely).
  for (const media of envelope.media || []) {
    try {
      await upsertMediaFromPeer(media);
      stats.media.applied++;
    } catch (err) {
      stats.media.failed++;
      recordFailure('media', `${media?.ingredientId}/${media?.kind}/${media?.mediaKey}`, err);
    }
  }

  return stats;
}

// Total rows actually applied (inserted + updated for LWW kinds, applied for
// tuple-unique kinds) across an `applyRemoteChanges` stats object. Lives here —
// not in the federation orchestrator — so the per-kind stats SHAPE has a single
// owner; a future envelope kind only needs adding here, not in every caller.
export function countAppliedFromStats(stats = {}) {
  return (
    (stats.scraps?.inserted || 0) + (stats.scraps?.updated || 0) +
    (stats.ingredients?.inserted || 0) + (stats.ingredients?.updated || 0) +
    (stats.sources?.applied || 0) + (stats.refs?.applied || 0) +
    (stats.relations?.applied || 0) +
    (stats.tags?.inserted || 0) + (stats.tags?.updated || 0) +
    (stats.media?.applied || 0)
  );
}

// Per-kind cursor view for the federation orchestrator. The previous scalar
// `getMaxSequence` collapsed the four BIGSERIALs into one max — that lied
// about the protocol (one cursor can't represent four independent sequences).
export { getMaxSequences };

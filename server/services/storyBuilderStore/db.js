/**
 * Story Builder sessions — PostgreSQL leaf I/O (#1016).
 *
 * One row per session in `story_builder_sessions`: the full sanitized record
 * (the `steps` lock/integrity map, `syncedHashes` baseline, `currentStep`,
 * `llm` picker choice, `origin`, tombstone fields) in `data` JSONB, with
 * universe_id / series_id / sync / ephemeral / updated_at / deleted / deleted_at
 * mirrored into columns for the queries the service + federation actually run
 * (sessions-for-a-record lookups, the OPT-IN sync snapshot filter, LWW
 * staleness, tombstone GC).
 *
 * PURE leaf I/O — no in-process serialization, no sanitizing. The store facade
 * (store.js) owns the per-id write queue + the mutation epoch and applies
 * `sanitizeSession` on read, so reads here return `data` verbatim (the columns
 * are a queryable mirror, never read back).
 */

import { createJsonbLeafDb } from '../../lib/jsonbLeafDb.js';

export const { readRaw, listRaw, listIds, writeRaw, deleteRaw } = createJsonbLeafDb({
  table: 'story_builder_sessions',
  softDelete: {},
  mirrorColumns: {
    universe_id: record => typeof record?.universeId === 'string' && record.universeId ? record.universeId : null,
    series_id: record => typeof record?.seriesId === 'string' && record.seriesId ? record.seriesId : null,
    sync: record => record?.sync === true,
    ephemeral: record => record?.ephemeral === true,
  },
});

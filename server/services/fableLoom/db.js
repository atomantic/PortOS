/**
 * PostgreSQL leaf I/O for FableLoom records. The full sanitized record lives
 * in JSONB; name/universe_id/series_id/updated_at are mirrored for the common
 * list/filter paths; delete markers are mirrored for federated tombstone GC.
 *
 * Storage: `db-primary` — federated through the opt-in per-record `fableLoom` category
 * (whole-record LWW, soft-delete tombstones, hashed scene-media manifests; no
 * `sync_sequence`). db-primary because looms relate to universes/series (soft refs).
 */

import { query, withTransaction } from '../../lib/db.js';
import { createJsonbLeafDb } from '../../lib/jsonbLeafDb.js';
import { LOOM_LIMITS } from './limits.js';

export const { readRaw, listRaw, listIds, listLiveIds, listTombstoneIdsBefore, writeRaw, deleteRaw } = createJsonbLeafDb({
  table: 'fableloom_stories',
  orderBy: [['updated_at', 'DESC'], ['id', 'ASC']],
  softDelete: {},
  mirrorColumns: {
    name: record => record.name,
    universe_id: record => record.universeId ?? null,
    series_id: record => record.seriesId ?? null,
  },
});

// Keep the projected fields as JSONB so the header sanitizer can distinguish
// strings from malformed legacy values. Count only children the sanitizer keeps,
// in source order before each cap, and treat only JSON true as an ending.
export async function listSummaries({ seriesId } = {}) {
  const { rows } = await query(
    `SELECT jsonb_build_object(
              'id', data->'id',
              'name', data->'name',
              'logline', data->'logline',
              'format', data->'format',
              'participationMode', data->'participationMode',
              'audienceCommunicationMedium', data->'audienceCommunicationMedium',
              'universeId', data->'universeId',
              'seriesId', data->'seriesId',
              'createdAt', data->'createdAt',
              'updatedAt', data->'updatedAt'
            ) AS header,
            counts.*
     FROM fableloom_stories
     CROSS JOIN LATERAL (
       SELECT count(*)::int AS "episodeCount",
              coalesce(sum(nodes.scenes), 0)::int AS "sceneCount",
              coalesce(sum(nodes.endings), 0)::int AS "endingCount"
       FROM (
         SELECT episode
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(data->'episodes') = 'array' THEN data->'episodes' ELSE '[]'::jsonb END
         ) WITH ORDINALITY AS episodes(episode, position)
         WHERE jsonb_typeof(episode->'id') = 'string' AND episode->>'id' <> ''
         ORDER BY position
         LIMIT $1
       ) AS kept_episodes
       CROSS JOIN LATERAL (
         SELECT count(*) AS scenes,
                count(*) FILTER (WHERE node->'isEnding' = 'true'::jsonb) AS endings
         FROM (
           SELECT node
           FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(episode->'nodes') = 'array' THEN episode->'nodes' ELSE '[]'::jsonb END
           ) WITH ORDINALITY AS nodes(node, position)
           WHERE jsonb_typeof(node->'id') = 'string' AND node->>'id' <> ''
           ORDER BY position
           LIMIT $2
         ) AS kept_nodes
       ) AS nodes
     ) AS counts
     WHERE deleted = FALSE${seriesId ? ' AND series_id = $3' : ''}
     ORDER BY updated_at DESC, name ASC, id ASC`,
    [LOOM_LIMITS.EPISODES_MAX, LOOM_LIMITS.NODES_MAX, ...(seriesId ? [seriesId] : [])],
  );
  return rows;
}

/** Keep gallery-video ownership stable until a media retirement settles. */
export function withMediaReferences(work) {
  return withTransaction(async client => {
    await client.query('LOCK TABLE fableloom_stories IN SHARE MODE');
    const { rows } = await client.query('SELECT data FROM fableloom_stories WHERE deleted = FALSE');
    return work(rows.map(row => row.data));
  });
}

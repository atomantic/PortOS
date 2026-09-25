/**
 * Memory Federation Sync Service
 *
 * Enables memory synchronization between PortOS instances via the
 * commit-ordered federation change feed (`sync_feed`, #8315). Peers pull
 * changes since their last known feed position.
 *
 * Sync Protocol:
 *   1. Every committed memory change gets a feed position, drawn AT COMMIT
 *      (server/lib/db/schema/syncFeed.js) — never the write-time
 *      sync_sequence, which a late-committing transaction could land below a
 *      cursor a peer already advanced past
 *   2. Peers request GET /api/memory/sync?since={lastPosition}&limit=100
 *   3. Response includes memories changed since that position + the max position
 *   4. Peer stores the max position and uses it for the next poll. A legacy
 *      sync_sequence cursor is below every position, so it replays the stream
 *   5. Conflict resolution: last-writer-wins by updated_at timestamp
 *
 * Note: memory_links (relationships) are not synced — only the memories table
 * is replicated. Relationship data is instance-local.
 */

import { query, withTransaction, arrayToPgvector, pgvectorToArray } from '../lib/db.js';
import { PERSISTENT_MIND_ID } from '../lib/persistentMindTrajectory.js';
import { PERSISTENT_MIND_CHOSEN_NAME_TAG } from '../lib/persistentMindChosenName.js';
import { dedupeByKey } from '../lib/arrayUtils.js';

/**
 * Get memories changed since a given feed position.
 * Used by peers to pull incremental updates.
 *
 * @param {string} sinceSequence - Return changes after this feed position (string to avoid BigInt precision loss)
 * @param {number} limit - Max records to return per batch
 * @returns {Promise<{memories: Array, maxSequence: string, hasMore: boolean}>}
 */
export async function getChangesSince(sinceSequence = '0', limit = 100) {
  // Fetch limit+1 rows to detect whether more records exist beyond this batch
  const result = await query(
    `SELECT m.id, m.type, m.content, m.summary, m.category, m.tags,
            m.embedding, m.embedding_model, m.confidence, m.importance,
            m.status, m.source_task_id, m.source_agent_id, m.source_app_id,
            m.expires_at, m.created_at, m.updated_at, m.origin_instance_id,
            f.position::text AS feed_position
     FROM sync_feed f
     JOIN memories m ON m.sync_sequence = f.row_sequence
     WHERE f.stream = 'memories'
       AND f.position > $1
       AND m.source_agent_id IS DISTINCT FROM $3
       AND NOT ($4 = ANY(COALESCE(m.tags, '{}'::text[])))
     ORDER BY f.position ASC
     LIMIT $2`,
    [sinceSequence, limit + 1, PERSISTENT_MIND_ID, PERSISTENT_MIND_CHOSEN_NAME_TAG]
  );

  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

  // access_count and last_accessed are instance-local read stats,
  // not replicated — omitted from sync payload intentionally.
  const memories = rows.map(row => ({
    id: row.id,
    type: row.type,
    content: row.content,
    summary: row.summary,
    category: row.category,
    tags: row.tags || [],
    embedding: pgvectorToArray(row.embedding),
    embeddingModel: row.embedding_model,
    confidence: row.confidence,
    importance: row.importance,
    status: row.status,
    sourceTaskId: row.source_task_id,
    sourceAgentId: row.source_agent_id,
    sourceAppId: row.source_app_id,
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    syncSequence: row.feed_position,
    originInstanceId: row.origin_instance_id
  }));

  const maxSequence = memories.length > 0
    ? memories[memories.length - 1].syncSequence
    : sinceSequence;

  return { memories, maxSequence, hasMore };
}

/**
 * Apply incoming changes from a remote peer.
 * Uses last-writer-wins conflict resolution based on updated_at.
 * Batches inserts (100 per query) to reduce round-trips and lock time.
 *
 * @param {Array} incomingMemories - Array of memory objects from remote peer
 * @returns {Promise<{inserted: number, updated: number, skipped: number}>}
 *   inserted - new rows created
 *   updated  - existing rows replaced (remote was newer)
 *   skipped  - rows rejected by last-writer-wins (local was newer)
 */
export async function applyRemoteChanges(incomingMemories) {
  if (incomingMemories.length === 0) return { inserted: 0, updated: 0, skipped: 0 };

  const COLS = 18;
  const BATCH_SIZE = 100;

  // Collapse duplicate ids BEFORE batching (see `dedupeByKey` for why a
  // multi-row upsert cannot carry a repeated conflict key). This runs inside a
  // transaction, so one repeated id anywhere in a peer's payload would roll back
  // the ENTIRE apply, not just its batch — and the rows arrive from a remote
  // peer, so uniqueness is not ours to assume.
  //
  // The survivor is the newest copy by `updated_at`, not simply the last one:
  // that is the winner the ON CONFLICT clause's last-writer-wins rule picks when
  // the same duplicates arrive in separate batches, so how a peer happened to
  // order its payload can't change the outcome. Ties keep the first copy, matching
  // the SQL's strict `>` (an equal clock is not a newer write).
  //
  // An unparseable clock sorts BELOW every real one rather than NaN-comparing
  // false and thereby winning: a peer that sends one good and one malformed copy
  // of a row must keep the good one, or the batch carries a timestamp Postgres
  // rejects and the apply fails on a row we already had intact.
  const lwwClock = (mem) => {
    const at = Date.parse(mem?.updatedAt);
    return Number.isNaN(at) ? -Infinity : at;
  };
  const deduped = dedupeByKey(
    incomingMemories.filter((mem) => mem.sourceAgentId !== PERSISTENT_MIND_ID
      && !mem.tags?.includes(PERSISTENT_MIND_CHOSEN_NAME_TAG)),
    (mem) => mem.id,
    (held, next) => (lwwClock(held) >= lwwClock(next) ? held : next),
  );
  // A collapsed duplicate lost last-writer-wins, which is exactly what `skipped`
  // counts — so the three tallies still sum to what the peer sent.
  const collapsed = incomingMemories.length - deduped.length;

  return withTransaction(async (client) => {
    let inserted = 0;
    let updated = 0;
    let skipped = collapsed;

    for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
      const batch = deduped.slice(i, i + BATCH_SIZE);
      const values = [];
      const params = [];

      batch.forEach((mem, idx) => {
        const base = idx * COLS;
        values.push(`(${Array.from({length: COLS}, (_, j) => `$${base + j + 1}`).join(', ')})`);
        params.push(
          mem.id, mem.type, mem.content, mem.summary, mem.category, mem.tags || [],
          arrayToPgvector(mem.embedding), mem.embeddingModel, mem.confidence, mem.importance,
          mem.status, mem.sourceTaskId, mem.sourceAgentId, mem.sourceAppId,
          mem.expiresAt, mem.createdAt, mem.updatedAt, mem.originInstanceId
        );
      });

      params.push(PERSISTENT_MIND_ID, PERSISTENT_MIND_CHOSEN_NAME_TAG);
      const localMindParam = params.length - 1;
      const nameTagParam = params.length;
      // access_count and last_accessed are instance-local, not synced
      const result = await client.query(
        `INSERT INTO memories (
            id, type, content, summary, category, tags,
            embedding, embedding_model, confidence, importance,
            status, source_task_id, source_agent_id, source_app_id,
            expires_at, created_at, updated_at, origin_instance_id
          ) VALUES ${values.join(', ')}
          ON CONFLICT (id) DO UPDATE SET
            type = EXCLUDED.type, content = EXCLUDED.content,
            summary = EXCLUDED.summary, category = EXCLUDED.category, tags = EXCLUDED.tags,
            embedding = EXCLUDED.embedding, embedding_model = EXCLUDED.embedding_model,
            confidence = EXCLUDED.confidence, importance = EXCLUDED.importance,
            status = EXCLUDED.status, expires_at = EXCLUDED.expires_at,
            updated_at = EXCLUDED.updated_at,
            source_task_id = EXCLUDED.source_task_id, source_agent_id = EXCLUDED.source_agent_id,
            source_app_id = EXCLUDED.source_app_id,
            origin_instance_id = EXCLUDED.origin_instance_id
          WHERE EXCLUDED.updated_at > memories.updated_at
            AND memories.source_agent_id IS DISTINCT FROM $${localMindParam}
            AND NOT ($${nameTagParam} = ANY(COALESCE(memories.tags, '{}'::text[])))
          RETURNING (xmax = 0) AS is_insert`,
        params
      );

      inserted += result.rows.filter(r => r.is_insert).length;
      updated += result.rows.filter(r => !r.is_insert).length;
      skipped += batch.length - result.rows.length;
    }

    return { inserted, updated, skipped };
  });
}

/**
 * Get the current maximum feed position.
 * Used by peers to determine if they're up-to-date, and to detect a reset
 * (a saved cursor above this maximum rewinds to 0).
 *
 * @returns {Promise<string>} Position as string to avoid BigInt precision loss
 */
export async function getMaxSequence() {
  const result = await query("SELECT COALESCE(MAX(position), 0)::text AS max_seq FROM sync_feed WHERE stream = 'memories'");
  return result.rows?.[0]?.max_seq ?? '0';
}

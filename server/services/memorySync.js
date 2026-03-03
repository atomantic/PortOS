/**
 * Memory Federation Sync Service
 *
 * Enables memory synchronization between PortOS instances via the
 * sync_sequence column in PostgreSQL. Peers pull changes since their
 * last known sequence number.
 *
 * Sync Protocol:
 *   1. Each memory row has an auto-incrementing sync_sequence (BIGSERIAL)
 *   2. Peers request GET /api/memory/sync?since={lastSequence}&limit=100
 *   3. Response includes memories changed since that sequence + the max sequence
 *   4. Peer stores the max sequence and uses it for the next poll
 *   5. Conflict resolution: last-writer-wins by updated_at timestamp
 *
 * Note: memory_links (relationships) are not synced — only the memories table
 * is replicated. Relationship data is instance-local.
 */

import { query, withTransaction, arrayToPgvector, pgvectorToArray } from '../lib/db.js';

/**
 * Get memories changed since a given sync sequence.
 * Used by peers to pull incremental updates.
 *
 * @param {string} sinceSequence - Return changes after this sequence (string to avoid BigInt precision loss)
 * @param {number} limit - Max records to return per batch
 * @returns {Promise<{memories: Array, maxSequence: string, hasMore: boolean}>}
 */
export async function getChangesSince(sinceSequence = '0', limit = 100) {
  // Fetch limit+1 rows to detect whether more records exist beyond this batch
  const result = await query(
    `SELECT id, type, content, summary, category, tags,
            embedding, embedding_model, confidence, importance,
            status, source_task_id, source_agent_id, source_app_id,
            expires_at, created_at, updated_at, sync_sequence
     FROM memories
     WHERE sync_sequence > $1
     ORDER BY sync_sequence ASC
     LIMIT $2`,
    [sinceSequence, limit + 1]
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
    syncSequence: String(row.sync_sequence)
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

  const COLS = 17;
  const BATCH_SIZE = 100;

  return withTransaction(async (client) => {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (let i = 0; i < incomingMemories.length; i += BATCH_SIZE) {
      const batch = incomingMemories.slice(i, i + BATCH_SIZE);
      const values = [];
      const params = [];

      batch.forEach((mem, idx) => {
        const base = idx * COLS;
        values.push(`(${Array.from({length: COLS}, (_, j) => `$${base + j + 1}`).join(', ')})`);
        params.push(
          mem.id, mem.type, mem.content, mem.summary, mem.category, mem.tags || [],
          arrayToPgvector(mem.embedding), mem.embeddingModel, mem.confidence, mem.importance,
          mem.status, mem.sourceTaskId, mem.sourceAgentId, mem.sourceAppId,
          mem.expiresAt, mem.createdAt, mem.updatedAt
        );
      });

      // access_count and last_accessed are instance-local, not synced
      const result = await client.query(
        `INSERT INTO memories (
            id, type, content, summary, category, tags,
            embedding, embedding_model, confidence, importance,
            status, source_task_id, source_agent_id, source_app_id,
            expires_at, created_at, updated_at
          ) VALUES ${values.join(', ')}
          ON CONFLICT (id) DO UPDATE SET
            type = EXCLUDED.type, content = EXCLUDED.content,
            summary = EXCLUDED.summary, category = EXCLUDED.category, tags = EXCLUDED.tags,
            embedding = EXCLUDED.embedding, embedding_model = EXCLUDED.embedding_model,
            confidence = EXCLUDED.confidence, importance = EXCLUDED.importance,
            status = EXCLUDED.status, expires_at = EXCLUDED.expires_at,
            updated_at = EXCLUDED.updated_at,
            source_task_id = EXCLUDED.source_task_id, source_agent_id = EXCLUDED.source_agent_id,
            source_app_id = EXCLUDED.source_app_id
          WHERE EXCLUDED.updated_at > memories.updated_at
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
 * Get the current maximum sync sequence.
 * Used by peers to determine if they're up-to-date.
 *
 * @returns {Promise<string>} Sequence as string to avoid BigInt precision loss
 */
export async function getMaxSequence() {
  const result = await query('SELECT COALESCE(MAX(sync_sequence), 0)::text AS max_seq FROM memories');
  return result.rows[0].max_seq;
}

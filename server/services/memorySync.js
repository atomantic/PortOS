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
 * @param {number} sinceSequence - Return changes after this sequence number (0 = all)
 * @param {number} limit - Max records to return per batch
 * @returns {Promise<{memories: Array, maxSequence: number, hasMore: boolean}>}
 */
export async function getChangesSince(sinceSequence = 0, limit = 100) {
  // Fetch limit+1 rows to detect whether more records exist beyond this batch
  const result = await query(
    `SELECT id, type, content, summary, category, tags,
            embedding, embedding_model, confidence, importance,
            access_count, last_accessed, status,
            source_task_id, source_agent_id, source_app_id,
            expires_at, created_at, updated_at, sync_sequence
     FROM memories
     WHERE sync_sequence > $1
     ORDER BY sync_sequence ASC
     LIMIT $2`,
    [sinceSequence, limit + 1]
  );

  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

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
    accessCount: row.access_count,
    lastAccessed: row.last_accessed?.toISOString() ?? null,
    status: row.status,
    sourceTaskId: row.source_task_id,
    sourceAgentId: row.source_agent_id,
    sourceAppId: row.source_app_id,
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    syncSequence: parseInt(row.sync_sequence, 10)
  }));

  const maxSequence = memories.length > 0
    ? memories[memories.length - 1].syncSequence
    : sinceSequence;

  return { memories, maxSequence, hasMore };
}

/**
 * Apply incoming changes from a remote peer.
 * Uses last-writer-wins conflict resolution based on updated_at.
 *
 * @param {Array} incomingMemories - Array of memory objects from remote peer
 * @returns {Promise<{applied: number, skipped: number, conflicts: number}>}
 */
export async function applyRemoteChanges(incomingMemories) {
  let applied = 0;
  let skipped = 0;
  let conflicts = 0;

  return withTransaction(async (client) => {
    for (const mem of incomingMemories) {
      const result = await client.query(
        `INSERT INTO memories (
            id, type, content, summary, category, tags,
            embedding, embedding_model, confidence, importance,
            access_count, last_accessed, status,
            source_task_id, source_agent_id, source_app_id,
            expires_at, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10,
            $11, $12, $13,
            $14, $15, $16,
            $17, $18, $19
          )
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
          RETURNING (xmax = 0) AS inserted`,
          [
            mem.id, mem.type, mem.content, mem.summary, mem.category, mem.tags || [],
            arrayToPgvector(mem.embedding), mem.embeddingModel, mem.confidence, mem.importance,
            mem.accessCount || 0, mem.lastAccessed,
            mem.status, mem.sourceTaskId, mem.sourceAgentId, mem.sourceAppId,
            mem.expiresAt, mem.createdAt, mem.updatedAt
          ]
        );

      if (result.rows.length > 0) {
        applied++;
        if (!result.rows[0].inserted) conflicts++;
      } else {
        skipped++;
      }
    }

    return { applied, skipped, conflicts };
  });
}

/**
 * Get the current maximum sync sequence number.
 * Used by peers to determine if they're up-to-date.
 *
 * @returns {Promise<number>}
 */
export async function getMaxSequence() {
  const result = await query('SELECT COALESCE(MAX(sync_sequence), 0) AS max_seq FROM memories');
  return parseInt(result.rows[0].max_seq, 10);
}

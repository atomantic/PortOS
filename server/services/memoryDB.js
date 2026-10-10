/**
 * Memory Service — PostgreSQL + pgvector Backend
 *
 * Drop-in replacement for memory.js (file-based) using PostgreSQL with pgvector
 * for vector similarity search and tsvector for full-text search.
 *
 * Same exported interface as memory.js so routes/consumers don't change.
 */

import { ServerError } from '../lib/errorHandler.js';
import { PERSISTENT_MIND_MEMORY_PROTECTION_TAGS } from '../lib/persistentMindMemory.js';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { query, withTransaction, pgvectorToArray, arrayToPgvector } from '../lib/db.js';
import { UUID_RE } from '../lib/fileCore.js';
import { cosEvents } from './cosEvents.js';
import * as notifications from './notifications.js';
import { DEFAULT_MEMORY_CONFIG, generateSummary, decrementAgentPendingApproval } from './memoryConfig.js';
import { getInstanceId } from './instanceIdentity.js';
import { DEFAULT_MEMORY_LINK_TYPE, isSymmetricMemoryLinkType } from '../lib/memoryLinkTypes.js';

const protectedMindMemoryTags = Object.values(PERSISTENT_MIND_MEMORY_PROTECTION_TAGS);

/**
 * Convert a database row to the memory object format matching the file-based API
 */
function rowToMemory(row) {
  return {
    id: row.id,
    version: row.version,
    archiveReason: row.archive_reason,
    type: row.type,
    content: row.content,
    summary: row.summary,
    category: row.category,
    tags: row.tags || [],
    sourceTaskId: row.source_task_id,
    sourceAgentId: row.source_agent_id,
    sourceAppId: row.source_app_id,
    embedding: row.embedding ? pgvectorToArray(row.embedding) : null,
    embeddingModel: row.embedding_model,
    confidence: row.confidence,
    importance: row.importance,
    accessCount: row.access_count,
    lastAccessed: row.last_accessed?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    status: row.status,
    originInstanceId: row.origin_instance_id
  };
}

/**
 * Convert a database row to index-style metadata (lightweight)
 */
function rowToMeta(row) {
  return {
    id: row.id,
    type: row.type,
    category: row.category,
    tags: row.tags || [],
    summary: row.summary,
    importance: row.importance,
    createdAt: row.created_at.toISOString(),
    status: row.status,
    sourceAppId: row.source_app_id,
    sourceAgentId: row.source_agent_id,
  };
}

// =============================================================================
// CRUD Operations
// =============================================================================

// The `embedding` column is a fixed-dimension pgvector (768). Now that the
// embedding provider/model is user-configurable, a mismatched model can yield a
// vector of a different length — Postgres would then throw "expected 768
// dimensions" on EVERY insert, aborting the whole bridge resync. Store NULL with
// one clear warning instead; the record stays un-searchable until it's
// re-embedded with a matching-dimension model. Returns `{ value, model }` for
// the embedding + embedding_model columns so both stay consistent.
function embeddingColumns(embedding) {
  if (!embedding) return { value: null, model: null };
  const expected = DEFAULT_MEMORY_CONFIG.embeddingDimension;
  if (embedding.length !== expected) {
    console.warn(`⚠️ Skipping memory embedding: got ${embedding.length} dims, column expects ${expected} — check the Brain embedding model`);
    return { value: null, model: null };
  }
  return { value: arrayToPgvector(embedding), model: DEFAULT_MEMORY_CONFIG.embeddingModel };
}

/**
 * Create a new memory
 */
export async function createMemory(data, embedding = null) {
  const id = uuidv4();
  const summary = data.summary || generateSummary(data.content);
  const now = new Date().toISOString();

  const originInstanceId = await getInstanceId();
  const embeddingCol = embeddingColumns(embedding);

  const memory = await withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO memories (
        id, type, content, summary, category, tags,
        embedding, embedding_model, confidence, importance,
        source_task_id, source_agent_id, source_app_id,
        expires_at, status, created_at, updated_at, origin_instance_id
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13,
        $14, $15, $16, $17, $18
      ) RETURNING *`,
      [
        id, data.type, data.content, summary, data.category || 'other', data.tags || [],
        embeddingCol.value,
        embeddingCol.model,
        data.confidence ?? 0.8, data.importance ?? 0.5,
        data.sourceTaskId || null, data.sourceAgentId || null, data.sourceAppId || null,
        data.expiresAt || null, data.status || 'active', now, now, originInstanceId
      ]
    );

    const mem = rowToMemory(result.rows[0]);
    // Attach the original embedding array (pgvector may return string
    // representation) — but ONLY when it was actually stored. A
    // wrong-dimension embedding is dropped to NULL by embeddingColumns(), and
    // echoing the rejected array back would tell the caller the record is
    // embedded when it isn't (embedding_model is already NULL), hiding it from
    // re-embed logic that gates on the returned value. Mirrors
    // updateMemoryEmbedding().
    mem.embedding = embeddingCol.value ? embedding : null;
    // Store related memories as links
    if (data.relatedMemories?.length > 0) {
      for (const relId of data.relatedMemories) {
        await client.query(
          'INSERT INTO memory_links (source_id, target_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, relId]
        );
      }
      mem.relatedMemories = data.relatedMemories;
    }

    return mem;
  });

  console.log(`🧠 Memory created: ${memory.type} - ${memory.summary.substring(0, 50)}...`);
  cosEvents.emit('memory:created', { id, type: memory.type, summary: memory.summary });

  return memory;
}

/**
 * Get a memory by ID
 */
export async function peekMemory(id) {
  const result = await query('SELECT * FROM memories WHERE id = $1', [id]);
  if (result.rows.length === 0) return null;
  return rowToMemory(result.rows[0]);
}

export async function getMemory(id) {
  const result = await query('SELECT * FROM memories WHERE id = $1', [id]);
  if (result.rows.length === 0) return null;

  // Update access stats
  await query(
    'UPDATE memories SET access_count = access_count + 1, last_accessed = NOW() WHERE id = $1',
    [id]
  );

  const memory = rowToMemory(result.rows[0]);
  memory.accessCount += 1;
  memory.lastAccessed = new Date().toISOString();

  // Load related memory IDs from links table
  const links = await query(
    'SELECT target_id FROM memory_links WHERE source_id = $1',
    [id]
  );
  memory.relatedMemories = links.rows.map(r => r.target_id);
  const replacements = await query(
    "SELECT source_id AS id FROM memory_links WHERE target_id = $1 AND link_type = 'supersedes' ORDER BY created_at",
    [id]
  );
  memory.supersededBy = replacements.rows.map(row => row.id);

  return memory;
}

// Historical rows describe the text replaced at createdAt; current lives in memories.
export async function getMemoryVersions(id, { limit = 20, offset = 0 } = {}) {
  const result = await query(
    'SELECT version, changed_by AS "changedBy", change_reason AS "changeReason", created_at AS "createdAt" FROM memory_versions WHERE memory_id = $1 ORDER BY version DESC LIMIT $2 OFFSET $3',
    [id, limit, offset]
  );
  return result.rows;
}

export async function getMemoryVersion(id, version) {
  const current = await peekMemory(id);
  if (!current) return null;
  if (current.version === version) return current;
  const result = await query(
    'SELECT memory_id AS id, version, content, summary, type, category, tags, changed_by AS "changedBy", change_reason AS "changeReason", created_at AS "createdAt" FROM memory_versions WHERE memory_id = $1 AND version = $2',
    [id, version]
  );
  return result.rows[0] ?? null;
}

/**
 * Build shared filters for memory list/count queries.
 */
function buildMemoryFilterWhere(options = {}) {
  const conditions = [];
  const params = [];
  let paramIdx = 1;

  // Filter by status
  const status = options.status || 'active';
  conditions.push(`status = $${paramIdx++}`);
  params.push(status);

  // Filter by types
  if (options.types?.length > 0) {
    conditions.push(`type = ANY($${paramIdx++})`);
    params.push(options.types);
  }

  // Filter by categories
  if (options.categories?.length > 0) {
    conditions.push(`category = ANY($${paramIdx++})`);
    params.push(options.categories);
  }

  // Filter by tags (any match)
  if (options.tags?.length > 0) {
    conditions.push(`tags && $${paramIdx++}`);
    params.push(options.tags);
  }

  // Filter by app
  if (options.appId === '__not_brain') {
    conditions.push(`(source_app_id IS NULL OR source_app_id != 'brain')`);
  } else if (options.appId) {
    conditions.push(`source_app_id = $${paramIdx++}`);
    params.push(options.appId);
  }


  if (options.sourceAgentId) {
    conditions.push(`source_agent_id = $${paramIdx++}`);
    params.push(options.sourceAgentId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

export async function countMemories(options = {}) {
  const { where, params } = buildMemoryFilterWhere(options);
  const countResult = await query(`SELECT COUNT(*) as total FROM memories ${where}`, params);
  return parseInt(countResult.rows[0].total, 10);
}

/**
 * Get memories with filters
 */
export async function getMemories(options = {}) {
  const { where, params } = buildMemoryFilterWhere(options);
  let paramIdx = params.length + 1;

  // Count total
  const countResult = await query(`SELECT COUNT(*) as total FROM memories ${where}`, params);
  const total = parseInt(countResult.rows[0].total, 10);

  // Sort and paginate
  const sortBy = {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    importance: 'importance',
    accessCount: 'access_count'
  }[options.sortBy] || 'created_at';
  const sortOrder = options.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const offset = options.offset || 0;
  const limit = options.limit || 50;

  const dataResult = await query(
    `SELECT id, type, category, tags, summary, importance, created_at, status, source_app_id, source_agent_id
     FROM memories ${where}
     ORDER BY ${sortBy} ${sortOrder}
     LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...params, limit, offset]
  );

  const memories = dataResult.rows.map(rowToMeta);
  return { total, memories };
}

/**
 * Update a memory
 */
export async function updateMemory(id, updates) {
  const memory = await withTransaction(async (client) => {
    const existing = await client.query('SELECT * FROM memories WHERE id = $1 FOR UPDATE', [id]);
    if (!existing.rows.length) return null;
    const row = existing.rows[0];
    if (updates.expectedVersion !== undefined && updates.expectedVersion !== row.version) {
      throw new ServerError('Memory changed since it was loaded. Reload before saving.', {
        status: 409, code: 'MEMORY_VERSION_CONFLICT'
      });
    }
    await client.query(
      "SELECT set_config('portos.memory_changed_by', $1, true), set_config('portos.memory_change_reason', $2, true)",
      [updates.changedBy ?? '', updates.changeReason ?? '']
    );
    const values = { ...updates };
    if (values.status === 'archived' && values.changeReason !== undefined) values.archiveReason = values.changeReason;
    if (typeof values.content === 'string' && values.summary === undefined) {
      values.summary = generateSummary(values.content);
    }
    const fieldMap = {
      content: 'content', summary: 'summary', type: 'type', category: 'category',
      tags: 'tags', confidence: 'confidence', importance: 'importance', status: 'status',
      expiresAt: 'expires_at', sourceAppId: 'source_app_id', archiveReason: 'archive_reason'
    };
    const params = [];
    const fields = Object.entries(fieldMap).filter(([key]) => values[key] !== undefined)
      .map(([key, column]) => { params.push(values[key]); return `${column} = $${params.length}`; });
    // The row trigger saves OLD and increments version in this same transaction,
    // including writes from sync. Operational-only writes do not create history.
    const updated = fields.length ? (await client.query(
      `UPDATE memories SET ${fields.join(', ')} WHERE id = $${params.length + 1} RETURNING *`,
      [...params, id]
    )).rows[0] : row;
    if (updates.relatedMemories) {
      // Legacy edits replace only the symmetric relation; preserve typed provenance.
      await client.query("DELETE FROM memory_links WHERE source_id = $1 AND link_type = 'related'", [id]);
      if (updates.relatedMemories.length) {
        const slots = updates.relatedMemories.map((_, i) => `($1, $${i + 2})`).join(', ');
        await client.query(`INSERT INTO memory_links (source_id, target_id) VALUES ${slots} ON CONFLICT DO NOTHING`,
          [id, ...updates.relatedMemories]);
      }
      await client.query('UPDATE memories SET updated_at = NOW() WHERE id = $1', [id]);
    }
    const links = await client.query('SELECT target_id FROM memory_links WHERE source_id = $1', [id]);
    return { ...rowToMemory(updated), relatedMemories: links.rows.map(link => link.target_id) };
  });
  if (!memory) return null;

  console.log(`🧠 Memory updated: ${id}`);
  cosEvents.emit('memory:updated', { id, updates });

  return memory;
}

/**
 * Update a memory's embedding
 */
export async function updateMemoryEmbedding(id, embedding) {
  const embeddingCol = embeddingColumns(embedding);
  const result = await query(
    `UPDATE memories SET embedding = $1, embedding_model = $2 WHERE id = $3 RETURNING *`,
    [embeddingCol.value, embeddingCol.model, id]
  );

  if (result.rows.length === 0) return null;

  const memory = rowToMemory(result.rows[0]);
  memory.embedding = embeddingCol.value ? embedding : null;

  console.log(`🧠 Memory embedding updated: ${id}`);
  return memory;
}

/**
 * Archive a memory: mark it archived; the row and embedding stay, so it is restorable.
 */
async function retireMemory(id, { reason, supersededBy }, expectedStatus) {
  if (supersededBy === id) throw new ServerError('A memory cannot replace itself', { status: 400 });
  return withTransaction(async client => {
    const ids = supersededBy ? [id, supersededBy].sort() : [id];
    const locked = await client.query('SELECT id, status, source_agent_id FROM memories WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
    const row = locked.rows.find(item => item.id === id);
    if (!row) return { success: false, error: 'Memory not found' };
    if (expectedStatus && row.status !== expectedStatus) return { success: false, error: 'Memory is not pending approval' };
    if (locked.rows.length !== ids.length) throw new ServerError('Replacement memory not found', { status: 404 });
    await client.query("UPDATE memories SET status = 'archived', archive_reason = $2 WHERE id = $1", [id, reason ?? null]);
    if (supersededBy) {
      await client.query(
        "INSERT INTO memory_links (source_id, target_id, link_type, note) VALUES ($1, $2, 'supersedes', $3) ON CONFLICT DO NOTHING",
        [supersededBy, id, reason ?? null]
      );
    }
    return { success: true, sourceAgentId: row.source_agent_id };
  });
}

export async function archiveMemory(id, options = {}) {
  const result = await retireMemory(id, options);
  if (!result.success) throw new ServerError(result.error, { status: 404 });
  console.log(`🧠 Memory archived: ${id}`);
  cosEvents.emit('memory:deleted', { id, hard: false });
  return { success: true, id };
}

/**
 * Purge a memory: DELETE the row (cascades to memory_links) and its embedding. Not restorable.
 */
export async function purgeMemory(id) {
  await query('DELETE FROM memories WHERE id = $1', [id]);

  console.log(`🧠 Memory purged: ${id}`);
  cosEvents.emit('memory:deleted', { id, hard: true });

  return { success: true, id };
}

/**
 * Approve a pending memory
 */
export async function approveMemory(id) {
  const result = await query("UPDATE memories SET status = 'active' WHERE id = $1 AND status = 'pending_approval' RETURNING *", [id]);
  if (!result.rows.length) {
    const existing = await peekMemory(id);
    return { success: false, error: existing ? 'Memory is not pending approval' : 'Memory not found' };
  }
  const row = result.rows[0];

  console.log(`🧠 Memory approved: ${id}`);
  const memory = rowToMemory({ ...row, status: 'active' });
  cosEvents.emit('memory:approved', { id, memory });

  await notifications.removeByMetadata('memoryId', id);
  await decrementAgentPendingApproval(row.source_agent_id);

  return { success: true, memory };
}

/**
 * Reject a pending memory, retaining its text and rejection reason
 */
export async function rejectMemory(id, options = {}) {
  const result = await retireMemory(id, { ...options, reason: options.reason ?? 'Rejected' }, 'pending_approval');
  if (!result.success) return result;
  const { sourceAgentId } = result;

  console.log(`🧠 Memory rejected: ${id}`);
  cosEvents.emit('memory:rejected', { id });

  await notifications.removeByMetadata('memoryId', id);
  await decrementAgentPendingApproval(sourceAgentId);

  return { success: true, id };
}

// =============================================================================
// Search Operations
// =============================================================================

/**
 * Search memories semantically using pgvector cosine similarity
 */
export async function searchMemories(queryEmbedding, options = {}) {
  if (!queryEmbedding) return { total: 0, memories: [] };

  const minRelevance = options.minRelevance || 0.7;
  const limit = options.limit || 20;

  const conditions = ["status = 'active'"];
  const params = [arrayToPgvector(queryEmbedding), minRelevance, limit];
  let paramIdx = 4;

  if (options.types?.length > 0) {
    conditions.push(`type = ANY($${paramIdx++})`);
    params.push(options.types);
  }
  if (options.categories?.length > 0) {
    conditions.push(`category = ANY($${paramIdx++})`);
    params.push(options.categories);
  }
  if (options.tags?.length > 0) {
    conditions.push(`tags && $${paramIdx++}`);
    params.push(options.tags);
  }
  if (options.appId === '__not_brain') {
    conditions.push(`(source_app_id IS NULL OR source_app_id != 'brain')`);
  } else if (options.appId) {
    conditions.push(`source_app_id = $${paramIdx++}`);
    params.push(options.appId);
  }

  const where = conditions.join(' AND ');

  // Use pgvector cosine distance operator <=>
  // Cosine distance = 1 - cosine_similarity, so similarity = 1 - distance
  const result = await query(
    `SELECT id, type, category, tags, summary, importance, created_at, status, source_app_id,
            1 - (embedding <=> $1) AS similarity
     FROM memories
     WHERE embedding IS NOT NULL AND ${where}
       AND 1 - (embedding <=> $1) >= $2
     ORDER BY embedding <=> $1
     LIMIT $3`,
    params
  );

  const memories = result.rows.map(row => ({
    ...rowToMeta(row),
    similarity: parseFloat(row.similarity)
  }));

  return { total: memories.length, memories };
}

/**
 * Hybrid search combining full-text (tsvector) and vector similarity
 * Uses Reciprocal Rank Fusion (RRF) to merge rankings
 */
export async function hybridSearchMemories(queryText, queryEmbedding, options = {}) {
  const { limit = 20, minRelevance = 0.5, ftsWeight = options.bm25Weight ?? 0.4, vectorWeight = 0.6 } = options;
  const RRF_K = 60;

  const filterConditions = ["status = 'active'"];
  const filterParams = [];
  let paramIdx = 1;

  if (options.types?.length > 0) {
    filterConditions.push(`type = ANY($${paramIdx++})`);
    filterParams.push(options.types);
  }
  if (options.categories?.length > 0) {
    filterConditions.push(`category = ANY($${paramIdx++})`);
    filterParams.push(options.categories);
  }
  if (options.tags?.length > 0) {
    filterConditions.push(`tags && $${paramIdx++}`);
    filterParams.push(options.tags);
  }
  if (options.appId === '__not_brain') {
    filterConditions.push(`(source_app_id IS NULL OR source_app_id != 'brain')`);
  } else if (options.appId) {
    filterConditions.push(`source_app_id = $${paramIdx++}`);
    filterParams.push(options.appId);
  }

  const filterWhere = filterConditions.join(' AND ');
  const fetchLimit = limit * 2;

  // Get full-text search results (replaces BM25)
  let ftsResults = [];
  if (queryText) {
    const ftsResult = await query(
      `SELECT id, type, category, tags, summary, importance, created_at, status, source_app_id,
              ts_rank(to_tsvector('english', coalesce(content, '') || ' ' || coalesce(summary, '')),
                      websearch_to_tsquery('english', $${paramIdx})) AS fts_score
       FROM memories
       WHERE ${filterWhere}
         AND to_tsvector('english', coalesce(content, '') || ' ' || coalesce(summary, ''))
             @@ websearch_to_tsquery('english', $${paramIdx})
       ORDER BY fts_score DESC
       LIMIT $${paramIdx + 1}`,
      [...filterParams, queryText, fetchLimit]
    );
    ftsResults = ftsResult.rows;
  }

  // Get vector similarity results
  let vectorResults = [];
  if (queryEmbedding) {
    const vecParamStart = filterParams.length + 1;
    const vectorResult = await query(
      `SELECT id, type, category, tags, summary, importance, created_at, status, source_app_id,
              1 - (embedding <=> $${vecParamStart}) AS similarity
       FROM memories
       WHERE embedding IS NOT NULL AND ${filterWhere}
         AND 1 - (embedding <=> $${vecParamStart}) >= $${vecParamStart + 1}
       ORDER BY embedding <=> $${vecParamStart}
       LIMIT $${vecParamStart + 2}`,
      [...filterParams, arrayToPgvector(queryEmbedding), minRelevance * 0.5, fetchLimit]
    );
    vectorResults = vectorResult.rows;
  }

  // Apply Reciprocal Rank Fusion
  const rrfScores = new Map();

  ftsResults.forEach((row, rank) => {
    const current = rrfScores.get(row.id) || { row, ftsRank: null, vectorRank: null, rrfScore: 0 };
    current.row = row;
    current.ftsRank = rank + 1;
    current.rrfScore += ftsWeight / (RRF_K + rank + 1);
    rrfScores.set(row.id, current);
  });

  vectorResults.forEach((row, rank) => {
    const current = rrfScores.get(row.id) || { row, ftsRank: null, vectorRank: null, rrfScore: 0 };
    if (!current.row) current.row = row;
    current.vectorRank = rank + 1;
    current.rrfScore += vectorWeight / (RRF_K + rank + 1);
    rrfScores.set(row.id, current);
  });

  const results = Array.from(rrfScores.values())
    .map(data => ({
      ...rowToMeta(data.row),
      rrfScore: data.rrfScore,
      ftsRank: data.ftsRank,
      vectorRank: data.vectorRank,
      searchMethod: data.ftsRank && data.vectorRank ? 'hybrid' :
                   data.ftsRank ? 'fts' : 'vector'
    }))
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit);

  return { total: results.length, memories: results };
}

/**
 * Rebuild the BM25 index — no-op for PostgreSQL (tsvector is automatic)
 */
export async function rebuildBM25Index() {
  // tsvector indexes are maintained automatically by PostgreSQL
  // This function exists for API compatibility
  const result = await query("SELECT COUNT(*) as count FROM memories WHERE status = 'active'");
  return { rebuilt: true, documents: parseInt(result.rows[0].count, 10) };
}

/**
 * Get BM25/FTS stats
 */
export async function getBM25Stats() {
  const totalResult = await query("SELECT COUNT(*) as total FROM memories WHERE status = 'active'");

  return {
    documentCount: parseInt(totalResult.rows[0].total, 10),
    backend: 'postgresql-tsvector'
  };
}

// =============================================================================
// Aggregation & Timeline
// =============================================================================

/**
 * Get timeline data (memories grouped by date)
 */
export async function getTimeline(options = {}) {
  const conditions = ["status = 'active'"];
  const params = [];
  let paramIdx = 1;

  if (options.startDate) {
    conditions.push(`created_at >= $${paramIdx++}`);
    params.push(options.startDate);
  }
  if (options.endDate) {
    conditions.push(`created_at <= $${paramIdx++}`);
    params.push(options.endDate);
  }
  if (options.types?.length > 0) {
    conditions.push(`type = ANY($${paramIdx++})`);
    params.push(options.types);
  }
  if (options.appId === '__not_brain') {
    conditions.push(`(source_app_id IS NULL OR source_app_id != 'brain')`);
  } else if (options.appId) {
    conditions.push(`source_app_id = $${paramIdx++}`);
    params.push(options.appId);
  }

  const where = conditions.join(' AND ');
  const limit = options.limit || 100;

  const result = await query(
    `SELECT id, type, category, tags, summary, importance, created_at, status, source_app_id
     FROM memories WHERE ${where}
     ORDER BY created_at DESC
     LIMIT $${paramIdx}`,
    [...params, limit]
  );

  // Group by date
  const timeline = {};
  for (const row of result.rows) {
    const meta = rowToMeta(row);
    const date = meta.createdAt.split('T')[0];
    if (!timeline[date]) timeline[date] = [];
    timeline[date].push(meta);
  }

  return timeline;
}

/**
 * Get all unique categories with counts
 */
export async function getCategories() {
  const result = await query(`
    SELECT category AS name, COUNT(*) AS count
    FROM memories WHERE status = 'active'
    GROUP BY category
    ORDER BY count DESC
  `);
  return result.rows.map(r => ({ name: r.name, count: parseInt(r.count, 10) }));
}

/**
 * Get all unique tags with counts
 */
export async function getTags() {
  const result = await query(`
    SELECT tag AS name, COUNT(*) AS count
    FROM memories, LATERAL unnest(tags) AS tag
    WHERE status = 'active'
    GROUP BY tag
    ORDER BY count DESC
  `);
  return result.rows.map(r => ({ name: r.name, count: parseInt(r.count, 10) }));
}

// =============================================================================
// Relationships
// =============================================================================

/**
 * Get related memories (by links + embedding similarity)
 */
export async function getRelatedMemories(id, limit = 10) {
  const existing = await query('SELECT embedding FROM memories WHERE id = $1', [id]);
  if (existing.rows.length === 0) return [];

  const related = [];

  // Get explicitly linked memories
  // Symmetric links are stored as a reverse pair, so the outgoing row covers
  // them; a directed link is one row, so also read the ones pointing AT this
  // memory (direction 'incoming') or "B supersedes A" would be invisible from A.
  const links = await query(`
    SELECT m.id, m.type, m.category, m.tags, m.summary, m.importance, m.created_at, m.status, m.source_app_id,
           ml.id AS link_id, ml.link_type, ml.note, ml.created_by,
           CASE WHEN ml.source_id = $1 THEN 'outgoing' ELSE 'incoming' END AS direction
    FROM memory_links ml
    JOIN memories m ON m.id = CASE WHEN ml.source_id = $1 THEN ml.target_id ELSE ml.source_id END
    WHERE (ml.source_id = $1 OR (ml.target_id = $1 AND ml.link_type <> 'related'))
      AND m.status = 'active'
    ORDER BY ml.created_at
  `, [id]);

  for (const row of links.rows) {
    related.push({
      ...rowToMeta(row),
      relationship: 'linked',
      similarity: 1.0,
      linkId: row.link_id,
      linkType: row.link_type,
      direction: row.direction,
      note: row.note,
      createdBy: row.created_by
    });
  }

  // Get similar by embedding
  const embedding = existing.rows[0].embedding;
  if (embedding) {
    const seenIds = new Set([id, ...related.map(r => r.id)]);
    const remaining = limit - related.length;

    const similar = await query(`
      SELECT id, type, category, tags, summary, importance, created_at, status, source_app_id,
             1 - (embedding <=> $1) AS similarity
      FROM memories
      WHERE id != $2 AND embedding IS NOT NULL AND status = 'active'
      ORDER BY embedding <=> $1
      LIMIT $3
    `, [embedding, id, remaining]);

    for (const row of similar.rows) {
      if (seenIds.has(row.id)) continue;
      related.push({
        ...rowToMeta(row),
        relationship: 'similar',
        similarity: parseFloat(row.similarity)
      });
    }
  }

  return related.slice(0, limit);
}

// Optional caller scope for getGraphData: absent (undefined/null) means the
// whole CoS graph; an array — even an empty one — restricts output to edges
// whose BOTH endpoints are in it. A non-UUID id can never name a memory row, so
// dropping it before the ::uuid[] cast changes no result and avoids a cast error.
function graphScope(sourceIds) {
  if (sourceIds === undefined || sourceIds === null) return null;
  if (!Array.isArray(sourceIds)) throw new TypeError('getGraphData: sourceIds must be an array');
  return [...new Set(sourceIds.filter(id => typeof id === 'string' && UUID_RE.test(id)))];
}

/**
 * Get graph data for visualization.
 *
 * `sourceIds` (internal, optional) scopes the read to the records a caller can
 * actually display (#10953): nodes and explicit links are restricted to the
 * scope, and only scoped memories are scored as similarity SOURCES. The target
 * population, the global top-three cutoff, the threshold and the active-record
 * rules are unchanged, so an out-of-scope nearest neighbour still occupies its
 * slot — the scoped edges are exactly the full graph's edges with both
 * endpoints in scope. Omitted, the full graph is returned unchanged.
 */
export async function getGraphData({ sourceIds } = {}) {
  const scope = graphScope(sourceIds);
  if (scope && scope.length === 0) return { nodes: [], edges: [] };
  const scopeParams = scope ? [scope] : [];
  return withTransaction(async (client) => {
    // Admission and all graph reads must share a snapshot: a concurrent insert
    // cannot grow the optimized projection beyond the node count checked here.
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    // Build nodes
    const nodesResult = await client.query(`
      SELECT id, type, category, summary, importance
      FROM memories WHERE status = 'active'${scope ? ' AND id = ANY($1::uuid[])' : ''}
    `, scopeParams);

    const nodes = nodesResult.rows.map(r => ({
      id: r.id,
      type: r.type,
      category: r.category,
      summary: r.summary,
      importance: r.importance
    }));

    // The materialization bound counts EVERY active record, scoped or not: the
    // CTE below still projects the whole active embedding population.
    const activeCount = scope
      ? (await client.query("SELECT count(*)::int AS count FROM memories WHERE status = 'active'")).rows[0].count
      : nodes.length;

    // Build edges from explicit links
    // A symmetric 'related' pair is stored twice; keep one row per pair. Directed
    // types are one row each and keep their source -> target orientation.
    const linksResult = await client.query(`
      SELECT ml.source_id AS source, ml.target_id AS target, ml.link_type
      FROM memory_links ml
      JOIN memories ms ON ms.id = ml.source_id AND ms.status = 'active'
      JOIN memories mt ON mt.id = ml.target_id AND mt.status = 'active'
      WHERE (ml.link_type <> 'related' OR ml.source_id < ml.target_id)
        ${scope ? 'AND ml.source_id = ANY($1::uuid[]) AND ml.target_id = ANY($1::uuid[])' : ''}
    `, scopeParams);

    const edges = linksResult.rows.map(r => ({
      source: r.source,
      target: r.target,
      type: 'linked',
      linkType: r.link_type,
      weight: 1.0
    }));

    // Add similarity edges (top 3 per node, >= 0.8 similarity)
    // Exact top-three scoring still does O(n²) distance work. For bounded graphs,
    // unpack each stored vector once, avoiding repeated TOAST reads per candidate.
    // A bare materialized embedding retains its external storage pointer; the
    // real[] round trip forces an inline vector without changing its float values.
    const materialize = activeCount <= 2048;
    if (materialize) await client.query("SET LOCAL work_mem = '32MB'");
    const relation = materialize ? 'active_embeddings' : 'memories';
    const seenEdges = new Set(edges.map(e => [e.source, e.target].sort().join('-')));

    // A scope restricts the OUTER sources before the lateral loop (so only M
    // sources are scored against all N candidates) and filters targets only
    // AFTER the LIMIT 3 — filtering candidates first would promote a fourth-
    // ranked in-scope memory into a slot an out-of-scope neighbour holds.
    const simResult = await client.query(`
      ${materialize ? `WITH active_embeddings AS MATERIALIZED (
        SELECT id, embedding::real[]::vector AS embedding
        FROM memories WHERE embedding IS NOT NULL AND status = 'active'
      )` : ''}
      SELECT a.id AS source_id, b.id AS target_id,
             1 - (a.embedding <=> b.embedding) AS similarity
      FROM ${relation} a
      CROSS JOIN LATERAL (
        SELECT id, embedding
        FROM ${relation}
        WHERE id != a.id
          ${materialize ? '' : "AND embedding IS NOT NULL AND status = 'active'"}
        ORDER BY embedding <=> a.embedding
        LIMIT 3
      ) b
      WHERE 1 - (a.embedding <=> b.embedding) >= 0.8
        ${materialize ? '' : "AND a.embedding IS NOT NULL AND a.status = 'active'"}
        ${scope ? 'AND a.id = ANY($1::uuid[]) AND b.id = ANY($1::uuid[])' : ''}
    `, scopeParams);

    for (const row of simResult.rows) {
      const edgeKey = [row.source_id, row.target_id].sort().join('-');
      if (!seenEdges.has(edgeKey)) {
        seenEdges.add(edgeKey);
        edges.push({
          source: row.source_id,
          target: row.target_id,
          type: 'similar',
          weight: parseFloat(row.similarity)
        });
      }
    }

    return { nodes, edges };
  });
}

/**
 * Ids of active memories with a NULL embedding — the backfill target for
 * "embed missing" (a record whose embedding generation failed or never ran).
 * Returned as a Set for O(1) membership tests by the bridge.
 */
export async function getMemoryIdsMissingEmbedding() {
  const result = await query(`
    SELECT id FROM memories WHERE embedding IS NULL AND status = 'active'
  `);
  return new Set(result.rows.map(r => r.id));
}

/**
 * Link two memories
 */
export async function linkMemories(sourceId, targetId, { linkType = DEFAULT_MEMORY_LINK_TYPE, note = null, createdBy = 'user' } = {}) {
  // Verify both exist
  const check = await query(
    'SELECT id FROM memories WHERE id = ANY($1)',
    [[sourceId, targetId]]
  );
  if (check.rows.length < 2) return { success: false, error: 'Memory not found' };

  // Only the symmetric 'related' type gets a reverse row; a directed type is one row.
  const values = isSymmetricMemoryLinkType(linkType)
    ? '($1, $2, $3, $4, $5), ($2, $1, $3, $4, $5)'
    : '($1, $2, $3, $4, $5)';
  await query(
    `INSERT INTO memory_links (source_id, target_id, link_type, note, created_by) VALUES ${values}
     ON CONFLICT DO NOTHING`,
    [sourceId, targetId, linkType, note, createdBy]
  );

  const stored = await query(
    'SELECT id FROM memory_links WHERE source_id = $1 AND target_id = $2 AND link_type = $3',
    [sourceId, targetId, linkType]
  );
  return { success: true, sourceId, targetId, linkType, linkId: stored.rows[0]?.id ?? null };
}

// =============================================================================
// Maintenance Operations
// =============================================================================

/**
 * Consolidate similar memories (merge duplicates)
 */
export async function consolidateMemories(threshold = 0.9, dryRun = false, { reason = 'Consolidated duplicate' } = {}) {
  // Use per-row KNN via HNSW index to find near-duplicates (avoids O(n²) self-join)
  const result = await query(`
    SELECT a.id AS id_a, a.summary AS summary_a, a.importance AS importance_a,
           b.id AS id_b, b.summary AS summary_b, b.importance AS importance_b,
           1 - (a.embedding <=> b.embedding) AS similarity
    FROM memories a
    CROSS JOIN LATERAL (
      SELECT id, summary, importance, embedding
      FROM memories
      WHERE id > a.id AND embedding IS NOT NULL AND status = 'active'
        AND NOT (COALESCE(tags, '{}'::text[]) && $2::text[])
      ORDER BY embedding <=> a.embedding
      LIMIT 5
    ) b
    WHERE a.embedding IS NOT NULL AND a.status = 'active'
      AND NOT (COALESCE(a.tags, '{}'::text[]) && $2::text[])
      AND 1 - (a.embedding <=> b.embedding) >= $1
    ORDER BY similarity DESC
  `, [threshold, protectedMindMemoryTags]);

  // Build clusters using union-find
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
    return parent.get(x);
  };
  const union = (a, b) => parent.set(find(a), find(b));

  for (const row of result.rows) {
    union(row.id_a, row.id_b);
  }

  // Group by cluster root
  const clusters = new Map();
  const allIds = new Set();
  for (const row of result.rows) {
    allIds.add(row.id_a);
    allIds.add(row.id_b);
  }

  const summaryMap = new Map();
  for (const row of result.rows) {
    summaryMap.set(row.id_a, row.summary_a);
    summaryMap.set(row.id_b, row.summary_b);
  }

  for (const id of allIds) {
    const root = find(id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(id);
  }

  const duplicateClusters = Array.from(clusters.values()).filter(c => c.length > 1);

  if (dryRun) {
    return {
      dryRun: true,
      clustersFound: duplicateClusters.length,
      memoriesAffected: duplicateClusters.reduce((sum, c) => sum + c.length, 0),
      clusters: duplicateClusters.map(c => c.map(id => ({
        id,
        summary: summaryMap.get(id) || ''
      })))
    };
  }

  const archivedIds = await withTransaction(async client => {
    // Lock the complete candidate set in a stable order before choosing keepers.
    // Concurrent consolidation cannot retire a keeper selected from stale state.
    const locked = await client.query(
      "SELECT id, importance FROM memories WHERE id = ANY($1::uuid[]) AND status = 'active' AND NOT (COALESCE(tags, '{}'::text[]) && $2::text[]) ORDER BY id FOR UPDATE",
      [[...allIds], protectedMindMemoryTags]
    );
    const active = new Map(locked.rows.map(row => [row.id, row.importance]));
    const archived = [];
    for (const cluster of duplicateClusters) {
      const members = cluster.filter(id => active.has(id))
        .sort((a, b) => active.get(b) - active.get(a) || a.localeCompare(b));
      if (members.length < 2) continue;
      const [keeper, ...duplicates] = members;
      await client.query("UPDATE memories SET status = 'archived', archive_reason = $2 WHERE id = ANY($1::uuid[])", [duplicates, reason]);
      await client.query(
        "INSERT INTO memory_links (source_id, target_id, link_type, note) SELECT $1::uuid, unnest($2::uuid[]), 'supersedes', $3 ON CONFLICT DO NOTHING",
        [keeper, duplicates, reason]
      );
      archived.push(...duplicates);
    }
    return archived;
  });
  const merged = archivedIds.length;
  for (const id of archivedIds) cosEvents.emit('memory:deleted', { id, hard: false });

  console.log(`🧠 Consolidated ${merged} duplicate memories into ${duplicateClusters.length} clusters`);
  return { merged, clusters: duplicateClusters.length };
}

/**
 * Apply importance decay to old memories
 */
export async function applyDecay(decayRate = 0.01) {
  // Set-based decay: archive old low-importance memories and decay the rest in bulk
  const archived = await withTransaction(async (client) => {
    // Archive memories that have decayed below threshold and are older than 30 days
    const archiveResult = await client.query(`
      UPDATE memories SET status = 'archived',
        importance = GREATEST(0.1,
          importance * (1 - $1 * sqrt(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0))
          + GREATEST(0, 0.1 - EXTRACT(EPOCH FROM (NOW() - COALESCE(last_accessed, created_at))) / 86400.0 * 0.001)
        )
      WHERE status = 'active'
        AND NOT (COALESCE(tags, '{}'::text[]) && $2::text[])
        AND created_at < NOW() - INTERVAL '30 days'
        AND GREATEST(0.1,
          importance * (1 - $1 * sqrt(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0))
          + GREATEST(0, 0.1 - EXTRACT(EPOCH FROM (NOW() - COALESCE(last_accessed, created_at))) / 86400.0 * 0.001)
        ) < 0.15
    `, [decayRate, protectedMindMemoryTags]);

    // Decay importance for remaining active memories where change exceeds threshold
    const decayResult = await client.query(`
      UPDATE memories SET importance = GREATEST(0.1,
        importance * (1 - $1 * sqrt(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0))
        + GREATEST(0, 0.1 - EXTRACT(EPOCH FROM (NOW() - COALESCE(last_accessed, created_at))) / 86400.0 * 0.001)
      )
      WHERE status = 'active'
        AND NOT (COALESCE(tags, '{}'::text[]) && $2::text[])
        AND abs(importance - GREATEST(0.1,
          importance * (1 - $1 * sqrt(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0))
          + GREATEST(0, 0.1 - EXTRACT(EPOCH FROM (NOW() - COALESCE(last_accessed, created_at))) / 86400.0 * 0.001)
        )) > 0.01
    `, [decayRate, protectedMindMemoryTags]);

    return archiveResult.rowCount + decayResult.rowCount;
  });

  console.log(`🧠 Decay applied to ${archived} memories`);
  return { updated: archived };
}

/**
 * Clear expired memories
 */
export async function clearExpired() {
  const result = await query(`
    UPDATE memories SET status = 'expired'
    WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < NOW()
      AND NOT (COALESCE(tags, '{}'::text[]) && $1::text[])
  `, [protectedMindMemoryTags]);

  const cleared = result.rowCount;
  console.log(`🧠 Cleared ${cleared} expired memories`);
  return { cleared };
}

// =============================================================================
// Stats
// =============================================================================

/**
 * Get memory stats
 */
export async function getStats() {
  const result = await query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'active') AS active,
      COUNT(*) FILTER (WHERE status = 'archived') AS archived,
      COUNT(*) FILTER (WHERE status = 'expired') AS expired,
      COUNT(*) FILTER (WHERE status = 'pending_approval') AS pending_approval,
      COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS with_embeddings,
      MAX(updated_at) AS last_updated
    FROM memories
  `);

  const row = result.rows[0];

  // Type breakdown
  const typeResult = await query(`
    SELECT type, COUNT(*) AS count FROM memories GROUP BY type
  `);
  const byType = {};
  for (const r of typeResult.rows) byType[r.type] = parseInt(r.count, 10);

  // Category breakdown
  const catResult = await query(`
    SELECT category, COUNT(*) AS count FROM memories GROUP BY category
  `);
  const byCategory = {};
  for (const r of catResult.rows) byCategory[r.category] = parseInt(r.count, 10);

  return {
    total: parseInt(row.total, 10),
    active: parseInt(row.active, 10),
    archived: parseInt(row.archived, 10),
    expired: parseInt(row.expired, 10),
    pendingApproval: parseInt(row.pending_approval, 10),
    withEmbeddings: parseInt(row.with_embeddings, 10),
    byType,
    byCategory,
    lastUpdated: row.last_updated?.toISOString() ?? null
  };
}

/**
 * Invalidate caches — no-op for PostgreSQL (no in-memory caches)
 */
export function invalidateCaches() {
  // PostgreSQL handles all caching internally
}

/**
 * Flush BM25 index — no-op for PostgreSQL (tsvector is always consistent)
 */
export async function flushBM25Index() {
  // No-op: tsvector indexes are maintained transactionally
}

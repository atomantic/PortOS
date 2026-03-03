/**
 * Memory Service — PostgreSQL + pgvector Backend
 *
 * Drop-in replacement for memory.js (file-based) using PostgreSQL with pgvector
 * for vector similarity search and tsvector for full-text search.
 *
 * Same exported interface as memory.js so routes/consumers don't change.
 */

import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../lib/db.js';
import { cosEvents, updateAgent } from './cos.js';
import * as notifications from './notifications.js';

// Default memory configuration (same as file-based version)
export const DEFAULT_MEMORY_CONFIG = {
  enabled: true,
  embeddingProvider: 'lmstudio',
  embeddingEndpoint: 'http://localhost:1234/v1/embeddings',
  embeddingModel: 'text-embedding-nomic-embed-text-v2-moe',
  embeddingDimension: 768,
  maxMemories: 10000,
  maxContextTokens: 2000,
  minRelevanceThreshold: 0.7,
  autoExtractEnabled: true,
  consolidationIntervalMs: 86400000,
  decayIntervalMs: 86400000
};

/**
 * Generate summary from content using simple truncation
 */
function generateSummary(content, maxLength = 150) {
  if (content.length <= maxLength) return content;
  return content.substring(0, maxLength - 3) + '...';
}

/**
 * Convert a database row to the memory object format matching the file-based API
 */
function rowToMemory(row) {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    summary: row.summary,
    category: row.category,
    tags: row.tags || [],
    relatedMemories: row.related_memories || [],
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
    status: row.status
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
    sourceAppId: row.source_app_id
  };
}

/**
 * Convert pgvector string representation to float array.
 * pgvector returns vectors as '[0.1,0.2,...]' strings.
 */
function pgvectorToArray(vec) {
  if (Array.isArray(vec)) return vec;
  if (typeof vec === 'string') {
    return vec.replace(/^\[|\]$/g, '').split(',').map(Number);
  }
  return null;
}

/**
 * Format a float array as pgvector literal '[0.1,0.2,...]'
 */
function arrayToPgvector(arr) {
  if (!arr) return null;
  return `[${arr.join(',')}]`;
}

// =============================================================================
// CRUD Operations
// =============================================================================

/**
 * Create a new memory
 */
export async function createMemory(data, embedding = null) {
  const id = uuidv4();
  const summary = data.summary || generateSummary(data.content);
  const now = new Date().toISOString();

  const result = await query(
    `INSERT INTO memories (
      id, type, content, summary, category, tags,
      embedding, embedding_model, confidence, importance,
      source_task_id, source_agent_id, source_app_id,
      expires_at, status, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10,
      $11, $12, $13,
      $14, $15, $16, $17
    ) RETURNING *`,
    [
      id, data.type, data.content, summary, data.category || 'other', data.tags || [],
      embedding ? arrayToPgvector(embedding) : null,
      embedding ? DEFAULT_MEMORY_CONFIG.embeddingModel : null,
      data.confidence ?? 0.8, data.importance ?? 0.5,
      data.sourceTaskId || null, data.sourceAgentId || null, data.sourceAppId || null,
      data.expiresAt || null, data.status || 'active', now, now
    ]
  );

  const memory = rowToMemory(result.rows[0]);
  // Attach the original embedding array (pgvector may return string representation)
  if (embedding) memory.embedding = embedding;
  // Store related memories as links
  if (data.relatedMemories?.length > 0) {
    for (const relId of data.relatedMemories) {
      await query(
        'INSERT INTO memory_links (source_id, target_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, relId]
      );
    }
    memory.relatedMemories = data.relatedMemories;
  }

  console.log(`🧠 Memory created: ${memory.type} - ${memory.summary.substring(0, 50)}...`);
  cosEvents.emit('memory:created', { id, type: memory.type, summary: memory.summary });

  return memory;
}

/**
 * Get a memory by ID
 */
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

  return memory;
}

/**
 * Get memories with filters
 */
export async function getMemories(options = {}) {
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
  if (options.appId) {
    conditions.push(`source_app_id = $${paramIdx++}`);
    params.push(options.appId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

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
    `SELECT id, type, category, tags, summary, importance, created_at, status, source_app_id
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
  // Check memory exists
  const existing = await query('SELECT * FROM memories WHERE id = $1', [id]);
  if (existing.rows.length === 0) return null;

  const fields = [];
  const params = [];
  let paramIdx = 1;

  const fieldMap = {
    content: 'content',
    summary: 'summary',
    category: 'category',
    tags: 'tags',
    confidence: 'confidence',
    importance: 'importance',
    status: 'status',
    expiresAt: 'expires_at',
    sourceAppId: 'source_app_id'
  };

  for (const [jsField, dbField] of Object.entries(fieldMap)) {
    if (updates[jsField] !== undefined) {
      fields.push(`${dbField} = $${paramIdx++}`);
      params.push(updates[jsField]);
    }
  }

  // Update summary if content changed but no explicit summary
  if (updates.content && !updates.summary) {
    fields.push(`summary = $${paramIdx++}`);
    params.push(generateSummary(updates.content));
  }

  if (fields.length === 0) return rowToMemory(existing.rows[0]);

  params.push(id);
  const result = await query(
    `UPDATE memories SET ${fields.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
    params
  );

  const memory = rowToMemory(result.rows[0]);

  // Load related memories
  const links = await query('SELECT target_id FROM memory_links WHERE source_id = $1', [id]);
  memory.relatedMemories = links.rows.map(r => r.target_id);

  // Update related memories if provided
  if (updates.relatedMemories) {
    await query('DELETE FROM memory_links WHERE source_id = $1', [id]);
    for (const relId of updates.relatedMemories) {
      await query(
        'INSERT INTO memory_links (source_id, target_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, relId]
      );
    }
    memory.relatedMemories = updates.relatedMemories;
  }

  console.log(`🧠 Memory updated: ${id}`);
  cosEvents.emit('memory:updated', { id, updates });

  return memory;
}

/**
 * Update a memory's embedding
 */
export async function updateMemoryEmbedding(id, embedding) {
  const result = await query(
    `UPDATE memories SET embedding = $1, embedding_model = $2 WHERE id = $3 RETURNING *`,
    [arrayToPgvector(embedding), DEFAULT_MEMORY_CONFIG.embeddingModel, id]
  );

  if (result.rows.length === 0) return null;

  const memory = rowToMemory(result.rows[0]);
  memory.embedding = embedding;

  console.log(`🧠 Memory embedding updated: ${id}`);
  return memory;
}

/**
 * Delete a memory (soft delete by default)
 */
export async function deleteMemory(id, hard = false) {
  if (hard) {
    // Hard delete — cascades to memory_links via ON DELETE CASCADE
    await query('DELETE FROM memories WHERE id = $1', [id]);
  } else {
    // Soft delete — mark as archived
    await query("UPDATE memories SET status = 'archived' WHERE id = $1", [id]);
  }

  console.log(`🧠 Memory deleted: ${id} (hard: ${hard})`);
  cosEvents.emit('memory:deleted', { id, hard });

  return { success: true, id };
}

/**
 * Helper to decrement agent's pendingApproval count
 */
async function decrementAgentPendingApproval(sourceAgentId) {
  if (!sourceAgentId) return;

  const { getAgent } = await import('./cos.js');
  const agent = await getAgent(sourceAgentId).catch(() => null);
  if (!agent?.memoryExtraction?.pendingApproval) return;

  const currentPending = agent.memoryExtraction.pendingApproval;
  if (currentPending > 0) {
    await updateAgent(sourceAgentId, {
      memoryExtraction: {
        ...agent.memoryExtraction,
        pendingApproval: currentPending - 1
      }
    });
  }
}

/**
 * Approve a pending memory
 */
export async function approveMemory(id) {
  const existing = await query('SELECT * FROM memories WHERE id = $1', [id]);
  if (existing.rows.length === 0) return { success: false, error: 'Memory not found' };

  const row = existing.rows[0];
  if (row.status !== 'pending_approval') {
    return { success: false, error: 'Memory is not pending approval' };
  }

  await query("UPDATE memories SET status = 'active' WHERE id = $1", [id]);

  console.log(`🧠 Memory approved: ${id}`);
  const memory = rowToMemory({ ...row, status: 'active' });
  cosEvents.emit('memory:approved', { id, memory });

  await notifications.removeByMetadata('memoryId', id);
  await decrementAgentPendingApproval(row.source_agent_id);

  return { success: true, memory };
}

/**
 * Reject a pending memory (hard deletes it)
 */
export async function rejectMemory(id) {
  const existing = await query('SELECT * FROM memories WHERE id = $1', [id]);
  if (existing.rows.length === 0) return { success: false, error: 'Memory not found' };

  const row = existing.rows[0];
  if (row.status !== 'pending_approval') {
    return { success: false, error: 'Memory is not pending approval' };
  }

  const sourceAgentId = row.source_agent_id;

  await query('DELETE FROM memories WHERE id = $1', [id]);

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
  if (options.appId) {
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
  const { limit = 20, minRelevance = 0.5, bm25Weight = 0.4, vectorWeight = 0.6 } = options;
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
  if (options.appId) {
    filterConditions.push(`source_app_id = $${paramIdx++}`);
    filterParams.push(options.appId);
  }

  const filterWhere = filterConditions.join(' AND ');
  const fetchLimit = limit * 2;

  // Get full-text search results (replaces BM25)
  let ftsResults = [];
  if (queryText) {
    const ftsQuery = queryText.split(/\s+/).filter(Boolean).join(' & ');
    const ftsResult = await query(
      `SELECT id, type, category, tags, summary, importance, created_at, status, source_app_id,
              ts_rank(to_tsvector('english', coalesce(content, '') || ' ' || coalesce(summary, '')),
                      to_tsquery('english', $${paramIdx})) AS fts_score
       FROM memories
       WHERE ${filterWhere}
         AND to_tsvector('english', coalesce(content, '') || ' ' || coalesce(summary, ''))
             @@ to_tsquery('english', $${paramIdx})
       ORDER BY fts_score DESC
       LIMIT $${paramIdx + 1}`,
      [...filterParams, ftsQuery, fetchLimit]
    );
    ftsResults = ftsResult.rows;
  }

  // Get vector similarity results
  let vectorResults = [];
  if (queryEmbedding) {
    const vecParamStart = paramIdx + 2;
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
    const current = rrfScores.get(row.id) || { row, bm25Rank: null, vectorRank: null, rrfScore: 0 };
    current.row = row;
    current.bm25Rank = rank + 1;
    current.rrfScore += bm25Weight / (RRF_K + rank + 1);
    rrfScores.set(row.id, current);
  });

  vectorResults.forEach((row, rank) => {
    const current = rrfScores.get(row.id) || { row, bm25Rank: null, vectorRank: null, rrfScore: 0 };
    if (!current.row) current.row = row;
    current.vectorRank = rank + 1;
    current.rrfScore += vectorWeight / (RRF_K + rank + 1);
    rrfScores.set(row.id, current);
  });

  const results = Array.from(rrfScores.values())
    .map(data => ({
      ...rowToMeta(data.row),
      rrfScore: data.rrfScore,
      bm25Rank: data.bm25Rank,
      vectorRank: data.vectorRank,
      searchMethod: data.bm25Rank && data.vectorRank ? 'hybrid' :
                   data.bm25Rank ? 'bm25' : 'vector'
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
  const result = await query(`
    SELECT COUNT(*) as doc_count,
           COUNT(DISTINCT unnest_tag) as unique_tags
    FROM memories, LATERAL unnest(tags) AS unnest_tag
    WHERE status = 'active'
  `).catch(() => ({ rows: [{ doc_count: 0, unique_tags: 0 }] }));

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
  if (options.appId) {
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
  const links = await query(`
    SELECT m.id, m.type, m.category, m.tags, m.summary, m.importance, m.created_at, m.status, m.source_app_id
    FROM memory_links ml
    JOIN memories m ON m.id = ml.target_id
    WHERE ml.source_id = $1 AND m.status = 'active'
  `, [id]);

  for (const row of links.rows) {
    related.push({ ...rowToMeta(row), relationship: 'linked', similarity: 1.0 });
  }

  // Get similar by embedding
  const embedding = existing.rows[0].embedding;
  if (embedding) {
    const seenIds = new Set([id, ...related.map(r => r.id)]);
    const remaining = limit - related.length + seenIds.size;

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

/**
 * Get graph data for visualization
 */
export async function getGraphData() {
  // Build nodes
  const nodesResult = await query(`
    SELECT id, type, category, summary, importance
    FROM memories WHERE status = 'active'
  `);

  const nodes = nodesResult.rows.map(r => ({
    id: r.id,
    type: r.type,
    category: r.category,
    summary: r.summary,
    importance: r.importance
  }));

  // Build edges from explicit links
  const linksResult = await query(`
    SELECT DISTINCT ON (LEAST(source_id, target_id), GREATEST(source_id, target_id))
      source_id AS source, target_id AS target
    FROM memory_links ml
    JOIN memories ms ON ms.id = ml.source_id AND ms.status = 'active'
    JOIN memories mt ON mt.id = ml.target_id AND mt.status = 'active'
  `);

  const edges = linksResult.rows.map(r => ({
    source: r.source,
    target: r.target,
    type: 'linked',
    weight: 1.0
  }));

  // Add similarity edges (top 3 per node, > 0.8 similarity)
  // Using a limited approach to avoid O(n^2) for large graphs
  const seenEdges = new Set(edges.map(e => [e.source, e.target].sort().join('-')));

  const simResult = await query(`
    SELECT a.id AS source_id, b.id AS target_id,
           1 - (a.embedding <=> b.embedding) AS similarity
    FROM memories a
    CROSS JOIN LATERAL (
      SELECT id, embedding
      FROM memories
      WHERE id != a.id AND embedding IS NOT NULL AND status = 'active'
      ORDER BY embedding <=> a.embedding
      LIMIT 3
    ) b
    WHERE a.embedding IS NOT NULL AND a.status = 'active'
      AND 1 - (a.embedding <=> b.embedding) >= 0.8
  `);

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
}

/**
 * Link two memories
 */
export async function linkMemories(sourceId, targetId) {
  // Verify both exist
  const check = await query(
    'SELECT id FROM memories WHERE id = ANY($1)',
    [[sourceId, targetId]]
  );
  if (check.rows.length < 2) return { success: false, error: 'Memory not found' };

  // Insert bidirectional links
  await query(
    `INSERT INTO memory_links (source_id, target_id) VALUES ($1, $2), ($2, $1)
     ON CONFLICT DO NOTHING`,
    [sourceId, targetId]
  );

  return { success: true, sourceId, targetId };
}

// =============================================================================
// Maintenance Operations
// =============================================================================

/**
 * Consolidate similar memories (merge duplicates)
 */
export async function consolidateMemories(threshold = 0.9, dryRun = false) {
  // Find pairs of active memories with similarity above threshold
  const result = await query(`
    SELECT a.id AS id_a, a.summary AS summary_a, a.importance AS importance_a,
           b.id AS id_b, b.summary AS summary_b, b.importance AS importance_b,
           1 - (a.embedding <=> b.embedding) AS similarity
    FROM memories a
    JOIN memories b ON a.id < b.id
    WHERE a.embedding IS NOT NULL AND b.embedding IS NOT NULL
      AND a.status = 'active' AND b.status = 'active'
      AND 1 - (a.embedding <=> b.embedding) >= $1
    ORDER BY similarity DESC
  `, [threshold]);

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

  const importanceMap = new Map();
  const summaryMap = new Map();
  for (const row of result.rows) {
    importanceMap.set(row.id_a, row.importance_a);
    importanceMap.set(row.id_b, row.importance_b);
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

  let merged = 0;
  for (const cluster of duplicateClusters) {
    // Sort by importance, keep highest
    cluster.sort((a, b) => (importanceMap.get(b) || 0) - (importanceMap.get(a) || 0));

    for (let i = 1; i < cluster.length; i++) {
      await query("UPDATE memories SET status = 'archived' WHERE id = $1", [cluster[i]]);
      merged++;
    }
  }

  console.log(`🧠 Consolidated ${merged} duplicate memories into ${duplicateClusters.length} clusters`);
  return { merged, clusters: duplicateClusters.length };
}

/**
 * Apply importance decay to old memories
 */
export async function applyDecay(decayRate = 0.01) {
  const result = await query(`
    SELECT id, importance, created_at, last_accessed
    FROM memories WHERE status = 'active'
  `);

  const now = Date.now();
  let updated = 0;

  for (const row of result.rows) {
    const ageInDays = (now - new Date(row.created_at).getTime()) / (1000 * 60 * 60 * 24);
    const accessRecency = row.last_accessed
      ? (now - new Date(row.last_accessed).getTime()) / (1000 * 60 * 60 * 24)
      : ageInDays;

    const accessBoost = Math.max(0, 0.1 - accessRecency * 0.001);
    const newImportance = Math.max(0.1, row.importance * (1 - decayRate * Math.sqrt(ageInDays)) + accessBoost);

    if (newImportance < 0.15 && ageInDays > 30) {
      await query("UPDATE memories SET status = 'archived', importance = $1 WHERE id = $2", [newImportance, row.id]);
      updated++;
    } else if (Math.abs(newImportance - row.importance) > 0.01) {
      await query("UPDATE memories SET importance = $1 WHERE id = $2", [newImportance, row.id]);
      updated++;
    }
  }

  console.log(`🧠 Decay applied to ${updated} memories`);
  return { updated };
}

/**
 * Clear expired memories
 */
export async function clearExpired() {
  const result = await query(`
    UPDATE memories SET status = 'expired'
    WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < NOW()
  `);

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

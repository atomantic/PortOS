/**
 * Memory API Routes
 */

import { Router } from 'express';
import * as memory from '../services/memoryBackend.js';
import { ensureBackend } from '../services/memoryBackend.js';
import * as embeddings from '../services/memoryEmbeddings.js';
import { getClassifierAvailability } from '../services/memoryClassifier.js';
import * as memorySync from '../services/memorySync.js';
import { findRecentRunsUsingMemory } from '../services/memoryRunUsage.js';
import { checkHealth } from '../lib/db.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  memoryCreateSchema,
  memoryUpdateSchema,
  memorySearchSchema,
  memoryListSchema,
  memorySyncSchema,
  memoryIdParamSchema,
  memoryVersionQuerySchema,
  memoryVersionsQuerySchema,
  memoryRetireSchema,
  memoryDeleteQuerySchema,
  memorySyncQuerySchema
} from '../lib/memoryValidation.js';

const router = Router();

// GET /api/memory - List memories with filters
router.get('/', asyncHandler(async (req, res) => {
  const options = validateRequest(memoryListSchema, req.query);

  const result = await memory.getMemories(options);
  res.json(result);
}));

// GET /api/memory/stats - Get memory statistics
router.get('/stats', asyncHandler(async (req, res) => {
  const stats = await memory.getStats();
  res.json(stats);
}));

// GET /api/memory/graph - Get graph visualization data
router.get('/graph', asyncHandler(async (req, res) => {
  const graph = await memory.getGraphData();
  res.json(graph);
}));

// GET /api/memory/backend/status - Check memory backend status
router.get('/backend/status', asyncHandler(async (req, res) => {
  const name = await ensureBackend();
  const dbHealth = await checkHealth();
  res.json({ backend: name, db: dbHealth });
}));

// GET /api/memory/sync - Federation sync: get changes since sequence
router.get('/sync', asyncHandler(async (req, res) => {
  const name = await ensureBackend();
  if (name !== 'postgres') {
    throw new ServerError('Sync requires PostgreSQL backend', { status: 400 });
  }
  const { since, limit, schemaVersion, tombstoneVersion } = validateRequest(memorySyncQuerySchema, req.query);
  // Peers pull this (PEER_API_SURFACE): honor the per-peer `memory` category.
  const { authorizePeerPull } = await import('../services/sharing/peerPullAuthorization.js');
  await authorizePeerPull(req, { syncCategory: 'memory', alwaysEnforce: true, allowOperator: true, route: 'memory sync' });
  const result = await memorySync.getChangesSince(since, limit, schemaVersion, tombstoneVersion === '1');
  res.json(result);
}));

// POST /api/memory/sync - Federation sync: apply remote changes
router.post('/sync', asyncHandler(async (req, res) => {
  const name = await ensureBackend();
  if (name !== 'postgres') {
    throw new ServerError('Sync requires PostgreSQL backend', { status: 400 });
  }
  const { memories, schemaVersion, deletedIds } = validateRequest(memorySyncSchema, req.body);
  const result = await memorySync.applyRemoteChanges(memories, schemaVersion, deletedIds);
  res.json(result);
}));

// GET /api/memory/embeddings/status - Check embedding and extraction model status
router.get('/embeddings/status', asyncHandler(async (_req, res) => {
  const [status, classifier] = await Promise.all([
    embeddings.checkAvailability(),
    getClassifierAvailability().catch(() => ({ available: false, disabled: false })),
  ]);
  res.json({ ...status, classifier });
}));

// GET /api/memory/embeddings/config - The resolved embedding backend (no probe):
// whether it comes from settings.embeddings or the legacy CoS config, so every
// embedding surface shows the one configuration actually in effect.
router.get('/embeddings/config', asyncHandler(async (req, res) => {
  res.json(await embeddings.resolveEmbeddingSource());
}));

// POST /api/memory/search - Semantic search with a lexical fallback
router.post('/search', asyncHandler(async (req, res) => {
  const { query, types, categories, tags, appId, minRelevance, limit, offset } = validateRequest(memorySearchSchema, req.body);
  const options = { types, categories, tags, appId, limit, offset };
  const queryEmbedding = await embeddings.generateQueryEmbedding(query, { types, categories });

  if (queryEmbedding) {
    const result = await memory.searchMemories(queryEmbedding, { ...options, minRelevance });
    return res.json({ ...result, searchMode: 'semantic' });
  }

  const result = await memory.hybridSearchMemories(query, null, { ...options, lexicalMatch: 'any' });
  res.json({ ...result, searchMode: 'lexical' });
}));

// POST /api/memory - Create a new memory
router.post('/', asyncHandler(async (req, res) => {
  const data = validateRequest(memoryCreateSchema, req.body);

  // Generate embedding for the memory
  const embedding = await embeddings.generateMemoryEmbedding(data);

  const created = await memory.createMemory(data, embedding);
  res.status(201).json(created);
}));

// GET /api/memory/:id - Get a single memory
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(memoryIdParamSchema, req.params);
  const { version } = validateRequest(memoryVersionQuerySchema, req.query);
  const mem = version === undefined ? await memory.getMemory(id) : await memory.getMemoryVersion(id, version);
  if (!mem) {
    throw new ServerError('Memory not found', { status: 404 });
  }
  res.json(mem);
}));

// GET /api/memory/:id/versions - Bounded history metadata, newest first
router.get('/:id/versions', asyncHandler(async (req, res) => {
  const { id } = validateRequest(memoryIdParamSchema, req.params);
  const options = validateRequest(memoryVersionsQuerySchema, req.query);
  res.json({ versions: await memory.getMemoryVersions(id, options) });
}));

// GET /api/memory/:id/runs - Recent agent runs whose prompt included this memory
router.get('/:id/runs', asyncHandler(async (req, res) => {
  const { id } = validateRequest(memoryIdParamSchema, req.params);
  res.json({ runs: await findRecentRunsUsingMemory(id) });
}));

// PUT /api/memory/:id - Update a memory
router.put('/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(memoryUpdateSchema, req.body);
  const updated = await memory.updateMemory(req.params.id, data);
  if (!updated) {
    throw new ServerError('Memory not found', { status: 404 });
  }

  // Regenerate embedding if content changed
  if (data.content) {
    const embedding = await embeddings.generateMemoryEmbedding(updated);
    if (embedding) {
      await memory.updateMemoryEmbedding(updated.id, embedding);
    }
  }

  res.json(updated);
}));

// POST /api/memory/:id/approve - Approve a pending memory
router.post('/:id/approve', asyncHandler(async (req, res) => {
  const result = await memory.approveMemory(req.params.id);
  if (!result.success) {
    throw new ServerError(result.error, { status: result.error === 'Memory not found' ? 404 : 400 });
  }
  res.json(result);
}));

// POST /api/memory/:id/reject - Reject a pending memory
router.post('/:id/reject', asyncHandler(async (req, res) => {
  const options = validateRequest(memoryRetireSchema, req.body ?? {});
  const result = await memory.rejectMemory(req.params.id, options);
  // Rejecting a memory that is already gone is the desired end state.
  if (!result.success && result.error === 'Memory not found') return res.json({ success: true, alreadyResolved: true });
  if (!result.success) {
    throw new ServerError(result.error, { status: 400 });
  }
  res.json(result);
}));

// DELETE /api/memory/:id - Delete a memory
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(memoryIdParamSchema, req.params);
  const { hard, ...options } = validateRequest(memoryDeleteQuerySchema, req.query);
  const result = await (hard === 'true' ? memory.purgeMemory(id) : memory.archiveMemory(id, options));
  res.json(result);
}));

export default router;

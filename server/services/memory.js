/**
 * Memory Service
 *
 * Core CRUD and search operations for the CoS memory system.
 * Stores facts, learnings, observations, decisions, preferences, and context.
 */

import { readFile, writeFile, mkdir, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { cosEvents, updateAgent } from './cos.js';
import { findTopK, findAboveThreshold, clusterBySimilarity, cosineSimilarity } from '../lib/vectorMath.js';
import * as notifications from './notifications.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data');
const MEMORY_DIR = join(DATA_DIR, 'cos/memory');
const INDEX_FILE = join(MEMORY_DIR, 'index.json');
const EMBEDDINGS_FILE = join(MEMORY_DIR, 'embeddings.json');
const MEMORIES_DIR = join(MEMORY_DIR, 'memories');

// Default memory configuration
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

// In-memory caches
let indexCache = null;
let embeddingsCache = null;

// Mutex lock for state operations
let memoryLock = Promise.resolve();
async function withMemoryLock(fn) {
  const release = memoryLock;
  let resolve;
  memoryLock = new Promise(r => { resolve = r; });
  await release;
  const result = await fn();
  resolve();
  return result;
}

/**
 * Ensure memory directories exist
 */
async function ensureDirectories() {
  const dirs = [MEMORY_DIR, MEMORIES_DIR];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }
}

/**
 * Load memory index
 */
async function loadIndex() {
  if (indexCache) return indexCache;

  await ensureDirectories();

  if (!existsSync(INDEX_FILE)) {
    indexCache = { version: 1, lastUpdated: new Date().toISOString(), count: 0, memories: [] };
    return indexCache;
  }

  const content = await readFile(INDEX_FILE, 'utf-8');
  indexCache = JSON.parse(content);
  return indexCache;
}

/**
 * Save memory index
 */
async function saveIndex(index) {
  await ensureDirectories();
  index.lastUpdated = new Date().toISOString();
  indexCache = index;
  await writeFile(INDEX_FILE, JSON.stringify(index, null, 2));
}

/**
 * Load embeddings
 */
async function loadEmbeddings() {
  if (embeddingsCache) return embeddingsCache;

  await ensureDirectories();

  if (!existsSync(EMBEDDINGS_FILE)) {
    embeddingsCache = { model: null, dimension: 0, vectors: {} };
    return embeddingsCache;
  }

  const content = await readFile(EMBEDDINGS_FILE, 'utf-8');
  embeddingsCache = JSON.parse(content);
  return embeddingsCache;
}

/**
 * Save embeddings
 */
async function saveEmbeddings(embeddings) {
  await ensureDirectories();
  embeddingsCache = embeddings;
  await writeFile(EMBEDDINGS_FILE, JSON.stringify(embeddings));
}

/**
 * Load full memory by ID
 */
async function loadMemory(id) {
  const memoryFile = join(MEMORIES_DIR, id, 'memory.json');
  if (!existsSync(memoryFile)) return null;

  const content = await readFile(memoryFile, 'utf-8');
  return JSON.parse(content);
}

/**
 * Save full memory
 */
async function saveMemory(memory) {
  const memoryDir = join(MEMORIES_DIR, memory.id);
  if (!existsSync(memoryDir)) {
    await mkdir(memoryDir, { recursive: true });
  }
  await writeFile(join(memoryDir, 'memory.json'), JSON.stringify(memory, null, 2));
}

/**
 * Delete memory files
 */
async function deleteMemoryFiles(id) {
  const memoryDir = join(MEMORIES_DIR, id);
  if (existsSync(memoryDir)) {
    await rm(memoryDir, { recursive: true });
  }
}

/**
 * Generate summary from content using simple truncation
 * Note: LLM-based summaries could improve quality but add latency and cost
 */
function generateSummary(content, maxLength = 150) {
  if (content.length <= maxLength) return content;
  return content.substring(0, maxLength - 3) + '...';
}

/**
 * Create a new memory
 */
export async function createMemory(data, embedding = null) {
  return withMemoryLock(async () => {
    const index = await loadIndex();
    const embeddings = await loadEmbeddings();

    const now = new Date().toISOString();
    const id = uuidv4();

    const memory = {
      id,
      type: data.type,
      content: data.content,
      summary: data.summary || generateSummary(data.content),
      category: data.category || 'other',
      tags: data.tags || [],
      relatedMemories: data.relatedMemories || [],
      sourceTaskId: data.sourceTaskId || null,
      sourceAgentId: data.sourceAgentId || null,
      sourceAppId: data.sourceAppId || null,
      embedding: embedding || null,
      embeddingModel: embedding ? DEFAULT_MEMORY_CONFIG.embeddingModel : null,
      confidence: data.confidence ?? 0.8,
      importance: data.importance ?? 0.5,
      accessCount: 0,
      lastAccessed: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: data.expiresAt || null,
      status: data.status || 'active'
    };

    // Save full memory
    await saveMemory(memory);

    // Add to index (lightweight metadata only)
    index.memories.push({
      id: memory.id,
      type: memory.type,
      category: memory.category,
      tags: memory.tags,
      summary: memory.summary,
      importance: memory.importance,
      createdAt: memory.createdAt,
      status: memory.status,
      sourceAppId: memory.sourceAppId
    });
    index.count = index.memories.length;
    await saveIndex(index);

    // Store embedding separately
    if (embedding) {
      embeddings.vectors[id] = embedding;
      embeddings.model = DEFAULT_MEMORY_CONFIG.embeddingModel;
      embeddings.dimension = embedding.length;
      await saveEmbeddings(embeddings);
    }

    console.log(`🧠 Memory created: ${memory.type} - ${memory.summary.substring(0, 50)}...`);
    cosEvents.emit('memory:created', { id, type: memory.type, summary: memory.summary });

    return memory;
  });
}

/**
 * Get a memory by ID
 */
export async function getMemory(id) {
  const memory = await loadMemory(id);
  if (!memory) return null;

  // Update access stats
  await withMemoryLock(async () => {
    memory.accessCount += 1;
    memory.lastAccessed = new Date().toISOString();
    await saveMemory(memory);
  });

  return memory;
}

/**
 * Get memories with filters
 */
export async function getMemories(options = {}) {
  const index = await loadIndex();
  let memories = [...index.memories];

  // Filter by status
  const status = options.status || 'active';
  memories = memories.filter(m => m.status === status);

  // Filter by types
  if (options.types && options.types.length > 0) {
    memories = memories.filter(m => options.types.includes(m.type));
  }

  // Filter by categories
  if (options.categories && options.categories.length > 0) {
    memories = memories.filter(m => options.categories.includes(m.category));
  }

  // Filter by tags (any match)
  if (options.tags && options.tags.length > 0) {
    memories = memories.filter(m => m.tags.some(t => options.tags.includes(t)));
  }

  // Filter by app
  if (options.appId) {
    memories = memories.filter(m => m.sourceAppId === options.appId);
  }

  // Sort
  const sortBy = options.sortBy || 'createdAt';
  const sortOrder = options.sortOrder || 'desc';
  memories.sort((a, b) => {
    const aVal = a[sortBy] || 0;
    const bVal = b[sortBy] || 0;
    return sortOrder === 'desc' ? (bVal > aVal ? 1 : -1) : (aVal > bVal ? 1 : -1);
  });

  // Paginate
  const offset = options.offset || 0;
  const limit = options.limit || 50;
  const total = memories.length;
  memories = memories.slice(offset, offset + limit);

  return { total, memories };
}

/**
 * Update a memory
 */
export async function updateMemory(id, updates) {
  return withMemoryLock(async () => {
    const memory = await loadMemory(id);
    if (!memory) return null;

    // Apply updates
    const updatableFields = ['content', 'summary', 'category', 'tags', 'confidence', 'importance', 'relatedMemories', 'status', 'expiresAt', 'sourceAppId'];
    for (const field of updatableFields) {
      if (updates[field] !== undefined) {
        memory[field] = updates[field];
      }
    }

    // Update summary if content changed
    if (updates.content && !updates.summary) {
      memory.summary = generateSummary(updates.content);
    }

    memory.updatedAt = new Date().toISOString();
    await saveMemory(memory);

    // Update index
    const index = await loadIndex();
    const idx = index.memories.findIndex(m => m.id === id);
    if (idx !== -1) {
      index.memories[idx] = {
        id: memory.id,
        type: memory.type,
        category: memory.category,
        tags: memory.tags,
        summary: memory.summary,
        importance: memory.importance,
        createdAt: memory.createdAt,
        status: memory.status,
        sourceAppId: memory.sourceAppId
      };
      await saveIndex(index);
    }

    console.log(`🧠 Memory updated: ${id}`);
    cosEvents.emit('memory:updated', { id, updates });

    return memory;
  });
}

/**
 * Update a memory's embedding
 */
export async function updateMemoryEmbedding(id, embedding) {
  return withMemoryLock(async () => {
    const memory = await loadMemory(id);
    if (!memory) return null;

    // Update memory with new embedding
    memory.embedding = embedding;
    memory.embeddingModel = DEFAULT_MEMORY_CONFIG.embeddingModel;
    memory.updatedAt = new Date().toISOString();
    await saveMemory(memory);

    // Update embeddings file
    const embeddings = await loadEmbeddings();
    embeddings.vectors[id] = embedding;
    embeddings.model = DEFAULT_MEMORY_CONFIG.embeddingModel;
    embeddings.dimension = embedding.length;
    await saveEmbeddings(embeddings);

    console.log(`🧠 Memory embedding updated: ${id}`);
    return memory;
  });
}

/**
 * Delete a memory (soft delete by default)
 */
export async function deleteMemory(id, hard = false) {
  return withMemoryLock(async () => {
    if (hard) {
      // Hard delete - remove files
      await deleteMemoryFiles(id);

      // Remove from index
      const index = await loadIndex();
      index.memories = index.memories.filter(m => m.id !== id);
      index.count = index.memories.length;
      await saveIndex(index);

      // Remove embedding
      const embeddings = await loadEmbeddings();
      delete embeddings.vectors[id];
      await saveEmbeddings(embeddings);
    } else {
      // Soft delete - mark as archived
      await updateMemory(id, { status: 'archived' });
    }

    console.log(`🧠 Memory deleted: ${id} (hard: ${hard})`);
    cosEvents.emit('memory:deleted', { id, hard });

    return { success: true, id };
  });
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
 * Approve a pending memory (changes status from pending_approval to active)
 */
export async function approveMemory(id) {
  return withMemoryLock(async () => {
    const memory = await loadMemory(id);
    if (!memory) return { success: false, error: 'Memory not found' };
    if (memory.status !== 'pending_approval') {
      return { success: false, error: 'Memory is not pending approval' };
    }

    memory.status = 'active';
    memory.updatedAt = new Date().toISOString();
    await saveMemory(memory);

    // Update index
    const index = await loadIndex();
    const idx = index.memories.findIndex(m => m.id === id);
    if (idx !== -1) {
      index.memories[idx].status = 'active';
      await saveIndex(index);
    }

    console.log(`🧠 Memory approved: ${id}`);
    cosEvents.emit('memory:approved', { id, memory });

    // Remove associated notification
    await notifications.removeByMetadata('memoryId', id);

    // Decrement agent's pendingApproval count
    await decrementAgentPendingApproval(memory.sourceAgentId);

    return { success: true, memory };
  });
}

/**
 * Reject a pending memory (hard deletes it)
 */
export async function rejectMemory(id) {
  return withMemoryLock(async () => {
    const memory = await loadMemory(id);
    if (!memory) return { success: false, error: 'Memory not found' };
    if (memory.status !== 'pending_approval') {
      return { success: false, error: 'Memory is not pending approval' };
    }

    // Store sourceAgentId before deletion
    const sourceAgentId = memory.sourceAgentId;

    // Hard delete - remove files
    await deleteMemoryFiles(id);

    // Remove from index
    const index = await loadIndex();
    index.memories = index.memories.filter(m => m.id !== id);
    index.count = index.memories.length;
    await saveIndex(index);

    // Remove embedding
    const embeddings = await loadEmbeddings();
    delete embeddings.vectors[id];
    await saveEmbeddings(embeddings);

    console.log(`🧠 Memory rejected: ${id}`);
    cosEvents.emit('memory:rejected', { id });

    // Remove associated notification
    await notifications.removeByMetadata('memoryId', id);

    // Decrement agent's pendingApproval count
    await decrementAgentPendingApproval(sourceAgentId);

    return { success: true, id };
  });
}

/**
 * Search memories semantically
 */
export async function searchMemories(queryEmbedding, options = {}) {
  const embeddings = await loadEmbeddings();
  const index = await loadIndex();

  if (!queryEmbedding || Object.keys(embeddings.vectors).length === 0) {
    return { total: 0, memories: [] };
  }

  // Find similar vectors
  const minRelevance = options.minRelevance || 0.7;
  const limit = options.limit || 20;

  const similar = findAboveThreshold(queryEmbedding, embeddings.vectors, minRelevance);

  // Filter by additional options
  let results = similar.slice(0, limit);

  // Get memory metadata from index
  const indexMap = new Map(index.memories.map(m => [m.id, m]));

  results = results
    .map(r => {
      const meta = indexMap.get(r.id);
      if (!meta || meta.status !== 'active') return null;

      // Apply type/category/tag/app filters
      if (options.types && options.types.length > 0 && !options.types.includes(meta.type)) return null;
      if (options.categories && options.categories.length > 0 && !options.categories.includes(meta.category)) return null;
      if (options.tags && options.tags.length > 0 && !meta.tags.some(t => options.tags.includes(t))) return null;
      if (options.appId && meta.sourceAppId !== options.appId) return null;

      return { ...meta, similarity: r.similarity };
    })
    .filter(Boolean);

  return { total: results.length, memories: results };
}

/**
 * Get timeline data (memories grouped by date)
 */
export async function getTimeline(options = {}) {
  const index = await loadIndex();
  let memories = index.memories.filter(m => m.status === 'active');

  // Filter by date range
  if (options.startDate) {
    memories = memories.filter(m => m.createdAt >= options.startDate);
  }
  if (options.endDate) {
    memories = memories.filter(m => m.createdAt <= options.endDate);
  }

  // Filter by types
  if (options.types && options.types.length > 0) {
    memories = memories.filter(m => options.types.includes(m.type));
  }

  // Filter by app
  if (options.appId) {
    memories = memories.filter(m => m.sourceAppId === options.appId);
  }

  // Sort by date descending
  memories.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));

  // Limit
  const limit = options.limit || 100;
  memories = memories.slice(0, limit);

  // Group by date
  const timeline = {};
  for (const memory of memories) {
    const date = memory.createdAt.split('T')[0];
    if (!timeline[date]) timeline[date] = [];
    timeline[date].push(memory);
  }

  return timeline;
}

/**
 * Get all unique categories
 */
export async function getCategories() {
  const index = await loadIndex();
  const categories = new Map();

  for (const memory of index.memories) {
    if (memory.status !== 'active') continue;
    const count = categories.get(memory.category) || 0;
    categories.set(memory.category, count + 1);
  }

  return Array.from(categories.entries()).map(([name, count]) => ({ name, count }));
}

/**
 * Get all unique tags
 */
export async function getTags() {
  const index = await loadIndex();
  const tags = new Map();

  for (const memory of index.memories) {
    if (memory.status !== 'active') continue;
    for (const tag of memory.tags) {
      const count = tags.get(tag) || 0;
      tags.set(tag, count + 1);
    }
  }

  return Array.from(tags.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Get related memories (by ID links + embedding similarity)
 */
export async function getRelatedMemories(id, limit = 10) {
  const memory = await loadMemory(id);
  if (!memory) return [];

  const embeddings = await loadEmbeddings();
  const index = await loadIndex();
  const indexMap = new Map(index.memories.map(m => [m.id, m]));

  const related = [];

  // Add explicitly linked memories
  for (const relId of memory.relatedMemories) {
    const meta = indexMap.get(relId);
    if (meta && meta.status === 'active') {
      related.push({ ...meta, relationship: 'linked', similarity: 1.0 });
    }
  }

  // Add similar by embedding
  if (memory.embedding && embeddings.vectors[id]) {
    const similar = findTopK(memory.embedding, embeddings.vectors, limit + related.length);
    for (const item of similar) {
      if (item.id === id) continue;
      if (related.some(r => r.id === item.id)) continue;

      const meta = indexMap.get(item.id);
      if (meta && meta.status === 'active') {
        related.push({ ...meta, relationship: 'similar', similarity: item.similarity });
      }
    }
  }

  return related.slice(0, limit);
}

/**
 * Get graph data for visualization
 */
export async function getGraphData() {
  const index = await loadIndex();
  const embeddings = await loadEmbeddings();

  const activeMemories = index.memories.filter(m => m.status === 'active');

  // Build nodes
  const nodes = activeMemories.map(m => ({
    id: m.id,
    type: m.type,
    category: m.category,
    summary: m.summary,
    importance: m.importance
  }));

  // Build edges from explicit links and high similarity
  const edges = [];
  const seenEdges = new Set();

  // Batch load all memories to avoid N+1 query pattern
  // Load all memories in parallel instead of sequential loadMemory calls
  const memoryLoadPromises = activeMemories.map(m => loadMemory(m.id));
  const loadedMemories = await Promise.all(memoryLoadPromises);
  const memoriesById = new Map();
  loadedMemories.forEach((mem, idx) => {
    if (mem) memoriesById.set(activeMemories[idx].id, mem);
  });

  // Build explicit link edges using pre-loaded memories
  for (const memory of activeMemories) {
    const full = memoriesById.get(memory.id);
    if (!full) continue;

    // Explicit links
    for (const targetId of full.relatedMemories) {
      const edgeKey = [memory.id, targetId].sort().join('-');
      if (!seenEdges.has(edgeKey)) {
        seenEdges.add(edgeKey);
        edges.push({ source: memory.id, target: targetId, type: 'linked', weight: 1.0 });
      }
    }
  }

  // Add similarity edges (top 3 per node, > 0.8 similarity)
  for (const memory of activeMemories) {
    if (!embeddings.vectors[memory.id]) continue;

    const similar = findTopK(embeddings.vectors[memory.id], embeddings.vectors, 4);
    for (const item of similar) {
      if (item.id === memory.id) continue;
      if (item.similarity < 0.8) continue;

      const edgeKey = [memory.id, item.id].sort().join('-');
      if (!seenEdges.has(edgeKey)) {
        seenEdges.add(edgeKey);
        edges.push({ source: memory.id, target: item.id, type: 'similar', weight: item.similarity });
      }
    }
  }

  return { nodes, edges };
}

/**
 * Link two memories
 */
export async function linkMemories(sourceId, targetId) {
  return withMemoryLock(async () => {
    const source = await loadMemory(sourceId);
    const target = await loadMemory(targetId);

    if (!source || !target) return { success: false, error: 'Memory not found' };

    // Add bidirectional links
    if (!source.relatedMemories.includes(targetId)) {
      source.relatedMemories.push(targetId);
      source.updatedAt = new Date().toISOString();
      await saveMemory(source);
    }

    if (!target.relatedMemories.includes(sourceId)) {
      target.relatedMemories.push(sourceId);
      target.updatedAt = new Date().toISOString();
      await saveMemory(target);
    }

    return { success: true, sourceId, targetId };
  });
}

/**
 * Consolidate similar memories (merge duplicates)
 */
export async function consolidateMemories(threshold = 0.9, dryRun = false) {
  const index = await loadIndex();
  const embeddings = await loadEmbeddings();

  const activeMemories = index.memories.filter(m => m.status === 'active');

  // Get memories with embeddings
  const memoriesWithEmbeddings = [];
  for (const meta of activeMemories) {
    if (embeddings.vectors[meta.id]) {
      memoriesWithEmbeddings.push({
        id: meta.id,
        embedding: embeddings.vectors[meta.id],
        ...meta
      });
    }
  }

  // Cluster by similarity
  const clusters = clusterBySimilarity(memoriesWithEmbeddings, threshold);
  const duplicateClusters = clusters.filter(c => c.length > 1);

  if (dryRun) {
    return {
      dryRun: true,
      clustersFound: duplicateClusters.length,
      memoriesAffected: duplicateClusters.reduce((sum, c) => sum + c.length, 0),
      clusters: duplicateClusters.map(c => c.map(m => ({ id: m.id, summary: m.summary })))
    };
  }

  // Merge each cluster
  let merged = 0;
  for (const cluster of duplicateClusters) {
    // Sort by importance, keep highest
    cluster.sort((a, b) => (b.importance || 0) - (a.importance || 0));
    const primary = cluster[0];

    for (let i = 1; i < cluster.length; i++) {
      await updateMemory(cluster[i].id, {
        status: 'archived',
        mergedInto: primary.id
      });
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
  const index = await loadIndex();
  const now = Date.now();
  let updated = 0;

  // Filter active memories first
  const activeMemories = index.memories.filter(m => m.status === 'active');

  // Batch load all active memories to avoid N+1 query pattern
  const memoryLoadPromises = activeMemories.map(m => loadMemory(m.id));
  const loadedMemories = await Promise.all(memoryLoadPromises);

  // Process each loaded memory
  for (let i = 0; i < activeMemories.length; i++) {
    const meta = activeMemories[i];
    const memory = loadedMemories[i];
    if (!memory) continue;

    const ageInDays = (now - new Date(memory.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    const accessRecency = memory.lastAccessed
      ? (now - new Date(memory.lastAccessed).getTime()) / (1000 * 60 * 60 * 24)
      : ageInDays;

    // Decay formula: importance = baseImportance * (1 - decayRate * sqrt(age)) + accessBoost
    const accessBoost = Math.max(0, 0.1 - accessRecency * 0.001);
    const newImportance = Math.max(0.1, memory.importance * (1 - decayRate * Math.sqrt(ageInDays)) + accessBoost);

    // Archive if importance falls below threshold and old enough
    if (newImportance < 0.15 && ageInDays > 30) {
      await updateMemory(meta.id, { status: 'archived', archivedReason: 'decay' });
      updated++;
    } else if (Math.abs(newImportance - memory.importance) > 0.01) {
      await updateMemory(meta.id, { importance: newImportance });
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
  const index = await loadIndex();
  const now = new Date().toISOString();
  let cleared = 0;

  // Filter active memories first
  const activeMemories = index.memories.filter(m => m.status === 'active');

  // Batch load all active memories to avoid N+1 query pattern
  const memoryLoadPromises = activeMemories.map(m => loadMemory(m.id));
  const loadedMemories = await Promise.all(memoryLoadPromises);

  // Process each loaded memory
  for (let i = 0; i < activeMemories.length; i++) {
    const meta = activeMemories[i];
    const memory = loadedMemories[i];
    if (!memory) continue;

    if (memory.expiresAt && memory.expiresAt < now) {
      await updateMemory(meta.id, { status: 'expired' });
      cleared++;
    }
  }

  console.log(`🧠 Cleared ${cleared} expired memories`);
  return { cleared };
}

/**
 * Get memory stats
 */
export async function getStats() {
  const index = await loadIndex();
  const embeddings = await loadEmbeddings();

  const byType = {};
  const byCategory = {};
  const byStatus = {};

  for (const memory of index.memories) {
    byType[memory.type] = (byType[memory.type] || 0) + 1;
    byCategory[memory.category] = (byCategory[memory.category] || 0) + 1;
    byStatus[memory.status] = (byStatus[memory.status] || 0) + 1;
  }

  return {
    total: index.count,
    active: byStatus.active || 0,
    archived: byStatus.archived || 0,
    expired: byStatus.expired || 0,
    pendingApproval: byStatus.pending_approval || 0,
    withEmbeddings: Object.keys(embeddings.vectors).length,
    byType,
    byCategory,
    lastUpdated: index.lastUpdated
  };
}

/**
 * Invalidate caches (call after external changes)
 */
export function invalidateCaches() {
  indexCache = null;
  embeddingsCache = null;
}

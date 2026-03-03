/**
 * Memory Backend Switcher
 *
 * Selects between file-based (memory.js) and PostgreSQL (memoryDB.js) backends.
 * Checks for MEMORY_BACKEND env var or falls back to DB health check.
 *
 * Usage:
 *   import * as memory from './memoryBackend.js';
 *   // All functions are the same regardless of backend
 */

import { checkHealth } from '../lib/db.js';

let backend = null;
let backendName = null;

/**
 * Initialize and return the appropriate backend module.
 * Caches the result after first call.
 */
async function getBackend() {
  if (backend) return backend;

  const envBackend = process.env.MEMORY_BACKEND;

  if (envBackend === 'file') {
    backend = await import('./memory.js');
    backendName = 'file';
    console.log('🧠 Memory backend: file-based (JSON)');
    return backend;
  }

  if (envBackend === 'postgres') {
    backend = await import('./memoryDB.js');
    backendName = 'postgres';
    console.log('🧠 Memory backend: PostgreSQL + pgvector');
    return backend;
  }

  // Auto-detect: try PostgreSQL first, fall back to file
  const health = await checkHealth();
  if (health.connected && health.hasSchema) {
    backend = await import('./memoryDB.js');
    backendName = 'postgres';
    console.log('🧠 Memory backend: PostgreSQL + pgvector (auto-detected)');
  } else {
    backend = await import('./memory.js');
    backendName = 'file';
    console.log(`🧠 Memory backend: file-based (PostgreSQL unavailable: ${health.error || 'no schema'})`);
  }

  return backend;
}

/**
 * Get the name of the active backend
 */
export function getBackendName() {
  return backendName;
}

// Re-export all functions with lazy initialization
// Each function loads the backend on first call, then delegates

export async function createMemory(data, embedding) {
  const b = await getBackend();
  return b.createMemory(data, embedding);
}

export async function getMemory(id) {
  const b = await getBackend();
  return b.getMemory(id);
}

export async function getMemories(options) {
  const b = await getBackend();
  return b.getMemories(options);
}

export async function updateMemory(id, updates) {
  const b = await getBackend();
  return b.updateMemory(id, updates);
}

export async function updateMemoryEmbedding(id, embedding) {
  const b = await getBackend();
  return b.updateMemoryEmbedding(id, embedding);
}

export async function deleteMemory(id, hard) {
  const b = await getBackend();
  return b.deleteMemory(id, hard);
}

export async function approveMemory(id) {
  const b = await getBackend();
  return b.approveMemory(id);
}

export async function rejectMemory(id) {
  const b = await getBackend();
  return b.rejectMemory(id);
}

export async function searchMemories(queryEmbedding, options) {
  const b = await getBackend();
  return b.searchMemories(queryEmbedding, options);
}

export async function hybridSearchMemories(query, queryEmbedding, options) {
  const b = await getBackend();
  return b.hybridSearchMemories(query, queryEmbedding, options);
}

export async function rebuildBM25Index() {
  const b = await getBackend();
  return b.rebuildBM25Index();
}

export async function getBM25Stats() {
  const b = await getBackend();
  return b.getBM25Stats();
}

export async function getTimeline(options) {
  const b = await getBackend();
  return b.getTimeline(options);
}

export async function getCategories() {
  const b = await getBackend();
  return b.getCategories();
}

export async function getTags() {
  const b = await getBackend();
  return b.getTags();
}

export async function getRelatedMemories(id, limit) {
  const b = await getBackend();
  return b.getRelatedMemories(id, limit);
}

export async function getGraphData() {
  const b = await getBackend();
  return b.getGraphData();
}

export async function linkMemories(sourceId, targetId) {
  const b = await getBackend();
  return b.linkMemories(sourceId, targetId);
}

export async function consolidateMemories(threshold, dryRun) {
  const b = await getBackend();
  return b.consolidateMemories(threshold, dryRun);
}

export async function applyDecay(decayRate) {
  const b = await getBackend();
  return b.applyDecay(decayRate);
}

export async function clearExpired() {
  const b = await getBackend();
  return b.clearExpired();
}

export async function getStats() {
  const b = await getBackend();
  return b.getStats();
}

export function invalidateCaches() {
  if (backend) backend.invalidateCaches();
}

export async function flushBM25Index() {
  const b = await getBackend();
  return b.flushBM25Index();
}

// Re-export the config constant (same in both backends)
export { DEFAULT_MEMORY_CONFIG } from './memory.js';

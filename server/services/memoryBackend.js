/**
 * Memory Backend Switcher
 *
 * Selects the PostgreSQL backend (memoryDB.js) for normal installs. PostgreSQL
 * is mandatory; when MEMORY_BACKEND is unset we require a healthy DB and do NOT
 * silently fall back to file storage — an unavailable DB throws. The file
 * backend (memory.js) is reachable only via the explicit MEMORY_BACKEND=file
 * escape hatch or NODE_ENV=test (both unsupported for production).
 *
 * Usage:
 *   import * as memory from './memoryBackend.js';
 *   // All functions are the same regardless of backend
 */

import { checkHealth, ensureSchema } from '../lib/db.js';
import { DEFAULT_MEMORY_CONFIG } from './memoryConfig.js';

export { DEFAULT_MEMORY_CONFIG };

let backend = null;
let backendName = null;

/**
 * Initialize and return the appropriate backend module.
 * Caches the result after first call.
 */
async function getBackend() {
  if (backend) return backend;

  const envBackend = process.env.MEMORY_BACKEND;

  // `MEMORY_BACKEND=file` is an explicit, UNSUPPORTED-for-production escape
  // hatch — honored for development/tests only. PostgreSQL is the mandatory
  // backend for normal installs (the creative catalog has no file-backed
  // equivalent). See docs/plans/2026-06-06-create-postgres-storage-inventory.md.
  if (envBackend === 'file') {
    backend = await import('./memory.js');
    backendName = 'file';
    console.log('🧠 Memory backend: file-based (JSON) — explicit MEMORY_BACKEND=file (unsupported for production)');
    return backend;
  }

  if (envBackend === 'postgres') {
    await ensureSchema();
    backend = await import('./memoryDB.js');
    backendName = 'postgres';
    console.log('🧠 Memory backend: PostgreSQL + pgvector');
    return backend;
  }

  // Under the test runner, ALWAYS use the file backend — never probe or touch a
  // real Postgres instance. A developer's machine commonly has a live `portos`
  // DB running (and that DB is federated to real peers). If the suite were to
  // auto-detect that healthy DB it would write hundreds of fixture
  // universes/series into it AND fan them out to live peers via
  // autoSubscribeRecordToAllPeers — and test-cleanup tombstones would delete the
  // user's real records. This must short-circuit BEFORE checkHealth(); the
  // earlier conditional-on-unavailable form silently wrote to a dev's real DB
  // whenever Postgres happened to be up. An explicit `MEMORY_BACKEND=postgres`
  // (handled above) still opts a suite into the PG path.
  if (process.env.NODE_ENV === 'test') {
    backend = await import('./memory.js');
    backendName = 'file';
    console.log('🧠 Memory backend: file-based (test mode — Postgres deliberately bypassed)');
    return backend;
  }

  // MEMORY_BACKEND unset: require PostgreSQL. We do NOT silently fall back to
  // file storage when Postgres is unavailable — that masks a broken install.
  const health = await checkHealth();
  if (health.connected && health.hasSchema) {
    await ensureSchema();
    backend = await import('./memoryDB.js');
    backendName = 'postgres';
    console.log('🧠 Memory backend: PostgreSQL + pgvector (auto-detected)');
    return backend;
  }

  // Production / normal install with no DB and no escape hatch: this is an
  // error condition, not a fallback. Log loudly and point at setup. Startup
  // (server/index.js) fails fast on the same condition.
  console.error(`❌ Memory backend unavailable: PostgreSQL is required but ${health.connected ? 'the schema is missing' : `unreachable (${health.error || 'connection failed'})`}`);
  console.error('   PostgreSQL is a mandatory dependency for PortOS. Set it up with: npm run setup:db');
  console.error('   Dev/test only: set PGMODE=file in .env (the launcher maps it to MEMORY_BACKEND=file) to use the (unsupported) file backend.');
  throw new Error('PostgreSQL is required for the memory backend — run `npm run setup:db`');
}

/**
 * Ensure the backend is initialized and return its name.
 * Safe to call from routes that need the backend name before any other function.
 */
export async function ensureBackend() {
  await getBackend();
  return backendName;
}

/**
 * Get the name of the active backend (null if not yet initialized)
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

export async function peekMemory(id) {
  const b = await getBackend();
  return b.peekMemory(id);
}

export async function getMemory(id) {
  const b = await getBackend();
  return b.getMemory(id);
}

export async function getMemories(options) {
  const b = await getBackend();
  return b.getMemories(options);
}

export async function countMemories(options) {
  const b = await getBackend();
  return b.countMemories(options);
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

export async function getMemoryIdsMissingEmbedding() {
  const b = await getBackend();
  return b.getMemoryIdsMissingEmbedding();
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

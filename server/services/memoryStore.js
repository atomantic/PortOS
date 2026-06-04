/**
 * Memory Store
 *
 * Persistence + cache layer for the file-based memory service. Owns the
 * on-disk layout (index.json, embeddings.json, memories/<id>/memory.json),
 * the in-memory caches, the per-process write mutex, and directory setup.
 * Extracted from memory.js so the orchestration layer (memory.js) only wires
 * CRUD/search logic and events on top of these primitives.
 */

import { writeFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { ensureDir, ensureDirs, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';

const MEMORY_DIR = PATHS.memory;
const INDEX_FILE = join(MEMORY_DIR, 'index.json');
const EMBEDDINGS_FILE = join(MEMORY_DIR, 'embeddings.json');
const MEMORIES_DIR = join(MEMORY_DIR, 'memories');

// In-memory caches
let indexCache = null;
let embeddingsCache = null;

// Mutex lock for state operations
export const withMemoryLock = createMutex();

/**
 * Ensure memory directories exist
 */
export async function ensureDirectories() {
  await ensureDirs([MEMORY_DIR, MEMORIES_DIR]);
}

/**
 * Load memory index
 */
export async function loadIndex() {
  if (indexCache) return indexCache;

  await ensureDirectories();

  const defaultIndex = { version: 1, lastUpdated: new Date().toISOString(), count: 0, memories: [] };
  indexCache = await readJSONFile(INDEX_FILE, defaultIndex);
  return indexCache;
}

/**
 * Save memory index
 */
export async function saveIndex(index) {
  await ensureDirectories();
  index.lastUpdated = new Date().toISOString();
  indexCache = index;
  await writeFile(INDEX_FILE, JSON.stringify(index, null, 2));
}

/**
 * Load embeddings
 */
export async function loadEmbeddings() {
  if (embeddingsCache) return embeddingsCache;

  await ensureDirectories();

  const defaultEmbeddings = { model: null, dimension: 0, vectors: {} };
  embeddingsCache = await readJSONFile(EMBEDDINGS_FILE, defaultEmbeddings);
  return embeddingsCache;
}

/**
 * Save embeddings
 */
export async function saveEmbeddings(embeddings) {
  await ensureDirectories();
  embeddingsCache = embeddings;
  await writeFile(EMBEDDINGS_FILE, JSON.stringify(embeddings));
}

/**
 * Load full memory by ID
 */
export async function loadMemory(id) {
  const memoryFile = join(MEMORIES_DIR, id, 'memory.json');
  return readJSONFile(memoryFile, null);
}

/**
 * Save full memory
 */
export async function saveMemory(memory) {
  const memoryDir = join(MEMORIES_DIR, memory.id);
  if (!existsSync(memoryDir)) {
    await ensureDir(memoryDir);
  }
  await writeFile(join(memoryDir, 'memory.json'), JSON.stringify(memory, null, 2));
}

/**
 * Delete memory files
 */
export async function deleteMemoryFiles(id) {
  const memoryDir = join(MEMORIES_DIR, id);
  if (existsSync(memoryDir)) {
    await rm(memoryDir, { recursive: true });
  }
}

/**
 * Invalidate caches (call after external changes)
 */
export function invalidateCaches() {
  indexCache = null;
  embeddingsCache = null;
}

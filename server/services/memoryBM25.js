/**
 * BM25 Index Manager for Memory System
 *
 * Manages the BM25 inverted index for text-based memory search.
 * Complements the vector-based semantic search with keyword matching.
 */

import { promises as fs } from 'fs'
import path from 'path'
import {
  buildInvertedIndex,
  addDocument,
  removeDocument,
  search,
  createEmptyIndex,
  serializeIndex,
  deserializeIndex,
  getIndexStats
} from '../lib/bm25.js'

const DATA_DIR = path.join(process.cwd(), 'data', 'cos', 'memory')
const INDEX_FILE = path.join(DATA_DIR, 'bm25-index.json')

// In-memory cache of the index
let indexCache = null
let isDirty = false

/**
 * Ensure the data directory exists
 */
async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true })
}

/**
 * Load the BM25 index from disk
 * @returns {Promise<Object>} - The BM25 index
 */
async function loadIndex() {
  if (indexCache) return indexCache

  await ensureDataDir()

  const exists = await fs.access(INDEX_FILE).then(() => true).catch(() => false)

  if (!exists) {
    indexCache = createEmptyIndex()
    return indexCache
  }

  const data = await fs.readFile(INDEX_FILE, 'utf-8')
  indexCache = deserializeIndex(JSON.parse(data))
  return indexCache
}

/**
 * Save the BM25 index to disk
 * @returns {Promise<void>}
 */
async function saveIndex() {
  if (!indexCache || !isDirty) return

  await ensureDataDir()
  const serialized = serializeIndex(indexCache)
  await fs.writeFile(INDEX_FILE, JSON.stringify(serialized, null, 2))
  isDirty = false

  console.log(`💾 BM25 index saved: ${indexCache.totalDocs} docs, ${Object.keys(indexCache.terms).length} terms`)
}

/**
 * Build or rebuild the entire index from memories
 * @param {Array<{id: string, content: string, type: string, tags: string[]}>} memories
 * @returns {Promise<Object>} - Index statistics
 */
async function rebuildIndex(memories) {
  await ensureDataDir()

  // Convert memories to documents for indexing
  const documents = memories.map(m => ({
    id: m.id,
    text: buildIndexableText(m)
  }))

  indexCache = buildInvertedIndex(documents)
  isDirty = true

  await saveIndex()

  console.log(`🔄 BM25 index rebuilt: ${indexCache.totalDocs} memories indexed`)
  return getIndexStats(indexCache)
}

/**
 * Build indexable text from a memory object
 * Combines content, type, and tags for better matching
 *
 * @param {Object} memory - Memory object
 * @returns {string} - Text for indexing
 */
function buildIndexableText(memory) {
  const parts = []

  if (memory.content) {
    parts.push(memory.content)
  }

  if (memory.type) {
    parts.push(memory.type)
  }

  if (memory.tags && Array.isArray(memory.tags)) {
    parts.push(memory.tags.join(' '))
  }

  if (memory.source) {
    parts.push(memory.source)
  }

  return parts.join(' ')
}

/**
 * Add or update a memory in the index
 * @param {Object} memory - Memory object with id, content, type, tags
 * @returns {Promise<void>}
 */
async function indexMemory(memory) {
  const index = await loadIndex()

  const text = buildIndexableText(memory)
  addDocument(index, memory.id, text)
  isDirty = true

  // Save periodically (every 10 changes) or on explicit flush
  if (isDirty && index.totalDocs % 10 === 0) {
    await saveIndex()
  }
}

/**
 * Remove a memory from the index
 * @param {string} memoryId - Memory ID to remove
 * @returns {Promise<void>}
 */
async function removeMemoryFromIndex(memoryId) {
  const index = await loadIndex()
  removeDocument(index, memoryId)
  isDirty = true
}

/**
 * Search memories using BM25 text matching
 *
 * @param {string} query - Search query
 * @param {Object} options - Search options
 * @param {number} options.limit - Maximum results (default 20)
 * @param {number} options.threshold - Minimum score threshold (default 0.1)
 * @returns {Promise<Array<{id: string, score: number}>>} - Ranked memory IDs with scores
 */
async function searchBM25(query, options = {}) {
  const { limit = 20, threshold = 0.1 } = options

  const index = await loadIndex()
  const results = search(query, index, { limit, threshold })

  return results.map(r => ({
    id: r.docId,
    score: r.score
  }))
}

/**
 * Get index statistics
 * @returns {Promise<Object>} - Index statistics
 */
async function getStats() {
  const index = await loadIndex()
  return {
    ...getIndexStats(index),
    isDirty,
    indexFile: INDEX_FILE
  }
}

/**
 * Flush pending changes to disk
 * @returns {Promise<void>}
 */
async function flush() {
  await saveIndex()
}

/**
 * Clear the entire index
 * @returns {Promise<void>}
 */
async function clearIndex() {
  indexCache = createEmptyIndex()
  isDirty = true
  await saveIndex()
  console.log('🗑️ BM25 index cleared')
}

/**
 * Check if a memory exists in the index
 * @param {string} memoryId - Memory ID
 * @returns {Promise<boolean>}
 */
async function hasMemory(memoryId) {
  const index = await loadIndex()
  return index.docIds.has(memoryId)
}

/**
 * Batch index multiple memories efficiently
 * @param {Array<Object>} memories - Memories to index
 * @returns {Promise<number>} - Number of memories indexed
 */
async function batchIndex(memories) {
  const index = await loadIndex()

  for (const memory of memories) {
    const text = buildIndexableText(memory)
    addDocument(index, memory.id, text)
  }

  isDirty = true
  await saveIndex()

  return memories.length
}

export {
  loadIndex,
  saveIndex,
  rebuildIndex,
  indexMemory,
  removeMemoryFromIndex,
  searchBM25,
  getStats,
  flush,
  clearIndex,
  hasMemory,
  batchIndex,
  buildIndexableText
}

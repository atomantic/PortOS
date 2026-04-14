import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('fs', () => ({
  promises: {
    access: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue()
  }
}))

vi.mock('../lib/fileUtils.js', () => ({
  ensureDir: vi.fn().mockResolvedValue(),
  PATHS: { memory: '/mock/data/memory' }
}))

vi.mock('../lib/bm25.js', () => ({
  buildInvertedIndex: vi.fn((docs) => ({
    terms: {},
    docIds: new Set(docs.map(d => d.id)),
    totalDocs: docs.length,
    docLengths: {},
    avgDocLength: 0
  })),
  addDocument: vi.fn((index, id) => {
    index.docIds.add(id)
    index.totalDocs++
  }),
  removeDocument: vi.fn((index, id) => {
    index.docIds.delete(id)
    index.totalDocs--
  }),
  search: vi.fn(() => []),
  createEmptyIndex: vi.fn(() => ({
    terms: {},
    docIds: new Set(),
    totalDocs: 0,
    docLengths: {},
    avgDocLength: 0
  })),
  serializeIndex: vi.fn((idx) => ({
    terms: {},
    docIds: [...idx.docIds],
    totalDocs: idx.totalDocs,
    docLengths: {},
    avgDocLength: 0
  })),
  deserializeIndex: vi.fn((parsed) => ({
    ...parsed,
    docIds: new Set(parsed.docIds || [])
  })),
  getIndexStats: vi.fn((idx) => ({
    totalDocs: idx.totalDocs,
    totalTerms: Object.keys(idx.terms).length
  }))
}))

import {
  loadIndex,
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
} from './memoryBM25.js'

import { promises as fs } from 'fs'
import { search, createEmptyIndex, buildInvertedIndex } from '../lib/bm25.js'

describe('memoryBM25', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the module's internal cache by clearing the index
    clearIndex()
  })

  describe('buildIndexableText', () => {
    it('should combine content, type, tags, and source', () => {
      const memory = {
        content: 'Hello world',
        type: 'fact',
        tags: ['greeting', 'test'],
        source: 'manual'
      }
      const text = buildIndexableText(memory)
      expect(text).toBe('Hello world fact greeting test manual')
    })

    it('should handle missing fields', () => {
      const text = buildIndexableText({})
      expect(text).toBe('')
    })

    it('should handle content only', () => {
      const text = buildIndexableText({ content: 'just content' })
      expect(text).toBe('just content')
    })

    it('should handle non-array tags gracefully', () => {
      const text = buildIndexableText({ content: 'test', tags: 'not-array' })
      expect(text).toBe('test')
    })

    it('should handle empty tags array', () => {
      const text = buildIndexableText({ content: 'test', tags: [] })
      // empty array still pushes empty string to parts, resulting in trailing space
      expect(text).toBe('test ')
    })
  })

  describe('loadIndex', () => {
    it('should return an index with expected shape', async () => {
      const index = await loadIndex()
      expect(index).toHaveProperty('totalDocs')
      expect(index).toHaveProperty('terms')
      expect(index).toHaveProperty('docIds')
    })

    it('should return cached index on subsequent calls', async () => {
      const index1 = await loadIndex()
      const index2 = await loadIndex()
      expect(index1).toBe(index2)
    })
  })

  describe('rebuildIndex', () => {
    it('should rebuild index from memories', async () => {
      const memories = [
        { id: 'm1', content: 'First memory', type: 'fact', tags: ['test'] },
        { id: 'm2', content: 'Second memory', type: 'event', tags: [] }
      ]

      const stats = await rebuildIndex(memories)
      expect(buildInvertedIndex).toHaveBeenCalledWith([
        { id: 'm1', text: 'First memory fact test' },
        { id: 'm2', text: 'Second memory event ' }
      ])
      expect(stats).toHaveProperty('totalDocs')
    })
  })

  describe('indexMemory', () => {
    it('should add a memory to the index', async () => {
      const memory = { id: 'new-1', content: 'New memory', type: 'fact', tags: ['new'] }
      await indexMemory(memory)

      const exists = await hasMemory('new-1')
      expect(exists).toBe(true)
    })
  })

  describe('removeMemoryFromIndex', () => {
    it('should remove a memory from the index', async () => {
      const memory = { id: 'rm-1', content: 'To remove', type: 'fact', tags: [] }
      await indexMemory(memory)
      await removeMemoryFromIndex('rm-1')

      const exists = await hasMemory('rm-1')
      expect(exists).toBe(false)
    })
  })

  describe('searchBM25', () => {
    it('should search with default options', async () => {
      search.mockReturnValueOnce([
        { docId: 'doc1', score: 1.5 },
        { docId: 'doc2', score: 0.8 }
      ])

      const results = await searchBM25('test query')
      expect(results).toEqual([
        { id: 'doc1', score: 1.5 },
        { id: 'doc2', score: 0.8 }
      ])
      expect(search).toHaveBeenCalledWith('test query', expect.any(Object), { limit: 20, threshold: 0.1 })
    })

    it('should pass custom options', async () => {
      search.mockReturnValueOnce([])

      await searchBM25('query', { limit: 5, threshold: 0.5 })
      expect(search).toHaveBeenCalledWith('query', expect.any(Object), { limit: 5, threshold: 0.5 })
    })

    it('should return empty array when no matches', async () => {
      search.mockReturnValueOnce([])
      const results = await searchBM25('no match')
      expect(results).toEqual([])
    })
  })

  describe('getStats', () => {
    it('should return index stats with isDirty and indexFile', async () => {
      const stats = await getStats()
      expect(stats).toHaveProperty('isDirty')
      expect(stats).toHaveProperty('indexFile')
      expect(stats.indexFile).toContain('bm25-index.json')
    })
  })

  describe('clearIndex', () => {
    it('should reset the index to empty', async () => {
      await indexMemory({ id: 'temp', content: 'temp', type: 'fact', tags: [] })
      await clearIndex()

      const exists = await hasMemory('temp')
      expect(exists).toBe(false)
    })
  })

  describe('batchIndex', () => {
    it('should index multiple memories', async () => {
      const memories = [
        { id: 'b1', content: 'Batch 1', type: 'fact', tags: [] },
        { id: 'b2', content: 'Batch 2', type: 'fact', tags: [] },
        { id: 'b3', content: 'Batch 3', type: 'fact', tags: [] }
      ]

      const count = await batchIndex(memories)
      expect(count).toBe(3)
    })
  })

  describe('hasMemory', () => {
    it('should return false for non-existent memory', async () => {
      const exists = await hasMemory('nonexistent')
      expect(exists).toBe(false)
    })
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'events';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  rm: vi.fn().mockResolvedValue(undefined)
}));

// Mock fs (sync)
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true)
}));

// Mock uuid
vi.mock('../lib/uuid.js', () => ({
  v4: vi.fn().mockReturnValue('test-uuid-1234')
}));

// Mock cosEvents (memory.js imports from cosEvents.js directly)
vi.mock('./cosEvents.js', () => ({
  cosEvents: new EventEmitter()
}));
vi.mock('./cos.js', () => ({
  cosEvents: new EventEmitter()
}));

// Mock vectorMath
vi.mock('../lib/vectorMath.js', () => ({
  findTopK: vi.fn().mockReturnValue([]),
  findAboveThreshold: vi.fn().mockReturnValue([]),
  clusterBySimilarity: vi.fn().mockReturnValue([])
}));

// Mock notifications
vi.mock('./notifications.js', () => ({
  removeByMetadata: vi.fn().mockResolvedValue(undefined)
}));

// Mock fileUtils
vi.mock('../lib/fileUtils.js', () => ({
  ensureDir: vi.fn(),
  ensureDirs: vi.fn(),
  readJSONFile: vi.fn(),
  PATHS: { memory: '/tmp/test/memory' }
}));

// Mock memoryBM25
vi.mock('./memoryBM25.js', () => ({
  indexMemory: vi.fn().mockResolvedValue(undefined),
  removeMemoryFromIndex: vi.fn().mockResolvedValue(undefined),
  searchBM25: vi.fn().mockResolvedValue([]),
  rebuildIndex: vi.fn().mockResolvedValue({ indexed: 0 }),
  getStats: vi.fn().mockResolvedValue({ documentCount: 0 }),
  flush: vi.fn().mockResolvedValue(undefined)
}));

// Mock asyncMutex - pass-through (no actual locking)
vi.mock('../lib/asyncMutex.js', () => ({
  createMutex: () => (fn) => fn()
}));

// Mock memoryConfig
vi.mock('./memoryConfig.js', () => ({
  DEFAULT_MEMORY_CONFIG: {
    enabled: true,
    embeddingModel: 'test-embedding-model',
    embeddingDimension: 768
  },
  generateSummary: vi.fn((content) => {
    if (content.length <= 150) return content;
    return content.substring(0, 147) + '...';
  }),
  decrementAgentPendingApproval: vi.fn().mockResolvedValue(undefined)
}));

import { writeFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { ensureDir, ensureDirs, readJSONFile } from '../lib/fileUtils.js';
import * as memoryBM25 from './memoryBM25.js';
import * as notifications from './notifications.js';
import { findTopK, findAboveThreshold, clusterBySimilarity } from '../lib/vectorMath.js';
import { generateSummary, decrementAgentPendingApproval } from './memoryConfig.js';
import { cosEvents } from './cosEvents.js';
import {
  createMemory,
  getMemory,
  getMemories,
  updateMemory,
  updateMemoryEmbedding,
  deleteMemory,
  approveMemory,
  rejectMemory,
  searchMemories,
  hybridSearchMemories,
  rebuildBM25Index,
  getBM25Stats,
  getTimeline,
  getCategories,
  getTags,
  getRelatedMemories,
  getGraphData,
  linkMemories,
  consolidateMemories,
  applyDecay,
  clearExpired,
  getStats,
  invalidateCaches,
  flushBM25Index
} from './memory.js';

describe('memory service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset caches between tests
    invalidateCaches();
    // Default readJSONFile behavior: return default index or embeddings based on call order
    readJSONFile.mockImplementation((filePath, defaultVal) => Promise.resolve(defaultVal));
    existsSync.mockReturnValue(true);
  });

  // ===========================================================================
  // createMemory
  // ===========================================================================

  describe('createMemory', () => {
    it('should create a memory with defaults', async () => {
      const data = { type: 'fact', content: 'The sky is blue' };
      const result = await createMemory(data);

      expect(result.id).toBe('test-uuid-1234');
      expect(result.type).toBe('fact');
      expect(result.content).toBe('The sky is blue');
      expect(result.category).toBe('other');
      expect(result.tags).toEqual([]);
      expect(result.relatedMemories).toEqual([]);
      expect(result.confidence).toBe(0.8);
      expect(result.importance).toBe(0.5);
      expect(result.accessCount).toBe(0);
      expect(result.status).toBe('active');
      expect(result.embedding).toBeNull();
      expect(result.embeddingModel).toBeNull();
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
    });

    it('should create directories when they do not exist', async () => {
      existsSync.mockReturnValue(false);
      const data = { type: 'fact', content: 'new dir test' };
      await createMemory(data);

      expect(ensureDirs).toHaveBeenCalled();
    });

    it('should use provided fields when given', async () => {
      const data = {
        type: 'decision',
        content: 'Use React',
        summary: 'Custom summary',
        category: 'engineering',
        tags: ['frontend', 'react'],
        confidence: 0.95,
        importance: 0.9,
        sourceTaskId: 'task-1',
        sourceAgentId: 'agent-1',
        sourceAppId: 'app-1',
        status: 'pending_approval',
        expiresAt: '2026-01-01T00:00:00.000Z',
        relatedMemories: ['mem-1']
      };

      const result = await createMemory(data);

      expect(result.summary).toBe('Custom summary');
      expect(result.category).toBe('engineering');
      expect(result.tags).toEqual(['frontend', 'react']);
      expect(result.confidence).toBe(0.95);
      expect(result.importance).toBe(0.9);
      expect(result.sourceTaskId).toBe('task-1');
      expect(result.sourceAgentId).toBe('agent-1');
      expect(result.sourceAppId).toBe('app-1');
      expect(result.status).toBe('pending_approval');
      expect(result.relatedMemories).toEqual(['mem-1']);
    });

    it('should generate summary when not provided', async () => {
      const data = { type: 'fact', content: 'Short content' };
      await createMemory(data);

      expect(generateSummary).toHaveBeenCalledWith('Short content');
    });

    it('should store embedding when provided', async () => {
      const embedding = [0.1, 0.2, 0.3];
      const data = { type: 'fact', content: 'test' };

      const result = await createMemory(data, embedding);

      expect(result.embedding).toEqual([0.1, 0.2, 0.3]);
      expect(result.embeddingModel).toBe('test-embedding-model');
      // Should save embeddings file
      const embeddingsCall = writeFile.mock.calls.find(c => c[0].includes('embeddings.json'));
      expect(embeddingsCall).toBeDefined();
    });

    it('should not save embeddings file when no embedding provided', async () => {
      const data = { type: 'fact', content: 'no embedding' };
      await createMemory(data);

      const embeddingsCall = writeFile.mock.calls.find(c => c[0].includes('embeddings.json'));
      expect(embeddingsCall).toBeUndefined();
    });

    it('should add entry to index and update count', async () => {
      const data = { type: 'learning', content: 'Learned something' };
      await createMemory(data);

      // writeFile is called for saving memory and saving index
      const indexCall = writeFile.mock.calls.find(call =>
        call[0].includes('index.json')
      );
      expect(indexCall).toBeDefined();
      const savedIndex = JSON.parse(indexCall[1]);
      expect(savedIndex.count).toBe(1);
      expect(savedIndex.memories).toHaveLength(1);
      expect(savedIndex.memories[0].id).toBe('test-uuid-1234');
    });

    it('should index in BM25', async () => {
      const data = { type: 'fact', content: 'Indexed content', tags: ['tag1'] };
      await createMemory(data);

      expect(memoryBM25.indexMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test-uuid-1234',
          content: 'Indexed content',
          type: 'fact',
          tags: ['tag1']
        })
      );
    });

    it('should emit memory:created event', async () => {
      const emitSpy = vi.spyOn(cosEvents, 'emit');
      const data = { type: 'fact', content: 'test' };

      await createMemory(data);

      expect(emitSpy).toHaveBeenCalledWith('memory:created', expect.objectContaining({
        id: 'test-uuid-1234',
        type: 'fact'
      }));
    });

    it('should handle confidence of 0 via nullish coalescing', async () => {
      const data = { type: 'fact', content: 'test', confidence: 0 };
      const result = await createMemory(data);

      expect(result.confidence).toBe(0);
    });
  });

  // ===========================================================================
  // getMemory
  // ===========================================================================

  describe('getMemory', () => {
    it('should return memory and update access stats', async () => {
      const mockMemory = {
        id: 'mem-1',
        type: 'fact',
        content: 'test',
        accessCount: 5,
        lastAccessed: null
      };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('memory.json')) return Promise.resolve({ ...mockMemory });
        return Promise.resolve(def);
      });

      const result = await getMemory('mem-1');

      expect(result.accessCount).toBe(6);
      expect(result.lastAccessed).toBeDefined();
    });

    it('should return null for non-existent memory', async () => {
      readJSONFile.mockImplementation((path, def) => Promise.resolve(def));

      const result = await getMemory('non-existent');

      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // getMemories
  // ===========================================================================

  describe('getMemories', () => {
    const makeIndex = (memories) => ({
      version: 1,
      lastUpdated: '2025-01-01T00:00:00.000Z',
      count: memories.length,
      memories
    });

    const mem1 = { id: 'm1', type: 'fact', category: 'science', tags: ['physics'], summary: 'Gravity', importance: 0.8, createdAt: '2025-01-01T00:00:00.000Z', status: 'active', sourceAppId: 'app1' };
    const mem2 = { id: 'm2', type: 'decision', category: 'engineering', tags: ['react'], summary: 'Use React', importance: 0.6, createdAt: '2025-01-02T00:00:00.000Z', status: 'active', sourceAppId: 'brain' };
    const mem3 = { id: 'm3', type: 'fact', category: 'science', tags: ['math'], summary: 'Pi', importance: 0.9, createdAt: '2025-01-03T00:00:00.000Z', status: 'archived', sourceAppId: 'app1' };

    beforeEach(() => {
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(makeIndex([mem1, mem2, mem3]));
        return Promise.resolve(def);
      });
    });

    it('should return active memories by default', async () => {
      const result = await getMemories();

      expect(result.total).toBe(2);
      expect(result.memories.every(m => m.status === 'active')).toBe(true);
    });

    it('should filter by status', async () => {
      const result = await getMemories({ status: 'archived' });

      expect(result.total).toBe(1);
      expect(result.memories[0].id).toBe('m3');
    });

    it('should filter by types', async () => {
      const result = await getMemories({ types: ['fact'] });

      expect(result.total).toBe(1);
      expect(result.memories[0].type).toBe('fact');
    });

    it('should filter by categories', async () => {
      const result = await getMemories({ categories: ['engineering'] });

      expect(result.total).toBe(1);
      expect(result.memories[0].category).toBe('engineering');
    });

    it('should filter by tags (any match)', async () => {
      const result = await getMemories({ tags: ['physics', 'react'] });

      expect(result.total).toBe(2);
    });

    it('should filter by appId', async () => {
      const result = await getMemories({ appId: 'app1' });

      expect(result.total).toBe(1);
      expect(result.memories[0].sourceAppId).toBe('app1');
    });

    it('should filter by __not_brain appId', async () => {
      const result = await getMemories({ appId: '__not_brain' });

      expect(result.total).toBe(1);
      expect(result.memories[0].sourceAppId).not.toBe('brain');
    });

    it('should sort by createdAt desc by default', async () => {
      const result = await getMemories();

      expect(result.memories[0].id).toBe('m2');
      expect(result.memories[1].id).toBe('m1');
    });

    it('should sort ascending when specified', async () => {
      const result = await getMemories({ sortOrder: 'asc' });

      expect(result.memories[0].id).toBe('m1');
    });

    it('should sort by importance', async () => {
      const result = await getMemories({ sortBy: 'importance', sortOrder: 'desc' });

      expect(result.memories[0].importance).toBeGreaterThanOrEqual(result.memories[1].importance);
    });

    it('should paginate results', async () => {
      const result = await getMemories({ offset: 0, limit: 1 });

      expect(result.total).toBe(2);
      expect(result.memories).toHaveLength(1);
    });

    it('should handle offset pagination', async () => {
      const result = await getMemories({ offset: 1, limit: 1 });

      expect(result.memories).toHaveLength(1);
    });

    it('should return empty when no memories match filters', async () => {
      const result = await getMemories({ types: ['preference'] });

      expect(result.total).toBe(0);
      expect(result.memories).toEqual([]);
    });
  });

  // ===========================================================================
  // updateMemory
  // ===========================================================================

  describe('updateMemory', () => {
    it('should update allowed fields', async () => {
      const mockMemory = {
        id: 'mem-1',
        type: 'fact',
        content: 'old content',
        summary: 'old summary',
        category: 'other',
        tags: [],
        importance: 0.5,
        relatedMemories: [],
        status: 'active',
        sourceAppId: null
      };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('memory.json')) return Promise.resolve({ ...mockMemory });
        if (path.includes('index.json')) return Promise.resolve({
          version: 1, lastUpdated: '', count: 1,
          memories: [{ id: 'mem-1', type: 'fact', category: 'other', tags: [], summary: 'old', importance: 0.5, createdAt: '', status: 'active', sourceAppId: null }]
        });
        return Promise.resolve(def);
      });

      const result = await updateMemory('mem-1', {
        content: 'new content',
        category: 'engineering',
        tags: ['updated'],
        importance: 0.9
      });

      expect(result.content).toBe('new content');
      expect(result.category).toBe('engineering');
      expect(result.tags).toEqual(['updated']);
      expect(result.importance).toBe(0.9);
      expect(result.updatedAt).toBeDefined();
    });

    it('should auto-generate summary when content changes without explicit summary', async () => {
      const mockMemory = { id: 'mem-1', type: 'fact', content: 'old', summary: 'old', category: 'other', tags: [], importance: 0.5, relatedMemories: [], status: 'active', sourceAppId: null };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('memory.json')) return Promise.resolve({ ...mockMemory });
        if (path.includes('index.json')) return Promise.resolve({ version: 1, lastUpdated: '', count: 1, memories: [{ id: 'mem-1', type: 'fact', category: 'other', tags: [], summary: 'old', importance: 0.5, createdAt: '', status: 'active', sourceAppId: null }] });
        return Promise.resolve(def);
      });

      await updateMemory('mem-1', { content: 'brand new content' });

      expect(generateSummary).toHaveBeenCalledWith('brand new content');
    });

    it('should not regenerate summary when both content and summary provided', async () => {
      const mockMemory = { id: 'mem-1', type: 'fact', content: 'old', summary: 'old', category: 'other', tags: [], importance: 0.5, relatedMemories: [], status: 'active', sourceAppId: null };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('memory.json')) return Promise.resolve({ ...mockMemory });
        if (path.includes('index.json')) return Promise.resolve({ version: 1, lastUpdated: '', count: 1, memories: [{ id: 'mem-1', type: 'fact', category: 'other', tags: [], summary: 'old', importance: 0.5, createdAt: '', status: 'active', sourceAppId: null }] });
        return Promise.resolve(def);
      });

      const result = await updateMemory('mem-1', { content: 'new', summary: 'explicit summary' });

      expect(result.summary).toBe('explicit summary');
    });

    it('should return null for non-existent memory', async () => {
      readJSONFile.mockImplementation((path, def) => Promise.resolve(def));

      const result = await updateMemory('non-existent', { content: 'test' });

      expect(result).toBeNull();
    });

    it('should update BM25 index when content changes', async () => {
      const mockMemory = { id: 'mem-1', type: 'fact', content: 'old', summary: 'old', category: 'other', tags: [], importance: 0.5, relatedMemories: [], status: 'active', sourceAppId: null };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('memory.json')) return Promise.resolve({ ...mockMemory });
        if (path.includes('index.json')) return Promise.resolve({ version: 1, lastUpdated: '', count: 1, memories: [{ id: 'mem-1', type: 'fact', category: 'other', tags: [], summary: 'old', importance: 0.5, createdAt: '', status: 'active', sourceAppId: null }] });
        return Promise.resolve(def);
      });

      await updateMemory('mem-1', { content: 'new content' });

      expect(memoryBM25.indexMemory).toHaveBeenCalled();
    });

    it('should update BM25 index when tags change', async () => {
      const mockMemory = { id: 'mem-1', type: 'fact', content: 'test', summary: 'test', category: 'other', tags: [], importance: 0.5, relatedMemories: [], status: 'active', sourceAppId: null };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('memory.json')) return Promise.resolve({ ...mockMemory });
        if (path.includes('index.json')) return Promise.resolve({ version: 1, lastUpdated: '', count: 1, memories: [{ id: 'mem-1', type: 'fact', category: 'other', tags: [], summary: 'test', importance: 0.5, createdAt: '', status: 'active', sourceAppId: null }] });
        return Promise.resolve(def);
      });

      await updateMemory('mem-1', { tags: ['new-tag'] });

      expect(memoryBM25.indexMemory).toHaveBeenCalled();
    });

    it('should emit memory:updated event', async () => {
      const emitSpy = vi.spyOn(cosEvents, 'emit');
      const mockMemory = { id: 'mem-1', type: 'fact', content: 'test', summary: 'test', category: 'other', tags: [], importance: 0.5, relatedMemories: [], status: 'active', sourceAppId: null };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('memory.json')) return Promise.resolve({ ...mockMemory });
        if (path.includes('index.json')) return Promise.resolve({ version: 1, lastUpdated: '', count: 1, memories: [{ id: 'mem-1', type: 'fact', category: 'other', tags: [], summary: 'test', importance: 0.5, createdAt: '', status: 'active', sourceAppId: null }] });
        return Promise.resolve(def);
      });

      await updateMemory('mem-1', { category: 'updated' });

      expect(emitSpy).toHaveBeenCalledWith('memory:updated', { id: 'mem-1', updates: { category: 'updated' } });
    });
  });

  // ===========================================================================
  // updateMemoryEmbedding
  // ===========================================================================

  describe('updateMemoryEmbedding', () => {
    it('should update embedding on memory and embeddings file', async () => {
      const mockMemory = { id: 'mem-1', embedding: null, embeddingModel: null, updatedAt: '' };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('memory.json')) return Promise.resolve({ ...mockMemory });
        if (path.includes('embeddings.json')) return Promise.resolve({ model: null, dimension: 0, vectors: {} });
        return Promise.resolve(def);
      });

      const embedding = [0.5, 0.6, 0.7];
      const result = await updateMemoryEmbedding('mem-1', embedding);

      expect(result.embedding).toEqual([0.5, 0.6, 0.7]);
      expect(result.embeddingModel).toBe('test-embedding-model');
    });

    it('should return null for non-existent memory', async () => {
      readJSONFile.mockImplementation((path, def) => Promise.resolve(def));

      const result = await updateMemoryEmbedding('non-existent', [0.1]);

      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // deleteMemory
  // ===========================================================================

  describe('deleteMemory', () => {
    const makeReadMock = (memory, index, embeddings) => (path, def) => {
      if (path.includes('memory.json')) return Promise.resolve(memory ? { ...memory } : def);
      if (path.includes('index.json')) return Promise.resolve(index || def);
      if (path.includes('embeddings.json')) return Promise.resolve(embeddings || def);
      return Promise.resolve(def);
    };

    it('should soft delete (archive) by default', async () => {
      const mockMemory = { id: 'mem-1', status: 'active', updatedAt: '' };
      const mockIndex = { version: 1, lastUpdated: '', count: 1, memories: [{ id: 'mem-1', status: 'active' }] };
      readJSONFile.mockImplementation(makeReadMock(mockMemory, mockIndex));

      const result = await deleteMemory('mem-1');

      expect(result).toEqual({ success: true, id: 'mem-1' });
      expect(rm).not.toHaveBeenCalled();
      // The memory should have been saved with archived status
      const memorySaveCall = writeFile.mock.calls.find(c => c[0].includes('memory.json'));
      expect(memorySaveCall).toBeDefined();
      const savedMemory = JSON.parse(memorySaveCall[1]);
      expect(savedMemory.status).toBe('archived');
    });

    it('should hard delete when hard=true', async () => {
      const mockIndex = { version: 1, lastUpdated: '', count: 1, memories: [{ id: 'mem-1', status: 'active' }] };
      const mockEmbeddings = { model: 'test', dimension: 3, vectors: { 'mem-1': [0.1, 0.2, 0.3] } };
      readJSONFile.mockImplementation(makeReadMock(null, mockIndex, mockEmbeddings));

      const result = await deleteMemory('mem-1', true);

      expect(result).toEqual({ success: true, id: 'mem-1' });
      expect(rm).toHaveBeenCalled();
      expect(memoryBM25.removeMemoryFromIndex).toHaveBeenCalledWith('mem-1');
    });

    it('should emit memory:deleted event', async () => {
      const emitSpy = vi.spyOn(cosEvents, 'emit');
      const mockMemory = { id: 'mem-1', status: 'active', updatedAt: '' };
      const mockIndex = { version: 1, lastUpdated: '', count: 1, memories: [{ id: 'mem-1', status: 'active' }] };
      readJSONFile.mockImplementation(makeReadMock(mockMemory, mockIndex));

      await deleteMemory('mem-1');

      expect(emitSpy).toHaveBeenCalledWith('memory:deleted', { id: 'mem-1', hard: false });
    });

    it('should emit memory:deleted with hard=true', async () => {
      const emitSpy = vi.spyOn(cosEvents, 'emit');
      const mockIndex = { version: 1, lastUpdated: '', count: 1, memories: [{ id: 'mem-1', status: 'active' }] };
      readJSONFile.mockImplementation(makeReadMock(null, mockIndex));

      await deleteMemory('mem-1', true);

      expect(emitSpy).toHaveBeenCalledWith('memory:deleted', { id: 'mem-1', hard: true });
    });
  });

  // ===========================================================================
  // approveMemory
  // ===========================================================================

  describe('approveMemory', () => {
    it('should approve a pending_approval memory', async () => {
      const mockMemory = { id: 'mem-1', status: 'pending_approval', sourceAgentId: 'agent-1', updatedAt: '' };
      const mockIndex = { version: 1, lastUpdated: '', count: 1, memories: [{ id: 'mem-1', status: 'pending_approval' }] };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('memory.json')) return Promise.resolve({ ...mockMemory });
        if (path.includes('index.json')) return Promise.resolve({ ...mockIndex, memories: [...mockIndex.memories] });
        return Promise.resolve(def);
      });

      const result = await approveMemory('mem-1');

      expect(result.success).toBe(true);
      expect(result.memory.status).toBe('active');
      expect(notifications.removeByMetadata).toHaveBeenCalledWith('memoryId', 'mem-1');
      expect(decrementAgentPendingApproval).toHaveBeenCalledWith('agent-1');
    });

    it('should return error for non-existent memory', async () => {
      readJSONFile.mockImplementation((path, def) => Promise.resolve(def));

      const result = await approveMemory('non-existent');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Memory not found');
    });

    it('should return error if not pending_approval', async () => {
      const mockMemory = { id: 'mem-1', status: 'active' };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('memory.json')) return Promise.resolve({ ...mockMemory });
        return Promise.resolve(def);
      });

      const result = await approveMemory('mem-1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Memory is not pending approval');
    });

    it('should emit memory:approved event', async () => {
      const emitSpy = vi.spyOn(cosEvents, 'emit');
      const mockMemory = { id: 'mem-1', status: 'pending_approval', sourceAgentId: 'agent-1', updatedAt: '' };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('memory.json')) return Promise.resolve({ ...mockMemory });
        if (path.includes('index.json')) return Promise.resolve({ version: 1, lastUpdated: '', count: 1, memories: [{ id: 'mem-1', status: 'pending_approval' }] });
        return Promise.resolve(def);
      });

      await approveMemory('mem-1');

      expect(emitSpy).toHaveBeenCalledWith('memory:approved', expect.objectContaining({ id: 'mem-1' }));
    });
  });

  // ===========================================================================
  // rejectMemory
  // ===========================================================================

  describe('rejectMemory', () => {
    it('should hard delete a pending_approval memory', async () => {
      const mockMemory = { id: 'mem-1', status: 'pending_approval', sourceAgentId: 'agent-1' };
      const mockIndex = { version: 1, lastUpdated: '', count: 1, memories: [{ id: 'mem-1', status: 'pending_approval' }] };
      const mockEmbeddings = { model: 'test', dimension: 0, vectors: {} };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('memory.json')) return Promise.resolve({ ...mockMemory });
        if (path.includes('index.json')) return Promise.resolve({ ...mockIndex, memories: [...mockIndex.memories] });
        if (path.includes('embeddings.json')) return Promise.resolve({ ...mockEmbeddings });
        return Promise.resolve(def);
      });

      const result = await rejectMemory('mem-1');

      expect(result.success).toBe(true);
      expect(rm).toHaveBeenCalled();
      expect(notifications.removeByMetadata).toHaveBeenCalledWith('memoryId', 'mem-1');
      expect(decrementAgentPendingApproval).toHaveBeenCalledWith('agent-1');
    });

    it('should return error for non-existent memory', async () => {
      readJSONFile.mockImplementation((path, def) => Promise.resolve(def));

      const result = await rejectMemory('non-existent');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Memory not found');
    });

    it('should return error if not pending_approval', async () => {
      const mockMemory = { id: 'mem-1', status: 'active' };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('memory.json')) return Promise.resolve({ ...mockMemory });
        return Promise.resolve(def);
      });

      const result = await rejectMemory('mem-1');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Memory is not pending approval');
    });

    it('should emit memory:rejected event', async () => {
      const emitSpy = vi.spyOn(cosEvents, 'emit');
      const mockMemory = { id: 'mem-1', status: 'pending_approval', sourceAgentId: 'agent-1' };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('memory.json')) return Promise.resolve({ ...mockMemory });
        if (path.includes('index.json')) return Promise.resolve({ version: 1, lastUpdated: '', count: 1, memories: [{ id: 'mem-1', status: 'pending_approval' }] });
        if (path.includes('embeddings.json')) return Promise.resolve({ model: null, dimension: 0, vectors: {} });
        return Promise.resolve(def);
      });

      await rejectMemory('mem-1');

      expect(emitSpy).toHaveBeenCalledWith('memory:rejected', { id: 'mem-1' });
    });
  });

  // ===========================================================================
  // searchMemories
  // ===========================================================================

  describe('searchMemories', () => {
    it('should return empty when no query embedding provided', async () => {
      const result = await searchMemories(null);

      expect(result).toEqual({ total: 0, memories: [] });
    });

    it('should return empty when no embeddings exist', async () => {
      readJSONFile.mockImplementation((path, def) => Promise.resolve(def));

      const result = await searchMemories([0.1, 0.2]);

      expect(result).toEqual({ total: 0, memories: [] });
    });

    it('should filter out non-active results', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 2,
        memories: [
          { id: 'm1', type: 'fact', status: 'active', tags: [] },
          { id: 'm2', type: 'fact', status: 'archived', tags: [] }
        ]
      };
      const mockEmbeddings = { model: 'test', dimension: 3, vectors: { m1: [0.1], m2: [0.2] } };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('embeddings.json')) return Promise.resolve(mockEmbeddings);
        return Promise.resolve(def);
      });
      findAboveThreshold.mockReturnValue([
        { id: 'm1', similarity: 0.9 },
        { id: 'm2', similarity: 0.85 }
      ]);

      const result = await searchMemories([0.1, 0.2]);

      expect(result.total).toBe(1);
      expect(result.memories[0].id).toBe('m1');
    });

    it('should apply type filter', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 2,
        memories: [
          { id: 'm1', type: 'fact', category: 'other', status: 'active', tags: [] },
          { id: 'm2', type: 'decision', category: 'other', status: 'active', tags: [] }
        ]
      };
      const mockEmbeddings = { model: 'test', dimension: 3, vectors: { m1: [0.1], m2: [0.2] } };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('embeddings.json')) return Promise.resolve(mockEmbeddings);
        return Promise.resolve(def);
      });
      findAboveThreshold.mockReturnValue([
        { id: 'm1', similarity: 0.9 },
        { id: 'm2', similarity: 0.85 }
      ]);

      const result = await searchMemories([0.1], { types: ['fact'] });

      expect(result.total).toBe(1);
      expect(result.memories[0].id).toBe('m1');
    });

    it('should apply __not_brain filter', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 2,
        memories: [
          { id: 'm1', type: 'fact', status: 'active', tags: [], sourceAppId: 'brain' },
          { id: 'm2', type: 'fact', status: 'active', tags: [], sourceAppId: 'other' }
        ]
      };
      const mockEmbeddings = { model: 'test', dimension: 3, vectors: { m1: [0.1], m2: [0.2] } };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('embeddings.json')) return Promise.resolve(mockEmbeddings);
        return Promise.resolve(def);
      });
      findAboveThreshold.mockReturnValue([
        { id: 'm1', similarity: 0.9 },
        { id: 'm2', similarity: 0.85 }
      ]);

      const result = await searchMemories([0.1], { appId: '__not_brain' });

      expect(result.total).toBe(1);
      expect(result.memories[0].id).toBe('m2');
    });

    it('should include similarity score in results', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 1,
        memories: [{ id: 'm1', type: 'fact', status: 'active', tags: [] }]
      };
      const mockEmbeddings = { model: 'test', dimension: 3, vectors: { m1: [0.1] } };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('embeddings.json')) return Promise.resolve(mockEmbeddings);
        return Promise.resolve(def);
      });
      findAboveThreshold.mockReturnValue([{ id: 'm1', similarity: 0.95 }]);

      const result = await searchMemories([0.1]);

      expect(result.memories[0].similarity).toBe(0.95);
    });
  });

  // ===========================================================================
  // hybridSearchMemories
  // ===========================================================================

  describe('hybridSearchMemories', () => {
    it('should combine BM25 and vector results via RRF', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 2,
        memories: [
          { id: 'm1', type: 'fact', status: 'active', tags: [], category: 'other', sourceAppId: null },
          { id: 'm2', type: 'fact', status: 'active', tags: [], category: 'other', sourceAppId: null }
        ]
      };
      const mockEmbeddings = { model: 'test', dimension: 3, vectors: { m1: [0.1], m2: [0.2] } };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('embeddings.json')) return Promise.resolve(mockEmbeddings);
        return Promise.resolve(def);
      });
      memoryBM25.searchBM25.mockResolvedValue([{ id: 'm1', score: 0.8 }]);
      findAboveThreshold.mockReturnValue([{ id: 'm2', similarity: 0.9 }]);

      const result = await hybridSearchMemories('test query', [0.1, 0.2]);

      expect(result.total).toBe(2);
      // Both should appear with RRF scores
      const ids = result.memories.map(m => m.id);
      expect(ids).toContain('m1');
      expect(ids).toContain('m2');
    });

    it('should mark searchMethod correctly', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 1,
        memories: [{ id: 'm1', type: 'fact', status: 'active', tags: [], category: 'other', sourceAppId: null }]
      };
      const mockEmbeddings = { model: 'test', dimension: 3, vectors: { m1: [0.1] } };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('embeddings.json')) return Promise.resolve(mockEmbeddings);
        return Promise.resolve(def);
      });
      memoryBM25.searchBM25.mockResolvedValue([{ id: 'm1', score: 0.8 }]);
      findAboveThreshold.mockReturnValue([{ id: 'm1', similarity: 0.9 }]);

      const result = await hybridSearchMemories('query', [0.1]);

      expect(result.memories[0].searchMethod).toBe('hybrid');
    });

    it('should handle empty query (no BM25)', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 1,
        memories: [{ id: 'm1', type: 'fact', status: 'active', tags: [], category: 'other', sourceAppId: null }]
      };
      const mockEmbeddings = { model: 'test', dimension: 3, vectors: { m1: [0.1] } };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('embeddings.json')) return Promise.resolve(mockEmbeddings);
        return Promise.resolve(def);
      });
      findAboveThreshold.mockReturnValue([{ id: 'm1', similarity: 0.9 }]);

      const result = await hybridSearchMemories('', [0.1]);

      expect(result.memories[0].searchMethod).toBe('vector');
      expect(memoryBM25.searchBM25).not.toHaveBeenCalled();
    });

    it('should handle no embedding (BM25 only)', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 1,
        memories: [{ id: 'm1', type: 'fact', status: 'active', tags: [], category: 'other', sourceAppId: null }]
      };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('embeddings.json')) return Promise.resolve({ model: null, dimension: 0, vectors: {} });
        return Promise.resolve(def);
      });
      memoryBM25.searchBM25.mockResolvedValue([{ id: 'm1', score: 0.8 }]);

      const result = await hybridSearchMemories('query', null);

      expect(result.memories[0].searchMethod).toBe('bm25');
    });

    it('should filter out non-active in hybrid results', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 1,
        memories: [{ id: 'm1', type: 'fact', status: 'archived', tags: [], category: 'other', sourceAppId: null }]
      };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('embeddings.json')) return Promise.resolve({ model: null, dimension: 0, vectors: {} });
        return Promise.resolve(def);
      });
      memoryBM25.searchBM25.mockResolvedValue([{ id: 'm1', score: 0.8 }]);

      const result = await hybridSearchMemories('query', null);

      expect(result.total).toBe(0);
    });
  });

  // ===========================================================================
  // rebuildBM25Index
  // ===========================================================================

  describe('rebuildBM25Index', () => {
    it('should rebuild index from active memories', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 2,
        memories: [
          { id: 'm1', status: 'active' },
          { id: 'm2', status: 'archived' }
        ]
      };
      const mockMemory = { id: 'm1', content: 'test', type: 'fact', tags: ['t1'], sourceAppId: 'app1' };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('m1/memory.json')) return Promise.resolve(mockMemory);
        return Promise.resolve(def);
      });
      memoryBM25.rebuildIndex.mockResolvedValue({ indexed: 1 });

      const result = await rebuildBM25Index();

      expect(memoryBM25.rebuildIndex).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'm1', content: 'test' })
      ]);
      expect(result).toEqual({ indexed: 1 });
    });
  });

  // ===========================================================================
  // getBM25Stats
  // ===========================================================================

  describe('getBM25Stats', () => {
    it('should delegate to memoryBM25.getStats', async () => {
      memoryBM25.getStats.mockResolvedValue({ documentCount: 42 });

      const result = await getBM25Stats();

      expect(result).toEqual({ documentCount: 42 });
    });
  });

  // ===========================================================================
  // getTimeline
  // ===========================================================================

  describe('getTimeline', () => {
    it('should group active memories by date', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 3,
        memories: [
          { id: 'm1', createdAt: '2025-01-15T10:00:00.000Z', status: 'active', sourceAppId: null },
          { id: 'm2', createdAt: '2025-01-15T14:00:00.000Z', status: 'active', sourceAppId: null },
          { id: 'm3', createdAt: '2025-01-16T08:00:00.000Z', status: 'active', sourceAppId: null }
        ]
      };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        return Promise.resolve(def);
      });

      const timeline = await getTimeline();

      expect(timeline['2025-01-15']).toHaveLength(2);
      expect(timeline['2025-01-16']).toHaveLength(1);
    });

    it('should filter by date range', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 2,
        memories: [
          { id: 'm1', createdAt: '2025-01-10T00:00:00.000Z', status: 'active', sourceAppId: null },
          { id: 'm2', createdAt: '2025-01-20T00:00:00.000Z', status: 'active', sourceAppId: null }
        ]
      };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        return Promise.resolve(def);
      });

      const timeline = await getTimeline({ startDate: '2025-01-15T00:00:00.000Z' });

      expect(Object.keys(timeline)).toHaveLength(1);
      expect(timeline['2025-01-20']).toBeDefined();
    });

    it('should filter by types', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 2,
        memories: [
          { id: 'm1', type: 'fact', createdAt: '2025-01-15T00:00:00.000Z', status: 'active', sourceAppId: null },
          { id: 'm2', type: 'decision', createdAt: '2025-01-15T00:00:00.000Z', status: 'active', sourceAppId: null }
        ]
      };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        return Promise.resolve(def);
      });

      const timeline = await getTimeline({ types: ['fact'] });

      expect(timeline['2025-01-15']).toHaveLength(1);
    });

    it('should exclude archived memories', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 2,
        memories: [
          { id: 'm1', createdAt: '2025-01-15T00:00:00.000Z', status: 'active', sourceAppId: null },
          { id: 'm2', createdAt: '2025-01-15T00:00:00.000Z', status: 'archived', sourceAppId: null }
        ]
      };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        return Promise.resolve(def);
      });

      const timeline = await getTimeline();

      expect(timeline['2025-01-15']).toHaveLength(1);
    });

    it('should apply limit', async () => {
      const memories = Array.from({ length: 10 }, (_, i) => ({
        id: `m${i}`, createdAt: `2025-01-${String(i + 10).padStart(2, '0')}T00:00:00.000Z`, status: 'active', sourceAppId: null
      }));
      const mockIndex = { version: 1, lastUpdated: '', count: 10, memories };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        return Promise.resolve(def);
      });

      const timeline = await getTimeline({ limit: 3 });

      const totalEntries = Object.values(timeline).reduce((sum, arr) => sum + arr.length, 0);
      expect(totalEntries).toBe(3);
    });

    it('should filter by __not_brain appId', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 2,
        memories: [
          { id: 'm1', createdAt: '2025-01-15T00:00:00.000Z', status: 'active', sourceAppId: 'brain' },
          { id: 'm2', createdAt: '2025-01-15T00:00:00.000Z', status: 'active', sourceAppId: 'other' }
        ]
      };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        return Promise.resolve(def);
      });

      const timeline = await getTimeline({ appId: '__not_brain' });

      expect(timeline['2025-01-15']).toHaveLength(1);
      expect(timeline['2025-01-15'][0].sourceAppId).toBe('other');
    });
  });

  // ===========================================================================
  // getCategories
  // ===========================================================================

  describe('getCategories', () => {
    it('should return unique categories with counts', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 3,
        memories: [
          { id: 'm1', category: 'science', status: 'active' },
          { id: 'm2', category: 'science', status: 'active' },
          { id: 'm3', category: 'engineering', status: 'active' }
        ]
      };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        return Promise.resolve(def);
      });

      const categories = await getCategories();

      expect(categories).toContainEqual({ name: 'science', count: 2 });
      expect(categories).toContainEqual({ name: 'engineering', count: 1 });
    });

    it('should exclude archived memories', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 2,
        memories: [
          { id: 'm1', category: 'science', status: 'active' },
          { id: 'm2', category: 'science', status: 'archived' }
        ]
      };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        return Promise.resolve(def);
      });

      const categories = await getCategories();

      expect(categories).toEqual([{ name: 'science', count: 1 }]);
    });

    it('should return empty array when no active memories', async () => {
      readJSONFile.mockImplementation((path, def) => Promise.resolve(def));

      const categories = await getCategories();

      expect(categories).toEqual([]);
    });
  });

  // ===========================================================================
  // getTags
  // ===========================================================================

  describe('getTags', () => {
    it('should return unique tags with counts sorted by count desc', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 3,
        memories: [
          { id: 'm1', tags: ['react', 'js'], status: 'active' },
          { id: 'm2', tags: ['react', 'node'], status: 'active' },
          { id: 'm3', tags: ['python'], status: 'active' }
        ]
      };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        return Promise.resolve(def);
      });

      const tags = await getTags();

      expect(tags[0]).toEqual({ name: 'react', count: 2 });
      expect(tags).toContainEqual({ name: 'js', count: 1 });
      expect(tags).toContainEqual({ name: 'node', count: 1 });
      expect(tags).toContainEqual({ name: 'python', count: 1 });
    });

    it('should exclude archived memories', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 2,
        memories: [
          { id: 'm1', tags: ['react'], status: 'active' },
          { id: 'm2', tags: ['react', 'vue'], status: 'archived' }
        ]
      };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        return Promise.resolve(def);
      });

      const tags = await getTags();

      expect(tags).toEqual([{ name: 'react', count: 1 }]);
    });
  });

  // ===========================================================================
  // getRelatedMemories
  // ===========================================================================

  describe('getRelatedMemories', () => {
    it('should return explicitly linked memories', async () => {
      const mockMemory = { id: 'mem-1', relatedMemories: ['mem-2'], embedding: null };
      const mockIndex = {
        version: 1, lastUpdated: '', count: 2,
        memories: [
          { id: 'mem-1', status: 'active' },
          { id: 'mem-2', status: 'active', summary: 'linked' }
        ]
      };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('memory.json')) return Promise.resolve({ ...mockMemory });
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('embeddings.json')) return Promise.resolve({ model: null, dimension: 0, vectors: {} });
        return Promise.resolve(def);
      });

      const related = await getRelatedMemories('mem-1');

      expect(related).toHaveLength(1);
      expect(related[0].relationship).toBe('linked');
      expect(related[0].similarity).toBe(1.0);
    });

    it('should include similar memories by embedding', async () => {
      const mockMemory = { id: 'mem-1', relatedMemories: [], embedding: [0.1, 0.2] };
      const mockIndex = {
        version: 1, lastUpdated: '', count: 2,
        memories: [
          { id: 'mem-1', status: 'active' },
          { id: 'mem-3', status: 'active', summary: 'similar' }
        ]
      };
      const mockEmbeddings = { model: 'test', dimension: 2, vectors: { 'mem-1': [0.1, 0.2], 'mem-3': [0.15, 0.25] } };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('memory.json')) return Promise.resolve({ ...mockMemory });
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('embeddings.json')) return Promise.resolve(mockEmbeddings);
        return Promise.resolve(def);
      });
      findTopK.mockReturnValue([{ id: 'mem-3', similarity: 0.85 }]);

      const related = await getRelatedMemories('mem-1');

      expect(related).toHaveLength(1);
      expect(related[0].relationship).toBe('similar');
      expect(related[0].similarity).toBe(0.85);
    });

    it('should return empty for non-existent memory', async () => {
      readJSONFile.mockImplementation((path, def) => Promise.resolve(def));

      const related = await getRelatedMemories('non-existent');

      expect(related).toEqual([]);
    });

    it('should not duplicate linked and similar results', async () => {
      const mockMemory = { id: 'mem-1', relatedMemories: ['mem-2'], embedding: [0.1] };
      const mockIndex = {
        version: 1, lastUpdated: '', count: 2,
        memories: [
          { id: 'mem-1', status: 'active' },
          { id: 'mem-2', status: 'active' }
        ]
      };
      const mockEmbeddings = { model: 'test', dimension: 1, vectors: { 'mem-1': [0.1], 'mem-2': [0.15] } };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('memory.json')) return Promise.resolve({ ...mockMemory });
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('embeddings.json')) return Promise.resolve(mockEmbeddings);
        return Promise.resolve(def);
      });
      // findTopK returns mem-2 as similar too
      findTopK.mockReturnValue([{ id: 'mem-2', similarity: 0.9 }]);

      const related = await getRelatedMemories('mem-1');

      expect(related).toHaveLength(1);
      expect(related[0].relationship).toBe('linked');
    });

    it('should respect limit parameter', async () => {
      const mockMemory = { id: 'mem-1', relatedMemories: ['mem-2', 'mem-3', 'mem-4'], embedding: null };
      const mockIndex = {
        version: 1, lastUpdated: '', count: 4,
        memories: [
          { id: 'mem-1', status: 'active' },
          { id: 'mem-2', status: 'active' },
          { id: 'mem-3', status: 'active' },
          { id: 'mem-4', status: 'active' }
        ]
      };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('memory.json')) return Promise.resolve({ ...mockMemory });
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('embeddings.json')) return Promise.resolve({ model: null, dimension: 0, vectors: {} });
        return Promise.resolve(def);
      });

      const related = await getRelatedMemories('mem-1', 2);

      expect(related).toHaveLength(2);
    });
  });

  // ===========================================================================
  // linkMemories
  // ===========================================================================

  describe('linkMemories', () => {
    it('should create bidirectional links', async () => {
      const source = { id: 'src', relatedMemories: [], updatedAt: '' };
      const target = { id: 'tgt', relatedMemories: [], updatedAt: '' };
      let callCount = 0;
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('memory.json')) {
          callCount++;
          // First call is source, second is target
          return Promise.resolve(callCount <= 1 ? { ...source } : { ...target });
        }
        return Promise.resolve(def);
      });

      const result = await linkMemories('src', 'tgt');

      expect(result.success).toBe(true);
      expect(result.sourceId).toBe('src');
      expect(result.targetId).toBe('tgt');
      // Both memories should be saved with the link
      const memorySaves = writeFile.mock.calls.filter(c => c[0].includes('memory.json'));
      expect(memorySaves.length).toBe(2);
    });

    it('should return error when source not found', async () => {
      readJSONFile.mockImplementation((path, def) => Promise.resolve(def));

      const result = await linkMemories('missing-src', 'missing-tgt');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Memory not found');
    });

    it('should not duplicate existing links', async () => {
      const source = { id: 'src', relatedMemories: ['tgt'], updatedAt: '' };
      const target = { id: 'tgt', relatedMemories: ['src'], updatedAt: '' };
      let callCount = 0;
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('memory.json')) {
          callCount++;
          return Promise.resolve(callCount <= 1 ? { ...source } : { ...target });
        }
        return Promise.resolve(def);
      });

      await linkMemories('src', 'tgt');

      // Should not add duplicate - memories saved but relatedMemories should still be length 1
      const memorySaves = writeFile.mock.calls.filter(c => c[0].includes('memory.json'));
      for (const save of memorySaves) {
        const saved = JSON.parse(save[1]);
        expect(saved.relatedMemories).toHaveLength(1);
      }
    });
  });

  // ===========================================================================
  // getGraphData
  // ===========================================================================

  describe('getGraphData', () => {
    it('should return nodes and edges', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 2,
        memories: [
          { id: 'm1', type: 'fact', category: 'science', summary: 'test1', importance: 0.8, status: 'active' },
          { id: 'm2', type: 'decision', category: 'eng', summary: 'test2', importance: 0.6, status: 'active' }
        ]
      };
      const mockMem1 = { id: 'm1', relatedMemories: ['m2'] };
      const mockMem2 = { id: 'm2', relatedMemories: [] };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('embeddings.json')) return Promise.resolve({ model: null, dimension: 0, vectors: {} });
        if (path.includes('m1/memory.json')) return Promise.resolve(mockMem1);
        if (path.includes('m2/memory.json')) return Promise.resolve(mockMem2);
        return Promise.resolve(def);
      });

      const result = await getGraphData();

      expect(result.nodes).toHaveLength(2);
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0].type).toBe('linked');
    });

    it('should exclude archived memories from nodes', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 2,
        memories: [
          { id: 'm1', type: 'fact', category: 'other', summary: 'test', importance: 0.5, status: 'active' },
          { id: 'm2', type: 'fact', category: 'other', summary: 'archived', importance: 0.5, status: 'archived' }
        ]
      };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('embeddings.json')) return Promise.resolve({ model: null, dimension: 0, vectors: {} });
        if (path.includes('m1/memory.json')) return Promise.resolve({ id: 'm1', relatedMemories: [] });
        return Promise.resolve(def);
      });

      const result = await getGraphData();

      expect(result.nodes).toHaveLength(1);
    });
  });

  // ===========================================================================
  // consolidateMemories
  // ===========================================================================

  describe('consolidateMemories', () => {
    it('should return dry run results without modifying data', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 2,
        memories: [
          { id: 'm1', summary: 'Similar A', importance: 0.8, status: 'active' },
          { id: 'm2', summary: 'Similar B', importance: 0.6, status: 'active' }
        ]
      };
      const mockEmbeddings = { model: 'test', dimension: 2, vectors: { m1: [0.1, 0.2], m2: [0.15, 0.25] } };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('embeddings.json')) return Promise.resolve(mockEmbeddings);
        return Promise.resolve(def);
      });
      clusterBySimilarity.mockReturnValue([
        [{ id: 'm1', summary: 'Similar A' }, { id: 'm2', summary: 'Similar B' }]
      ]);

      const result = await consolidateMemories(0.9, true);

      expect(result.dryRun).toBe(true);
      expect(result.clustersFound).toBe(1);
      expect(result.memoriesAffected).toBe(2);
    });

    it('should return no clusters when all are unique', async () => {
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve({ version: 1, lastUpdated: '', count: 0, memories: [] });
        if (path.includes('embeddings.json')) return Promise.resolve({ model: null, dimension: 0, vectors: {} });
        return Promise.resolve(def);
      });
      clusterBySimilarity.mockReturnValue([]);

      const result = await consolidateMemories(0.9, true);

      expect(result.clustersFound).toBe(0);
    });
  });

  // ===========================================================================
  // applyDecay
  // ===========================================================================

  describe('applyDecay', () => {
    it('should apply decay to old memories', async () => {
      const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(); // 100 days ago
      const mockIndex = {
        version: 1, lastUpdated: '', count: 1,
        memories: [{ id: 'm1', status: 'active' }]
      };
      const mockMemory = { id: 'm1', importance: 0.5, createdAt: oldDate, lastAccessed: null };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('memory.json')) return Promise.resolve({ ...mockMemory });
        return Promise.resolve(def);
      });

      const result = await applyDecay(0.01);

      expect(result.updated).toBeGreaterThanOrEqual(0);
    });

    it('should return zero updates when no memories exist', async () => {
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve({ version: 1, lastUpdated: '', count: 0, memories: [] });
        return Promise.resolve(def);
      });

      const result = await applyDecay();

      expect(result.updated).toBe(0);
    });
  });

  // ===========================================================================
  // clearExpired
  // ===========================================================================

  describe('clearExpired', () => {
    it('should clear expired memories', async () => {
      const pastDate = '2020-01-01T00:00:00.000Z';
      const mockIndex = {
        version: 1, lastUpdated: '', count: 1,
        memories: [{ id: 'm1', status: 'active' }]
      };
      const mockMemory = { id: 'm1', expiresAt: pastDate, status: 'active', content: 'test', summary: 'test', category: 'other', tags: [], importance: 0.5, relatedMemories: [], sourceAppId: null };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve({ ...mockIndex, memories: [...mockIndex.memories] });
        if (path.includes('memory.json')) return Promise.resolve({ ...mockMemory });
        return Promise.resolve(def);
      });

      const result = await clearExpired();

      expect(result.cleared).toBe(1);
    });

    it('should not clear non-expired memories', async () => {
      const futureDate = '2099-01-01T00:00:00.000Z';
      const mockIndex = {
        version: 1, lastUpdated: '', count: 1,
        memories: [{ id: 'm1', status: 'active' }]
      };
      const mockMemory = { id: 'm1', expiresAt: futureDate };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('memory.json')) return Promise.resolve(mockMemory);
        return Promise.resolve(def);
      });

      const result = await clearExpired();

      expect(result.cleared).toBe(0);
    });

    it('should skip memories without expiresAt', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '', count: 1,
        memories: [{ id: 'm1', status: 'active' }]
      };
      const mockMemory = { id: 'm1', expiresAt: null };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('memory.json')) return Promise.resolve(mockMemory);
        return Promise.resolve(def);
      });

      const result = await clearExpired();

      expect(result.cleared).toBe(0);
    });
  });

  // ===========================================================================
  // getStats
  // ===========================================================================

  describe('getStats', () => {
    it('should return correct stats breakdown', async () => {
      const mockIndex = {
        version: 1, lastUpdated: '2025-01-01T00:00:00.000Z', count: 4,
        memories: [
          { id: 'm1', type: 'fact', category: 'science', status: 'active' },
          { id: 'm2', type: 'decision', category: 'engineering', status: 'active' },
          { id: 'm3', type: 'fact', category: 'science', status: 'archived' },
          { id: 'm4', type: 'fact', category: 'other', status: 'pending_approval' }
        ]
      };
      const mockEmbeddings = { model: 'test', dimension: 3, vectors: { m1: [0.1], m2: [0.2] } };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(mockIndex);
        if (path.includes('embeddings.json')) return Promise.resolve(mockEmbeddings);
        return Promise.resolve(def);
      });

      const stats = await getStats();

      expect(stats.total).toBe(4);
      expect(stats.active).toBe(2);
      expect(stats.archived).toBe(1);
      expect(stats.pendingApproval).toBe(1);
      expect(stats.expired).toBe(0);
      expect(stats.withEmbeddings).toBe(2);
      expect(stats.byType.fact).toBe(3);
      expect(stats.byType.decision).toBe(1);
      expect(stats.byCategory.science).toBe(2);
      expect(stats.lastUpdated).toBe('2025-01-01T00:00:00.000Z');
    });

    it('should handle empty index', async () => {
      readJSONFile.mockImplementation((path, def) => Promise.resolve(def));

      const stats = await getStats();

      expect(stats.total).toBe(0);
      expect(stats.active).toBe(0);
      expect(stats.withEmbeddings).toBe(0);
    });
  });

  // ===========================================================================
  // invalidateCaches
  // ===========================================================================

  describe('invalidateCaches', () => {
    it('should force reload on next access', async () => {
      // First call loads and caches
      readJSONFile.mockImplementation((path, def) => Promise.resolve(def));
      await getStats();

      // Reset readJSONFile to return different data
      const newIndex = { version: 1, lastUpdated: '', count: 1, memories: [{ id: 'm1', type: 'fact', category: 'x', status: 'active' }] };
      readJSONFile.mockImplementation((path, def) => {
        if (path.includes('index.json')) return Promise.resolve(newIndex);
        return Promise.resolve(def);
      });

      invalidateCaches();
      const stats = await getStats();

      expect(stats.total).toBe(1);
    });
  });

  // ===========================================================================
  // flushBM25Index
  // ===========================================================================

  describe('flushBM25Index', () => {
    it('should delegate to memoryBM25.flush', async () => {
      await flushBM25Index();

      expect(memoryBM25.flush).toHaveBeenCalled();
    });
  });
});

/**
 * memoryStore.test.js
 *
 * Tests for the persistence + cache layer of the file-backed memory service.
 * Covers: cache invalidation, atomicWrite (verified via real-file round-trips),
 * and deleteMemoryFiles path.
 *
 * memoryStore does NOT call createUniverse/createSeries and does not import
 * peerSync or instances, so mockNoPeers / mockNoPeerSync are not needed.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'memorystore-test-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), {
    dataRoot: TEST_DATA_ROOT,
    extraOverrides: (root) => ({
      cos: join(root, 'cos'),
      memory: join(root, 'cos', 'memory'),
    }),
  }));

// Pass-through mutex: no locking overhead in tests
vi.mock('../lib/asyncMutex.js', () => ({
  createMutex: () => (fn) => fn(),
}));

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

// Dynamically import AFTER mocks are hoisted so the module reads the mocked PATHS
const {
  loadIndex, saveIndex,
  loadEmbeddings, saveEmbeddings,
  loadMemory, saveMemory,
  deleteMemoryFiles,
  invalidateCaches,
} = await import('./memoryStore.js');

describe('memoryStore', () => {
  beforeEach(() => {
    rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
    mkdirSync(join(TEST_DATA_ROOT, 'cos', 'memory', 'memories'), { recursive: true });
    invalidateCaches();
  });

  // ---------------------------------------------------------------------------
  // loadIndex + cache
  // ---------------------------------------------------------------------------
  describe('loadIndex', () => {
    it('returns a default index when no file exists', async () => {
      const idx = await loadIndex();
      expect(idx.version).toBe(1);
      expect(idx.count).toBe(0);
      expect(Array.isArray(idx.memories)).toBe(true);
    });

    it('caches the index on second call (same reference returned)', async () => {
      const first = await loadIndex();
      const second = await loadIndex();
      expect(first).toBe(second); // cache hit — same object
    });

    it('reloads from disk after invalidateCaches()', async () => {
      const idx = { version: 1, lastUpdated: '', count: 3, memories: [] };
      await saveIndex(idx);
      // cache is warm; force reload
      invalidateCaches();
      const loaded = await loadIndex();
      expect(loaded.count).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // saveIndex — atomicWrite verified via round-trip
  // ---------------------------------------------------------------------------
  describe('saveIndex', () => {
    it('persists via atomicWrite: reload after invalidate returns the saved data', async () => {
      const idx = { version: 1, lastUpdated: '', count: 0, memories: [] };
      await saveIndex(idx);
      // lastUpdated should have been stamped
      expect(idx.lastUpdated).not.toBe('');

      invalidateCaches();
      const loaded = await loadIndex();
      expect(loaded.count).toBe(0);
      expect(loaded.lastUpdated).toBeTruthy();
    });

    it('round-trips multi-entry index', async () => {
      const idx = {
        version: 1, lastUpdated: '',
        count: 2,
        memories: [{ id: 'a', type: 'fact' }, { id: 'b', type: 'learning' }]
      };
      await saveIndex(idx);
      invalidateCaches();
      const loaded = await loadIndex();
      expect(loaded.count).toBe(2);
      expect(loaded.memories).toHaveLength(2);
      expect(loaded.memories[0].id).toBe('a');
    });
  });

  // ---------------------------------------------------------------------------
  // loadEmbeddings + saveEmbeddings
  // ---------------------------------------------------------------------------
  describe('loadEmbeddings', () => {
    it('returns empty defaults when file is absent', async () => {
      const e = await loadEmbeddings();
      expect(e.model).toBeNull();
      expect(e.dimension).toBe(0);
      expect(e.vectors).toEqual({});
    });

    it('caches embeddings on subsequent loads', async () => {
      const e1 = await loadEmbeddings();
      const e2 = await loadEmbeddings();
      expect(e1).toBe(e2);
    });
  });

  describe('saveEmbeddings', () => {
    it('persists embeddings so they reload after cache invalidation', async () => {
      const emb = { model: 'test-model', dimension: 3, vectors: { 'mem-1': [0.1, 0.2, 0.3] } };
      await saveEmbeddings(emb);
      invalidateCaches();
      const loaded = await loadEmbeddings();
      expect(loaded.model).toBe('test-model');
      expect(loaded.vectors['mem-1']).toEqual([0.1, 0.2, 0.3]);
    });
  });

  // ---------------------------------------------------------------------------
  // saveMemory + loadMemory
  // ---------------------------------------------------------------------------
  describe('saveMemory / loadMemory', () => {
    it('persists and reloads a memory record via the per-id path', async () => {
      const mem = { id: 'mem-42', content: 'hello', status: 'active' };
      await saveMemory(mem);

      const loaded = await loadMemory('mem-42');
      expect(loaded.id).toBe('mem-42');
      expect(loaded.content).toBe('hello');
      expect(loaded.status).toBe('active');
    });

    it('creates the per-id directory under memories/', async () => {
      const mem = { id: 'mem-dir-test', content: 'dir check' };
      await saveMemory(mem);
      const memDir = join(TEST_DATA_ROOT, 'cos', 'memory', 'memories', 'mem-dir-test');
      expect(existsSync(memDir)).toBe(true);
    });

    it('returns null for a memory that does not exist', async () => {
      const result = await loadMemory('no-such-id');
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // deleteMemoryFiles
  // ---------------------------------------------------------------------------
  describe('deleteMemoryFiles', () => {
    it('removes the memory directory when it exists', async () => {
      const mem = { id: 'del-me', content: 'bye' };
      await saveMemory(mem);

      const before = await loadMemory('del-me');
      expect(before).not.toBeNull();

      await deleteMemoryFiles('del-me');

      const after = await loadMemory('del-me');
      expect(after).toBeNull();
    });

    it('is a no-op for a non-existent id (does not throw)', async () => {
      await expect(deleteMemoryFiles('ghost-id')).resolves.not.toThrow();
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all dependencies
vi.mock('./instances.js', () => ({
  getPeers: vi.fn(),
  DEFAULT_SYNC_CATEGORIES: {
    brain: false, memory: false, goals: false,
    character: false, digitalTwin: false, meatspace: false
  }
}));
vi.mock('./brainSyncLog.js', () => ({
  getChangesSince: vi.fn(),
  compactLog: vi.fn().mockResolvedValue(0)
}));
vi.mock('./brainSync.js', () => ({
  applyRemoteChanges: vi.fn()
}));
vi.mock('./memorySync.js', () => ({
  applyRemoteChanges: vi.fn(),
  getMaxSequence: vi.fn().mockResolvedValue('0')
}));
vi.mock('./memoryBackend.js', () => ({
  getBackendName: vi.fn(() => 'postgres')
}));
vi.mock('./dataSync.js', () => ({
  getSnapshot: vi.fn().mockResolvedValue({ data: {}, checksum: 'abc' }),
  applyRemote: vi.fn().mockResolvedValue({ applied: false, count: 0 }),
  getSupportedCategories: vi.fn(() => ['goals', 'character', 'digitalTwin', 'meatspace'])
}));
vi.mock('./instanceEvents.js', () => ({
  instanceEvents: { on: vi.fn(), removeListener: vi.fn() }
}));
vi.mock('../lib/fileUtils.js', () => ({
  readJSONFile: vi.fn().mockResolvedValue({}),
  ensureDir: vi.fn().mockResolvedValue(),
  atomicWrite: vi.fn().mockResolvedValue(),
  PATHS: { data: '/mock/data' },
  dataPath: (name) => `/mock/data/${name}`
}));
vi.mock('../lib/asyncMutex.js', () => ({
  createMutex: () => async (fn) => fn()
}));
vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(),
  rename: vi.fn().mockResolvedValue()
}));

import { getPeers } from './instances.js';
import { applyRemoteChanges as applyBrainChanges } from './brainSync.js';
import { applyRemoteChanges as applyMemoryChanges } from './memorySync.js';
import { instanceEvents } from './instanceEvents.js';
import { syncWithPeer, syncAllPeers, initSyncOrchestrator, stopSyncOrchestrator } from './syncOrchestrator.js';

const mockFetch = vi.fn();

describe('syncOrchestrator', () => {
  const mockPeer = {
    name: 'test-peer',
    address: '10.0.0.2',
    port: 5555,
    instanceId: 'peer-inst-1',
    enabled: true,
    status: 'online'
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    stopSyncOrchestrator();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('syncWithPeer', () => {
    it('skips peers without instanceId', async () => {
      await syncWithPeer({ ...mockPeer, instanceId: undefined });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fetches brain and memory changes from peer', async () => {
      // Brain sync: single batch, no more
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            changes: [{ seq: 1, op: 'create', type: 'people', id: 'p1', record: {} }],
            maxSeq: 1,
            hasMore: false
          })
        })
        // Memory sync: single batch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            memories: [{ id: 'm1', content: 'test' }],
            maxSequence: '5',
            hasMore: false
          })
        });

      applyBrainChanges.mockResolvedValue({ inserted: 1, updated: 0, deleted: 0, skipped: 0 });
      applyMemoryChanges.mockResolvedValue({ inserted: 1, updated: 0 });

      const result = await syncWithPeer(mockPeer);

      expect(result.brain.totalApplied).toBe(1);
      expect(result.memory.totalApplied).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('handles pagination loop with hasMore=true', async () => {
      // First brain batch: hasMore=true
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            changes: [{ seq: 1 }],
            maxSeq: 1,
            hasMore: true
          })
        })
        // Second brain batch: hasMore=false
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            changes: [{ seq: 2 }],
            maxSeq: 2,
            hasMore: false
          })
        })
        // Memory: no changes
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            memories: [],
            maxSequence: '0',
            hasMore: false
          })
        });

      applyBrainChanges
        .mockResolvedValueOnce({ inserted: 1, updated: 0, deleted: 0, skipped: 0 })
        .mockResolvedValueOnce({ inserted: 0, updated: 1, deleted: 0, skipped: 0 });

      const result = await syncWithPeer(mockPeer);

      expect(applyBrainChanges).toHaveBeenCalledTimes(2);
      expect(result.brain.totalApplied).toBe(2);
    });

    it('resets memory cursor when peer DB was rebuilt (cursor > peerMax)', async () => {
      const peerWithReset = {
        ...mockPeer,
        remoteSyncSeqs: { brainSeq: 0, memorySeq: '2' }
      };

      // Simulate stale cursor (we previously synced to 1127 but peer reset to 2)
      const { readJSONFile } = await import('../lib/fileUtils.js');
      const cursorData = {
        [peerWithReset.instanceId]: { brainSeq: 0, memorySeq: '1127', lastSyncAt: '2026-01-01T00:00:00.000Z' }
      };
      readJSONFile.mockResolvedValue(cursorData);

      // Brain: no changes
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ changes: [], maxSeq: 0, hasMore: false })
        })
        // Memory: returns data from seq 0 (after cursor reset)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            memories: [{ id: 'm1', content: 'new' }],
            maxSequence: '2',
            hasMore: false
          })
        });

      applyMemoryChanges.mockResolvedValue({ inserted: 1, updated: 0 });

      const result = await syncWithPeer(peerWithReset);

      // Memory sync should have fetched since=0 (reset), not since=1127
      const memoryCall = mockFetch.mock.calls.find(c => c[0].includes('/api/memory/sync'));
      expect(memoryCall[0]).toContain('since=0');
      expect(result.memory.totalApplied).toBe(1);
    });

    it('resets brain cursor when peer sync log was rebuilt', async () => {
      const peerWithReset = {
        ...mockPeer,
        remoteSyncSeqs: { brainSeq: 0, memorySeq: '10' }
      };

      const { readJSONFile } = await import('../lib/fileUtils.js');
      const cursorData = {
        [peerWithReset.instanceId]: { brainSeq: 5, memorySeq: '10', lastSyncAt: '2026-01-01T00:00:00.000Z' }
      };
      readJSONFile.mockResolvedValue(cursorData);

      // Brain: returns data from seq 0 (after cursor reset)
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            changes: [{ seq: 1, op: 'create', type: 'people', id: 'p1', record: {} }],
            maxSeq: 1,
            hasMore: false
          })
        })
        // Memory: no changes
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ memories: [], maxSequence: '10', hasMore: false })
        });

      applyBrainChanges.mockResolvedValue({ inserted: 1, updated: 0, deleted: 0, skipped: 0 });

      const result = await syncWithPeer(peerWithReset);

      const brainCall = mockFetch.mock.calls.find(c => c[0].includes('/api/brain/sync'));
      expect(brainCall[0]).toContain('since=0');
      expect(result.brain.totalApplied).toBe(1);
    });

    it('handles fetch failure gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await syncWithPeer(mockPeer);

      // fetchPeer catches errors and returns null, so no changes applied
      expect(result.brain.totalApplied).toBe(0);
      expect(result.memory.totalApplied).toBe(0);
    });
  });

  describe('syncAllPeers', () => {
    it('iterates online peers with instanceId', async () => {
      const onlinePeer = { ...mockPeer };
      const offlinePeer = { ...mockPeer, name: 'offline', status: 'offline', instanceId: 'p2' };
      const disabledPeer = { ...mockPeer, name: 'disabled', enabled: false, instanceId: 'p3' };
      const noIdPeer = { ...mockPeer, name: 'no-id', instanceId: undefined };

      getPeers.mockResolvedValue([onlinePeer, offlinePeer, disabledPeer, noIdPeer]);

      // For the single qualifying peer: brain + memory fetch
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ changes: [], maxSeq: 0, hasMore: false }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ memories: [], maxSequence: '0', hasMore: false }) });

      await syncAllPeers();

      // Only 1 peer qualifies (online + enabled + has instanceId)
      // fetchPeer should be called for brain + memory
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('initSyncOrchestrator', () => {
    it('registers peer:online event handler', () => {
      initSyncOrchestrator();
      expect(instanceEvents.on).toHaveBeenCalledWith('peer:online', expect.any(Function));
    });

    it('sets up periodic sync interval', () => {
      initSyncOrchestrator();

      getPeers.mockResolvedValue([]);

      // Advance past the interval (60s)
      vi.advanceTimersByTime(60000);

      // syncAllPeers should have been triggered
      expect(getPeers).toHaveBeenCalled();
    });
  });

  describe('stopSyncOrchestrator', () => {
    it('clears the interval', () => {
      initSyncOrchestrator();
      stopSyncOrchestrator();

      getPeers.mockResolvedValue([]);
      vi.advanceTimersByTime(120000);

      // getPeers should not be called after stopping
      expect(getPeers).not.toHaveBeenCalled();
    });

    it('removes the peer:online event listener', () => {
      initSyncOrchestrator();
      stopSyncOrchestrator();

      expect(instanceEvents.removeListener).toHaveBeenCalledWith('peer:online', expect.any(Function));
    });
  });
});

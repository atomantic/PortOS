import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all dependencies
vi.mock('./instances.js', () => ({
  getPeers: vi.fn(),
  updatePeer: vi.fn().mockResolvedValue(undefined),
  // forPeer scoping resolves our own instanceId; the orchestrator catches a
  // throw/UNKNOWN and just omits the query param, so the default mock returns
  // a stable id to exercise the scoped path.
  getInstanceId: vi.fn().mockResolvedValue('our-inst-id'),
  UNKNOWN_INSTANCE_ID: 'unknown',
  DEFAULT_SYNC_CATEGORIES: {
    brain: false, memory: false, goals: false,
    character: false, digitalTwin: false, meatspace: false, catalog: false
  }
}));
vi.mock('./brainSyncLog.js', () => ({
  getChangesSince: vi.fn(),
  getCurrentSeq: vi.fn(() => 0),
  compactLog: vi.fn().mockResolvedValue(0)
}));
vi.mock('./brainSync.js', () => ({
  applyRemoteChanges: vi.fn()
}));
// Real brainStorage builds data paths at module load, which the fileUtils mock
// breaks — the orchestrator only needs the type list for the checksum-cache
// signature. Keep it a stable literal here; the real list is pinned elsewhere.
vi.mock('./brainStorage.js', () => ({
  BRAIN_ENTITY_TYPES: Object.freeze([
    'people', 'projects', 'ideas', 'admin', 'memories',
    'links', 'buckets', 'journals', 'inbox', 'songs',
  ]),
}));
vi.mock('./brainReconcile.js', () => ({
  getBrainChecksum: vi.fn().mockResolvedValue('local-cksum'),
  getBrainSnapshot: vi.fn(),
  applyBrainSnapshot: vi.fn().mockResolvedValue({ inserted: 0, updated: 0, deleted: 0, skipped: 0 }),
}));
vi.mock('./memorySync.js', () => ({
  applyRemoteChanges: vi.fn(),
  getMaxSequence: vi.fn().mockResolvedValue('0')
}));
vi.mock('./catalogSync.js', async (importOriginal) => {
  // Keep the real countAppliedFromStats (pure tally over the stats shape) so
  // the orchestrator's totalApplied assertions exercise the production sum.
  const actual = await importOriginal();
  return {
    countAppliedFromStats: actual.countAppliedFromStats,
    applyRemoteChanges: vi.fn().mockResolvedValue({
      scraps: { inserted: 0, updated: 0 }, ingredients: { inserted: 0, updated: 0 },
      sources: { applied: 0 }, refs: { applied: 0 }, relations: { applied: 0 },
      tags: { inserted: 0, updated: 0 }, media: { applied: 0 }, errors: []
    }),
    getMaxSequences: vi.fn().mockResolvedValue({
      scraps: '0', ingredients: '0', sources: '0', refs: '0', relations: '0', tags: '0', media: '0'
    })
  };
});
vi.mock('./memoryBackend.js', () => ({
  getBackendName: vi.fn(() => 'postgres')
}));
vi.mock('./dataSync.js', () => ({
  getSnapshot: vi.fn().mockResolvedValue({ data: {}, checksum: 'abc' }),
  getChecksum: vi.fn().mockResolvedValue({ checksum: 'abc' }),
  applyRemote: vi.fn().mockResolvedValue({ applied: false, count: 0 }),
  getSupportedCategories: vi.fn(() => ['goals', 'character', 'digitalTwin', 'meatspace'])
}));
vi.mock('./sharing/peerSync.js', () => ({
  listPeerSubscriptions: vi.fn().mockResolvedValue([]),
  getOutboundCoverageForPeer: vi.fn().mockResolvedValue({
    universe: new Set(), pipeline: new Set(), mediaCollections: new Set(),
  }),
}));
vi.mock('./instanceEvents.js', () => ({
  instanceEvents: { on: vi.fn(), removeListener: vi.fn(), emit: vi.fn() }
}));
vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  // Fresh object per call: `mockResolvedValue({})` would hand every
  // loadCursors() the SAME object, so one test's saveCursors mutation leaks
  // into the next (a prior test's high catalog cursor then trips the
  // rebuild/reset detection). A fresh {} isolates each test's cursor state.
  readJSONFile: vi.fn(async () => ({})),
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

import { readJSONFile } from '../lib/fileUtils.js';
import { getPeers } from './instances.js';
import { applyRemoteChanges as applyBrainChanges } from './brainSync.js';
import { BRAIN_ENTITY_TYPES } from './brainStorage.js';
import { applyRemoteChanges as applyMemoryChanges } from './memorySync.js';
import { applyRemoteChanges as applyCatalogChanges } from './catalogSync.js';
import { instanceEvents } from './instanceEvents.js';
import { getCurrentSeq, compactLog } from './brainSyncLog.js';
import { getBrainChecksum, applyBrainSnapshot } from './brainReconcile.js';
import { getMaxSequence } from './memorySync.js';
import { syncWithPeer, syncAllPeers, getSyncStatus, initSyncOrchestrator, stopSyncOrchestrator } from './syncOrchestrator.js';

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
    // Reset the cursor-store read to a FRESH empty object each test. The
    // brain/memory reset tests below override it with `mockResolvedValue(
    // cursorData)`, and that implementation survives `clearAllMocks` — without
    // this reset a later test inherits a prior test's (mutated) cursor and the
    // catalog rebuild/reset detection fires on it.
    readJSONFile.mockImplementation(async () => ({}));
    vi.useFakeTimers();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(async () => {
    stopSyncOrchestrator();
    // A fake-timer advance can fire the orchestrator's fire-and-forget interval
    // cycle (syncAllPeers + the tombstone sweeps), whose console.log/console.error
    // land on promise resolution — AFTER a synchronous advanceTimersByTime returns.
    // Drain that in-flight async here (stopSyncOrchestrator already cleared the
    // recurring timer, so this terminates) before restoring real timers and ending
    // the file, so a late log can't race vitest's worker teardown
    // ("Closing rpc while onUserConsoleLog was pending").
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('syncWithPeer', () => {
    it('skips peers without instanceId', async () => {
      await syncWithPeer({ ...mockPeer, instanceId: undefined });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fetches brain and memory changes from peer', async () => {
      // URL-routed (resilient to the #1077 reconcile checksum fetch between
      // brain and memory). Brain + memory each return a single batch.
      mockFetch.mockImplementation(async (url) => {
        if (url.includes('/api/brain/reconcile/checksum')) return { ok: true, json: async () => ({ checksum: 'local-cksum' }) };
        if (url.includes('/api/brain/sync')) return { ok: true, json: async () => ({ changes: [{ seq: 1, op: 'create', type: 'people', id: 'p1', record: {} }], maxSeq: 1, hasMore: false }) };
        if (url.includes('/api/memory/sync')) return { ok: true, json: async () => ({ memories: [{ id: 'm1', content: 'test' }], maxSequence: '5', hasMore: false }) };
        return { ok: true, json: async () => ({}) };
      });

      applyBrainChanges.mockResolvedValue({ inserted: 1, updated: 0, deleted: 0, skipped: 0 });
      applyMemoryChanges.mockResolvedValue({ inserted: 1, updated: 0 });

      const result = await syncWithPeer(mockPeer);

      expect(result.brain.totalApplied).toBe(1);
      expect(result.memory.totalApplied).toBe(1);
      // brain delta + reconcile checksum + memory = 3 fetches
      expect(mockFetch).toHaveBeenCalledTimes(3);
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

      // URL-routed so the test is resilient to the order/number of fetches
      // (the anti-entropy reconcile adds a /reconcile/checksum fetch — #1077).
      mockFetch.mockImplementation(async (url) => {
        if (url.includes('/api/brain/sync')) return { ok: true, json: async () => ({ changes: [], maxSeq: 0, hasMore: false }) };
        if (url.includes('/api/brain/reconcile/checksum')) return { ok: true, json: async () => ({ checksum: 'local-cksum' }) };
        if (url.includes('/api/memory/sync')) return { ok: true, json: async () => ({ memories: [{ id: 'm1', content: 'new' }], maxSequence: '2', hasMore: false }) };
        return { ok: true, json: async () => ({}) };
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

      // URL-routed (resilient to the reconcile fetch added in #1077). Brain
      // returns data from seq 0 (after cursor reset); memory + reconcile quiet.
      mockFetch.mockImplementation(async (url) => {
        if (url.includes('/api/brain/sync')) return { ok: true, json: async () => ({ changes: [{ seq: 1, op: 'create', type: 'people', id: 'p1', record: {} }], maxSeq: 1, hasMore: false }) };
        if (url.includes('/api/brain/reconcile/checksum')) return { ok: true, json: async () => ({ checksum: 'local-cksum' }) };
        if (url.includes('/api/memory/sync')) return { ok: true, json: async () => ({ memories: [], maxSequence: '10', hasMore: false }) };
        return { ok: true, json: async () => ({}) };
      });

      applyBrainChanges.mockResolvedValue({ inserted: 1, updated: 0, deleted: 0, skipped: 0 });

      const result = await syncWithPeer(peerWithReset);

      const brainCall = mockFetch.mock.calls.find(c => c[0].includes('/api/brain/sync') && !c[0].includes('reconcile'));
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

    it('ALWAYS pulls every enabled snapshot category, scoped with forPeer (no whole-category skip)', async () => {
      // Item A fix: a per-record subscription must NO LONGER suppress the
      // inbound snapshot pull for the whole category. The pull always fires,
      // but with `?forPeer=<ourId>` so the SOURCE excludes the records it
      // already pushes us. This is what lets UN-subscribed records (and
      // torn-down-sub tombstones) keep converging via the snapshot.
      const dataSync = await import('./dataSync.js');
      dataSync.getSupportedCategories.mockReturnValue(['universe', 'pipeline', 'character']);
      const peerWithCats = {
        ...mockPeer,
        syncCategories: { universe: true, pipeline: true, character: true },
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ checksum: 'x', data: null }),
      });
      await syncWithPeer(peerWithCats);
      const urls = mockFetch.mock.calls.map((c) => c[0]);
      // Every category is pulled — none skipped.
      expect(urls.some((u) => u.includes('/api/sync/universe/'))).toBe(true);
      expect(urls.some((u) => u.includes('/api/sync/pipeline/'))).toBe(true);
      expect(urls.some((u) => u.includes('/api/sync/character/'))).toBe(true);
      // Snapshot/checksum URLs carry our instanceId so the source can scope.
      const universeUrls = urls.filter((u) => u.includes('/api/sync/universe/'));
      expect(universeUrls.length).toBeGreaterThan(0);
      expect(universeUrls.every((u) => u.includes('forPeer=our-inst-id'))).toBe(true);
    });

    it('omits forPeer when our instanceId is UNKNOWN (older/uninitialized install)', async () => {
      const dataSync = await import('./dataSync.js');
      const instances = await import('./instances.js');
      dataSync.getSupportedCategories.mockReturnValue(['universe', 'character']);
      instances.getInstanceId.mockResolvedValueOnce('unknown'); // === UNKNOWN_INSTANCE_ID
      const peerWithCats = { ...mockPeer, syncCategories: { universe: true, character: true } };
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ checksum: 'x', data: null }) });
      await syncWithPeer(peerWithCats);
      const urls = mockFetch.mock.calls.map((c) => c[0]);
      // Categories still pulled, but WITHOUT the forPeer param (full snapshot).
      expect(urls.some((u) => u.includes('/api/sync/universe/'))).toBe(true);
      expect(urls.some((u) => u.includes('forPeer='))).toBe(false);
    });
  });

  describe('catalog sync (delta-based, Postgres-only)', () => {
    const catalogPeer = { ...mockPeer, syncCategories: { catalog: true } };

    it('pulls /api/catalog/sync with per-kind cursors and applies locally', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ingredients: [{ id: 'cat-chr-1' }],
          refs: [{ ingredientId: 'cat-chr-1', refKind: 'universe', refId: 'u1', role: 'canon-character' }],
          maxSequences: { scraps: '0', ingredients: '7', sources: '0', refs: '3', relations: '0', tags: '0', media: '0' },
          hasMore: false,
          portosMeta: { schemaVersions: { catalog: 1 } },
        }),
      });
      applyCatalogChanges.mockResolvedValueOnce({
        scraps: { inserted: 0, updated: 0 }, ingredients: { inserted: 1, updated: 0 },
        sources: { applied: 0 }, refs: { applied: 1 }, relations: { applied: 0 },
        tags: { inserted: 0, updated: 0 }, media: { applied: 0 }, errors: [],
      });

      const result = await syncWithPeer(catalogPeer);

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('/api/catalog/sync?');
      expect(url).toContain('since[ingredients]=0');
      expect(url).toContain('since[refs]=0');
      expect(applyCatalogChanges).toHaveBeenCalledTimes(1);
      // inserted ingredient (1) + applied ref (1)
      expect(result.catalog.totalApplied).toBe(2);
    });

    it('drains multiple batches via hasMore, advancing the per-kind cursor', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ingredients: [{ id: 'a' }],
            maxSequences: { scraps: '0', ingredients: '5', sources: '0', refs: '0', relations: '0', tags: '0', media: '0' },
            hasMore: true,
            portosMeta: { schemaVersions: { catalog: 1 } },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ingredients: [{ id: 'b' }],
            maxSequences: { scraps: '0', ingredients: '9', sources: '0', refs: '0', relations: '0', tags: '0', media: '0' },
            hasMore: false,
            portosMeta: { schemaVersions: { catalog: 1 } },
          }),
        });
      applyCatalogChanges.mockResolvedValue({
        scraps: { inserted: 0, updated: 0 }, ingredients: { inserted: 1, updated: 0 },
        sources: { applied: 0 }, refs: { applied: 0 }, relations: { applied: 0 },
        tags: { inserted: 0, updated: 0 }, media: { applied: 0 }, errors: [],
      });

      const result = await syncWithPeer(catalogPeer);

      expect(applyCatalogChanges).toHaveBeenCalledTimes(2);
      expect(result.catalog.totalApplied).toBe(2);
      // Second pull must carry the cursor from the first batch.
      const secondUrl = mockFetch.mock.calls[1][0];
      expect(secondUrl).toContain('since[ingredients]=5');
      // Final cursor advanced to the last batch's max.
      expect(result.catalog.catalogSeqs.ingredients).toBe('9');
    });

    it('rewinds a stale catalog cursor that exceeds the peer max (peer DB rebuild) and re-pulls from 0', async () => {
      // Saved cursor is far ahead of the peer's rebuilt table maxima.
      readJSONFile.mockResolvedValue({
        [catalogPeer.instanceId]: {
          catalogSeqs: { scraps: '0', ingredients: '999', sources: '0', refs: '0', relations: '0', tags: '0', media: '0' },
        },
      });
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ingredients: [],
            // No rows for the stale cursor → maxSequences ECHOES the inbound
            // cursor (999), but tableMaxSequences reports the TRUE max (5).
            maxSequences: { scraps: '0', ingredients: '999', sources: '0', refs: '0', relations: '0', tags: '0', media: '0' },
            tableMaxSequences: { scraps: '0', ingredients: '5', sources: '0', refs: '0', relations: '0', tags: '0', media: '0' },
            hasMore: true,
            portosMeta: { schemaVersions: { catalog: 1 } },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ingredients: [{ id: 'a' }],
            maxSequences: { scraps: '0', ingredients: '5', sources: '0', refs: '0', relations: '0', tags: '0', media: '0' },
            tableMaxSequences: { scraps: '0', ingredients: '5', sources: '0', refs: '0', relations: '0', tags: '0', media: '0' },
            hasMore: false,
            portosMeta: { schemaVersions: { catalog: 1 } },
          }),
        });
      applyCatalogChanges.mockResolvedValue({
        scraps: { inserted: 0, updated: 0 }, ingredients: { inserted: 1, updated: 0 },
        sources: { applied: 0 }, refs: { applied: 0 }, relations: { applied: 0 },
        tags: { inserted: 0, updated: 0 }, media: { applied: 0 }, errors: [],
      });

      await syncWithPeer(catalogPeer);

      // First fetch carries the stale cursor; detecting cursor(999) > peerMax(5)
      // rewinds ingredients to 0 and re-fetches BEFORE applying, so the stale
      // page isn't applied and the rewound page is.
      expect(mockFetch.mock.calls[0][0]).toContain('since[ingredients]=999');
      expect(mockFetch.mock.calls[1][0]).toContain('since[ingredients]=0');
      expect(applyCatalogChanges).toHaveBeenCalledTimes(1);
    });

    it('holds a kind cursor when that kind had apply failures (parent on a later page)', async () => {
      // A ref fails because its parent ingredient is on a later page; the
      // ingredient itself applies cleanly in the same batch.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ingredients: [{ id: 'a' }], refs: [{ id: 'r' }],
          maxSequences: { scraps: '0', ingredients: '5', sources: '0', refs: '5', relations: '0', tags: '0', media: '0' },
          hasMore: false,
          portosMeta: { schemaVersions: { catalog: 1 } },
        }),
      });
      applyCatalogChanges.mockResolvedValue({
        scraps: { inserted: 0, updated: 0 }, ingredients: { inserted: 1, updated: 0 },
        sources: { applied: 0 }, refs: { applied: 0, failed: 1 }, relations: { applied: 0 },
        tags: { inserted: 0, updated: 0 }, media: { applied: 0 }, errors: [{ kind: 'refs', id: 'r' }],
      });

      const result = await syncWithPeer(catalogPeer);

      // ingredients applied cleanly → its cursor advances; refs failed → its
      // cursor is HELD (unset/0) so the next sync re-requests it once the parent
      // ingredient has landed.
      expect(result.catalog.catalogSeqs.ingredients).toBe('5');
      expect(result.catalog.catalogSeqs.refs ?? '0').toBe('0');
    });

    it('records a schema gap and stops draining when the sender is ahead on catalog', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          ingredients: [{ id: 'x' }],
          maxSequences: { scraps: '0', ingredients: '5', sources: '0', refs: '0', relations: '0', tags: '0', media: '0' },
          hasMore: true,
          portosMeta: { schemaVersions: { catalog: 99 }, portosVersion: '99.0.0' },
        }),
      });
      const mismatch = new Error('catalog ahead');
      mismatch.code = 'CATALOG_SCHEMA_VERSION_AHEAD';
      mismatch.diff = { ahead: [{ category: 'catalog', senderV: 99, receiverV: 1 }], behind: [] };
      applyCatalogChanges.mockRejectedValueOnce(mismatch);

      const { updatePeer } = await import('./instances.js');
      getPeers.mockResolvedValue([{ ...catalogPeer, id: 'local-peer-row', instanceId: catalogPeer.instanceId }]);

      const result = await syncWithPeer(catalogPeer);

      // Only one apply attempt — we stop draining on the block (no hasMore loop).
      expect(applyCatalogChanges).toHaveBeenCalledTimes(1);
      expect(result.catalog.blockedBySchema).toBeTruthy();
      // Gap persisted on the local peer row under schemaGaps.catalog.
      expect(updatePeer).toHaveBeenCalledWith(
        'local-peer-row',
        expect.objectContaining({
          schemaGaps: expect.objectContaining({
            catalog: expect.objectContaining({
              ahead: [{ category: 'catalog', senderV: 99, receiverV: 1 }],
            }),
          }),
        }),
      );
    });
  });

  describe('categoriesCoveredByPeerSync (per-direction coverage)', () => {
    it('returns outbound from our local subs, grouped by snapshot category', async () => {
      const peerSync = await import('./sharing/peerSync.js');
      peerSync.getOutboundCoverageForPeer.mockResolvedValueOnce({
        universe: new Set(['u1', 'u2']),
        pipeline: new Set(['s1']),
        mediaCollections: new Set(),
      });
      const { categoriesCoveredByPeerSync } = await import('./syncOrchestrator.js');
      // No peer/ourId → inbound stays empty (no peer query).
      const { outbound, inbound } = await categoriesCoveredByPeerSync('peer-inst-1');
      expect([...outbound.universe].sort()).toEqual(['u1', 'u2']);
      expect([...outbound.pipeline]).toEqual(['s1']);
      expect(inbound.universe.size).toBe(0);
      expect(inbound.pipeline.size).toBe(0);
    });

    it('populates inbound from the peer\'s subscriptions targeting our instanceId (NOT our outbound)', async () => {
      const peerSync = await import('./sharing/peerSync.js');
      // Our OUTBOUND coverage is EMPTY — proving inbound is sourced separately
      // (the inbound-vs-outbound distinction). The peer pushes us s9 (series →
      // pipeline) and col-7 (mediaCollection).
      peerSync.getOutboundCoverageForPeer.mockResolvedValueOnce({
        universe: new Set(), pipeline: new Set(), mediaCollections: new Set(),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          subscriptions: [
            { peerId: 'our-inst-id', recordKind: 'series', recordId: 's9' },
            { peerId: 'our-inst-id', recordKind: 'mediaCollection', recordId: 'col-7' },
          ],
        }),
      });
      const { categoriesCoveredByPeerSync } = await import('./syncOrchestrator.js');
      const { outbound, inbound } = await categoriesCoveredByPeerSync(
        'peer-inst-1',
        { ...mockPeer, instanceId: 'peer-inst-1' },
        'our-inst-id',
      );
      // Outbound empty; inbound carries the peer-pushed records.
      expect(outbound.pipeline.size).toBe(0);
      expect([...inbound.pipeline]).toEqual(['s9']);
      expect([...inbound.mediaCollections]).toEqual(['col-7']);
      // The peer's /subscriptions endpoint was queried filtered by our id.
      const calledUrl = mockFetch.mock.calls.map((c) => c[0]).find((u) => u.includes('/api/peer-sync/subscriptions'));
      expect(calledUrl).toContain('peerId=our-inst-id');
    });

    it('inbound stays empty when the peer query fails (older/offline peer → full snapshot)', async () => {
      const peerSync = await import('./sharing/peerSync.js');
      peerSync.getOutboundCoverageForPeer.mockResolvedValueOnce({
        universe: new Set(), pipeline: new Set(), mediaCollections: new Set(),
      });
      mockFetch.mockRejectedValueOnce(new Error('peer offline'));
      const { categoriesCoveredByPeerSync } = await import('./syncOrchestrator.js');
      const { inbound } = await categoriesCoveredByPeerSync(
        'peer-inst-1',
        { ...mockPeer, instanceId: 'peer-inst-1' },
        'our-inst-id',
      );
      expect(inbound.universe.size).toBe(0);
      expect(inbound.pipeline.size).toBe(0);
      expect(inbound.mediaCollections.size).toBe(0);
    });
  });

  describe('getSyncStatus forPeer / cursorForYou', () => {
    it('returns our cursor into the requesting peer as cursorForYou', async () => {
      getCurrentSeq.mockReturnValue(120);
      getMaxSequence.mockResolvedValue('45');
      // Our stored cursors: how far we've pulled from each peer. The requesting
      // peer ('peer-A') wants its own entry back as its push-frontier toward us.
      readJSONFile.mockImplementation(async () => ({
        'peer-A': { brainSeq: 88, memorySeq: '30', lastSyncAt: '2026-01-01T00:00:00.000Z' },
        'peer-B': { brainSeq: 5 },
      }));

      const status = await getSyncStatus({ forPeer: 'peer-A' });
      expect(status.cursorForYou).toEqual({ brainSeq: 88, memorySeq: '30', lastSyncAt: '2026-01-01T00:00:00.000Z' });
      // Our own local maxes are reported under `local`.
      expect(status.local.brainSeq).toBe(120);
    });

    it('returns null cursorForYou when we have never synced the requesting peer', async () => {
      readJSONFile.mockImplementation(async () => ({ 'peer-B': { brainSeq: 5 } }));
      const status = await getSyncStatus({ forPeer: 'peer-A' });
      expect(status.cursorForYou).toBeNull();
    });

    it('omits cursorForYou entirely when no forPeer is supplied (legacy shape)', async () => {
      readJSONFile.mockImplementation(async () => ({ 'peer-A': { brainSeq: 88 } }));
      const status = await getSyncStatus({});
      expect(status).not.toHaveProperty('cursorForYou');
    });

    // Regression (#1077, Bug 3): the served local.checksums must be SCOPED to the
    // requesting peer (forPeerId === forPeer) so they match the scoped checksum
    // the peer's cursor cached during sync. Computing them unscoped (global) made
    // every per-record-subscribable category (universe/pipeline/mediaCollections)
    // read "behind" forever — including the both-empty case.
    it('computes local.checksums scoped to the requesting peer (forPeerId === forPeer)', async () => {
      const dataSync = await import('./dataSync.js');
      dataSync.getSupportedCategories.mockReturnValue(['mediaCollections']);
      dataSync.getChecksum.mockResolvedValue({ checksum: 'scoped-xyz' });
      readJSONFile.mockImplementation(async () => ({ 'peer-A': { brainSeq: 88 } }));

      const status = await getSyncStatus({ includeChecksums: true, forPeer: 'peer-A' });

      expect(dataSync.getChecksum).toHaveBeenCalledWith('mediaCollections', { forPeerId: 'peer-A' });
      expect(status.local.checksums.mediaCollections).toBe('scoped-xyz');
    });

    it('computes UNscoped local.checksums when no forPeer is supplied (self-view)', async () => {
      const dataSync = await import('./dataSync.js');
      dataSync.getSupportedCategories.mockReturnValue(['mediaCollections']);
      dataSync.getChecksum.mockResolvedValue({ checksum: 'global-abc' });
      readJSONFile.mockImplementation(async () => ({}));

      await getSyncStatus({ includeChecksums: true });

      expect(dataSync.getChecksum).toHaveBeenCalledWith('mediaCollections', { forPeerId: undefined });
    });
  });

  describe('sync:progress events', () => {
    it('emits start → applied → complete around a sync that moves records', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ changes: [{ id: 'b1' }], maxSeq: 1, hasMore: false }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ changes: [], maxSeq: 1, hasMore: false }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ memories: [], maxSequence: '0', hasMore: false }) });
      applyBrainChanges.mockResolvedValue({ inserted: 1, updated: 0, deleted: 0, skipped: 0 });

      await syncWithPeer({ ...mockPeer, syncCategories: { brain: true, memory: true } });

      const progressCalls = instanceEvents.emit.mock.calls
        .filter(([event]) => event === 'sync:progress')
        .map(([, payload]) => payload);
      expect(progressCalls[0]).toEqual({ phase: 'start', peerId: 'peer-inst-1' });
      expect(progressCalls).toContainEqual({ phase: 'applied', peerId: 'peer-inst-1', category: 'brain', applied: 1 });
      const complete = progressCalls.find(p => p.phase === 'complete');
      expect(complete).toMatchObject({ phase: 'complete', peerId: 'peer-inst-1' });
      expect(complete.totalApplied).toBeGreaterThanOrEqual(1);
    });

    it('releases the per-peer lock and still emits complete when the cursor read throws', async () => {
      // readCursors → loadCursors → readJSONFile. A throw here (corrupt cursor
      // file, disk error) happens AFTER the lock is acquired and the `start`
      // emit fires — the finally must release the lock and emit a terminal
      // `complete`, or the peer is wedged "syncing" until restart.
      readJSONFile.mockRejectedValueOnce(new Error('cursor file corrupt'));
      await expect(syncWithPeer({ ...mockPeer, syncCategories: { brain: true } })).rejects.toThrow('cursor file corrupt');

      const progress = instanceEvents.emit.mock.calls
        .filter(([event]) => event === 'sync:progress')
        .map(([, payload]) => payload);
      expect(progress).toContainEqual({ phase: 'start', peerId: 'peer-inst-1' });
      expect(progress).toContainEqual({ phase: 'complete', peerId: 'peer-inst-1', totalApplied: 0 });

      // Lock released: a subsequent sync is NOT short-circuited by syncingPeers.
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ changes: [], maxSeq: 0, hasMore: false }) });
      instanceEvents.emit.mockClear();
      await syncWithPeer({ ...mockPeer, syncCategories: { brain: true } });
      const reran = instanceEvents.emit.mock.calls.some(([event, p]) => event === 'sync:progress' && p.phase === 'start');
      expect(reran).toBe(true);
    });

    it('emits exactly one complete (totalApplied 0) for a no-op sync — card never sticks on "syncing"', async () => {
      // A category enabled but no changes available: lifecycle still settles.
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ changes: [], maxSeq: 0, hasMore: false }) });
      await syncWithPeer({ ...mockPeer, syncCategories: { brain: true } });

      const progress = instanceEvents.emit.mock.calls
        .filter(([event]) => event === 'sync:progress')
        .map(([, payload]) => payload);
      const completes = progress.filter(p => p.phase === 'complete');
      // Exactly one complete, and no spurious second one from the finally guard.
      expect(completes).toEqual([{ phase: 'complete', peerId: 'peer-inst-1', totalApplied: 0 }]);
      // No `applied` events when nothing moved.
      expect(progress.some(p => p.phase === 'applied')).toBe(false);
    });
  });

  // #1077 Part 1: anti-entropy reconcile. After draining the delta log, brain
  // sync compares a whole-brain checksum with the peer and pulls+merges the
  // snapshot on a mismatch — the only path that re-converges a peer that missed
  // compacted entries.
  describe('brain anti-entropy reconcile (#1077)', () => {
    // Brain delta drain is always empty here; we exercise the reconcile leg.
    const routeFetch = (handlers) => mockFetch.mockImplementation(async (url) => {
      if (url.includes('/api/brain/sync')) return { ok: true, json: async () => ({ changes: [], maxSeq: 0, hasMore: false }) };
      if (url.includes('/api/brain/reconcile/checksum')) return { ok: true, json: async () => handlers.checksum };
      if (url.includes('/api/brain/reconcile/snapshot')) return { ok: true, json: async () => handlers.snapshot };
      if (url.includes('/api/memory/sync')) return { ok: true, json: async () => ({ memories: [], maxSequence: '0', hasMore: false }) };
      return { ok: true, json: async () => ({}) };
    });

    it('pulls + merges the snapshot when peer checksum differs from local', async () => {
      getBrainChecksum.mockResolvedValue('local-AAA');
      applyBrainSnapshot.mockResolvedValue({ inserted: 0, updated: 3, deleted: 1, skipped: 0 });
      routeFetch({
        checksum: { checksum: 'peer-BBB' },
        snapshot: { records: { links: { x: { id: 'x', updatedAt: '2026-02-02T00:00:00.000Z' } } }, checksum: 'peer-BBB' },
      });

      const result = await syncWithPeer(mockPeer);

      expect(applyBrainSnapshot).toHaveBeenCalledTimes(1);
      // delta(0) + reconcile merge(3 upd + 1 del) = 4
      expect(result.brain.totalApplied).toBe(4);
    });

    it('SKIPS the snapshot fetch when peer checksum equals our local checksum', async () => {
      getBrainChecksum.mockResolvedValue('same-CCC');
      routeFetch({ checksum: { checksum: 'same-CCC' }, snapshot: { records: {} } });

      await syncWithPeer(mockPeer);

      expect(applyBrainSnapshot).not.toHaveBeenCalled();
      const snapshotFetches = mockFetch.mock.calls.filter(c => c[0].includes('/api/brain/reconcile/snapshot'));
      expect(snapshotFetches).toHaveLength(0);
    });

    it('SKIPS reconcile entirely when peer checksum matches the cached cursor checksum', async () => {
      const typesSig = [...BRAIN_ENTITY_TYPES].sort().join(',');
      readJSONFile.mockImplementation(async () => ({
        [mockPeer.instanceId]: { brainSeq: 0, brainChecksum: 'cached-DDD', brainChecksumTypes: typesSig },
      }));
      routeFetch({ checksum: { checksum: 'cached-DDD' }, snapshot: { records: {} } });

      await syncWithPeer(mockPeer);

      // Cached match → never even computes local checksum or fetches snapshot.
      expect(getBrainChecksum).not.toHaveBeenCalled();
      expect(applyBrainSnapshot).not.toHaveBeenCalled();
    });

    it('IGNORES a cached checksum from a different entity-type enrollment (version-skew healing)', async () => {
      // An older install skipped unknown types (e.g. `songs`) while applying a
      // snapshot yet cached the peer's checksum. Post-upgrade, that cache must
      // NOT short-circuit reconcile — a stale/absent type signature is cold.
      getBrainChecksum.mockResolvedValue('local-post-upgrade');
      readJSONFile.mockImplementation(async () => ({
        [mockPeer.instanceId]: {
          brainSeq: 0,
          brainChecksum: 'cached-DDD', // matches the remote, but from old code
          brainChecksumTypes: 'people,projects', // pre-songs enrollment (also covers absent)
        },
      }));
      routeFetch({ checksum: { checksum: 'cached-DDD' }, snapshot: { records: {}, checksum: 'cached-DDD' } });

      await syncWithPeer(mockPeer);

      // Stale signature → cache treated as cold → local checksum computed,
      // mismatch → snapshot pulled and merged.
      expect(getBrainChecksum).toHaveBeenCalled();
      expect(applyBrainSnapshot).toHaveBeenCalled();
    });

    it('falls back to delta-only when peer is too old to expose /reconcile/checksum', async () => {
      mockFetch.mockImplementation(async (url) => {
        if (url.includes('/api/brain/sync')) return { ok: true, json: async () => ({ changes: [], maxSeq: 0, hasMore: false }) };
        if (url.includes('/api/brain/reconcile/checksum')) return { ok: false, status: 404, json: async () => ({}) };
        if (url.includes('/api/memory/sync')) return { ok: true, json: async () => ({ memories: [], maxSequence: '0', hasMore: false }) };
        return { ok: true, json: async () => ({}) };
      });

      const result = await syncWithPeer(mockPeer);

      expect(applyBrainSnapshot).not.toHaveBeenCalled();
      expect(result.brain.totalApplied).toBe(0);
    });
  });

  describe('syncAllPeers', () => {
    it('iterates online peers with instanceId', async () => {
      const onlinePeer = { ...mockPeer };
      const offlinePeer = { ...mockPeer, name: 'offline', status: 'offline', instanceId: 'p2' };
      const disabledPeer = { ...mockPeer, name: 'disabled', enabled: false, instanceId: 'p3' };
      const noIdPeer = { ...mockPeer, name: 'no-id', instanceId: undefined };

      getPeers.mockResolvedValue([onlinePeer, offlinePeer, disabledPeer, noIdPeer]);

      // For the single qualifying peer: brain delta + reconcile checksum (#1077)
      // + memory fetch. URL-routed so it doesn't depend on call order.
      mockFetch.mockImplementation(async (url) => {
        if (url.includes('/api/brain/reconcile/checksum')) return { ok: true, json: async () => ({ checksum: 'local-cksum' }) };
        if (url.includes('/api/brain/sync')) return { ok: true, json: async () => ({ changes: [], maxSeq: 0, hasMore: false }) };
        if (url.includes('/api/memory/sync')) return { ok: true, json: async () => ({ memories: [], maxSequence: '0', hasMore: false }) };
        return { ok: true, json: async () => ({}) };
      });

      await syncAllPeers();

      // Only 1 peer qualifies (online + enabled + has instanceId): brain delta +
      // reconcile checksum + memory. Match by URL so unrelated fetches don't skew.
      const brainSyncCalls = mockFetch.mock.calls.filter(c => c[0].includes('/api/brain/sync'));
      const reconcileCalls = mockFetch.mock.calls.filter(c => c[0].includes('/api/brain/reconcile/checksum'));
      const memoryCalls = mockFetch.mock.calls.filter(c => c[0].includes('/api/memory/sync'));
      expect(brainSyncCalls).toHaveLength(1);
      expect(reconcileCalls).toHaveLength(1);
      expect(memoryCalls).toHaveLength(1);
    });
  });

  // #1077 Bug 1: compaction must floor on how much each brain-enabled peer has
  // pulled FROM us (peer.remoteSyncSeqs.cursorForYou.brainSeq), NOT our outbound
  // pull cursor into them (cursors[peerId].brainSeq). Flooring on the wrong
  // cursor drops log entries a peer hasn't consumed → that peer can never learn
  // those records (the divergence this issue fixes).
  describe('brain log compaction floor (#1077)', () => {
    beforeEach(() => {
      getCurrentSeq.mockReturnValue(200);
      // No changes to pull, so each peer's sync is a no-op drain.
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ changes: [], maxSeq: 0, hasMore: false }) });
    });

    it('floors on the MIN of peers consumption of our log (cursorForYou.brainSeq)', async () => {
      const peerA = { ...mockPeer, instanceId: 'A', remoteSyncSeqs: { cursorForYou: { brainSeq: 150 } } };
      const peerB = { ...mockPeer, name: 'B', instanceId: 'B', remoteSyncSeqs: { cursorForYou: { brainSeq: 90 } } };
      getPeers.mockResolvedValue([peerA, peerB]);
      // Our OUTBOUND pull cursors are high — the old (buggy) floor would use these.
      readJSONFile.mockImplementation(async () => ({ A: { brainSeq: 199 }, B: { brainSeq: 199 } }));

      await syncAllPeers();

      // Floor = min(150, 90) = 90 — NOT min(199,199), and NOT our pull cursors.
      expect(compactLog).toHaveBeenCalledWith(90);
    });

    it('floors at 0 when a brain-enabled peer has not reported its cursor into us', async () => {
      const reported = { ...mockPeer, instanceId: 'A', remoteSyncSeqs: { cursorForYou: { brainSeq: 150 } } };
      // peer B is brain-enabled but never told us how far it pulled — must NOT
      // assume it caught up. Floor drops to 0 so we keep everything for it.
      const unreported = { ...mockPeer, name: 'B', instanceId: 'B', remoteSyncSeqs: null };
      getPeers.mockResolvedValue([reported, unreported]);
      readJSONFile.mockImplementation(async () => ({}));

      await syncAllPeers();

      expect(compactLog).toHaveBeenCalledWith(0);
    });
  });

  describe('initSyncOrchestrator', () => {
    it('registers peer:online event handler', () => {
      initSyncOrchestrator();
      expect(instanceEvents.on).toHaveBeenCalledWith('peer:online', expect.any(Function));
    });

    it('sets up periodic sync interval', async () => {
      initSyncOrchestrator();

      getPeers.mockResolvedValue([]);

      // Advance past the interval (60s) and AWAIT the triggered cycle so its
      // fire-and-forget logs settle inside the test rather than after it returns
      // (the async variant flushes the promise chain the timer kicked off).
      await vi.advanceTimersByTimeAsync(60000);

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

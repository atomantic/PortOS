import { describe, it, expect, afterEach, vi } from 'vitest';

const { tempData } = vi.hoisted(() => {
  const { tmpdir } = require('os');
  const { join } = require('path');
  // Not created: sharing state reads fall back when the file is absent, and
  // this must stay off the real data directory.
  return { tempData: join(tmpdir(), 'portos-sharing-index-absent') };
});

// Lifecycle of sharing/index.js only. Peer sync, watchers, and the refusal
// bell are collaborators; their own suites cover their internals. Subscription
// and annotation modules stay real so shutdown is proven against the listeners
// initSharing actually installs.

const peers = vi.hoisted(() => {
  const { EventEmitter: EE } = require('events');
  return {
    peerSyncEvents: new EE(),
    installPeerSyncListener: vi.fn(),
    uninstallPeerSyncListener: vi.fn(),
    syncMediaLibraryWithAllPeers: vi.fn(async () => {}),
    syncCosHistoryWithAllPeers: vi.fn(async () => {}),
    syncCosTasksWithAllPeers: vi.fn(async () => {}),
    syncEidoverseFoundationsWithAllPeers: vi.fn(async () => {}),
  };
});

const localAnnotationListeners = vi.hoisted(() => []);

vi.mock('./peerSync.js', () => peers);
vi.mock('./watcher.js', () => ({
  attachAllWatchers: vi.fn(async () => ({ attached: 0 })),
  attachWatcher: vi.fn(),
  detachWatcher: vi.fn(),
  shutdownAllWatchers: vi.fn(async () => {}),
  quiesceAllWatchersForExit: vi.fn(),
  listAttachedWatchers: vi.fn(() => []),
}));
vi.mock('./shareRefusalNotifier.js', () => ({
  installShareRefusalNotifier: vi.fn(),
}));
vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'PATHS') return { ...actual.PATHS, data: tempData };
      if (prop === 'ensureDir') return vi.fn(async () => {});
      return target[prop];
    },
  });
});
vi.mock('./buckets.js', () => ({
  listBuckets: vi.fn(async () => []),
  getBucket: vi.fn(async () => null),
}));
vi.mock('../instanceIdentity.js', () => ({
  getInstanceId: vi.fn(async () => 'local-instance'),
  UNKNOWN_INSTANCE_ID: 'unknown',
}));
vi.mock('../mediaAnnotations.js', () => ({
  onLocalAnnotationChange: vi.fn((fn) => {
    localAnnotationListeners.push(fn);
    return () => {
      const index = localAnnotationListeners.indexOf(fn);
      if (index >= 0) localAnnotationListeners.splice(index, 1);
    };
  }),
  listLocalAuthorAnnotations: vi.fn(async () => ({})),
}));

const sharing = await import('./index.js');
const { recordEvents } = await import('./recordEvents.js');
const { attachAllWatchers, shutdownAllWatchers, quiesceAllWatchersForExit } = await import('./watcher.js');
const fileUtils = await import('../../lib/fileUtils.js');
const { listLocalAuthorAnnotations } = await import('../mediaAnnotations.js');

const SWEEPS = [
  peers.syncMediaLibraryWithAllPeers,
  peers.syncCosHistoryWithAllPeers,
  peers.syncCosTasksWithAllPeers,
  peers.syncEidoverseFoundationsWithAllPeers,
];

function ioMock() {
  return { emit: vi.fn() };
}

describe('sharing/index lifecycle', () => {
  afterEach(async () => {
    vi.useRealTimers();
    sharing.quiesceSharingForExit();
    localAnnotationListeners.splice(0, localAnnotationListeners.length);
    for (const fn of SWEEPS) fn.mockReset();
    for (const fn of SWEEPS) fn.mockResolvedValue(undefined);
    peers.installPeerSyncListener.mockClear();
    peers.uninstallPeerSyncListener.mockClear();
    attachAllWatchers.mockClear();
    shutdownAllWatchers.mockClear();
    quiesceAllWatchersForExit.mockClear();
  });

  it('initializes once, warns when no subscription adapter is registered, and relays nine socket events', async () => {
    vi.useFakeTimers();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const io = ioMock();
    try {
      const updatedBefore = recordEvents.listenerCount('updated');
      await sharing.initSharing({ io });
      await sharing.initSharing({ io });
      expect(attachAllWatchers).toHaveBeenCalledTimes(1);
      expect(peers.installPeerSyncListener).toHaveBeenCalledTimes(1);
      expect(recordEvents.listenerCount('updated')).toBe(updatedBefore + 1);
      expect(localAnnotationListeners).toHaveLength(1);
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('subscription adapter not registered'));

      const { sharingEvents } = sharing;
      sharingEvents.emit('manifest-processed', { bucketId: 'b1', outcome: { mode: 'inbox' } });
      sharingEvents.emit('manifest-processed', { bucketId: 'b2', outcome: { mode: 'applied' } });
      sharingEvents.emit('inbox-updated', { bucketId: 'b3' });
      sharingEvents.emit('incompatible-manifest', { bucketId: 'b4' });
      sharingEvents.emit('portos-schema-ahead', { bucketId: 'b5' });
      sharingEvents.emit('annotation-updated', { ref: 'image:a.png' });
      peers.peerSyncEvents.emit('subscription-blocked', { peerId: 'p' });
      peers.peerSyncEvents.emit('subscription-unblocked', { peerId: 'p' });
      peers.peerSyncEvents.emit('subscription-created', { peerId: 'p' });
      peers.peerSyncEvents.emit('asset-arrived', { ref: 'image:a.png' });

      const names = io.emit.mock.calls.map((call) => call[0]);
      expect(names).toEqual([
        'sharing:manifest-processed',
        'sharing:inbox-updated',
        'sharing:manifest-processed',
        'sharing:inbox-updated',
        'sharing:incompatible-manifest',
        'sharing:portos-schema-ahead',
        'media:annotation:updated',
        'peerSync:subscription-blocked',
        'peerSync:subscription-unblocked',
        'peerSync:subscription:created',
        'peerSync:asset-arrived',
      ]);
      expect(io.emit.mock.calls[1][1]).toEqual({ bucketId: 'b1' });
      expect(io.emit.mock.calls[2][1]).toEqual({ bucketId: 'b2', outcome: { mode: 'applied' } });
      expect(names.filter((name) => name === 'sharing:inbox-updated')).toEqual([
        'sharing:inbox-updated',
        'sharing:inbox-updated',
      ]);
      // The applied manifest relays once and does not also emit inbox-updated.
      expect(io.emit.mock.calls[2][0]).toBe('sharing:manifest-processed');
      expect(io.emit.mock.calls[3][0]).toBe('sharing:inbox-updated');
      expect(io.emit.mock.calls[3][1]).toEqual({ bucketId: 'b3' });
    } finally {
      errorLog.mockRestore();
      log.mockRestore();
    }
  });

  it('runs the four full-sync sweeps on the boot delay and interval, isolating a rejection', async () => {
    vi.useFakeTimers();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    peers.syncCosHistoryWithAllPeers.mockRejectedValueOnce(new Error('history down'));
    try {
      await sharing.initSharing({ io: ioMock() });
      await vi.advanceTimersByTimeAsync(19_999);
      for (const fn of SWEEPS) expect(fn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      for (const fn of SWEEPS) expect(fn).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('cos-history sweep failed: history down'));
      });
      await vi.advanceTimersByTimeAsync(60_000);
      for (const fn of SWEEPS) expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      errorLog.mockRestore();
      log.mockRestore();
    }
  });

  it('shutdown and quiesce stop sweeps and listeners so a later init does not double-fire', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const updatedBefore = recordEvents.listenerCount('updated');
      const deletedBefore = recordEvents.listenerCount('deleted');
      await sharing.initSharing({ io: ioMock() });
      const callsAtInit = peers.syncMediaLibraryWithAllPeers.mock.calls.length;

      await sharing.shutdownSharing();
      expect(shutdownAllWatchers).toHaveBeenCalledTimes(1);
      expect(peers.uninstallPeerSyncListener).toHaveBeenCalledTimes(1);
      expect(recordEvents.listenerCount('updated')).toBe(updatedBefore);
      expect(recordEvents.listenerCount('deleted')).toBe(deletedBefore);
      expect(localAnnotationListeners).toHaveLength(0);

      const readSpy = vi.spyOn(fileUtils, 'readJSONFile');
      listLocalAuthorAnnotations.mockClear();
      recordEvents.emit('updated', { recordKind: 'universe', recordId: 'rec-1' });
      localAnnotationListeners.forEach((fn) => fn());
      await vi.advanceTimersByTimeAsync(80_000);
      expect(peers.syncMediaLibraryWithAllPeers.mock.calls.length).toBe(callsAtInit);
      expect(readSpy).not.toHaveBeenCalled();
      expect(listLocalAuthorAnnotations).not.toHaveBeenCalled();

      await sharing.initSharing({ io: ioMock() });
      expect(recordEvents.listenerCount('updated')).toBe(updatedBefore + 1);
      expect(localAnnotationListeners).toHaveLength(1);
      recordEvents.emit('updated', { recordKind: 'universe', recordId: 'rec-1' });
      await vi.waitFor(() => expect(readSpy).toHaveBeenCalled());
      const readsAfterOne = readSpy.mock.calls.length;

      sharing.quiesceSharingForExit();
      expect(quiesceAllWatchersForExit).toHaveBeenCalledTimes(1);
      expect(recordEvents.listenerCount('updated')).toBe(updatedBefore);
      expect(localAnnotationListeners).toHaveLength(0);
      recordEvents.emit('updated', { recordKind: 'universe', recordId: 'rec-1' });
      await Promise.resolve();
      expect(readSpy.mock.calls.length).toBe(readsAfterOne);
      readSpy.mockRestore();

      await sharing.initSharing({ io: ioMock() });
      expect(attachAllWatchers).toHaveBeenCalledTimes(3);
      expect(localAnnotationListeners).toHaveLength(1);
    } finally {
      log.mockRestore();
      errorLog.mockRestore();
    }
  });
});

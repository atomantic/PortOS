import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  registerSubscriptionAdapter,
  __resetSubscriptionAdapter,
  autoSubscribeRecordToAllPeers,
  unsubscribeAllForRecord,
  autoSubscribePeerToAllRecords,
} from './recordEvents.js';

afterEach(() => {
  __resetSubscriptionAdapter();
});

describe('recordEvents subscription adapter', () => {
  it('is a silent no-op before any adapter registers (test/partial-boot state)', async () => {
    await expect(autoSubscribeRecordToAllPeers('universe', 'u1')).resolves.toBeUndefined();
    await expect(unsubscribeAllForRecord('series', 's1')).resolves.toBeUndefined();
    await expect(autoSubscribePeerToAllRecords('peer-1', 'universe')).resolves.toBeUndefined();
  });

  it('delegates to the registered adapter and returns its result (callers can await completion)', async () => {
    const adapter = {
      autoSubscribeRecordToAllPeers: vi.fn().mockResolvedValue(['peer-a']),
      unsubscribeAllForRecord: vi.fn().mockResolvedValue({ removed: ['peer-a'], failed: [] }),
      autoSubscribePeerToAllRecords: vi.fn().mockResolvedValue(3),
    };
    registerSubscriptionAdapter(adapter);

    await expect(autoSubscribeRecordToAllPeers('universe', 'u1')).resolves.toEqual(['peer-a']);
    expect(adapter.autoSubscribeRecordToAllPeers).toHaveBeenCalledWith('universe', 'u1');

    await expect(unsubscribeAllForRecord('series', 's1')).resolves.toEqual({ removed: ['peer-a'], failed: [] });
    expect(adapter.unsubscribeAllForRecord).toHaveBeenCalledWith('series', 's1');

    await expect(autoSubscribePeerToAllRecords('peer-1', 'series')).resolves.toBe(3);
    expect(adapter.autoSubscribePeerToAllRecords).toHaveBeenCalledWith('peer-1', 'series');
  });

  it('propagates adapter rejections so callers can .catch and log them', async () => {
    registerSubscriptionAdapter({
      autoSubscribeRecordToAllPeers: vi.fn().mockRejectedValue(new Error('peer offline')),
    });
    await expect(autoSubscribeRecordToAllPeers('universe', 'u1')).rejects.toThrow('peer offline');
  });

  it('tolerates a partial adapter (missing methods no-op)', async () => {
    registerSubscriptionAdapter({});
    await expect(autoSubscribeRecordToAllPeers('universe', 'u1')).resolves.toBeUndefined();
  });

  it('reset detaches the adapter', async () => {
    const spy = vi.fn().mockResolvedValue([]);
    registerSubscriptionAdapter({ autoSubscribeRecordToAllPeers: spy });
    __resetSubscriptionAdapter();
    await autoSubscribeRecordToAllPeers('universe', 'u1');
    expect(spy).not.toHaveBeenCalled();
  });
});

// peerSync.js's module-scope registerSubscriptionAdapter(...) is pinned in
// peerSync.test.js (which already imports the real module with its heavy
// deps mocked) — importing it here would drag the full peer-sync graph into
// this unit suite.

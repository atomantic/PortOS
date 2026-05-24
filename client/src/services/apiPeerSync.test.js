import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock apiCore before importing the module under test.
vi.mock('./apiCore.js', () => ({
  request: vi.fn(),
}));

let request;
let fetchSyncIntegrity;
let syncRecordToPeer;
let syncNowForPeer;
let pullMissingMetadata;

beforeEach(async () => {
  vi.resetModules();
  ({ request } = await import('./apiCore.js'));
  ({
    fetchSyncIntegrity,
    syncRecordToPeer,
    syncNowForPeer,
    pullMissingMetadata,
  } = await import('./apiPeerSync.js'));
  request.mockReset();
  request.mockResolvedValue({ ok: true });
});

describe('fetchSyncIntegrity', () => {
  it('calls the correct GET path with encoded params', async () => {
    await fetchSyncIntegrity('peer-a', 'universe');
    expect(request).toHaveBeenCalledWith(
      '/peer-sync/integrity?peerId=peer-a&kind=universe',
      { silent: true },
    );
  });

  it('URL-encodes peerId and kind that contain special characters', async () => {
    await fetchSyncIntegrity('peer a/b', 'media collection');
    expect(request).toHaveBeenCalledWith(
      '/peer-sync/integrity?peerId=peer%20a%2Fb&kind=media%20collection',
      { silent: true },
    );
  });

  it('always passes silent:true so the hook owns the failure UI', async () => {
    await fetchSyncIntegrity('x', 'series');
    const [, opts] = request.mock.calls[0];
    expect(opts.silent).toBe(true);
  });
});

describe('syncRecordToPeer', () => {
  it('calls POST /peer-sync/sync-record with the correct body', async () => {
    await syncRecordToPeer('peer-b', 'universe', 'rec-1');
    expect(request).toHaveBeenCalledWith('/peer-sync/sync-record', {
      method: 'POST',
      body: JSON.stringify({ peerId: 'peer-b', recordKind: 'universe', recordId: 'rec-1' }),
    });
  });

  it('spreads caller options (e.g. silent:true) into the request', async () => {
    await syncRecordToPeer('p', 'series', 'r', { silent: true });
    const [, opts] = request.mock.calls[0];
    expect(opts.silent).toBe(true);
    expect(opts.method).toBe('POST');
  });
});

describe('syncNowForPeer', () => {
  it('calls POST /peer-sync/sync-now with peerId in body', async () => {
    await syncNowForPeer('peer-c');
    expect(request).toHaveBeenCalledWith('/peer-sync/sync-now', {
      method: 'POST',
      body: JSON.stringify({ peerId: 'peer-c' }),
    });
  });

  it('spreads caller options', async () => {
    await syncNowForPeer('peer-c', { silent: true });
    const [, opts] = request.mock.calls[0];
    expect(opts.silent).toBe(true);
  });
});

describe('pullMissingMetadata', () => {
  it('calls POST /peer-sync/pull-metadata with filenames array', async () => {
    await pullMissingMetadata(['a.json', 'b.json']);
    expect(request).toHaveBeenCalledWith('/peer-sync/pull-metadata', {
      method: 'POST',
      body: JSON.stringify({ filenames: ['a.json', 'b.json'] }),
    });
  });

  it('spreads caller options', async () => {
    await pullMissingMetadata([], { silent: true });
    const [, opts] = request.mock.calls[0];
    expect(opts.silent).toBe(true);
  });

  it('sends a single request when at/under the 5000 cap', async () => {
    await pullMissingMetadata(Array.from({ length: 5000 }, (_, i) => `f${i}.json`));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('chunks lists over 5000 into multiple requests and aggregates counts', async () => {
    request.mockReset();
    request
      .mockResolvedValueOnce({ attempted: 5000, recovered: 10 })
      .mockResolvedValueOnce({ attempted: 1, recovered: 1 });

    const result = await pullMissingMetadata(
      Array.from({ length: 5001 }, (_, i) => `f${i}.json`),
      { silent: true },
    );

    expect(request).toHaveBeenCalledTimes(2);
    // Each chunk is ≤ 5000 (server's peerPullMetadataSchema cap).
    expect(JSON.parse(request.mock.calls[0][1].body).filenames).toHaveLength(5000);
    expect(JSON.parse(request.mock.calls[1][1].body).filenames).toHaveLength(1);
    // Aggregated counts across batches.
    expect(result).toEqual({ attempted: 5001, recovered: 11 });
  });
});

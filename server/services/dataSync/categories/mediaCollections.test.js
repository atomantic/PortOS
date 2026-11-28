import { describe, it, expect, vi, beforeEach } from 'vitest';

const listUniversesMock = vi.fn();
const listSeriesMock = vi.fn();
const listCollectionsMock = vi.fn();
const mergeMediaCollectionsFromSyncMock = vi.fn();

vi.mock('../../universeBuilder.js', () => ({
  listUniverses: (...args) => listUniversesMock(...args),
}));

vi.mock('../../pipeline/series.js', () => ({
  listSeries: (...args) => listSeriesMock(...args),
}));

vi.mock('../../mediaCollections.js', () => ({
  listCollections: (...args) => listCollectionsMock(...args),
  mergeMediaCollectionsFromSync: (...args) => mergeMediaCollectionsFromSyncMock(...args),
  itemKey: (item) => `${item.kind}:${item.ref}`,
}));

import {
  getWireCollections,
  getMediaCollectionsSnapshot,
  applyMediaCollectionsRemote,
} from './mediaCollections.js';

const sampleCollection = (overrides = {}) => ({
  id: 'col-1',
  name: 'Collection 1',
  description: '',
  coverKey: null,
  universeId: 'u-1',
  seriesId: null,
  items: [{ kind: 'image', ref: 'a.png', addedAt: '2026-05-22T01:00:00Z' }],
  createdAt: '2026-05-22T00:00:00Z',
  updatedAt: '2026-05-22T01:00:00Z',
  ...overrides,
});

describe('dataSync/categories/mediaCollections — fail-closed parent reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listCollectionsMock.mockResolvedValue([sampleCollection()]);
    listUniversesMock.mockResolvedValue([]);
    listSeriesMock.mockResolvedValue([]);
    mergeMediaCollectionsFromSyncMock.mockResolvedValue({ applied: true, count: 1 });
  });

  it('rejects getMediaCollectionsSnapshot when listUniverses fails instead of leaking ephemeral collections', async () => {
    listUniversesMock.mockRejectedValue(new Error('pg connection refused'));
    await expect(getMediaCollectionsSnapshot()).rejects.toThrow('pg connection refused');
  });

  it('rejects getMediaCollectionsSnapshot when listSeries fails instead of leaking ephemeral collections', async () => {
    listSeriesMock.mockRejectedValue(new Error('series store unreadable'));
    await expect(getMediaCollectionsSnapshot()).rejects.toThrow('series store unreadable');
  });

  it('rejects getWireCollections when either parent store fails', async () => {
    listUniversesMock.mockRejectedValue(new Error('universe store unavailable'));
    await expect(getWireCollections()).rejects.toThrow('universe store unavailable');
  });

  it('excludes collections linked to ephemeral parents on export', async () => {
    listCollectionsMock.mockResolvedValue([
      sampleCollection({ id: 'col-private-u', universeId: 'u-ephemeral' }),
      sampleCollection({ id: 'col-private-s', universeId: null, seriesId: 's-ephemeral' }),
      sampleCollection({ id: 'col-public', universeId: 'u-public', seriesId: null }),
    ]);
    listUniversesMock.mockResolvedValue([
      { id: 'u-ephemeral', ephemeral: true },
      { id: 'u-public', ephemeral: false },
    ]);
    listSeriesMock.mockResolvedValue([
      { id: 's-ephemeral', ephemeral: true },
    ]);

    const snap = await getMediaCollectionsSnapshot();
    expect(snap.data.collections.map((c) => c.id)).toEqual(['col-public']);
  });

  it('rejects applyMediaCollectionsRemote when listUniverses fails without merging', async () => {
    listUniversesMock.mockRejectedValue(new Error('pg connection refused'));
    await expect(
      applyMediaCollectionsRemote({ collections: [sampleCollection()] }, { peerId: 'peer-1' }),
    ).rejects.toThrow('pg connection refused');
    expect(mergeMediaCollectionsFromSyncMock).not.toHaveBeenCalled();
  });

  it('rejects applyMediaCollectionsRemote when listSeries fails without merging', async () => {
    listSeriesMock.mockRejectedValue(new Error('series store unreadable'));
    await expect(
      applyMediaCollectionsRemote({ collections: [sampleCollection({ universeId: null, seriesId: 's-1' })] }, { peerId: 'peer-1' }),
    ).rejects.toThrow('series store unreadable');
    expect(mergeMediaCollectionsFromSyncMock).not.toHaveBeenCalled();
  });

  it('filters out remote collections linked to ephemeral or tombstoned parents before merging', async () => {
    listUniversesMock.mockResolvedValue([
      { id: 'u-ephemeral', ephemeral: true },
      { id: 'u-deleted', deleted: true },
      { id: 'u-live' },
    ]);
    listSeriesMock.mockResolvedValue([
      { id: 's-deleted', deleted: true },
    ]);

    const incoming = [
      sampleCollection({ id: 'col-ephemeral', universeId: 'u-ephemeral' }),
      sampleCollection({ id: 'col-deleted-u', universeId: 'u-deleted' }),
      sampleCollection({ id: 'col-deleted-s', universeId: null, seriesId: 's-deleted' }),
      sampleCollection({ id: 'col-ok', universeId: 'u-live' }),
    ];
    await applyMediaCollectionsRemote({ collections: incoming }, { peerId: 'peer-1' });

    expect(mergeMediaCollectionsFromSyncMock).toHaveBeenCalledTimes(1);
    const [merged] = mergeMediaCollectionsFromSyncMock.mock.calls[0];
    expect(merged.map((c) => c.id)).toEqual(['col-ok']);
  });
});

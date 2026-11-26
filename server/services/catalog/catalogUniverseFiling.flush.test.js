import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as filing from './catalogUniverseFiling.js';
import { catalogEvents } from './catalogEvents.js';

// Shutdown drain for the debounced live filing (#14262). Filing deps are
// replaced so the pass records what it would file, with no DB.
let loadPlacements;

beforeEach(() => {
  vi.useFakeTimers();
  loadPlacements = vi.fn(async () => []);
  filing.__setUniverseFilingDepsForTests({ loadPlacements, loadTypePlacements: vi.fn(async () => []), isGalleryImage: () => true });
  filing.__testing.reset();
  filing.initCatalogUniverseFiling();
});

afterEach(() => {
  filing.__testing.reset();
  vi.useRealTimers();
});

describe('flushCatalogUniverseFiling', () => {
  it('runs a debounced batch immediately instead of waiting out the timer, then resolves once it settles', async () => {
    catalogEvents.emit('assets-changed', { ingredientId: 'cid-render' });
    expect(loadPlacements).not.toHaveBeenCalled();

    await filing.flushCatalogUniverseFiling();

    expect(loadPlacements).toHaveBeenCalledOnce();
    expect(loadPlacements).toHaveBeenCalledWith(['cid-render']);
    // The armed timer was cleared, so the same batch is not replayed later.
    await vi.advanceTimersByTimeAsync(5000);
    expect(loadPlacements).toHaveBeenCalledOnce();
  });

  it('resolves without filing anything when nothing is pending', async () => {
    await filing.flushCatalogUniverseFiling();
    expect(loadPlacements).not.toHaveBeenCalled();
  });
});

describe('full catalog filing', () => {
  it('shares one directory listing between both collection passes', async () => {
    const mediaKeys = ['present.png', 'missing.png', 'broken-link.png'];
    const readGallery = vi.fn(async () => [
      { name: 'present.png', isSymbolicLink: () => false },
      { name: 'broken-link.png', isSymbolicLink: () => true },
    ]);
    const isGalleryImage = vi.fn(async () => false);
    const bulkUpdateCollectionItems = vi.fn(async (_, { add }) => ({ added: add.length }));
    loadPlacements.mockResolvedValue(mediaKeys.map(mediaKey => ({ ingredientId: 'cast-1', universeId: 'world-1', mediaKey })));
    filing.__setUniverseFilingDepsForTests({
      loadTypePlacements: async () => [
        ...mediaKeys.map(mediaKey => ({ type: 'character', mediaKey })),
        { type: 'place', mediaKey: 'already-filed.png' },
      ],
      readGallery,
      isGalleryImage,
      findCollectionByUniverseId: async () => ({ id: 'universe-collection', items: [] }),
      findCatalogTypeCollection: async (type) => ({
        id: `type-${type}`,
        items: type === 'place' ? [{ kind: 'image', ref: 'already-filed.png' }] : [],
      }),
      bulkUpdateCollectionItems,
    });

    expect(await filing.fileCatalogImages()).toEqual({ added: 2, updatedCollections: 2 });
    expect(readGallery).toHaveBeenCalledOnce();
    expect(isGalleryImage.mock.calls).toEqual([['broken-link.png']]);
    expect(bulkUpdateCollectionItems).toHaveBeenCalledTimes(2);
    for (const [, { add }] of bulkUpdateCollectionItems.mock.calls) {
      expect(add).toEqual([{ kind: 'image', ref: 'present.png' }]);
    }
  });
});

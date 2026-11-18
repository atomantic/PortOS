import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as filing from './catalogUniverseFiling.js';
import { catalogEvents } from './catalogEvents.js';

// Shutdown drain for the debounced live filing (#14262). Filing deps are
// replaced so the pass records what it would file, with no DB.
let loadPlacements;

beforeEach(() => {
  vi.useFakeTimers();
  loadPlacements = vi.fn(async () => []);
  filing.__setUniverseFilingDepsForTests({ loadPlacements, isGalleryImage: () => true });
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

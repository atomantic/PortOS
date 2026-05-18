import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the three collaborators canonUsage pulls from — universe storage, the
// series store, and the issue store. Each test seeds the fixtures directly
// so the assertions are deterministic without hitting disk.
const mockUniverses = new Map();
const mockSeriesList = [];
const mockIssuesBySeries = new Map();

vi.mock('./universeBuilder.js', () => ({
  getUniverse: vi.fn(async (id) => {
    const u = mockUniverses.get(id);
    if (!u) throw new Error(`Universe not found: ${id}`);
    return u;
  }),
}));

vi.mock('./pipeline/series.js', () => ({
  listSeries: vi.fn(async () => [...mockSeriesList]),
}));

vi.mock('./pipeline/issues.js', () => ({
  listIssues: vi.fn(async ({ seriesId }) => mockIssuesBySeries.get(seriesId) || []),
}));

const { getUniverseCanonUsage } = await import('./canonUsage.js');

beforeEach(() => {
  mockUniverses.clear();
  mockSeriesList.length = 0;
  mockIssuesBySeries.clear();
});

describe('canonUsage — seriesNameMap', () => {
  it('includes every linked series, even ones with no prose match', async () => {
    mockUniverses.set('uni-1', {
      id: 'uni-1',
      characters: [{ id: 'char-1', name: 'Lyra', sourceSeriesId: 'ser-quiet' }],
      settings: [],
      objects: [],
    });
    mockSeriesList.push(
      { id: 'ser-active', name: 'Phantom Pact', universeId: 'uni-1' },
      // Linked but has no issues / no prose match — must still appear in the
      // map so the CanonCard chip can render its name for entries stamped
      // with sourceSeriesId='ser-quiet'.
      { id: 'ser-quiet', name: 'Silent Series', universeId: 'uni-1' },
      // Different universe — must NOT leak into this universe's lookup.
      { id: 'ser-other', name: 'Other Universe', universeId: 'uni-2' },
    );
    mockIssuesBySeries.set('ser-active', [
      { id: 'iss-1', stages: { prose: { output: 'A long prose passage.' } } },
    ]);

    const usage = await getUniverseCanonUsage('uni-1');
    expect(usage.seriesNameMap).toEqual({
      'ser-active': 'Phantom Pact',
      'ser-quiet': 'Silent Series',
    });
    expect(usage.seriesCount).toBe(2);
  });

  it('returns an empty map when no series link to the universe', async () => {
    mockUniverses.set('uni-empty', { id: 'uni-empty', characters: [], settings: [], objects: [] });
    const usage = await getUniverseCanonUsage('uni-empty');
    expect(usage.seriesNameMap).toEqual({});
    expect(usage.seriesCount).toBe(0);
  });
});

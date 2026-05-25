import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

const ERR_DUPLICATE = 'DUPLICATE';
const ERR_NOT_FOUND = 'NOT_FOUND';

// In-memory universe store the mock backs. Mirrors the file-backed shape so
// insert/get/update behave like the real module from the helper's POV.
const universes = new Map();
const insertCalls = [];

vi.mock('../universeBuilder.js', () => ({
  ERR_DUPLICATE,
  insertUniverseWithId: vi.fn(async ({ id, name, starterPrompt }) => {
    insertCalls.push({ id, name });
    if (universes.has(id)) {
      const err = new Error(`Universe id already exists: ${id}`);
      err.code = ERR_DUPLICATE;
      throw err;
    }
    const rec = { id, name, starterPrompt, characters: [], places: [], objects: [] };
    universes.set(id, rec);
    return rec;
  }),
  getUniverse: vi.fn(async (id) => {
    if (!universes.has(id)) {
      const err = new Error(`Universe not found: ${id}`);
      err.code = ERR_NOT_FOUND;
      throw err;
    }
    return universes.get(id);
  }),
  updateUniverse: vi.fn(async (id, patch) => {
    const cur = universes.get(id);
    Object.assign(cur, patch);
    return cur;
  }),
}));

vi.mock('./series.js', () => ({ updateSeries: vi.fn(async () => null) }));
vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { data: '/mock/data' },
  readJSONFile: vi.fn(async (_p, fallback) => fallback),
}));
vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());

const { applyLegacySeriesCanonToUniverse, deriveOrphanUniverseId } = await import('./migrateSeriesCanon.js');
const universeBuilder = await import('../universeBuilder.js');

const baseSeries = (over = {}) => ({
  id: 'series-abc-123',
  name: 'Aegis Online',
  characters: [{ name: 'Iris', description: 'protagonist' }],
  places: [],
  objects: [],
  ...over,
});

beforeEach(() => {
  universes.clear();
  insertCalls.length = 0;
  vi.clearAllMocks();
});

describe('deriveOrphanUniverseId', () => {
  it('is deterministic for the same series id', () => {
    expect(deriveOrphanUniverseId('series-abc-123')).toBe(deriveOrphanUniverseId('series-abc-123'));
  });

  it('produces a different id for a different series id', () => {
    expect(deriveOrphanUniverseId('series-abc-123')).not.toBe(deriveOrphanUniverseId('series-xyz-789'));
  });

  it('fits UNIVERSE_ID_RE (^[A-Za-z0-9-]{8,80}$)', () => {
    const id = deriveOrphanUniverseId('any-seed');
    expect(id).toMatch(/^[A-Za-z0-9-]{8,80}$/);
  });
});

describe('applyLegacySeriesCanonToUniverse — retry idempotency', () => {
  it('creates a single deterministic universe for an orphan series on first call', async () => {
    const r = await applyLegacySeriesCanonToUniverse(baseSeries(), { log: () => {} });
    expect(r.universeCreated).toBe(true);
    expect(r.universeId).toBe(deriveOrphanUniverseId('series-abc-123'));
    expect(insertCalls).toHaveLength(1);
    expect(universes.size).toBe(1);
  });

  it('reuses the prior orphan universe when retried after an updateUniverse failure', async () => {
    // First pass: insertUniverseWithId lands the universe, updateUniverse
    // throws (transient I/O). Helper bubbles the throw (caller catches).
    universeBuilder.updateUniverse.mockRejectedValueOnce(new Error('EIO: disk full'));
    await expect(applyLegacySeriesCanonToUniverse(baseSeries(), { log: () => {} }))
      .rejects.toThrow(/EIO/);
    expect(universes.size).toBe(1);
    const orphanId = deriveOrphanUniverseId('series-abc-123');
    expect(universes.has(orphanId)).toBe(true);
    expect(universes.get(orphanId).characters).toEqual([]);

    // Retry pass: same series.id, no universeId on the record (bucket
    // record isn't mutated between retries).
    const r2 = await applyLegacySeriesCanonToUniverse(baseSeries(), { log: () => {} });
    expect(r2.universeId).toBe(orphanId);
    expect(r2.universeCreated).toBe(true);
    expect(r2.migrated).toBe(true);
    // Exactly two insert attempts (first success, second ERR_DUPLICATE) —
    // never a third orphan minted.
    expect(insertCalls).toHaveLength(2);
    expect(universes.size).toBe(1);
    expect(universes.get(orphanId).characters).toEqual([
      expect.objectContaining({ name: 'Iris' }),
    ]);
  });

  it('does not create a universe in dry-run mode', async () => {
    const r = await applyLegacySeriesCanonToUniverse(baseSeries(), { dryRun: true, log: () => {} });
    expect(r.skipped).toBe('dry-run-orphan');
    expect(r.universeCreated).toBe(false);
    expect(insertCalls).toHaveLength(0);
    expect(universes.size).toBe(0);
  });

  it('rethrows non-ERR_DUPLICATE insert errors so callers can mark the series pending', async () => {
    universeBuilder.insertUniverseWithId.mockRejectedValueOnce(
      Object.assign(new Error('disk dead'), { code: 'EIO' }),
    );
    await expect(applyLegacySeriesCanonToUniverse(baseSeries(), { log: () => {} }))
      .rejects.toThrow(/disk dead/);
    expect(universes.size).toBe(0);
  });
});

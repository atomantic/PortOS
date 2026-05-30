/**
 * Unit tests for catalogSync — the peer→peer envelope apply path.
 *
 * The catalogDB upserts are mocked so this test stays pure (no Postgres).
 * The assertions cover:
 *   - per-kind dispatch (scraps → ingredients → sources → refs)
 *   - per-row try/catch isolation (one bad row doesn't abort the rest)
 *   - the schema-version gate (sender ahead on `catalog` → 412)
 *   - cursor normalization in getChangesSince (scalar vs per-kind)
 *   - per-kind cursor advance falls back to the inbound cursor on quiet kinds
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./catalogDB.js', () => ({
  getScrapChangesSince: vi.fn(),
  getIngredientChangesSince: vi.fn(),
  getSourceChangesSince: vi.fn(),
  getRefChangesSince: vi.fn(),
  getMaxSequences: vi.fn(),
  upsertScrapFromPeer: vi.fn(),
  upsertIngredientFromPeer: vi.fn(),
  upsertSourceFromPeer: vi.fn(),
  upsertRefFromPeer: vi.fn(),
}));

vi.mock('../lib/schemaVersions.js', async () => {
  const actual = await vi.importActual('../lib/schemaVersions.js');
  return actual;
});

const catalogDB = await import('./catalogDB.js');
const {
  applyRemoteChanges,
  getChangesSince,
  CatalogSyncVersionMismatchError,
} = await import('./catalogSync.js');
const { PORTOS_SCHEMA_VERSIONS } = await import('../lib/schemaVersions.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('applyRemoteChanges — dispatch + stats', () => {
  it('routes each kind to its upsert and counts inserts/updates/skips', async () => {
    catalogDB.upsertScrapFromPeer.mockResolvedValueOnce({ applied: true, isInsert: true });
    catalogDB.upsertIngredientFromPeer.mockResolvedValueOnce({ applied: true, isInsert: false });
    catalogDB.upsertIngredientFromPeer.mockResolvedValueOnce({ applied: false }); // LWW skip
    catalogDB.upsertSourceFromPeer.mockResolvedValueOnce(undefined);
    catalogDB.upsertRefFromPeer.mockResolvedValueOnce(undefined);

    const stats = await applyRemoteChanges({
      scraps:      [{ id: 's1', rawText: 'x', createdAt: 't', updatedAt: 't' }],
      ingredients: [
        { id: 'i1', type: 'character', name: 'A', createdAt: 't', updatedAt: 't' },
        { id: 'i2', type: 'character', name: 'B', createdAt: 't', updatedAt: 't' },
      ],
      sources: [{ ingredientId: 'i1', scrapId: 's1', extractedAt: 't' }],
      refs: [{ ingredientId: 'i1', refKind: 'universe', refId: 'u1', role: 'canon-character', createdAt: 't' }],
    });

    expect(stats.scraps.inserted).toBe(1);
    expect(stats.ingredients.updated).toBe(1);
    expect(stats.ingredients.skipped).toBe(1);
    expect(stats.sources.applied).toBe(1);
    expect(stats.refs.applied).toBe(1);
    expect(stats.errors).toHaveLength(0);
  });

  it('isolates per-row failures — one bad row does not abort the rest', async () => {
    catalogDB.upsertScrapFromPeer.mockRejectedValueOnce(new Error('boom'));
    catalogDB.upsertScrapFromPeer.mockResolvedValueOnce({ applied: true, isInsert: true });

    const stats = await applyRemoteChanges({
      scraps: [
        { id: 'bad', rawText: 'x', createdAt: 't', updatedAt: 't' },
        { id: 'good', rawText: 'y', createdAt: 't', updatedAt: 't' },
      ],
    });

    expect(stats.scraps.failed).toBe(1);
    expect(stats.scraps.inserted).toBe(1);
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0]).toMatchObject({ kind: 'scrap', id: 'bad', message: 'boom' });
  });

  it('applies scraps before ingredients so source FKs can land in the same envelope', async () => {
    const order = [];
    catalogDB.upsertScrapFromPeer.mockImplementation(async () => {
      order.push('scrap');
      return { applied: true, isInsert: true };
    });
    catalogDB.upsertIngredientFromPeer.mockImplementation(async () => {
      order.push('ingredient');
      return { applied: true, isInsert: true };
    });
    catalogDB.upsertSourceFromPeer.mockImplementation(async () => {
      order.push('source');
    });
    catalogDB.upsertRefFromPeer.mockImplementation(async () => {
      order.push('ref');
    });

    await applyRemoteChanges({
      refs:        [{ ingredientId: 'i1', refKind: 'universe', refId: 'u1', role: 'canon-character', createdAt: 't' }],
      sources:     [{ ingredientId: 'i1', scrapId: 's1', extractedAt: 't' }],
      ingredients: [{ id: 'i1', type: 'character', name: 'A', createdAt: 't', updatedAt: 't' }],
      scraps:      [{ id: 's1', rawText: 'x', createdAt: 't', updatedAt: 't' }],
    });

    expect(order).toEqual(['scrap', 'ingredient', 'source', 'ref']);
  });
});

describe('applyRemoteChanges — schema-version gate', () => {
  it('rejects envelopes whose sender is ahead on `catalog` with a 412', async () => {
    const tooNew = PORTOS_SCHEMA_VERSIONS.catalog + 1;
    await expect(applyRemoteChanges({
      portosMeta: { schemaVersions: { catalog: tooNew } },
      ingredients: [],
    })).rejects.toBeInstanceOf(CatalogSyncVersionMismatchError);

    // The thrown error carries the HTTP status + a structured diff.
    try {
      await applyRemoteChanges({
        portosMeta: { schemaVersions: { catalog: tooNew } },
        ingredients: [],
      });
    } catch (err) {
      expect(err.status).toBe(412);
      expect(err.code).toBe('CATALOG_SCHEMA_VERSION_AHEAD');
      expect(err.diff.ahead[0].category).toBe('catalog');
    }
  });

  it('accepts envelopes from a sender behind on `catalog`', async () => {
    catalogDB.upsertIngredientFromPeer.mockResolvedValue({ applied: true, isInsert: true });
    const stats = await applyRemoteChanges({
      portosMeta: { schemaVersions: { catalog: 1 } },
      ingredients: [{ id: 'i1', type: 'character', name: 'A', createdAt: 't', updatedAt: 't' }],
    });
    expect(stats.ingredients.inserted).toBe(1);
  });

  it('accepts envelopes with no portosMeta (legacy/forked peers)', async () => {
    catalogDB.upsertIngredientFromPeer.mockResolvedValue({ applied: true, isInsert: true });
    const stats = await applyRemoteChanges({
      ingredients: [{ id: 'i1', type: 'character', name: 'A', createdAt: 't', updatedAt: 't' }],
    });
    expect(stats.ingredients.inserted).toBe(1);
  });
});

describe('getChangesSince — cursor normalization + per-kind advance', () => {
  beforeEach(() => {
    catalogDB.getScrapChangesSince.mockResolvedValue({ items: [], hasMore: false });
    catalogDB.getIngredientChangesSince.mockResolvedValue({ items: [], hasMore: false });
    catalogDB.getSourceChangesSince.mockResolvedValue({ items: [], hasMore: false });
    catalogDB.getRefChangesSince.mockResolvedValue({ items: [], hasMore: false });
  });

  it('accepts a scalar since and applies it uniformly to all four kinds', async () => {
    await getChangesSince('42', 100);
    expect(catalogDB.getScrapChangesSince).toHaveBeenCalledWith('42', 100);
    expect(catalogDB.getIngredientChangesSince).toHaveBeenCalledWith('42', 100);
    expect(catalogDB.getSourceChangesSince).toHaveBeenCalledWith('42', 100);
    expect(catalogDB.getRefChangesSince).toHaveBeenCalledWith('42', 100);
  });

  it('accepts a per-kind cursor object', async () => {
    await getChangesSince({ scraps: '5', ingredients: '10', sources: '15', refs: '20' }, 100);
    expect(catalogDB.getScrapChangesSince).toHaveBeenCalledWith('5', 100);
    expect(catalogDB.getIngredientChangesSince).toHaveBeenCalledWith('10', 100);
    expect(catalogDB.getSourceChangesSince).toHaveBeenCalledWith('15', 100);
    expect(catalogDB.getRefChangesSince).toHaveBeenCalledWith('20', 100);
  });

  it('rejects non-numeric cursor values, falling back to "0"', async () => {
    await getChangesSince({ scraps: '5', ingredients: 'NaN', sources: null, refs: undefined }, 100);
    expect(catalogDB.getScrapChangesSince).toHaveBeenCalledWith('5', 100);
    expect(catalogDB.getIngredientChangesSince).toHaveBeenCalledWith('0', 100);
    expect(catalogDB.getSourceChangesSince).toHaveBeenCalledWith('0', 100);
    expect(catalogDB.getRefChangesSince).toHaveBeenCalledWith('0', 100);
  });

  it('per-kind maxSequence falls back to the inbound cursor on quiet kinds', async () => {
    catalogDB.getScrapChangesSince.mockResolvedValue({
      items: [{ id: 's2', syncSequence: '100' }],
      hasMore: false,
    });
    catalogDB.getIngredientChangesSince.mockResolvedValue({ items: [], hasMore: false });

    const res = await getChangesSince({ scraps: '50', ingredients: '99', sources: '88', refs: '77' }, 100);

    // Quiet kinds reflect the inbound cursor — NOT 0 — so the next pull
    // doesn't move backward.
    expect(res.maxSequences.scraps).toBe('100');
    expect(res.maxSequences.ingredients).toBe('99');
    expect(res.maxSequences.sources).toBe('88');
    expect(res.maxSequences.refs).toBe('77');
  });

  it('hasMore is true when ANY kind reports more', async () => {
    catalogDB.getSourceChangesSince.mockResolvedValue({ items: [], hasMore: true });
    const res = await getChangesSince('0', 100);
    expect(res.hasMore).toBe(true);
  });
});

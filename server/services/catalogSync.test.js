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
  getRelationChangesSince: vi.fn(),
  getTagChangesSince: vi.fn(),
  getMediaChangesSince: vi.fn(),
  getMaxSequences: vi.fn(),
  upsertScrapFromPeer: vi.fn(),
  upsertIngredientFromPeer: vi.fn(),
  upsertSourceFromPeer: vi.fn(),
  upsertRefFromPeer: vi.fn(),
  upsertRelationFromPeer: vi.fn(),
  upsertTagFromPeer: vi.fn(),
  upsertMediaFromPeer: vi.fn(),
}));

vi.mock('../lib/schemaVersions.js', async () => {
  const actual = await vi.importActual('../lib/schemaVersions.js');
  return actual;
});

const catalogDB = await import('./catalogDB.js');
const {
  applyRemoteChanges,
  getChangesSince,
  countAppliedFromStats,
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
    catalogDB.upsertRelationFromPeer.mockResolvedValueOnce(undefined);
    catalogDB.upsertTagFromPeer.mockResolvedValueOnce({ applied: true, isInsert: true });
    catalogDB.upsertMediaFromPeer.mockResolvedValueOnce(undefined);

    const stats = await applyRemoteChanges({
      scraps:      [{ id: 's1', rawText: 'x', createdAt: 't', updatedAt: 't' }],
      ingredients: [
        { id: 'i1', type: 'character', name: 'A', createdAt: 't', updatedAt: 't' },
        { id: 'i2', type: 'character', name: 'B', createdAt: 't', updatedAt: 't' },
      ],
      sources: [{ ingredientId: 'i1', scrapId: 's1', extractedAt: 't' }],
      refs: [{ ingredientId: 'i1', refKind: 'universe', refId: 'u1', role: 'canon-character', createdAt: 't' }],
      relations: [{ fromId: 'i1', toId: 'i2', kind: 'lives-in', createdAt: 't' }],
      tags: [{ id: 'cat-tag-noir', label: 'Noir', createdAt: 't', updatedAt: 't' }],
      media: [{ ingredientId: 'i1', mediaKey: 'hero.png', kind: 'portrait', createdAt: 't' }],
    });

    expect(stats.scraps.inserted).toBe(1);
    expect(stats.ingredients.updated).toBe(1);
    expect(stats.ingredients.skipped).toBe(1);
    expect(stats.sources.applied).toBe(1);
    expect(stats.refs.applied).toBe(1);
    expect(stats.relations.applied).toBe(1);
    expect(stats.tags.inserted).toBe(1);
    expect(stats.media.applied).toBe(1);
    expect(catalogDB.upsertMediaFromPeer).toHaveBeenCalledWith(
      expect.objectContaining({ ingredientId: 'i1', mediaKey: 'hero.png', kind: 'portrait' }),
    );
    expect(stats.errors).toHaveLength(0);
  });

  it('counts tag inserts / updates / skips and isolates a failing tag row', async () => {
    catalogDB.upsertTagFromPeer.mockResolvedValueOnce({ applied: true, isInsert: false }); // LWW update
    catalogDB.upsertTagFromPeer.mockResolvedValueOnce({ applied: false });                 // LWW skip
    catalogDB.upsertTagFromPeer.mockRejectedValueOnce(new Error('bad tag'));

    const stats = await applyRemoteChanges({
      tags: [
        { id: 'cat-tag-noir', label: 'Noir', createdAt: 't', updatedAt: 't2' },
        { id: 'cat-tag-pulp', label: 'Pulp', createdAt: 't', updatedAt: 't' },
        { id: 'cat-tag-bad', label: 'Bad', createdAt: 't', updatedAt: 't' },
      ],
    });

    expect(stats.tags.updated).toBe(1);
    expect(stats.tags.skipped).toBe(1);
    expect(stats.tags.failed).toBe(1);
    expect(stats.errors[0]).toMatchObject({ kind: 'tag', id: 'cat-tag-bad', message: 'bad tag' });
  });

  it('isolates a failing relation row and records it', async () => {
    catalogDB.upsertRelationFromPeer.mockRejectedValueOnce(new Error('fk violation'));
    const stats = await applyRemoteChanges({
      relations: [{ fromId: 'i1', toId: 'gone', kind: 'references', createdAt: 't' }],
    });
    expect(stats.relations.failed).toBe(1);
    expect(stats.errors[0]).toMatchObject({ kind: 'relation', message: 'fk violation' });
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
    catalogDB.upsertRelationFromPeer.mockImplementation(async () => {
      order.push('relation');
    });
    catalogDB.upsertTagFromPeer.mockImplementation(async () => {
      order.push('tag');
      return { applied: true, isInsert: true };
    });

    await applyRemoteChanges({
      relations:   [{ fromId: 'i1', toId: 'i2', kind: 'lives-in', createdAt: 't' }],
      refs:        [{ ingredientId: 'i1', refKind: 'universe', refId: 'u1', role: 'canon-character', createdAt: 't' }],
      sources:     [{ ingredientId: 'i1', scrapId: 's1', extractedAt: 't' }],
      ingredients: [{ id: 'i1', type: 'character', name: 'A', createdAt: 't', updatedAt: 't' }],
      scraps:      [{ id: 's1', rawText: 'x', createdAt: 't', updatedAt: 't' }],
      tags:        [{ id: 'cat-tag-noir', label: 'Noir', createdAt: 't', updatedAt: 't' }],
    });

    // Tags land FIRST (canonical rows present before the ingredient tag arrays
    // reference them); relations land last so both FK ends are present from the
    // ingredient upserts.
    expect(order).toEqual(['tag', 'scrap', 'ingredient', 'source', 'ref', 'relation']);
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
    catalogDB.getRelationChangesSince.mockResolvedValue({ items: [], hasMore: false });
    catalogDB.getTagChangesSince.mockResolvedValue({ items: [], hasMore: false });
    catalogDB.getMediaChangesSince.mockResolvedValue({ items: [], hasMore: false });
  });

  it('accepts a scalar since and applies it uniformly to all seven kinds', async () => {
    await getChangesSince('42', 100);
    expect(catalogDB.getScrapChangesSince).toHaveBeenCalledWith('42', 100);
    expect(catalogDB.getIngredientChangesSince).toHaveBeenCalledWith('42', 100);
    expect(catalogDB.getSourceChangesSince).toHaveBeenCalledWith('42', 100);
    expect(catalogDB.getRefChangesSince).toHaveBeenCalledWith('42', 100);
    expect(catalogDB.getRelationChangesSince).toHaveBeenCalledWith('42', 100);
    expect(catalogDB.getTagChangesSince).toHaveBeenCalledWith('42', 100);
    expect(catalogDB.getMediaChangesSince).toHaveBeenCalledWith('42', 100);
  });

  it('accepts a per-kind cursor object', async () => {
    await getChangesSince({ scraps: '5', ingredients: '10', sources: '15', refs: '20', relations: '25', tags: '30', media: '35' }, 100);
    expect(catalogDB.getScrapChangesSince).toHaveBeenCalledWith('5', 100);
    expect(catalogDB.getIngredientChangesSince).toHaveBeenCalledWith('10', 100);
    expect(catalogDB.getSourceChangesSince).toHaveBeenCalledWith('15', 100);
    expect(catalogDB.getRefChangesSince).toHaveBeenCalledWith('20', 100);
    expect(catalogDB.getRelationChangesSince).toHaveBeenCalledWith('25', 100);
    expect(catalogDB.getTagChangesSince).toHaveBeenCalledWith('30', 100);
    expect(catalogDB.getMediaChangesSince).toHaveBeenCalledWith('35', 100);
  });

  it('rejects non-numeric cursor values, falling back to "0"', async () => {
    await getChangesSince({ scraps: '5', ingredients: 'NaN', sources: null, refs: undefined, relations: 'x', tags: 'y', media: 'z' }, 100);
    expect(catalogDB.getScrapChangesSince).toHaveBeenCalledWith('5', 100);
    expect(catalogDB.getIngredientChangesSince).toHaveBeenCalledWith('0', 100);
    expect(catalogDB.getSourceChangesSince).toHaveBeenCalledWith('0', 100);
    expect(catalogDB.getRefChangesSince).toHaveBeenCalledWith('0', 100);
    expect(catalogDB.getRelationChangesSince).toHaveBeenCalledWith('0', 100);
    expect(catalogDB.getTagChangesSince).toHaveBeenCalledWith('0', 100);
    expect(catalogDB.getMediaChangesSince).toHaveBeenCalledWith('0', 100);
  });

  it('per-kind maxSequence falls back to the inbound cursor on quiet kinds', async () => {
    catalogDB.getScrapChangesSince.mockResolvedValue({
      items: [{ id: 's2', syncSequence: '100' }],
      hasMore: false,
    });
    catalogDB.getIngredientChangesSince.mockResolvedValue({ items: [], hasMore: false });

    const res = await getChangesSince({ scraps: '50', ingredients: '99', sources: '88', refs: '77', relations: '66', tags: '55', media: '44' }, 100);

    // Quiet kinds reflect the inbound cursor — NOT 0 — so the next pull
    // doesn't move backward.
    expect(res.maxSequences.scraps).toBe('100');
    expect(res.maxSequences.ingredients).toBe('99');
    expect(res.maxSequences.sources).toBe('88');
    expect(res.maxSequences.refs).toBe('77');
    expect(res.maxSequences.relations).toBe('66');
    expect(res.maxSequences.tags).toBe('55');
    expect(res.maxSequences.media).toBe('44');
  });

  it('advances the media cursor to the last media row + hasMore when only media reports more', async () => {
    catalogDB.getMediaChangesSince.mockResolvedValue({
      items: [
        { ingredientId: 'i1', mediaKey: 'a.png', kind: 'portrait', syncSequence: '3' },
        { ingredientId: 'i1', mediaKey: 'b.png', kind: 'reference', syncSequence: '4' },
      ],
      hasMore: true,
    });
    const res = await getChangesSince({ scraps: '0', ingredients: '0', sources: '0', refs: '0', relations: '0', tags: '0', media: '0' }, 100);
    expect(res.media).toHaveLength(2);
    expect(res.maxSequences.media).toBe('4');
    expect(res.hasMore).toBe(true);
  });

  it('advances the tags cursor to the last tag row + hasMore when only tags report more', async () => {
    catalogDB.getTagChangesSince.mockResolvedValue({
      items: [
        { id: 'cat-tag-noir', label: 'Noir', syncSequence: '7' },
        { id: 'cat-tag-pulp', label: 'Pulp', syncSequence: '8' },
      ],
      hasMore: true,
    });
    const res = await getChangesSince({ scraps: '0', ingredients: '0', sources: '0', refs: '0', relations: '0', tags: '0' }, 100);
    expect(res.tags).toHaveLength(2);
    expect(res.maxSequences.tags).toBe('8');
    expect(res.hasMore).toBe(true);
  });

  it('advances the relations cursor to the last relation row', async () => {
    catalogDB.getRelationChangesSince.mockResolvedValue({
      items: [
        { fromId: 'a', toId: 'b', kind: 'lives-in', syncSequence: '10' },
        { fromId: 'a', toId: 'c', kind: 'references', syncSequence: '11' },
      ],
      hasMore: false,
    });
    const res = await getChangesSince({ scraps: '0', ingredients: '0', sources: '0', refs: '0', relations: '0' }, 100);
    expect(res.relations).toHaveLength(2);
    expect(res.maxSequences.relations).toBe('11');
  });

  it('hasMore is true when ONLY relations reports more', async () => {
    catalogDB.getRelationChangesSince.mockResolvedValue({ items: [], hasMore: true });
    const res = await getChangesSince('0', 100);
    expect(res.hasMore).toBe(true);
  });

  it('hasMore is true when ANY kind reports more', async () => {
    catalogDB.getSourceChangesSince.mockResolvedValue({ items: [], hasMore: true });
    const res = await getChangesSince('0', 100);
    expect(res.hasMore).toBe(true);
  });
});

describe('countAppliedFromStats', () => {
  it('sums inserts/updates (LWW kinds) + applied (tuple kinds) across every kind', () => {
    const total = countAppliedFromStats({
      scraps: { inserted: 1, updated: 2 },
      ingredients: { inserted: 3, updated: 4 },
      sources: { applied: 5 },
      refs: { applied: 6 },
      relations: { applied: 7 },
      tags: { inserted: 8, updated: 9 },
      media: { applied: 10 },
    });
    expect(total).toBe(55);
  });

  it('treats missing kinds / fields as zero and tolerates an empty object', () => {
    expect(countAppliedFromStats({})).toBe(0);
    expect(countAppliedFromStats()).toBe(0);
    expect(countAppliedFromStats({ ingredients: { inserted: 2 } })).toBe(2);
  });

  it('does NOT count skipped / failed rows', () => {
    expect(countAppliedFromStats({
      ingredients: { inserted: 1, updated: 0, skipped: 9, failed: 4 },
    })).toBe(1);
  });
});

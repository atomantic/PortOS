/**
 * Unit tests for the BATCHED canon→catalog projection (#3941).
 *
 * `projectToCatalog` used to issue one `getIngredient` per embedded canon entry
 * before deciding whether to write — N single-row SELECTs inside the
 * synchronous `updateUniverse` request. It now issues ONE
 * `getIngredientTimestamps` lookup for every candidate id and writes only the
 * rows the LWW comparison says are stale.
 *
 * `catalogDB` is mocked wholesale (no Postgres): the assertions are the query
 * COUNT + shape and that the skip/write accounting is byte-identical to the
 * per-entry version. The live-DB round-trip (loop break, exactly-once writes)
 * stays in `catalogCanonProjection.test.js`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./catalogDB.js', () => ({
  getIngredient: vi.fn(),
  getIngredientTimestamps: vi.fn(),
  updateIngredient: vi.fn(async () => ({})),
  listRefsForIngredient: vi.fn(async () => []),
}));

const catalogDB = await import('./catalogDB.js');
const { projectToCatalog } = await import('./catalogCanonProjection.js');

const ROW_AT = '2026-02-01T00:00:00.000Z';
const NEWER = '2026-03-01T00:00:00.000Z';
const OLDER = '2026-01-01T00:00:00.000Z';

// An embedded canon entry: the full bible payload plus the catalog backlink.
const entry = (ingredientId, { name = 'Example Character', updatedAt = NEWER, ...rest } = {}) => ({
  id: `entry-${ingredientId}`,
  ingredientId,
  name,
  updatedAt,
  createdAt: OLDER,
  schemaVersion: 3,
  ...rest,
});

const timestampMap = (pairs) => new Map(pairs);

beforeEach(() => {
  vi.clearAllMocks();
  catalogDB.updateIngredient.mockResolvedValue({});
});

describe('projectToCatalog batching', () => {
  it('issues ONE timestamp lookup for every canon array and no per-entry getIngredient', async () => {
    catalogDB.getIngredientTimestamps.mockResolvedValue(timestampMap([
      ['ing-c1', ROW_AT], ['ing-c2', ROW_AT], ['ing-p1', ROW_AT], ['ing-o1', ROW_AT],
    ]));

    const stats = await projectToCatalog('universe-1', {
      characters: [entry('ing-c1'), entry('ing-c2')],
      places: [entry('ing-p1')],
      objects: [entry('ing-o1')],
    });

    expect(catalogDB.getIngredient).not.toHaveBeenCalled();
    expect(catalogDB.getIngredientTimestamps).toHaveBeenCalledTimes(1);
    expect(catalogDB.getIngredientTimestamps).toHaveBeenCalledWith(['ing-c1', 'ing-c2', 'ing-p1', 'ing-o1']);
    expect(catalogDB.updateIngredient).toHaveBeenCalledTimes(4);
    expect(stats).toEqual({ written: 4, skipped: 0 });
  });

  it('writes the stripped payload with the sync source, exactly as the per-entry version did', async () => {
    catalogDB.getIngredientTimestamps.mockResolvedValue(timestampMap([['ing-c1', ROW_AT]]));

    await projectToCatalog('universe-1', {
      characters: [entry('ing-c1', { name: 'Renamed', role: 'Hero', tagline: 'Fake tagline' })],
    });

    expect(catalogDB.updateIngredient).toHaveBeenCalledWith(
      'ing-c1',
      { name: 'Renamed', payload: { role: 'Hero', tagline: 'Fake tagline' } },
      { source: 'sync', actor: 'canon-projection' },
    );
  });

  it('keeps LWW: an embedded entry OLDER than its row is skipped, equal timestamps still write', async () => {
    catalogDB.getIngredientTimestamps.mockResolvedValue(timestampMap([
      ['ing-stale', ROW_AT], ['ing-equal', ROW_AT], ['ing-fresh', ROW_AT],
    ]));

    const stats = await projectToCatalog('universe-1', {
      characters: [
        entry('ing-stale', { updatedAt: OLDER }),
        entry('ing-equal', { updatedAt: ROW_AT }),
        entry('ing-fresh', { updatedAt: NEWER }),
      ],
    });

    expect(catalogDB.updateIngredient.mock.calls.map(([id]) => id)).toEqual(['ing-equal', 'ing-fresh']);
    expect(stats).toEqual({ written: 2, skipped: 1 });
  });

  it('skips an id the batch returned no row for (deleted / never existed)', async () => {
    catalogDB.getIngredientTimestamps.mockResolvedValue(timestampMap([['ing-live', ROW_AT]]));

    const stats = await projectToCatalog('universe-1', {
      characters: [entry('ing-live'), entry('ing-gone')],
    });

    expect(catalogDB.updateIngredient).toHaveBeenCalledTimes(1);
    expect(catalogDB.updateIngredient).toHaveBeenCalledWith('ing-live', expect.anything(), expect.anything());
    expect(stats).toEqual({ written: 1, skipped: 1 });
  });

  it('excludes the guarded ingredient from the batch entirely (loop break)', async () => {
    catalogDB.getIngredientTimestamps.mockResolvedValue(timestampMap([['ing-other', ROW_AT]]));

    const stats = await projectToCatalog('universe-1', {
      characters: [entry('ing-guarded'), entry('ing-other')],
    }, { guardToken: 'ing-guarded' });

    expect(catalogDB.getIngredientTimestamps).toHaveBeenCalledWith(['ing-other']);
    expect(stats).toEqual({ written: 1, skipped: 1 });
  });

  it('queries nothing when no entry carries an ingredientId', async () => {
    const stats = await projectToCatalog('universe-1', {
      characters: [{ id: 'e1', name: 'Unlinked' }],
      places: [],
    });

    expect(catalogDB.getIngredientTimestamps).not.toHaveBeenCalled();
    expect(catalogDB.updateIngredient).not.toHaveBeenCalled();
    expect(stats).toEqual({ written: 0, skipped: 0 });
  });

  it('counts every candidate as skipped when the batched lookup itself fails', async () => {
    catalogDB.getIngredientTimestamps.mockRejectedValue(new Error('connection reset'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const stats = await projectToCatalog('universe-1', {
      characters: [entry('ing-c1'), entry('ing-c2')],
    });

    expect(catalogDB.updateIngredient).not.toHaveBeenCalled();
    expect(stats).toEqual({ written: 0, skipped: 2 });
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('keeps a single failing write best-effort — the remaining entries still project', async () => {
    catalogDB.getIngredientTimestamps.mockResolvedValue(timestampMap([['ing-bad', ROW_AT], ['ing-ok', ROW_AT]]));
    catalogDB.updateIngredient.mockImplementation(async (id) => {
      if (id === 'ing-bad') throw new Error('constraint violation');
      return {};
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const stats = await projectToCatalog('universe-1', {
      characters: [entry('ing-bad'), entry('ing-ok')],
    });

    expect(stats).toEqual({ written: 1, skipped: 1 });
    errSpy.mockRestore();
  });

  it('returns an empty stat block for a non-object canonArrays', async () => {
    expect(await projectToCatalog('universe-1', null)).toEqual({ written: 0, skipped: 0 });
    expect(catalogDB.getIngredientTimestamps).not.toHaveBeenCalled();
  });
});

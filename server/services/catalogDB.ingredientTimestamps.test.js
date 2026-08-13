/**
 * Unit tests for `getIngredientTimestamps` (#3941) — the batched freshness
 * lookup the canon→catalog projection uses instead of N `getIngredient` calls.
 *
 * Postgres is mocked: the assertions are the SQL shape (one `= ANY($1)` query,
 * live rows only, two columns) and the sentinel contract — a MISSING map key
 * means "no live row", never "row with no timestamp".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
const ROWS = [
  { id: 'ing-1', updated_at: new Date('2026-02-01T00:00:00Z') },
  { id: 'ing-2', updated_at: new Date('2026-03-02T03:04:05Z') },
];

vi.mock('../lib/db.js', () => ({
  query: vi.fn(async (sql, params) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: flat, params });
    return { rows: ROWS.filter((r) => params[0].includes(r.id)) };
  }),
  withTransaction: vi.fn(),
  pgvectorToArray: vi.fn(() => null),
  arrayToPgvector: vi.fn(),
}));

// instances.getInstanceId is pulled in transitively by catalogDB — stub it.
vi.mock('./instances.js', () => ({ getInstanceId: vi.fn(async () => 'inst-1') }));

const catalogDB = await import('./catalogDB.js');

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
});

describe('getIngredientTimestamps (#3941)', () => {
  it('resolves N ids in ONE live-rows-only query and returns ISO strings', async () => {
    const map = await catalogDB.getIngredientTimestamps(['ing-1', 'ing-2']);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe(
      'SELECT id, updated_at FROM catalog_ingredients WHERE id = ANY($1) AND deleted = false',
    );
    expect(calls[0].params).toEqual([['ing-1', 'ing-2']]);
    expect(map.get('ing-1')).toBe('2026-02-01T00:00:00.000Z');
    expect(map.get('ing-2')).toBe('2026-03-02T03:04:05.000Z');
  });

  it('de-duplicates ids and drops falsy ones before querying', async () => {
    await catalogDB.getIngredientTimestamps(['ing-1', 'ing-1', null, undefined, '', 'ing-2']);
    expect(calls[0].params).toEqual([['ing-1', 'ing-2']]);
  });

  it('omits ids with no live row rather than mapping them to a null timestamp', async () => {
    const map = await catalogDB.getIngredientTimestamps(['ing-1', 'ing-missing']);
    expect(map.has('ing-missing')).toBe(false);
    expect(map.size).toBe(1);
  });

  it('short-circuits an empty / undefined id list without touching the database', async () => {
    expect(await catalogDB.getIngredientTimestamps([])).toEqual(new Map());
    expect(await catalogDB.getIngredientTimestamps()).toEqual(new Map());
    expect(await catalogDB.getIngredientTimestamps([null])).toEqual(new Map());
    expect(calls).toHaveLength(0);
  });
});

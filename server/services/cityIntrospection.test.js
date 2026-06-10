/**
 * Tests for the Data Harbor introspection service: DB section shape (including
 * the down-DB → `db: null` absent-vs-empty contract), the data/ domain section
 * (delegated to dataManager's getDataOverview so the harbor and the Data page
 * always agree), and the TTL + stale-while-revalidate cache discipline.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock, overviewMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  overviewMock: vi.fn(),
}));
vi.mock('../lib/db.js', () => ({ query: queryMock }));
vi.mock('./dataManager.js', () => ({ getDataOverview: overviewMock }));

const {
  getCityIntrospection,
  resetIntrospectionCache,
  INTROSPECTION_TTL_MS,
} = await import('./cityIntrospection.js');

const TABLE_ROWS = [
  { name: 'memories', row_estimate: '1200', total_bytes: '900000' },
  { name: 'catalog_scraps', row_estimate: '40', total_bytes: '50000' },
  { name: 'schema_migrations', row_estimate: '12', total_bytes: '8000' },
];

// Default happy-path query dispatcher, keyed on SQL shape.
const happyQueries = (sql) => {
  if (sql.includes('pg_stat_user_tables')) return { rows: TABLE_ROWS };
  if (sql.includes('information_schema.columns')) {
    return { rows: [{ table_name: 'memories' }, { table_name: 'catalog_scraps' }] };
  }
  if (sql.includes('pg_database_size')) return { rows: [{ bytes: '5000000' }] };
  if (sql.includes('schema_migrations')) {
    return { rows: [{ applied: 12, last_applied: '2026-06-01T00:00:00.000Z' }] };
  }
  throw new Error(`unexpected query: ${sql}`);
};

const happyOverview = () => ({
  totalSize: 3_100_800_000,
  dataDir: 'data',
  categories: [
    { key: 'images', path: 'data/images', size: 3_100_000_000, fileCount: 2400 },
    { key: 'brain', path: 'data/brain', size: 800_000, fileCount: 60 },
  ],
});

beforeEach(() => {
  resetIntrospectionCache();
  vi.restoreAllMocks();
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql) => happyQueries(sql));
  overviewMock.mockReset();
  overviewMock.mockResolvedValue(happyOverview());
});

describe('getCityIntrospection — db section', () => {
  it('maps tables with coerced numbers, embedding flags, size, and migrations', async () => {
    const result = await getCityIntrospection();
    expect(result.ts).toBeTruthy();
    expect(result.db.sizeBytes).toBe(5000000);
    expect(result.db.tables).toHaveLength(3);
    const memories = result.db.tables.find((t) => t.name === 'memories');
    expect(memories).toEqual({
      name: 'memories', rowEstimate: 1200, totalBytes: 900000, hasEmbedding: true,
    });
    const migrationsTable = result.db.tables.find((t) => t.name === 'schema_migrations');
    expect(migrationsTable.hasEmbedding).toBe(false);
    expect(result.db.migrations).toEqual({ applied: 12, lastApplied: '2026-06-01T00:00:00.000Z' });
  });

  it('returns db: null (absent, not empty) when the table query fails', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (sql.includes('pg_stat_user_tables')) throw new Error('connection refused');
      return happyQueries(sql);
    });
    const result = await getCityIntrospection();
    expect(result.db).toBeNull();
    // The filesystem section is independent of DB health.
    expect(result.fs.domains.length).toBeGreaterThan(0);
  });

  it('tolerates enrichment failures without sinking the section', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (sql.includes('schema_migrations')) throw new Error('relation does not exist');
      if (sql.includes('pg_database_size')) throw new Error('nope');
      if (sql.includes('information_schema.columns')) throw new Error('nope');
      return happyQueries(sql);
    });
    const result = await getCityIntrospection();
    expect(result.db.tables).toHaveLength(3);
    expect(result.db.migrations).toBeNull();
    expect(result.db.sizeBytes).toBeNull();
    expect(result.db.tables.every((t) => t.hasEmbedding === false)).toBe(true);
  });
});

describe('getCityIntrospection — fs section', () => {
  it('maps the data overview into harbor domains + totals', async () => {
    const { fs } = await getCityIntrospection();
    expect(fs.domains).toEqual([
      { name: 'images', bytes: 3_100_000_000, files: 2400 },
      { name: 'brain', bytes: 800_000, files: 60 },
    ]);
    expect(fs.totalBytes).toBe(3_100_800_000);
    expect(fs.totalFiles).toBe(2460);
  });

  it('returns fs: null (absent) when the overview fails, keeping the db section', async () => {
    overviewMock.mockRejectedValue(new Error('du exploded'));
    const result = await getCityIntrospection();
    expect(result.fs).toBeNull();
    expect(result.db.tables).toHaveLength(3);
  });
});

describe('getCityIntrospection — cache discipline', () => {
  it('serves the cached payload within the TTL without re-querying', async () => {
    const first = await getCityIntrospection();
    const callsAfterFirst = queryMock.mock.calls.length;
    const second = await getCityIntrospection();
    expect(second).toBe(first);
    expect(queryMock.mock.calls.length).toBe(callsAfterFirst);
    expect(overviewMock).toHaveBeenCalledTimes(1);
  });

  it('serves stale immediately past the TTL while revalidating in the background', async () => {
    const first = await getCityIntrospection();
    // Jump past the TTL without fake timers — the background rebuild does real
    // async work that fake timers can't flush.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + INTROSPECTION_TTL_MS + 1000);

    // Make the rebuild distinguishable.
    queryMock.mockImplementation(async (sql) => {
      if (sql.includes('pg_database_size')) return { rows: [{ bytes: '777' }] };
      return happyQueries(sql);
    });

    const stale = await getCityIntrospection();
    expect(stale).toBe(first); // immediate stale answer, no blocking on the rebuild

    // Once the background rebuild settles, the fresh payload is served.
    await vi.waitFor(async () => {
      expect((await getCityIntrospection()).db.sizeBytes).toBe(777);
    });
    vi.restoreAllMocks();
  });
});

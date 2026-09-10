import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  query: vi.fn(), release: vi.fn(), connect: vi.fn(),
}));
vi.mock('pg', () => ({ default: { Pool: class {
  on() {}
  connect = state.connect;
} } }));
vi.mock('./db/schema/index.js', () => ({
  buildUpgradeDdl: () => ['upgrade schema'],
  buildCatalogDdl: () => ['repair catalog'],
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.query.mockImplementation(async () => ({ rows: [{ locked: true }] }));
  state.connect.mockResolvedValue({ query: state.query, release: state.release });
});

describe('schema readiness across store startup', () => {
  it('shares concurrent initialization and skips DDL for later store warms', async () => {
    const { ensureSchema } = await import('./db.js');
    await Promise.all([ensureSchema(), ensureSchema()]);
    await ensureSchema();
    expect(state.connect).toHaveBeenCalledTimes(1);
    expect(state.query.mock.calls.map(([sql]) => sql)).toEqual([
      'SELECT pg_try_advisory_lock($1) AS locked', 'upgrade schema',
      'repair catalog', 'SELECT pg_advisory_unlock($1)',
    ]);
    expect(state.release).toHaveBeenCalledWith(false);
  });

  it('allows forced repair and retries after its failure without caching partial work', async () => {
    const { ensureSchema } = await import('./db.js');
    await ensureSchema();
    state.query.mockImplementation(async sql => {
      if (sql === 'repair catalog') throw new Error('catalog repair failed');
      return { rows: [{ locked: true }] };
    });
    await expect(ensureSchema({ force: true })).rejects.toThrow('catalog repair failed');
    expect(state.query).toHaveBeenLastCalledWith('SELECT pg_advisory_unlock($1)', expect.any(Array));
    state.query.mockImplementation(async () => ({ rows: [{ locked: true }] }));
    await ensureSchema();
    await ensureSchema();
    expect(state.connect).toHaveBeenCalledTimes(3);
  });
});

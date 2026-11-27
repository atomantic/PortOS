import { afterEach, describe, expect, it, vi } from 'vitest';
import { query } from './db.js';
import { createJsonbLeafDb } from './jsonbLeafDb.js';

vi.mock('./db.js', () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) }));

afterEach(() => vi.useRealTimers());

describe('createJsonbLeafDb', () => {
  it.each([
    { table: 'bad-name' },
    { table: 'schema.records' },
    { table: 'records\n' },
    { table: 'a'.repeat(64) },
    { orderBy: [['created_at DESC', 'ASC']] },
    { orderBy: [['created_at', 'asc nulls first']] },
    { mirrorColumns: { 'bad-name': () => null } },
    { mirrorColumns: { created_at: () => null } },
    { mirrorColumns: { summary: { jsonb: true } } },
  ])('rejects invalid SQL configuration %# before querying', invalid => {
    expect(() => createJsonbLeafDb({ table: 'example_records', ...invalid })).toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('queries raw JSONB and ids with the configured deletion default and list order', async () => {
    const db = createJsonbLeafDb({
      table: 'example_records',
      orderBy: [['updated_at', 'DESC'], ['id', 'ASC']],
      softDelete: { includeDeletedByDefault: false },
    });
    const record = { id: 'example', extra: { field: true } };
    query.mockResolvedValueOnce({ rows: [{ data: record }] });
    expect(await db.readRaw(record.id)).toBe(record);
    expect(await db.readRaw('missing', { includeDeleted: true })).toBeNull();
    query.mockResolvedValueOnce({ rows: [{ data: record }] });
    expect(await db.listRaw()).toEqual([record]);
    await db.listRaw({ includeDeleted: true });
    query.mockResolvedValueOnce({ rows: [{ id: record.id }] });
    expect(await db.listIds()).toEqual([record.id]);
    await db.listIds({ includeDeleted: true });
    await db.listLiveIds();
    query.mockResolvedValueOnce({ rows: [{ id: 'old' }] });
    expect(await db.listTombstoneIdsBefore(Date.parse('2026-02-01'))).toEqual(['old']);
    await db.deleteRaw(record.id);
    expect(query.mock.calls).toEqual([
      ['SELECT data FROM example_records WHERE id = $1 AND deleted = FALSE', [record.id]],
      ['SELECT data FROM example_records WHERE id = $1', ['missing']],
      ['SELECT data FROM example_records WHERE deleted = FALSE ORDER BY updated_at DESC, id ASC'],
      ['SELECT data FROM example_records ORDER BY updated_at DESC, id ASC'],
      ['SELECT id FROM example_records WHERE deleted = FALSE'],
      ['SELECT id FROM example_records'],
      ['SELECT id FROM example_records WHERE deleted = FALSE'],
      ['SELECT id FROM example_records WHERE deleted = TRUE AND deleted_at IS NOT NULL AND deleted_at < $1', ['2026-02-01T00:00:00.000Z']],
      ['DELETE FROM example_records WHERE id = $1', [record.id]],
    ]);
  });

  it('uses the given transaction client for reads and upserts with typed and JSONB mirrors', async () => {
    const db = createJsonbLeafDb({
      table: 'example_records',
      softDelete: {},
      mirrorColumns: {
        name: record => record.name,
        list_summary: { jsonb: record => ({ name: record.name }) },
      },
    });
    const record = {
      name: 'Example\0',
      createdAt: '2026-01-01',
      updatedAt: 'malformed',
      deleted: true,
      deletedAt: 'malformed',
    };
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ data: record }] }) };
    expect(await db.readRaw('example', { client })).toBe(record);
    expect(await db.writeRaw('example', record, { client })).toBe(record);
    expect(client.query).toHaveBeenCalledWith('SELECT data FROM example_records WHERE id = $1', ['example']);
    const [sql, params] = client.query.mock.calls[1];
    expect(sql.replace(/\s+/g, ' ')).toBe(
      'INSERT INTO example_records (id, data, created_at, updated_at, name, list_summary, deleted, deleted_at) '
      + 'VALUES ($1, $2::jsonb, $3, $4, $5, $6::jsonb, $7, $8) '
      + 'ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at, '
      + 'name = EXCLUDED.name, list_summary = EXCLUDED.list_summary, deleted = EXCLUDED.deleted, deleted_at = EXCLUDED.deleted_at',
    );
    expect(params).toEqual([
      'example', JSON.stringify({ ...record, name: 'Example�' }),
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      'Example\0', '{"name":"Example�"}', true, null,
    ]);
    expect(query).not.toHaveBeenCalled();
  });

  it('can backfill a missing deleted timestamp only for tombstones', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-02-01'));
    const db = createJsonbLeafDb({ table: 'example_records', softDelete: { fillDeletedAt: true } });
    await db.writeRaw('dead', { deleted: true });
    await db.writeRaw('live', { deletedAt: '2026-01-01' });
    expect(query.mock.calls.map(([, params]) => params.slice(4))).toEqual([
      [true, '2026-02-01T00:00:00.000Z'],
      [false, null],
    ]);
  });

  it('uses hard deletion and no tombstone columns when soft deletion is disabled', async () => {
    const db = createJsonbLeafDb({ table: 'example_records' });
    const record = { createdAt: '2026-01-01', deleted: true };
    await db.listIds({ includeDeleted: false });
    await db.writeRaw('example', record);
    await db.deleteRaw('example');
    expect(Object.keys(db)).toEqual(['readRaw', 'listRaw', 'listIds', 'writeRaw', 'deleteRaw']);
    expect(query.mock.calls).toEqual([
      ['SELECT id FROM example_records'],
      [expect.stringMatching(/INSERT INTO example_records \(id, data, created_at, updated_at\)/),
        ['example', JSON.stringify(record), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']],
      ['DELETE FROM example_records WHERE id = $1', ['example']],
    ]);
  });
});

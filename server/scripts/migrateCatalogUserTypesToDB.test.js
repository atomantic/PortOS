/**
 * Unit tests for the settings.catalogUserTypes → catalog_user_types importer
 * (#1001). Pure — the DB `query` and the settings service are mocked, so the
 * suite asserts the import semantics (verbatim copy, ON CONFLICT idempotency,
 * key rename-aside, crash-before-rename retry) without Postgres or disk.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let store = {};
const inserted = [];
let insertRowCount = 1;

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ ...store })),
  updateSettingsWith: vi.fn(async (mutate) => { store = await mutate({ ...store }); return store; }),
}));
vi.mock('../lib/db.js', () => ({
  query: vi.fn(async (_sql, params) => {
    inserted.push(params);
    return { rowCount: insertRowCount };
  }),
}));

const { migrateCatalogUserTypesToDB } = await import('./migrateCatalogUserTypesToDB.js');

beforeEach(() => {
  store = {};
  inserted.length = 0;
  insertRowCount = 1;
});

describe('migrateCatalogUserTypesToDB', () => {
  it('no-ops on a fresh install (no legacy key)', async () => {
    const res = await migrateCatalogUserTypesToDB();
    expect(res).toMatchObject({ ok: true, reason: 'already-applied', imported: 0 });
    expect(inserted).toHaveLength(0);
    expect(store.catalogUserTypes_imported).toBeUndefined();
  });

  it('imports each legacy type verbatim and renames the key aside', async () => {
    store = { catalogUserTypes: [
      { id: 'faction', label: 'Faction', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'guild', label: 'Guild' },
    ] };
    const res = await migrateCatalogUserTypesToDB();
    expect(res).toMatchObject({ ok: true, reason: 'imported', imported: 2 });
    expect(inserted).toHaveLength(2);
    // First param of each INSERT is the id, second is the verbatim JSON.
    expect(inserted.map((p) => p[0])).toEqual(['faction', 'guild']);
    expect(JSON.parse(inserted[0][1])).toMatchObject({ id: 'faction', label: 'Faction' });
    // Live key gone, recovery key holds the original slice.
    expect(store.catalogUserTypes).toBeUndefined();
    expect(store.catalogUserTypes_imported).toHaveLength(2);
  });

  it('is idempotent on re-run: the renamed key means a second call no-ops', async () => {
    store = { catalogUserTypes: [{ id: 'faction', label: 'Faction' }] };
    await migrateCatalogUserTypesToDB();
    inserted.length = 0;
    const res = await migrateCatalogUserTypesToDB();
    expect(res.reason).toBe('already-applied');
    expect(inserted).toHaveLength(0);
  });

  it('skips structurally-invalid entries but still imports the good ones', async () => {
    store = { catalogUserTypes: [{ id: 'ok', label: 'OK' }, { label: 'no id' }, null, { id: '' }] };
    const res = await migrateCatalogUserTypesToDB();
    expect(res.imported).toBe(1);
    expect(res.skipped).toBe(3);
    expect(inserted.map((p) => p[0])).toEqual(['ok']);
  });

  it('counts an ON CONFLICT no-op (rowCount 0) as skipped, not imported', async () => {
    insertRowCount = 0; // row already in the table
    store = { catalogUserTypes: [{ id: 'faction', label: 'Faction' }] };
    const res = await migrateCatalogUserTypesToDB();
    expect(res.imported).toBe(0);
    expect(res.skipped).toBe(1);
    // Still renames the key aside — the rows are present in the table.
    expect(store.catalogUserTypes_imported).toHaveLength(1);
  });

  it('does NOT clobber an existing recovery copy when a legacy key is re-introduced', async () => {
    // Migration already ran once: original recovery copy parked.
    store = { catalogUserTypes_imported: [{ id: 'original', label: 'Original' }] };
    // A restore bundle / hand-edit re-introduces the live key post-migration.
    store.catalogUserTypes = [{ id: 'reintroduced', label: 'Reintroduced' }];
    const res = await migrateCatalogUserTypesToDB();
    expect(res.reason).toBe('imported');
    // Live key dropped, but the ORIGINAL recovery copy is preserved (not
    // overwritten by the reintroduced slice).
    expect(store.catalogUserTypes).toBeUndefined();
    expect(store.catalogUserTypes_imported).toEqual([{ id: 'original', label: 'Original' }]);
  });

  it('renames aside a non-array legacy value without importing', async () => {
    store = { catalogUserTypes: { hand: 'edited' } };
    const res = await migrateCatalogUserTypesToDB();
    expect(res).toMatchObject({ ok: false, reason: 'not-an-array', imported: 0 });
    expect(inserted).toHaveLength(0);
    expect(store.catalogUserTypes).toBeUndefined();
    expect(store.catalogUserTypes_imported).toEqual({ hand: 'edited' });
  });
});

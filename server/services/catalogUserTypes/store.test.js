/**
 * Backend-dispatcher tests for the catalog user-type store (#1001).
 *
 * Under NODE_ENV=test the store selects the FILE backend (settings.json via the
 * settings service), so this suite asserts the dispatcher routes read/write to
 * the settings slice exactly as the routes/sync did inline before #1001 — the
 * back-compat guarantee that keeps the existing test suites green. settings is
 * mocked, so no disk/Postgres is touched.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let store = {};
vi.mock('../settings.js', () => ({
  getSettings: vi.fn(async () => ({ ...store })),
  updateSettings: vi.fn(async (patch) => { store = { ...store, ...patch }; return { ...store }; }),
}));

const { readUserTypes, writeUserTypes, getCatalogUserTypesBackendName, _resetCatalogUserTypesBackend } =
  await import('./store.js');

beforeEach(() => {
  store = {};
  _resetCatalogUserTypesBackend();
});

describe('catalog user-type store — file backend (test/escape-hatch)', () => {
  it('selects the file backend under NODE_ENV=test', async () => {
    await readUserTypes();
    expect(getCatalogUserTypesBackendName()).toBe('file');
  });

  it('reads the catalogUserTypes slice from settings (absent → [])', async () => {
    expect(await readUserTypes()).toEqual([]);
    store = { catalogUserTypes: [{ id: 'faction', label: 'Faction' }] };
    expect(await readUserTypes()).toEqual([{ id: 'faction', label: 'Faction' }]);
  });

  it('tolerates a non-array slice (junk → [])', async () => {
    store = { catalogUserTypes: { not: 'an array' } };
    expect(await readUserTypes()).toEqual([]);
  });

  it('writes the whole slice back into settings.catalogUserTypes', async () => {
    await writeUserTypes([{ id: 'a' }, { id: 'b' }]);
    expect(store.catalogUserTypes).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('a null/non-array write persists an empty slice', async () => {
    store = { catalogUserTypes: [{ id: 'a' }] };
    await writeUserTypes(null);
    expect(store.catalogUserTypes).toEqual([]);
  });
});

describe('updateUserTypes — serialized read-modify-write (#9132)', () => {
  it('a route-style edit and a peer-sync merge running concurrently both survive', async () => {
    const { updateUserTypes } = await import('./store.js');
    store = { catalogUserTypes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
    let releaseFirst;
    const gate = new Promise((r) => { releaseFirst = r; });
    // First writer (PATCH-like) stalls after reading; the second (peer tombstone
    // + new type) is queued behind it and must observe the first's write.
    const first = updateUserTypes(async (cur) => {
      await gate;
      return cur.map((t) => (t.id === 'a' ? { ...t, label: 'A2' } : t));
    });
    const second = updateUserTypes((cur) => [
      ...cur.map((t) => (t.id === 'b' ? { ...t, deletedAt: 'T' } : t)),
      { id: 'c', label: 'C' },
    ]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(store.catalogUserTypes).toEqual([
      { id: 'a', label: 'A2' },
      { id: 'b', label: 'B', deletedAt: 'T' },
      { id: 'c', label: 'C' },
    ]);
  });

  it('a throwing mutator writes nothing and does not wedge the queue', async () => {
    const { updateUserTypes } = await import('./store.js');
    store = { catalogUserTypes: [{ id: 'a' }] };
    await expect(updateUserTypes(() => { throw new Error('409'); })).rejects.toThrow('409');
    await updateUserTypes((cur) => [...cur, { id: 'z' }]);
    expect(store.catalogUserTypes).toEqual([{ id: 'a' }, { id: 'z' }]);
  });
});

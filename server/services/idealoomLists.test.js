import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

var tempRoot; // eslint-disable-line no-var
function getTempRoot() {
  if (!tempRoot) tempRoot = mkdtempSync(join(tmpdir(), 'idealoom-lists-test-'));
  return tempRoot;
}

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => getTempRoot() });
});

import * as lists from './idealoomLists.js';

afterAll(() => { if (tempRoot) rmSync(tempRoot, { recursive: true, force: true }); });

// A well-formed UUID that is never created, for the not-found paths.
const UNKNOWN_ID = 'a1f0c2d4-3b5e-4c7a-9d81-6e2f4b8c0a13';

const draft = {
  prompt: 'Find small practical improvements',
  title: 'Practical improvements',
  category: 'product',
  status: 'draft',
  ideas: ['Improve the empty state', 'Add a clear keyboard shortcut']
};

describe('IdeaLoom local lists', () => {
  it('stores ordered list records separately with local-only defaults', async () => {
    expect(await lists.getSettings()).toEqual({ enabled: false, obsidianVaultId: null, autoSync: false });

    const created = await lists.createList(draft);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.schemaVersion).toBe(1);
    expect(created.ideas).toEqual(draft.ideas);

    const updated = await lists.updateList(created.id, { ideas: [...draft.ideas, 'Keep items ordered'] });
    expect(updated.ideas).toEqual([...draft.ideas, 'Keep items ordered']);
    expect((await lists.listLists()).map(({ id }) => id)).toContain(created.id);
  });

  it('updates integration settings without requiring a vault', async () => {
    expect(await lists.updateSettings({ autoSync: true })).toEqual({ enabled: false, obsidianVaultId: null, autoSync: true });
  });

  it('reads a single list back by id and reports an unknown id as missing', async () => {
    const created = await lists.createList(draft);
    expect(await lists.getList(created.id)).toEqual(created);
    expect(await lists.getList(UNKNOWN_ID)).toBeNull();
  });

  it('deletes a list and reports whether anything was removed', async () => {
    const created = await lists.createList(draft);

    expect(await lists.deleteList(created.id)).toBe(true);
    expect(await lists.getList(created.id)).toBeNull();
    expect((await lists.listLists()).map(({ id }) => id)).not.toContain(created.id);

    // Idempotent: a second delete removed nothing, so the route answers 404
    // rather than a second 204. This is what a bare store.deleteOne() could not
    // report — it resolves to undefined whether or not the record existed.
    expect(await lists.deleteList(created.id)).toBe(false);
    expect(await lists.deleteList(UNKNOWN_ID)).toBe(false);
  });

  it('rejects a malformed id on every id-addressed operation', async () => {
    // The store would THROW on a non-UUID id; the service guards ahead of it so
    // the routes can answer 404 instead of surfacing a 500.
    for (const badId of ['not-a-uuid', '../escape', '__proto__']) {
      expect(await lists.getList(badId)).toBeNull();
      expect(await lists.updateList(badId, { title: 'Nope' })).toBeNull();
      expect(await lists.deleteList(badId)).toBe(false);
    }
  });
});

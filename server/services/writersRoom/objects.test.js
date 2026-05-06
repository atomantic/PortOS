import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tempRoot;

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'PATHS') return { ...actual.PATHS, data: tempRoot };
      return target[prop];
    },
  });
});

const local = await import('./local.js');
const objects = await import('./objects.js');
const { createWork } = local;
const {
  listObjects, createObject, updateObject, deleteObject,
  mergeExtractedObjects,
} = objects;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'wr-objects-test-'));
});

afterEach(() => {
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

async function newWork() {
  const w = await createWork({ title: 'Test Work', kind: 'short-story' });
  return w.id;
}

describe('writers room — objects CRUD', () => {
  it('starts with an empty bible', async () => {
    const id = await newWork();
    expect(await listObjects(id)).toEqual([]);
  });

  it('rejects path-traversal-shaped work ids', async () => {
    await expect(listObjects('../../etc')).rejects.toThrow(/work id/i);
    await expect(createObject('../../etc', { name: 'X' })).rejects.toThrow(/work id/i);
    await expect(mergeExtractedObjects('../../etc', [{ name: 'X' }])).rejects.toThrow(/work id/i);
  });

  it('rejects creating without a name', async () => {
    const id = await newWork();
    await expect(createObject(id, { name: '   ' })).rejects.toThrow(/name required/i);
  });

  it('rejects duplicate names (case-insensitive)', async () => {
    const id = await newWork();
    await createObject(id, { name: 'the letter', description: 'sealed' });
    await expect(createObject(id, { name: 'The Letter' })).rejects.toThrow(/already exists/i);
  });

  it('creates, updates, deletes', async () => {
    const id = await newWork();
    const o = await createObject(id, { name: 'the fedora', description: 'wide-brimmed' });
    expect(o.name).toBe('the fedora');
    expect(o.id).toMatch(/^wr-object-/);
    const upd = await updateObject(id, o.id, { significance: 'his father wore one' });
    expect(upd.significance).toBe('his father wore one');
    expect(upd.source).toBe('user');
    await deleteObject(id, o.id);
    expect(await listObjects(id)).toEqual([]);
  });
});

describe('writers room — objects merge', () => {
  it('inserts new ai-extracted objects', async () => {
    const id = await newWork();
    const merged = await mergeExtractedObjects(id, [
      { name: 'the letter', description: 'cream paper, blue ink', significance: 'unsent confession' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('ai');
    expect(merged[0].description).toBe('cream paper, blue ink');
  });

  it('preserves user edits — only fills blank fields', async () => {
    const id = await newWork();
    // User-created object with a manual description.
    const userOne = await createObject(id, {
      name: 'the locket',
      description: 'her grandmother\'s, silver',
    });
    // AI tries to "improve" the description — must be ignored.
    const merged = await mergeExtractedObjects(id, [
      { name: 'the locket', description: 'tarnished gold pendant', significance: 'family heirloom' },
    ]);
    const o = merged.find((x) => x.id === userOne.id);
    expect(o.description).toBe('her grandmother\'s, silver'); // user wins
    expect(o.significance).toBe('family heirloom'); // blank → filled
  });

  it('matches by alias to avoid duplicates across runs', async () => {
    const id = await newWork();
    await createObject(id, { name: 'the fedora', aliases: ['the hat'] });
    const merged = await mergeExtractedObjects(id, [
      { name: 'the hat', description: 'felt, dark grey' },
    ]);
    expect(merged).toHaveLength(1); // matched via alias, not duplicated
    expect(merged[0].name).toBe('the fedora');
    expect(merged[0].description).toBe('felt, dark grey');
  });
});

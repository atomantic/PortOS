/**
 * Test for migration 021 — link orphan "Universe: <name>" collections to
 * their universes by name match.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './021-link-orphan-universe-collections.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 021 — link orphan universe collections', () => {
  let rootDir;
  let dataDir;
  let collectionsPath;
  let universesPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-021-'));
    dataDir = join(rootDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    collectionsPath = join(dataDir, 'media-collections.json');
    universesPath = join(dataDir, 'universe-builder.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('links a single unlinked "Universe: <name>" collection to the matching universe', async () => {
    writeJson(universesPath, { universes: [{ id: 'u-1', name: 'Foo' }] });
    writeJson(collectionsPath, {
      collections: [
        { id: 'c-1', name: 'Universe: Foo', universeId: null, items: [] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.linked).toBe(1);
    const after = readJson(collectionsPath);
    expect(after.collections[0].universeId).toBe('u-1');
  });

  it('is idempotent — already-linked collections are skipped on re-run', async () => {
    writeJson(universesPath, { universes: [{ id: 'u-1', name: 'Foo' }] });
    writeJson(collectionsPath, {
      collections: [
        { id: 'c-1', name: 'Universe: Foo', universeId: 'u-1', items: [] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.linked).toBe(0);
  });

  it('skips ambiguous matches (two universes share the same display name)', async () => {
    writeJson(universesPath, {
      universes: [
        { id: 'u-A', name: 'Twin' },
        { id: 'u-B', name: 'Twin' },
      ],
    });
    writeJson(collectionsPath, {
      collections: [
        { id: 'c-1', name: 'Universe: Twin', universeId: null, items: [] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.linked).toBe(0);
    expect(result.ambiguous).toBe(1);
    const after = readJson(collectionsPath);
    expect(after.collections[0].universeId).toBeNull();
  });

  it('ignores collections whose name does not match the "Universe: <X>" pattern', async () => {
    writeJson(universesPath, { universes: [{ id: 'u-1', name: 'Foo' }] });
    writeJson(collectionsPath, {
      collections: [
        { id: 'c-1', name: 'My Custom Bucket', universeId: null, items: [] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.linked).toBe(0);
    const after = readJson(collectionsPath);
    expect(after.collections[0].universeId).toBeNull();
  });

  it('matches case-insensitively and tolerates surrounding whitespace', async () => {
    writeJson(universesPath, { universes: [{ id: 'u-1', name: '  bar  ' }] });
    writeJson(collectionsPath, {
      collections: [
        { id: 'c-1', name: 'universe: BAR', universeId: null, items: [] },
      ],
    });
    const result = await migration.up({ rootDir });
    expect(result.linked).toBe(1);
    const after = readJson(collectionsPath);
    expect(after.collections[0].universeId).toBe('u-1');
  });

  it('no-ops when the media-collections file does not exist', async () => {
    writeJson(universesPath, { universes: [{ id: 'u-1', name: 'Foo' }] });
    const result = await migration.up({ rootDir });
    expect(result.linked).toBe(0);
    expect(result.reason).toBe('no-collections');
  });

  it('no-ops when the universe-builder file does not exist', async () => {
    writeJson(collectionsPath, {
      collections: [{ id: 'c-1', name: 'Universe: Foo', universeId: null, items: [] }],
    });
    const result = await migration.up({ rootDir });
    expect(result.linked).toBe(0);
    expect(result.reason).toBe('no-universes');
  });
});

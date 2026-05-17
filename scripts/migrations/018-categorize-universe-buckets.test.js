/**
 * Test for migration 018 — categorize universe buckets + retire characters bucket.
 *
 * Vitest's `include` pattern (`**\/*.test.js`) only scans server/ and
 * client/src/. To get this picked up, server/vitest.config.js was extended
 * to also include `../scripts/migrations/**\/*.test.js`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './018-categorize-universe-buckets.js';

describe('migration 018 — categorize universe buckets', () => {
  let rootDir;
  let dataDir;
  let filePath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-018-'));
    dataDir = join(rootDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    filePath = join(dataDir, 'universe-builder.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const writeUniverses = (universes) => {
    writeFileSync(filePath, JSON.stringify({ universes, runs: [] }, null, 2));
  };
  const readUniverses = () => JSON.parse(readFileSync(filePath, 'utf-8')).universes;

  it('no-ops cleanly when universe-builder.json is missing', async () => {
    expect(existsSync(filePath)).toBe(false);
    await expect(migration.up({ rootDir })).resolves.not.toThrow();
    expect(existsSync(filePath)).toBe(false);
  });

  it('skips universes already at schema v4', async () => {
    writeUniverses([{
      id: 'already-migrated',
      name: 'Already',
      schemaVersion: 4,
      categories: { landscapes: { kind: 'settings', variations: [] } },
      characters: [],
    }]);
    const before = readFileSync(filePath, 'utf-8');
    await migration.up({ rootDir });
    const after = readFileSync(filePath, 'utf-8');
    expect(after).toBe(before); // bit-for-bit unchanged
  });

  it('folds categories.characters into universe.characters[] and drops the bucket', async () => {
    writeUniverses([{
      id: 'legacy',
      name: 'Legacy',
      schemaVersion: 3,
      categories: {
        landscapes: { variations: [{ label: 'Crystal Canyon', prompt: 'canyon' }] },
        characters: { variations: [
          { label: 'Ash', prompt: 'young survivor' },
          { label: 'Roan', prompt: 'weathered scavenger', locked: true },
        ] },
      },
      characters: [],
    }]);
    await migration.up({ rootDir });
    const [u] = readUniverses();
    expect(u.schemaVersion).toBe(4);
    expect(u.categories.characters).toBeUndefined();
    expect(u.categories.landscapes).toBeDefined();
    expect(u.characters.find((c) => c.name === 'Ash')).toBeDefined();
    const roan = u.characters.find((c) => c.name === 'Roan');
    expect(roan).toBeDefined();
    expect(roan.locked).toBe(true);
    expect(roan.source).toBe('universe-expand');
  });

  it('dedupes by canon name when folding the characters bucket', async () => {
    writeUniverses([{
      id: 'mixed',
      name: 'Mixed',
      schemaVersion: 3,
      categories: {
        characters: { variations: [{ label: 'Ash', prompt: 'from variation' }] },
      },
      // Hand-authored canon entry with richer metadata — must not be clobbered.
      characters: [{
        id: 'chr-existing', name: 'Ash',
        physicalDescription: 'hand-authored description',
        source: 'manual',
      }],
    }]);
    await migration.up({ rootDir });
    const [u] = readUniverses();
    expect(u.characters.filter((c) => c.name === 'Ash')).toHaveLength(1);
    expect(u.characters[0].source).toBe('manual'); // hand-authored preserved
  });

  it('assigns kind to built-in defaults and custom buckets', async () => {
    writeUniverses([{
      id: 'kinds',
      name: 'Kinds',
      schemaVersion: 3,
      categories: {
        landscapes: { variations: [] },
        environments: { variations: [] },
        structures: { variations: [] },
        vehicles: { variations: [] },
        factions: { variations: [{ label: 'Iron Reach', prompt: 'x' }] },
        colonies: { variations: [{ label: 'Tycho', prompt: 'y' }] },
      },
      characters: [],
    }]);
    await migration.up({ rootDir });
    const [u] = readUniverses();
    expect(u.categories.landscapes.kind).toBe('settings');
    expect(u.categories.environments.kind).toBe('settings');
    expect(u.categories.structures.kind).toBe('settings');
    expect(u.categories.vehicles.kind).toBe('objects');
    expect(u.categories.factions.kind).toBe('other');
    expect(u.categories.colonies.kind).toBe('other');
  });

  it('preserves an explicit valid `kind` over the built-in default', async () => {
    writeUniverses([{
      id: 'explicit-kind',
      name: 'Explicit',
      schemaVersion: 3,
      categories: {
        // Hand-authored kind that disagrees with the built-in default.
        landscapes: { kind: 'objects', variations: [] },
      },
      characters: [],
    }]);
    await migration.up({ rootDir });
    const [u] = readUniverses();
    expect(u.categories.landscapes.kind).toBe('objects');
  });

  it('is idempotent — running twice produces no further changes', async () => {
    writeUniverses([{
      id: 'idem',
      name: 'Idempotent',
      schemaVersion: 3,
      categories: {
        characters: { variations: [{ label: 'Ash', prompt: 'x' }] },
        landscapes: { variations: [] },
      },
      characters: [],
    }]);
    await migration.up({ rootDir });
    const afterFirst = readFileSync(filePath, 'utf-8');
    await migration.up({ rootDir });
    const afterSecond = readFileSync(filePath, 'utf-8');
    expect(afterSecond).toBe(afterFirst);
  });
});

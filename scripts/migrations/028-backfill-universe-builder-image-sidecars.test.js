/**
 * Test for migration 028 — backfill universe + entity metadata onto
 * pre-existing image sidecars.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './028-backfill-universe-builder-image-sidecars.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 028 — backfill universe builder image sidecars', () => {
  let rootDir;
  let dataDir;
  let imagesDir;
  let universesPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-028-'));
    dataDir = join(rootDir, 'data');
    imagesDir = join(dataDir, 'images');
    mkdirSync(imagesDir, { recursive: true });
    universesPath = join(dataDir, 'universe-builder.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function seedSidecar(filename, metadata) {
    writeJson(join(imagesDir, filename.replace(/\.png$/i, '.metadata.json')), metadata);
  }

  it('stamps universe + canon entity context onto referenced sidecars', async () => {
    writeJson(universesPath, {
      universes: [
        {
          id: 'u-1', name: 'TestVerse',
          characters: [
            { id: 'char-ash', name: 'Ash', imageRefs: ['ash-1.png', 'ash-2.png'] },
          ],
          places: [{ id: 'place-glen', name: 'Hollow Glen', imageRefs: ['glen-1.png'] }],
          objects: [],
        },
      ],
    });
    seedSidecar('ash-1.png', { id: 'ash-1', prompt: 'p1' });
    seedSidecar('ash-2.png', { id: 'ash-2', prompt: 'p2' });
    seedSidecar('glen-1.png', { id: 'glen-1', prompt: 'p3' });

    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(3);

    const ash1 = readJson(join(imagesDir, 'ash-1.metadata.json'));
    expect(ash1.universeId).toBe('u-1');
    expect(ash1.universeName).toBe('TestVerse');
    expect(ash1.entryKind).toBe('canon');
    expect(ash1.entryCategory).toBe('characters');
    expect(ash1.entryId).toBe('char-ash');
    expect(ash1.entryName).toBe('Ash');
    expect(ash1.prompt).toBe('p1'); // original field preserved

    const glen = readJson(join(imagesDir, 'glen-1.metadata.json'));
    expect(glen.entryName).toBe('Hollow Glen');
    expect(glen.entryCategory).toBe('places');
  });

  it('stamps category variations with their label as entryName', async () => {
    writeJson(universesPath, {
      universes: [
        {
          id: 'u-2', name: 'CatVerse',
          categories: {
            landscapes: {
              variations: [
                { id: 'var-foggy', label: 'Foggy moor at dusk', imageRefs: ['foggy.png'] },
              ],
            },
          },
        },
      ],
    });
    seedSidecar('foggy.png', { id: 'foggy', prompt: 'misty hills' });

    await migration.up({ rootDir });
    const sc = readJson(join(imagesDir, 'foggy.metadata.json'));
    expect(sc.entryKind).toBe('variation');
    expect(sc.entryCategory).toBe('landscapes');
    expect(sc.entryId).toBe('var-foggy');
    expect(sc.entryName).toBe('Foggy moor at dusk');
    expect(sc.entryLabel).toBe('Foggy moor at dusk');
  });

  it('stamps composite sheets (no category, entryName from label)', async () => {
    writeJson(universesPath, {
      universes: [
        {
          id: 'u-3', name: 'SheetVerse',
          compositeSheets: [
            { id: 'sheet-cast', label: 'Main cast lineup', imageRefs: ['cast.png'] },
          ],
        },
      ],
    });
    seedSidecar('cast.png', { id: 'cast', prompt: 'eight characters' });

    await migration.up({ rootDir });
    const sc = readJson(join(imagesDir, 'cast.metadata.json'));
    expect(sc.entryKind).toBe('sheet');
    expect(sc.entryId).toBe('sheet-cast');
    expect(sc.entryName).toBe('Main cast lineup');
    expect(sc.entryCategory).toBeUndefined();
  });

  it('is idempotent — re-running reports zero updates', async () => {
    writeJson(universesPath, {
      universes: [
        {
          id: 'u-4', name: 'IdemVerse',
          characters: [{ id: 'c1', name: 'Once', imageRefs: ['once.png'] }],
        },
      ],
    });
    seedSidecar('once.png', { id: 'once', prompt: 'p' });

    const first = await migration.up({ rootDir });
    expect(first.updated).toBe(1);

    const second = await migration.up({ rootDir });
    expect(second.updated).toBe(0);
    expect(second.alreadyTagged).toBe(1);
  });

  it('does not clobber an existing universe tag on the sidecar', async () => {
    writeJson(universesPath, {
      universes: [
        {
          id: 'u-new', name: 'NewVerse',
          characters: [{ id: 'c1', name: 'NewName', imageRefs: ['shared.png'] }],
        },
      ],
    });
    // Sidecar already carries a stamp from a different universe (e.g.
    // image was moved manually). Migration must NOT overwrite it.
    seedSidecar('shared.png', {
      id: 'shared',
      universeId: 'u-old',
      universeName: 'OldVerse',
      entryName: 'OldName',
    });

    await migration.up({ rootDir });
    const sc = readJson(join(imagesDir, 'shared.metadata.json'));
    expect(sc.universeId).toBe('u-old');
    expect(sc.universeName).toBe('OldVerse');
    expect(sc.entryName).toBe('OldName');
    // But absent fields still get filled in.
    expect(sc.entryKind).toBe('canon');
    expect(sc.entryId).toBe('c1');
  });

  it('skips orphaned imageRefs (no sidecar on disk)', async () => {
    writeJson(universesPath, {
      universes: [
        {
          id: 'u-5', name: 'OrphanVerse',
          characters: [
            { id: 'c1', name: 'Living', imageRefs: ['alive.png', 'deleted.png'] },
          ],
        },
      ],
    });
    seedSidecar('alive.png', { id: 'alive', prompt: 'p' });
    // deleted.png has no sidecar on disk.

    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    expect(result.missingSidecar).toBe(1);
    expect(existsSync(join(imagesDir, 'alive.metadata.json'))).toBe(true);
  });

  it('handles the alt sidecar naming convention (<filename>.metadata.json)', async () => {
    writeJson(universesPath, {
      universes: [
        {
          id: 'u-6', name: 'AltVerse',
          characters: [{ id: 'c1', name: 'Alt', imageRefs: ['alt.png'] }],
        },
      ],
    });
    // Alternate convention: <filename>.metadata.json (not <basename>.metadata.json).
    writeJson(join(imagesDir, 'alt.png.metadata.json'), { id: 'alt', prompt: 'p' });

    await migration.up({ rootDir });
    const sc = readJson(join(imagesDir, 'alt.png.metadata.json'));
    expect(sc.entryName).toBe('Alt');
  });

  it('no-ops when universe-builder.json does not exist', async () => {
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(0);
    expect(result.reason).toBe('no-universes');
  });
});

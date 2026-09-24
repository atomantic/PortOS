import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './022-rename-bible-setting-to-place.js';

let rootDir;
const workDir = () => join(rootDir, 'data/writers-room/works/example-work');
const legacyPath = () => join(workDir(), 'settings.json');
const placesPath = () => join(workDir(), 'places.json');
const exists = async (path) => stat(path).then(() => true, (error) => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'migration-022-'));
  await mkdir(workDir(), { recursive: true });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('migration 022 Writers Room settings', () => {
  it('fails without replacing or deleting malformed legacy bytes', async () => {
    const malformed = Buffer.from('{"settings":[{"id":"set-1"}', 'utf8');
    await writeFile(legacyPath(), malformed);

    await expect(migration.up({ rootDir })).rejects.toThrow(/settings\.json/);

    expect(await readFile(legacyPath())).toEqual(malformed);
    expect(await exists(placesPath())).toBe(false);
  });

  it('does not treat a valid JSON envelope without settings as an empty bible', async () => {
    const unexpected = Buffer.from('{"entries":[{"id":"set-1"}]}\n');
    await writeFile(legacyPath(), unexpected);

    await expect(migration.up({ rootDir })).rejects.toThrow(/missing settings array/);

    expect(await readFile(legacyPath())).toEqual(unexpected);
    expect(await exists(placesPath())).toBe(false);
  });

  it('converts valid settings while preserving entries and envelope metadata', async () => {
    const original = {
      settings: [{ id: 'set-1', name: 'Example Place', details: { weather: 'rain' } }],
      updatedAt: '2024-01-01T00:00:00.000Z',
      customField: { retained: true },
    };
    await writeFile(legacyPath(), JSON.stringify(original));

    await migration.up({ rootDir });

    expect(JSON.parse(await readFile(placesPath(), 'utf8'))).toEqual({
      places: original.settings,
      updatedAt: original.updatedAt,
      customField: original.customField,
    });
    expect(await exists(legacyPath())).toBe(false);
  });

  it('keeps existing places authoritative and retains the legacy bytes in a backup', async () => {
    const legacy = Buffer.from('{"settings":[{"id":"set-legacy"}]}\n');
    const places = Buffer.from('{"places":[{"id":"place-current"}]}\n');
    await writeFile(legacyPath(), legacy);
    await writeFile(placesPath(), places);

    await migration.up({ rootDir });

    expect(await readFile(placesPath())).toEqual(places);
    expect(await readFile(`${legacyPath()}.bak-022`)).toEqual(legacy);
    expect(await exists(legacyPath())).toBe(false);
  });

  it('does not overwrite an earlier backup when both files exist', async () => {
    const legacy = Buffer.from('{"settings":[{"id":"set-new"}]}\n');
    const places = Buffer.from('{"places":[{"id":"place-current"}]}\n');
    const backup = Buffer.from('{"settings":[{"id":"set-earlier"}]}\n');
    await writeFile(legacyPath(), legacy);
    await writeFile(placesPath(), places);
    await writeFile(`${legacyPath()}.bak-022`, backup);

    await expect(migration.up({ rootDir })).rejects.toThrow(/bak-022 already exists/);

    expect(await readFile(legacyPath())).toEqual(legacy);
    expect(await readFile(placesPath())).toEqual(places);
    expect(await readFile(`${legacyPath()}.bak-022`)).toEqual(backup);
  });
});

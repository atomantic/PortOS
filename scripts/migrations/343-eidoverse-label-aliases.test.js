import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './343-eidoverse-label-aliases.js';

let rootDir;
afterEach(async () => {
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
  rootDir = null;
});

describe('Eidoverse alias state migration', () => {
  it('preserves V2 custom recipes and asset locks without deriving aliases from records', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'eidoverse-aliases-'));
    const path = join(rootDir, 'data/eidoverse/portos-world.json');
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'no-state' });
    await mkdir(join(rootDir, 'data/eidoverse'), { recursive: true });
    const userOverrides = { name: 'Example garden', assets: { app: 'store/example-custom' }, limits: { apps: 2 } };
    const assetResolutions = { app: { path: 'store/example-custom', userOverride: true } };
    await writeFile(path, JSON.stringify({ schemaVersion: 2, userOverrides, assetResolutions, world: 'example-world' }));
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 1 });
    const state = JSON.parse(await readFile(path, 'utf8'));
    expect(state).toMatchObject({ schemaVersion: 3, selectedDesignVersion: 3, labelAliases: {}, userOverrides, assetResolutions });
    expect(state.recipe).toMatchObject({ name: 'Example garden', assets: { app: 'store/example-custom' }, limits: { apps: 2 } });
    const aliases = { 'app-0123456789ab': 'Example tower' };
    await writeFile(path, JSON.stringify({ ...state, labelAliases: aliases }));
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });
    expect(JSON.parse(await readFile(path, 'utf8')).labelAliases).toEqual(aliases);
    for (const raw of ['{invalid', JSON.stringify({ schemaVersion: 99, labelAliases: aliases })]) {
      await writeFile(path, raw);
      expect((await migration.up({ rootDir })).updated).toBe(0);
      expect(await readFile(path, 'utf8')).toBe(raw);
    }
  });
});

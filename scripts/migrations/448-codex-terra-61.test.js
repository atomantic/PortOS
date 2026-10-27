import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './448-codex-terra-61.js';

let rootDir;
afterEach(async () => { if (rootDir) await rm(rootDir, { recursive: true, force: true }); });

it('offers Terra on older and newer Codex catalogs without changing user choices', async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'portos-terra-migration-'));
  await mkdir(join(rootDir, 'data'));
  const path = join(rootDir, 'data/providers.json');
  const providers = {
    codex: { models: ['custom', 'gpt-6.1-sol', 'gpt-6-astra'], defaultModel: 'custom' },
    'codex-tui': { models: ['gpt-6-sol', 'custom'], heavyModel: 'custom' },
    unrelated: { models: ['gpt-6-sol'] },
  };
  await writeFile(path, JSON.stringify({ providers }));
  expect(await migration.up({ rootDir })).toMatchObject({ updated: 2 });
  const updated = JSON.parse(await readFile(path, 'utf8')).providers;
  expect(updated.codex).toEqual({ ...providers.codex, models: ['custom', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra'] });
  expect(updated['codex-tui']).toEqual({ ...providers['codex-tui'], models: ['gpt-6-sol', 'gpt-6.1-terra', 'custom'] });
  expect(updated.unrelated).toEqual(providers.unrelated);
  expect(await migration.up({ rootDir })).toMatchObject({ updated: 0 });
  expect(JSON.parse(await readFile(path, 'utf8')).providers).toEqual(updated);
});

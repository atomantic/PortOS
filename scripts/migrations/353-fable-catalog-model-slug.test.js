import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './353-fable-catalog-model-slug.js';

let rootDir;
afterEach(async () => { if (rootDir) await rm(rootDir, { recursive: true, force: true }); });

const withCatalog = async observations => {
  rootDir = await mkdtemp(join(tmpdir(), 'fable-slug-migration-'));
  await mkdir(join(rootDir, 'data'));
  if (observations) {
    await writeFile(join(rootDir, 'data/model-comparison.json'), JSON.stringify({ schemaVersion: 1, observations }));
  }
  return join(rootDir, 'data/model-comparison.json');
};

it('renames the dashed Fable slug while leaving its id and every other row alone', async () => {
  const path = await withCatalog([
    { id: 'aa-v4.2-anthropic-claude-fable-5-1-max', model: 'claude-fable-5-1', effort: 'max' },
    { id: 'aa-v4.2-anthropic-claude-fable-5.1-low', model: 'claude-fable-5.1', effort: 'low' },
    { id: 'aa-v4.2-anthropic-claude-fable-5-max', model: 'claude-fable-5', effort: 'max' },
  ]);
  expect(await migration.up({ rootDir })).toMatchObject({ success: true, renamed: 1 });
  const { observations } = JSON.parse(await readFile(path, 'utf8'));
  expect(observations.map(row => row.model)).toEqual(['claude-fable-5.1', 'claude-fable-5.1', 'claude-fable-5']);
  expect(observations[0].id).toBe('aa-v4.2-anthropic-claude-fable-5-1-max');
});

it('is a no-op on an already-normalized catalog and on an install with none', async () => {
  const path = await withCatalog([{ id: 'x', model: 'claude-fable-5.1', effort: 'max' }]);
  const before = await readFile(path, 'utf8');
  expect(await migration.up({ rootDir })).toMatchObject({ skipped: 'already normalized' });
  expect(await readFile(path, 'utf8')).toBe(before);

  await withCatalog(null);
  expect(await migration.up({ rootDir })).toMatchObject({ skipped: 'no catalog' });
});

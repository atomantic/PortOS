import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './353-fable-catalog-model-slug.js';

let rootDir;
// A test can call withCatalog() more than once (the "no-op ... on an install
// with none" case mints a second root to check the missing-catalog path),
// which reassigns `rootDir` and orphans the previous one — track every root
// this file has handed out so afterEach removes all of them, not just the
// last (#9032).
const rootDirs = [];
afterEach(async () => {
  for (const dir of rootDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const withCatalog = async observations => {
  rootDir = await mkdtemp(join(tmpdir(), 'fable-slug-migration-'));
  rootDirs.push(rootDir);
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

it('leaves a build date or parameter count that only looks like a version', async () => {
  const path = await withCatalog([
    { id: 'a', model: 'deepseek-r1-0528', effort: 'unspecified' },
    { id: 'b', model: 'qwen3-235b-a22b-2507', effort: 'reasoning' },
  ]);
  const before = await readFile(path, 'utf8');
  expect(await migration.up({ rootDir })).toMatchObject({ skipped: 'already normalized' });
  expect(await readFile(path, 'utf8')).toBe(before);
});

it('is a no-op on an already-normalized catalog and on an install with none', async () => {
  const path = await withCatalog([{ id: 'x', model: 'claude-fable-5.1', effort: 'max' }]);
  const before = await readFile(path, 'utf8');
  expect(await migration.up({ rootDir })).toMatchObject({ skipped: 'already normalized' });
  expect(await readFile(path, 'utf8')).toBe(before);

  await withCatalog(null);
  expect(await migration.up({ rootDir })).toMatchObject({ skipped: 'no catalog' });
});

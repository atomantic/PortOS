import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './375-aa-comparison-v43.js';

let rootDir;
afterEach(async () => { if (rootDir) await rm(rootDir, { recursive: true, force: true }); });
it('does not re-add retired benchmark rows or overwrite a catalog and fails closed on future versions', async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'portos-aa-seed-'));
  await mkdir(join(rootDir, 'data'));
  await mkdir(join(rootDir, 'data.reference'));
  const seed = JSON.parse(await readFile(new URL('../../data.reference/model-comparison.json', import.meta.url), 'utf8'));
  expect(seed.observations.filter(row => row.id.startsWith('aa-v4.3-'))).toEqual([]);
  await writeFile(join(rootDir, 'data.reference/model-comparison.json'), JSON.stringify(seed));
  const prior = { schemaVersion: 1, observations: [seed.observations[0]] };
  const path = join(rootDir, 'data/model-comparison.json');
  await writeFile(path, JSON.stringify(prior));
  expect(await migration.up({ rootDir })).toEqual({ added: 0 });
  const result = JSON.parse(await readFile(path, 'utf8'));
  expect(result.observations).toEqual(prior.observations);
  expect(await migration.up({ rootDir })).toEqual({ added: 0 });
  const future = JSON.stringify({ ...prior, schemaVersion: 99 });
  await writeFile(path, future);
  await expect(migration.up({ rootDir })).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe(future);
});

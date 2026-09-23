import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './407-aa-comparison-v432.js';

let rootDir;
afterEach(async () => { if (rootDir) await rm(rootDir, { recursive: true, force: true }); });

it('adds only missing v4.3.2 rows and preserves researched evidence', async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'portos-aa-v432-'));
  await mkdir(join(rootDir, 'data'));
  await mkdir(join(rootDir, 'data.reference'));
  const seedText = await readFile(new URL('../../data.reference/model-comparison.json', import.meta.url), 'utf8');
  const seed = JSON.parse(seedText);
  await writeFile(join(rootDir, 'data.reference/model-comparison.json'), seedText);
  const additions = seed.observations.filter(row => row.id.startsWith('aa-v4.3.2-'));
  expect(additions).toHaveLength(28);

  expect(await migration.up({ rootDir })).toEqual({ added: 0 });
  const custom = { ...additions[0], notes: 'Locally researched observation' };
  const prior = { schemaVersion: 1, observations: [seed.observations[0], custom] };
  const path = join(rootDir, 'data/model-comparison.json');
  await writeFile(path, JSON.stringify(prior));

  expect(await migration.up({ rootDir })).toEqual({ added: additions.length - 1 });
  const result = JSON.parse(await readFile(path, 'utf8'));
  expect(result.observations.slice(0, 2)).toEqual(prior.observations);
  expect(await migration.up({ rootDir })).toEqual({ added: 0 });

  const future = JSON.stringify({ ...prior, schemaVersion: 99 });
  await writeFile(path, future);
  await expect(migration.up({ rootDir })).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe(future);
});

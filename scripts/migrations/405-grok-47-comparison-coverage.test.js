import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './405-grok-47-comparison-coverage.js';

let rootDir;
afterEach(async () => { if (rootDir) await rm(rootDir, { recursive: true, force: true }); });

it('upgrades an existing catalog without losing researched evidence and fails closed on future versions', async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'portos-grok47-seed-'));
  await mkdir(join(rootDir, 'data'));
  await mkdir(join(rootDir, 'data.reference'));
  const seed = JSON.parse(await readFile(new URL('../../data.reference/model-comparison.json', import.meta.url), 'utf8'));
  await writeFile(join(rootDir, 'data.reference/model-comparison.json'), JSON.stringify(seed));
  // No install catalog yet — a fresh install gets the seed through setup-data.
  expect(await migration.up({ rootDir })).toEqual({ added: 0 });

  // Seed CONTENT is asserted in scripts/prune-model-comparison-seed.test.js;
  // here it only has to be the set this migration backfills.
  const pricing = seed.observations.filter(row => row.id.startsWith('xai-grok-4.7-pricing-2026-09-21-'));
  expect(pricing).toHaveLength(2);

  const researched = { ...pricing[0], notes: 'Example locally researched evidence' };
  const prior = { schemaVersion: 1, observations: [seed.observations[0], researched] };
  const path = join(rootDir, 'data/model-comparison.json');
  await writeFile(path, JSON.stringify(prior));
  expect(await migration.up({ rootDir })).toEqual({ added: 1 });
  const result = JSON.parse(await readFile(path, 'utf8'));
  expect(result.observations.slice(0, 2)).toEqual(prior.observations);
  expect(await migration.up({ rootDir })).toEqual({ added: 0 });

  const future = JSON.stringify({ ...prior, schemaVersion: 99 });
  await writeFile(path, future);
  await expect(migration.up({ rootDir })).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe(future);
});

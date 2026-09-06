import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './344-local-video-queue-holds.js';
let rootDir;
afterEach(async () => { if (rootDir) await rm(rootDir, { recursive: true, force: true }); });
it('adds an empty hold list while preserving ordered jobs, unknown fields and existing holds', async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'video-holds-migration-'));
  expect(await migration.up({ rootDir })).toEqual({ updated: 0 });
  await mkdir(join(rootDir, 'data'));
  const file = join(rootDir, 'data', 'media-jobs.json');
  const legacy = { jobs: [{ id: 'example-job', params: { prompt: 'invented clip' } }], futureField: true };
  await writeFile(file, JSON.stringify(legacy));
  expect(await migration.up({ rootDir })).toEqual({ updated: 1 });
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ...legacy, videoHolds: [] });
  const current = { ...legacy, videoHolds: [{ id: 'existing-hold' }] };
  await writeFile(file, JSON.stringify(current));
  expect(await migration.up({ rootDir })).toEqual({ updated: 0 });
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(current);
  for (const invalid of ['{invalid', '{}']) {
    await writeFile(file, invalid);
    expect(await migration.up({ rootDir })).toEqual({ updated: 0 });
    expect(await readFile(file, 'utf8')).toBe(invalid);
  }
  // A directory is a portable non-ENOENT read failure, without chmod/root assumptions.
  await rm(file);
  await mkdir(file);
  expect(await migration.up({ rootDir })).toEqual({ updated: 0 });
  expect((await stat(file)).isDirectory()).toBe(true);
});

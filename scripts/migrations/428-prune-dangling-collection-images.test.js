import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import migration from './428-prune-dangling-collection-images.js';

let rootDir;
beforeEach(async () => { rootDir = await mkdtemp(join(tmpdir(), 'portos-prune-collections-')); });
afterEach(() => rm(rootDir, { recursive: true, force: true }));

const seedCollection = async (id, record) => {
  await mkdir(join(rootDir, 'data', 'media-collections', id), { recursive: true });
  await writeFile(join(rootDir, 'data', 'media-collections', id, 'index.json'), JSON.stringify(record));
};
const readCollection = async (id) => JSON.parse(await readFile(join(rootDir, 'data', 'media-collections', id, 'index.json'), 'utf8'));

it('removes image rows with no gallery file, keeps videos and tombstones, and is idempotent', async () => {
  await mkdir(join(rootDir, 'data', 'images'), { recursive: true });
  await writeFile(join(rootDir, 'data', 'images', 'live.png'), '');
  const stamp = '2026-01-01T00:00:00.000Z';
  await seedCollection('uc-1', {
    id: 'uc-1', coverKey: 'image:gone.png', updatedAt: stamp,
    items: [{ kind: 'image', ref: 'live.png' }, { kind: 'image', ref: 'gone.png' }, { kind: 'video', ref: 'clip' }],
  });
  await seedCollection('uc-2', { id: 'uc-2', deleted: true, updatedAt: stamp, items: [{ kind: 'image', ref: 'gone.png' }] });

  expect(await migration.up({ rootDir })).toEqual({ collections: 1, removed: 1 });
  const first = await readCollection('uc-1');
  expect(first.items.map((i) => i.ref)).toEqual(['live.png', 'clip']);
  expect(first.coverKey).toBeNull();
  expect(first.updatedAt).not.toBe(stamp);
  expect((await readCollection('uc-2')).items).toHaveLength(1);
  expect(await migration.up({ rootDir })).toEqual({ collections: 0, removed: 0 });
});

it('does nothing without a gallery directory or without collections', async () => {
  expect(await migration.up({ rootDir })).toEqual({ collections: 0, removed: 0 });
  await seedCollection('uc-1', { id: 'uc-1', items: [{ kind: 'image', ref: 'x.png' }] });
  expect(await migration.up({ rootDir })).toEqual({ collections: 0, removed: 0 });
  expect((await readCollection('uc-1')).items).toHaveLength(1);
});

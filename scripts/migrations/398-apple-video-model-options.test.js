import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './398-apple-video-model-options.js';

let rootDir;
let path;
beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'video-options-upgrade-'));
  await mkdir(join(rootDir, 'data'));
  path = join(rootDir, 'data/media-models.json');
});
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

it.each(['mlx', 'macos'])('upgrades an old %s registry once, preserving custom models, defaults and deletions', async (key) => {
  const custom = { id: 'fastmetal_5b_qad', repo: 'example/custom-model', name: 'My model' };
  await writeFile(path, JSON.stringify({ video: { [key]: [custom], defaultMlx: custom.id }, customSetting: 7 }));
  await migration.up({ rootDir });
  const upgraded = JSON.parse(await readFile(path, 'utf8'));
  expect(upgraded.video[key]).toHaveLength(5);
  expect(upgraded.video[key][0]).toEqual(custom);
  expect(upgraded.video.defaultMlx).toBe(custom.id);
  expect(upgraded.customSetting).toBe(7);
  expect(upgraded.video[key].some((entry) => entry.id === 'fastmetal_14b_qad')).toBe(false);
  const once = await readFile(path, 'utf8');
  await migration.up({ rootDir });
  expect(await readFile(path, 'utf8')).toBe(once);
  upgraded.video[key] = upgraded.video[key].filter((entry) => entry.id !== 'fasth3_v2_int8');
  await writeFile(path, JSON.stringify(upgraded));
  await migration.up({ rootDir });
  expect(JSON.parse(await readFile(path, 'utf8')).video[key].some((entry) => entry.id === 'fasth3_v2_int8')).toBe(false);
});

it('leaves malformed state intact and does not create a registry on a missing-data install', async () => {
  await migration.up({ rootDir });
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(path, '{broken');
  await expect(migration.up({ rootDir })).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe('{broken');
});

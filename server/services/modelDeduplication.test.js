import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanModelDuplicates, rectifyModelDuplicates } from './modelDeduplication.js';

vi.mock('./lmStudioManager.js', () => ({ getModelsDir: async () => process.env.LM_STUDIO_MODELS_DIR }));

let root;
let roots;
const bytes = Buffer.alloc(10 * 1024 * 1024, 7);
async function weight(dir, name = 'example.safetensors', data = bytes) {
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await fs.writeFile(path, data);
  return path;
}
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'model-dedupe-')));
  roots = { local: [join(root, 'local')], external: [join(root, 'pinokio')] };
  await Promise.all([...roots.local, ...roots.external].map((dir) => fs.mkdir(dir)));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

it('verifies contents, preserves HF snapshot links and links multiple copies to one source', async () => {
  const blob = await weight(join(roots.local[0], 'blobs'), 'hash');
  const snapshot = join(roots.local[0], 'snapshots', 'revision');
  await fs.mkdir(snapshot, { recursive: true });
  const sourcePath = join(snapshot, 'example.safetensors');
  await fs.symlink(blob, sourcePath);
  const targetPath = await weight(join(roots.external[0], 'first'));
  const secondPath = await weight(join(roots.external[0], 'second'));
  const wrongPath = await weight(join(roots.external[0], 'wrong'), 'example.safetensors', Buffer.alloc(bytes.length, 8));
  const report = await scanModelDuplicates({ roots });
  expect(report.items).toHaveLength(2);
  expect(report.totalReclaimableBytes).toBe((await fs.stat(targetPath)).blocks * 1024);
  const rename = vi.spyOn(fs, 'rename');
  const result = await rectifyModelDuplicates(report.items, { roots });
  expect(result.reclaimedBytes).toBe(report.totalReclaimableBytes);
  expect(rename).toHaveBeenCalledTimes(2);
  expect((await fs.lstat(sourcePath)).isSymbolicLink()).toBe(true);
  for (const path of [targetPath, secondPath]) {
    expect((await fs.stat(path)).ino).toBe((await fs.stat(blob)).ino);
    expect((await fs.readFile(path)).equals(bytes)).toBe(true);
  }
  expect((await fs.readFile(wrongPath)).equals(Buffer.alloc(bytes.length, 8))).toBe(true);
  const rescanned = await scanModelDuplicates({ roots });
  expect(rescanned.totalReclaimableBytes).toBe(0);
  expect(rescanned.items.every((item) => item.alreadyLinked)).toBe(true);
});

it('rejects mismatches and symlink escapes before replacing any batch entry', async () => {
  const sourcePath = await weight(roots.local[0]);
  const targetPath = await weight(roots.external[0]);
  const original = (await fs.stat(targetPath)).ino;
  const outside = await weight(root, 'outside.safetensors');
  const escape = join(roots.external[0], 'escape.safetensors');
  await fs.symlink(outside, escape);
  await expect(rectifyModelDuplicates([{ sourcePath, targetPath }, { sourcePath, targetPath: escape }], { roots })).rejects.toThrow('Unsafe');
  expect((await fs.stat(targetPath)).ino).toBe(original);
  await fs.writeFile(targetPath, Buffer.alloc(bytes.length, 9));
  await expect(rectifyModelDuplicates([{ sourcePath, targetPath }], { roots })).rejects.toThrow('contents differ');
  await expect(rectifyModelDuplicates([{ sourcePath, targetPath: outside }], { roots })).rejects.toThrow('outside');
});

it('does not count target aliases and rejects cross-device replacement', async () => {
  const sourcePath = await weight(roots.local[0]);
  const targetPath = await weight(roots.external[0]);
  const alias = join(roots.external[0], 'alias.safetensors');
  await fs.link(targetPath, alias);
  expect((await scanModelDuplicates({ roots })).totalReclaimableBytes).toBe(0);
  await expect(rectifyModelDuplicates([{ sourcePath, targetPath }], { roots })).rejects.toThrow('additional hardlinks');
  await fs.unlink(alias);
  const stat = fs.stat.bind(fs);
  vi.spyOn(fs, 'stat').mockImplementation(async (path, ...args) => {
    const info = await stat(path, ...args);
    if (path === targetPath) info.dev += 1;
    return info;
  });
  await expect(rectifyModelDuplicates([{ sourcePath, targetPath }], { roots })).rejects.toThrow('span filesystems');
});

it('cleans a failed rename without replacing the original', async () => {
  const sourcePath = await weight(roots.local[0]);
  const targetPath = await weight(roots.external[0]);
  const original = (await fs.stat(targetPath)).ino;
  vi.spyOn(fs, 'rename').mockRejectedValue(new Error('rename failed'));
  await expect(rectifyModelDuplicates([{ sourcePath, targetPath }], { roots })).rejects.toThrow('rename failed');
  expect((await fs.stat(targetPath)).ino).toBe(original);
  expect(await fs.readdir(roots.external[0])).toEqual(['example.safetensors']);
});

it('does no directory traversal when Pinokio is absent', async () => {
  vi.stubEnv('PINOKIO_HOME', join(root, 'absent'));
  const read = vi.spyOn(fs, 'readdir');
  expect(await scanModelDuplicates()).toEqual({ pinokioDetected: false, items: [], totalReclaimableBytes: 0 });
  expect(read).not.toHaveBeenCalled();
});

it('discovers peer drives, app models and the separate HF cache from configured roots', async () => {
  vi.stubEnv('PINOKIO_HOME', roots.external[0]);
  vi.stubEnv('HF_HUB_CACHE', roots.local[0]);
  vi.stubEnv('LM_STUDIO_MODELS_DIR', join(root, 'absent-lm'));
  await weight(roots.local[0]);
  await weight(join(roots.external[0], 'drive', 'drives', 'peers', 'example-peer', 'mlx_models', 'example-model'));
  await weight(join(roots.external[0], 'api', 'example-app', 'models'));
  await weight(join(roots.external[0], 'cache', 'huggingface', 'hub', 'models--example--model', 'snapshots', 'revision'));
  const report = await scanModelDuplicates();
  expect(report.pinokioDetected).toBe(true);
  expect(report.items).toHaveLength(3);
});

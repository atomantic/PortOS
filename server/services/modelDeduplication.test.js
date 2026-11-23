import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HUB_MIN_BYTES, scanModelDuplicates, rectifyModelDuplicates } from './modelDeduplication.js';

const spawnState = vi.hoisted(() => ({ failCp: false }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  const { EventEmitter } = await import('node:events');
  return {
    ...actual,
    spawn(command, args, options) {
      if (spawnState.failCp && command === 'cp') {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = { end() {} };
        child.kill = () => {};
        process.nextTick(() => child.emit('close', 1));
        return child;
      }
      return actual.spawn(command, args, options);
    },
  };
});

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
  await Promise.all([...roots.local, ...roots.external, join(root, 'hub')].map((dir) => fs.mkdir(dir)));
  vi.stubEnv('HF_HUB_CACHE', join(root, 'hub'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  spawnState.failCp = false;
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
  expect(report.items[0].sizeBytes).toBe(bytes.length);
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
  const escapeLink = join(roots.external[0], 'escape.safetensors');
  await fs.symlink(outside, escapeLink);
  await expect(rectifyModelDuplicates([{ sourcePath, targetPath }, { sourcePath, targetPath: escapeLink }], { roots })).rejects.toThrow('Unsafe');
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
    if (path === targetPath) info.dev += 1n;
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

const blobName = 'ab'.repeat(32);
const otherName = 'cd'.repeat(32);

async function hubFixture(hub, repo, name, data) {
  const blobs = join(hub, repo, 'blobs');
  await fs.mkdir(blobs, { recursive: true });
  const path = join(blobs, name);
  await fs.writeFile(path, data);
  const snapshot = join(hub, repo, 'snapshots', 'rev');
  await fs.mkdir(snapshot, { recursive: true });
  const link = join(snapshot, 'weights.safetensors');
  await fs.symlink(join('..', '..', 'blobs', name), link);
  return { path, link };
}

it('keeps the production hub blob threshold at 50 MB', () => {
  expect(HUB_MIN_BYTES).toBe(50 * 1024 * 1024);
});

it('reports and clones identical hub blobs without Pinokio, and leaves snapshots readable', async () => {
  const hub = join(root, 'models-hub');
  const data = Buffer.alloc(128 * 1024, 7);
  const base = await hubFixture(hub, 'models--example--base', blobName, data);
  const distilled = await hubFixture(hub, 'models--example--distilled', blobName, data);
  const sourceInode = (await fs.stat(base.path)).ino;
  const targetInode = (await fs.stat(distilled.path)).ino;
  const report = await scanModelDuplicates({ roots: null, hubRoot: hub, minHubBytes: 1024 });
  expect(report.pinokioDetected).toBe(false);
  expect(report.hub.groups).toHaveLength(1);
  expect(report.hub.groups[0].sizeBytes).toBe(data.length);
  expect(report.hub.groups[0].repos).toEqual(['models--example--base', 'models--example--distilled']);
  const linkBefore = await fs.readlink(distilled.link);
  if (!report.hub.cloneSupported) {
    expect(report.hub.totalReclaimableBytes).toBe(0);
    expect(report.hub.groups[0].canClone).toBe(false);
    await expect(rectifyModelDuplicates([
      { sourcePath: base.path, targetPath: distilled.path },
    ], { mode: 'clone', hubRoot: hub, minBytes: 1024 })).rejects.toThrow(/unavailable/i);
    expect((await fs.stat(distilled.path)).ino).toBe(targetInode);
    expect(await fs.readlink(distilled.link)).toBe(linkBefore);
    return;
  }
  expect(report.hub.totalReclaimableBytes).toBeGreaterThan(0);
  const result = await rectifyModelDuplicates(report.hub.groups[0].replacements.map((replacement) => ({
    sourcePath: report.hub.groups[0].sourcePath,
    targetPath: replacement.path,
  })), { mode: 'clone', hubRoot: hub, minBytes: 1024 });
  expect(result.success).toBe(true);
  expect(result.physicalReclaimedBytes === null || result.physicalReclaimedBytes >= 0).toBe(true);
  expect((await fs.stat(base.path)).ino).toBe(sourceInode);
  expect((await fs.stat(base.path)).nlink).toBe(1);
  expect((await fs.stat(distilled.path)).ino).not.toBe(targetInode);
  expect((await fs.readFile(distilled.path)).equals(data)).toBe(true);
  expect((await fs.readFile(base.link)).equals(data)).toBe(true);
  expect((await fs.readFile(distilled.link)).equals(data)).toBe(true);
  expect((await fs.lstat(distilled.link)).isSymbolicLink()).toBe(true);
  expect(await fs.readlink(distilled.link)).toBe(linkBefore);
  if (result.results.every((item) => item.sharedStorage === true)) {
    const again = await scanModelDuplicates({ roots: null, hubRoot: hub, minHubBytes: 1024 });
    expect(again.hub.totalReclaimableBytes).toBe(0);
  } else if (process.platform === 'darwin') {
    expect(result.results[0].sharedStorage).toBe(true);
  }
});

it('does not replace a hub blob whose bytes differ or a repo that is still downloading', async () => {
  const hub = join(root, 'corrupt-hub');
  const data = Buffer.alloc(64 * 1024, 4);
  const base = await hubFixture(hub, 'models--example--base', blobName, data);
  const corrupt = await hubFixture(hub, 'models--example--corrupt', blobName, Buffer.alloc(data.length, 5));
  const report = await scanModelDuplicates({ roots: null, hubRoot: hub, minHubBytes: 1024 });
  expect(report.hub.groups).toEqual([]);
  const corruptInode = (await fs.stat(corrupt.path)).ino;
  await expect(rectifyModelDuplicates([
    { sourcePath: base.path, targetPath: corrupt.path },
  ], { mode: 'clone', hubRoot: hub, minBytes: 1024 })).rejects.toThrow(/contents differ/);
  expect((await fs.stat(corrupt.path)).ino).toBe(corruptInode);

  const busyHub = join(root, 'busy-hub');
  const left = await hubFixture(busyHub, 'models--example--left', otherName, data);
  const right = await hubFixture(busyHub, 'models--example--right', otherName, data);
  await fs.writeFile(join(busyHub, 'models--example--right', 'blobs', 'partial.incomplete'), Buffer.alloc(0));
  expect((await scanModelDuplicates({ roots: null, hubRoot: busyHub, minHubBytes: 1024 })).hub.groups).toEqual([]);
  await expect(rectifyModelDuplicates([
    { sourcePath: left.path, targetPath: right.path },
  ], { mode: 'clone', hubRoot: busyHub, minBytes: 1024 })).rejects.toThrow(/download is in progress/);
  expect((await fs.readFile(right.path)).equals(data)).toBe(true);
  await expect(rectifyModelDuplicates([
    { sourcePath: left.path, targetPath: right.link },
  ], { mode: 'clone', hubRoot: busyHub, minBytes: 1024 })).rejects.toThrow(/snapshot/);
});

it('ignores hub blobs under the 50 MB threshold and refuses hardlinks when cloning is unavailable', async () => {
  const hub = join(root, 'small-hub');
  const data = Buffer.alloc(4096, 9);
  await hubFixture(hub, 'models--example--base', blobName, data);
  await hubFixture(hub, 'models--example--distilled', blobName, data);
  const ignored = await scanModelDuplicates({ roots: null, hubRoot: hub });
  expect(ignored.hub.groups).toEqual([]);

  const forced = join(root, 'forced-hub');
  const base = await hubFixture(forced, 'models--example--base', blobName, data);
  const copy = await hubFixture(forced, 'models--example--distilled', blobName, data);
  const inode = (await fs.stat(copy.path)).ino;
  spawnState.failCp = true;
  const report = await scanModelDuplicates({ roots: null, hubRoot: forced, minHubBytes: 1024 });
  expect(report.hub.cloneSupported).toBe(false);
  expect(report.hub.groups).toHaveLength(1);
  expect(report.hub.totalReclaimableBytes).toBe(0);
  expect(report.hub.groups[0].sizeBytes).toBe(data.length);
  await expect(rectifyModelDuplicates([
    { sourcePath: base.path, targetPath: copy.path },
  ], { mode: 'clone', hubRoot: forced, minBytes: 1024 })).rejects.toThrow(/unavailable/i);
  expect((await fs.stat(copy.path)).ino).toBe(inode);
  expect((await fs.stat(base.path)).ino).not.toBe(inode);
});

it('scans the hub cache for duplicate blobs when Pinokio is absent', async () => {
  vi.stubEnv('PINOKIO_HOME', join(root, 'absent'));
  const read = vi.spyOn(fs, 'readdir');
  const report = await scanModelDuplicates();
  expect(report.pinokioDetected).toBe(false);
  expect(report.items).toEqual([]);
  expect(report.totalReclaimableBytes).toBe(0);
  expect(report.hub.groups).toEqual([]);
  expect(report.hub.totalReclaimableBytes).toBe(0);
  expect(read.mock.calls.some((call) => String(call[0]).includes('absent'))).toBe(false);
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

// Windows inode identifiers can exceed Number's exact integer range. Distinct
// files must still reach hash verification and atomic replacement.
it('does not mistake rounded inode identifiers for already-linked files', async () => {
  const sourcePath = await weight(roots.local[0]);
  const targetPath = await weight(roots.external[0]);
  const stat = fs.stat.bind(fs);
  const sourceInode = 2n ** 60n;
  const targetInode = sourceInode + 1n;
  expect(Number(sourceInode)).toBe(Number(targetInode));
  vi.spyOn(fs, 'stat').mockImplementation(async (path, options) => {
    const info = await stat(path, options);
    if (path === sourcePath || path === targetPath) {
      const inode = path === sourcePath ? sourceInode : targetInode;
      info.ino = options?.bigint ? inode : Number(inode);
    }
    return info;
  });
  vi.spyOn(fs, 'rename').mockRejectedValue(new Error('rename failed'));
  await expect(rectifyModelDuplicates([{ sourcePath, targetPath }], { roots })).rejects.toThrow('rename failed');
  expect(await fs.readdir(roots.external[0])).toEqual(['example.safetensors']);
  expect((await fs.readFile(targetPath)).equals(bytes)).toBe(true);
});

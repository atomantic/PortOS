import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import migration from './442-remove-cos-checkout-archives.js';

let rootDir;
const data = (...parts) => join(rootDir, 'data', ...parts);
const exists = path => lstat(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'portos-remove-cos-archives-442-'));
});
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

describe('442-remove-cos-checkout-archives', () => {
  it('deletes legacy checkout archive directories while leaving sibling worktrees intact', async () => {
    const names = ['held-checkout-archives', 'branch-retirement-archives', 'initialized-checkout-retirements'];
    for (const name of names) {
      const directory = data('cos', name, 'nested');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'artifact.json'), JSON.stringify({ legacy: true }));
    }
    await mkdir(data('cos', 'worktrees'), { recursive: true });
    await writeFile(data('cos', 'worktrees', 'keep.txt'), 'live checkout');

    const first = await migration.up({ rootDir });
    expect(first).toEqual({ removed: names });
    for (const name of names) {
      expect(await exists(data('cos', name))).toBe(false);
    }
    expect(await readFile(data('cos', 'worktrees', 'keep.txt'), 'utf8')).toBe('live checkout');

    const second = await migration.up({ rootDir });
    expect(second).toEqual({ removed: [] });
  });

  it('does not create archive roots on a fresh install', async () => {
    await migration.up({ rootDir });
    expect(await readdir(rootDir)).toEqual([]);
  });

  it('ignores a missing directory and does not follow or remove a symlink at an archive path', async () => {
    const target = data('cos', 'worktrees');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'keep.txt'), 'live checkout');
    await symlink(target, data('cos', 'held-checkout-archives'), 'dir');
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ removed: [] });
    expect(await exists(data('cos', 'held-checkout-archives'))).toBe(true);
    expect(await exists(join(target, 'keep.txt'))).toBe(true);
  });
});

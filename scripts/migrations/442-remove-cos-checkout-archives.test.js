import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
  rootDir = await mkdtemp(join(tmpdir(), 'portos-remove-cos-archives-'));
});
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

describe('checkout archive removal', () => {
  it('deletes only the three archive directories and leaves a sibling worktree', async () => {
    for (const name of ['held-checkout-archives', 'branch-retirement-archives', 'initialized-checkout-retirements']) {
      await mkdir(data('cos', name, 'old'), { recursive: true });
      await writeFile(data('cos', name, 'old', 'manifest.json'), '{}');
    }
    await mkdir(data('cos', 'worktrees'), { recursive: true });
    await writeFile(data('cos', 'worktrees', 'keep.txt'), 'live checkout');
    await migration.up({ rootDir });
    expect(await exists(data('cos', 'held-checkout-archives'))).toBe(false);
    expect(await exists(data('cos', 'branch-retirement-archives'))).toBe(false);
    expect(await exists(data('cos', 'initialized-checkout-retirements'))).toBe(false);
    expect(await exists(data('cos', 'worktrees', 'keep.txt'))).toBe(true);
    await migration.up({ rootDir });
    expect(await exists(data('cos', 'worktrees', 'keep.txt'))).toBe(true);
  });

  it('ignores a missing directory and does not follow a symlink at an archive path', async () => {
    const target = data('cos', 'worktrees');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'keep.txt'), 'live checkout');
    await symlink(target, data('cos', 'held-checkout-archives'), 'dir');
    await migration.up({ rootDir });
    expect(await exists(data('cos', 'held-checkout-archives'))).toBe(true);
    expect(await exists(join(target, 'keep.txt'))).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import migration from './461-remove-initialized-checkout-fixtures.js';

let rootDir;
const data = (...parts) => join(rootDir, 'data', ...parts);
const exists = path => lstat(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'portos-remove-fixtures-461-'));
});
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

describe('461-remove-initialized-checkout-fixtures', () => {
  it('deletes the fixture directory and leaves sibling CoS data intact', async () => {
    const repo = data('cos', 'initialized-checkout-fixtures', 'fixture-1', 'primary');
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(join(repo, 'file.txt'), 'scratch');
    await mkdir(data('cos', 'worktrees'), { recursive: true });
    await writeFile(data('cos', 'worktrees', 'keep.txt'), 'live checkout');

    expect(await migration.up({ rootDir })).toEqual({ removed: true });
    expect(await exists(data('cos', 'initialized-checkout-fixtures'))).toBe(false);
    expect(await readFile(data('cos', 'worktrees', 'keep.txt'), 'utf8')).toBe('live checkout');
    expect(await migration.up({ rootDir })).toEqual({ removed: false });
  });

  it('is a no-op on an install that never had the directory', async () => {
    expect(await migration.up({ rootDir })).toEqual({ removed: false });
    expect(await readdir(rootDir)).toEqual([]);
  });

  it('does not follow or remove a symlink at the fixture path', async () => {
    const target = data('cos', 'worktrees');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'keep.txt'), 'live checkout');
    await symlink(target, data('cos', 'initialized-checkout-fixtures'), 'dir');
    expect(await migration.up({ rootDir })).toEqual({ removed: false });
    expect(await exists(data('cos', 'initialized-checkout-fixtures'))).toBe(true);
    expect(await exists(join(target, 'keep.txt'))).toBe(true);
  });
});

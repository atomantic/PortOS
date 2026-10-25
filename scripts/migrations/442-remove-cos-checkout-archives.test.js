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
  rootDir = await mkdtemp(join(tmpdir(), 'portos-remove-cos-archives-'));
});
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

describe('historical checkout recovery preservation', () => {
  it('keeps sole unpublished bytes and unfinished quarantine journals, including sibling checkouts', async () => {
    const sentinels = [];
    for (const name of ['held-checkout-archives', 'branch-retirement-archives', 'initialized-checkout-retirements']) {
      const directory = data('cos', name, 'interrupted', 'quarantine');
      await mkdir(directory, { recursive: true });
      const path = join(directory, 'unpublished.bin');
      const bytes = Buffer.from([0, 255, 128, 42]);
      await writeFile(path, bytes);
      const journal = data('cos', name, 'interrupted', 'journal.json');
      const state = JSON.stringify({ phase: 'quarantined', recoveryComplete: false });
      await writeFile(journal, state);
      sentinels.push([path, bytes], [journal, Buffer.from(state)]);
    }
    await mkdir(data('cos', 'worktrees'), { recursive: true });
    await writeFile(data('cos', 'worktrees', 'keep.txt'), 'live checkout');
    for (let attempt = 0; attempt < 2; attempt++) {
      await migration.up({ rootDir });
      for (const [path, bytes] of sentinels) expect(await readFile(path)).toEqual(bytes);
      expect(await readFile(data('cos', 'worktrees', 'keep.txt'), 'utf8')).toBe('live checkout');
    }
  });

  it('does not create archive roots on a fresh install', async () => {
    await migration.up({ rootDir });
    expect(await readdir(rootDir)).toEqual([]);
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

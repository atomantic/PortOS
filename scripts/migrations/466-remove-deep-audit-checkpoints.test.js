import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import migration from './466-remove-deep-audit-checkpoints.js';

let rootDir;
const data = (...parts) => join(rootDir, 'data', ...parts);
const exists = path => lstat(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'portos-remove-checkpoints-466-'));
});
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

describe('466-remove-deep-audit-checkpoints', () => {
  it('deletes the checkpoint directory and leaves sibling CoS data intact', async () => {
    await mkdir(data('cos', 'deep-audit-checkpoints'), { recursive: true });
    await writeFile(data('cos', 'deep-audit-checkpoints', '.portos-deep-example-ledger.json'), '{}');
    await mkdir(data('cos', 'agents'), { recursive: true });
    await writeFile(data('cos', 'agents', 'keep.json'), '{}');

    expect(await migration.up({ rootDir })).toEqual({ removed: true });
    expect(await exists(data('cos', 'deep-audit-checkpoints'))).toBe(false);
    expect(await readFile(data('cos', 'agents', 'keep.json'), 'utf8')).toBe('{}');
    expect(await migration.up({ rootDir })).toEqual({ removed: false });
  });

  it('is a no-op on an install that never had the directory', async () => {
    expect(await migration.up({ rootDir })).toEqual({ removed: false });
    expect(await readdir(rootDir)).toEqual([]);
  });

  it('does not follow or remove a symlink at the checkpoint path', async () => {
    const target = data('cos', 'agents');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'keep.json'), '{}');
    await symlink(target, data('cos', 'deep-audit-checkpoints'), 'dir');
    expect(await migration.up({ rootDir })).toEqual({ removed: false });
    expect(await exists(data('cos', 'deep-audit-checkpoints'))).toBe(true);
    expect(await exists(join(target, 'keep.json'))).toBe(true);
  });
});

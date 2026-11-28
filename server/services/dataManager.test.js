/**
 * Unit tests for deleteBackup filename validation (issue #1822).
 *
 * Backup archives are named like `agents-2026-06-30T12-34-56.tar.gz`, so the
 * raw filename legitimately contains dots. The validation must accept that
 * shape while rejecting traversal/wildcard names — the old dot-stripping
 * double-pass never validated the real dotted filename, leaving only the
 * startsWith(backupDir) guard against traversal.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const { execFile, rmGuarded } = vi.hoisted(() => ({
  execFile: vi.fn(),
  rmGuarded: vi.fn().mockResolvedValue(undefined),
}));
const testDataRoot = createTempDataRoot('datamanager-detail-test-');

vi.mock('../lib/childProcess.js', () => ({ execFile }));

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return makePathsProxy(actual, { dataRoot: testDataRoot, overrides: { rmGuarded } });
});

const { deleteBackup, getCategoryDetail } = await import('./dataManager.js');

describe('deleteBackup filename validation (#1822)', () => {
  beforeEach(() => {
    rmGuarded.mockClear();
  });

  it('accepts a real dotted backup archive name', async () => {
    const result = await deleteBackup('agents-2026-06-30T12-34-56.tar.gz');
    expect(result).toEqual({ deleted: 'agents-2026-06-30T12-34-56.tar.gz' });
    expect(rmGuarded).toHaveBeenCalledTimes(1);
  });

  it('rejects ".." traversal without touching the filesystem', async () => {
    await expect(deleteBackup('../secrets.json')).rejects.toThrow('Invalid filename');
    await expect(deleteBackup('a/../../etc/passwd')).rejects.toThrow('Invalid filename');
    expect(rmGuarded).not.toHaveBeenCalled();
  });

  it('rejects the bare "." and ".." entries (which resolve to the backup dir / its parent)', async () => {
    await expect(deleteBackup('.')).rejects.toThrow('Invalid filename');
    await expect(deleteBackup('..')).rejects.toThrow('Invalid filename');
    expect(rmGuarded).not.toHaveBeenCalled();
  });

  it('rejects path separators and other unsafe characters', async () => {
    await expect(deleteBackup('sub/dir.tar.gz')).rejects.toThrow('Invalid filename');
    await expect(deleteBackup('name with spaces.tar.gz')).rejects.toThrow('Invalid filename');
    await expect(deleteBackup('weird$name.tar.gz')).rejects.toThrow('Invalid filename');
    expect(rmGuarded).not.toHaveBeenCalled();
  });
});

afterAll(() => rm(testDataRoot, { recursive: true, force: true }));

it('bounds directory scans while building the detail listing', async () => {
  const categoryKey = 'sample';
  const names = Array.from({ length: 21 }, (_, index) => `entry-${index}`);
  await Promise.all(names.map(name => mkdir(join(testDataRoot, categoryKey, name), { recursive: true })));

  let running = 0;
  let peak = 0;
  execFile.mockImplementation((_command, args, _options, callback) => {
    running++;
    peak = Math.max(peak, running);
    setImmediate(() => {
      running--;
      callback(null, { stdout: `1\t${args[1]}\n`, stderr: '' });
    });
  });

  const detail = await getCategoryDetail(categoryKey);

  expect(detail.items.map(({ name }) => name).sort()).toEqual(names.sort());
  expect(execFile).toHaveBeenCalledTimes(names.length);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(8);
});

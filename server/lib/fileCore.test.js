import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import * as fsPromises from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pinPlatform } from './testHelper.js';
import { copyFileGuarded, parseFilesystemStats } from './fileCore.js';

// Lets a test force `copyFile` to throw a Windows lock errno, which cannot be
// provoked portably; delegates to the real implementation by default.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, copyFile: vi.fn((...args) => actual.copyFile(...args)) };
});

describe('parseFilesystemStats', () => {
  it('derives canonical byte metrics and compatibility aliases from statfs counts', () => {
    expect(parseFilesystemStats({ blocks: 100, bavail: 25, bsize: 4096 })).toEqual({
      total: 409_600,
      used: 307_200,
      free: 102_400,
      usagePercent: 75,
      totalBytes: 409_600,
      usedBytes: 307_200,
      freeBytes: 102_400,
    });
  });

  it.each([
    null,
    undefined,
    { blocks: 0, bavail: 0, bsize: 4096 },
    { blocks: 100, bavail: 25 },
    { blocks: 100, bavail: 25, bsize: 0 },
    { blocks: 100, bavail: -1, bsize: 4096 },
    { blocks: Number.NaN, bavail: 25, bsize: 4096 },
  ])('returns null for unavailable or invalid stats (%j)', (stats) => {
    expect(parseFilesystemStats(stats)).toBeNull();
  });

  it('clamps available blocks to the filesystem total', () => {
    expect(parseFilesystemStats({ blocks: 10, bavail: 11, bsize: 1024 })).toEqual({
      total: 10_240,
      used: 0,
      free: 10_240,
      usagePercent: 0,
      totalBytes: 10_240,
      usedBytes: 0,
      freeBytes: 10_240,
    });
  });

  it('preserves whole-percent rounding at the centralized boundary', () => {
    expect(parseFilesystemStats({ blocks: 1000, bavail: 2, bsize: 1 })?.usagePercent).toBe(100);
  });
});

describe('copyFileGuarded Windows lock retry', () => {
  let restorePlatform = () => {};
  afterEach(async () => {
    restorePlatform();
    const real = await vi.importActual('fs/promises');
    fsPromises.copyFile.mockReset();
    fsPromises.copyFile.mockImplementation((...args) => real.copyFile(...args));
  });

  const lockErr = (code) => Object.assign(new Error(`${code}: locked`), { code });
  const withFiles = async (fn) => {
    const dir = await mkdtemp(join(tmpdir(), 'portos-copy-retry-'));
    try {
      await writeFile(join(dir, 'src.bin'), 'payload');
      return await fn(join(dir, 'src.bin'), join(dir, 'dest.bin'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it('succeeds after transient EBUSY locks on win32', async () => {
    restorePlatform = pinPlatform('win32');
    await withFiles(async (src, dest) => {
      fsPromises.copyFile.mockRejectedValueOnce(lockErr('EBUSY')).mockRejectedValueOnce(lockErr('EBUSY'));
      await copyFileGuarded(src, dest, undefined, { delayMs: 0 });
      expect(fsPromises.copyFile).toHaveBeenCalledTimes(3);
      expect(await readFile(dest, 'utf8')).toBe('payload');
    });
  });

  it('rethrows the original error when the lock persists past the bound', async () => {
    restorePlatform = pinPlatform('win32');
    await withFiles(async (src, dest) => {
      const err = lockErr('EBUSY');
      fsPromises.copyFile.mockRejectedValue(err);
      await expect(copyFileGuarded(src, dest, undefined, { attempts: 3, delayMs: 0 })).rejects.toBe(err);
      expect(fsPromises.copyFile).toHaveBeenCalledTimes(3);
    });
  });

  it('does not retry non-lock errors', async () => {
    restorePlatform = pinPlatform('win32');
    await withFiles(async (src, dest) => {
      const err = lockErr('ENOENT');
      fsPromises.copyFile.mockRejectedValue(err);
      await expect(copyFileGuarded(src, dest, undefined, { delayMs: 0 })).rejects.toBe(err);
      expect(fsPromises.copyFile).toHaveBeenCalledTimes(1);
    });
  });

  it('does not retry lock errors off win32', async () => {
    restorePlatform = pinPlatform('linux');
    await withFiles(async (src, dest) => {
      const err = lockErr('EBUSY');
      fsPromises.copyFile.mockRejectedValue(err);
      await expect(copyFileGuarded(src, dest, undefined, { delayMs: 0 })).rejects.toBe(err);
      expect(fsPromises.copyFile).toHaveBeenCalledTimes(1);
    });
  });
});

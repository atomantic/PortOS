import { describe, expect, it } from 'vitest';
import { parseFilesystemStats } from './fileCore.js';

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

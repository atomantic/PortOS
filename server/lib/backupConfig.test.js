import { describe, expect, it } from 'vitest';
import { MAX_RETENTION_COUNT, MIN_RETENTION_COUNT, resolveRetentionCount } from './backupConfig.js';

describe('resolveRetentionCount', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['above the maximum', MAX_RETENTION_COUNT + 1],
    ['fractional', 2.5],
    ['numeric string', '30'],
    ['null', null],
    ['missing', undefined]
  ])('returns unlimited for %s retention', (_label, retentionCount) => {
    expect(resolveRetentionCount({ retentionCount })).toBeNull();
  });

  it.each([MIN_RETENTION_COUNT, 30, MAX_RETENTION_COUNT])('accepts the valid count %s', retentionCount => {
    expect(resolveRetentionCount({ retentionCount })).toBe(retentionCount);
  });
});

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { isSeedSuppressed } from './mediaModels.js';

// #14112: a process running from a CoS claim worktree must not lazily seed an
// ignored registry into the checkout (it blocks retirement of the merged tree).
describe('media registry seed in claim worktrees', () => {
  const worktreeFile = join('/install', 'data', 'cos', 'worktrees', 'claim-x-issue-1', 'data', 'media-models.json');
  it('suppresses the lazy seed for a registry inside a worktree checkout', () => {
    expect(isSeedSuppressed(worktreeFile, null)).toBe(true);
  });
  it('still seeds a real install registry', () => {
    expect(isSeedSuppressed(join('/install', 'data', 'media-models.json'), null)).toBe(false);
  });
  it('honors an explicit registry path even inside a worktree (test fixture, disposable boot)', () => {
    expect(isSeedSuppressed(worktreeFile, worktreeFile)).toBe(false);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { join, sep } from 'path';
import { DATA_ROOT_ENV, resolveInstallRoot, isWorktreeRoot } from './dataRoot.js';

const REAL_ROOT = join(sep, 'Users', 'me', 'PortOS');

afterEach(() => {
  delete process.env[DATA_ROOT_ENV];
});

describe('resolveInstallRoot', () => {
  it('returns the fallback when PORTOS_DATA_ROOT is unset (backward compatible)', () => {
    delete process.env[DATA_ROOT_ENV];
    expect(resolveInstallRoot(REAL_ROOT)).toBe(REAL_ROOT);
  });

  it('returns the fallback when PORTOS_DATA_ROOT is blank', () => {
    process.env[DATA_ROOT_ENV] = '   ';
    expect(resolveInstallRoot(REAL_ROOT)).toBe(REAL_ROOT);
  });

  it('prefers an absolute PORTOS_DATA_ROOT over the fallback', () => {
    const pinned = join(sep, 'srv', 'portos');
    process.env[DATA_ROOT_ENV] = pinned;
    expect(resolveInstallRoot(REAL_ROOT)).toBe(pinned);
  });

  it('resolves a relative PORTOS_DATA_ROOT to an absolute path', () => {
    process.env[DATA_ROOT_ENV] = 'some/rel';
    const out = resolveInstallRoot(REAL_ROOT);
    expect(out).toBe(join(process.cwd(), 'some', 'rel'));
    expect(out).not.toBe(REAL_ROOT);
  });

  it('IGNORES the pin when the fallback is a worktree checkout (leak safety #1947)', () => {
    // A worktree-executing process must never honor a (possibly-leaked) pin —
    // resolving its data root to the live install would let worktree code
    // read/write real data. It stays on the worktree path instead.
    process.env[DATA_ROOT_ENV] = REAL_ROOT;
    const worktreeFallback = join(REAL_ROOT, 'data', 'cos', 'worktrees', 'agent-abc');
    expect(resolveInstallRoot(worktreeFallback)).toBe(worktreeFallback);
  });
});

describe('isWorktreeRoot', () => {
  it('detects a CoS agent worktree checkout by path segment', () => {
    const worktree = join(REAL_ROOT, 'data', 'cos', 'worktrees', 'agent-3afe1ffb');
    expect(isWorktreeRoot(worktree)).toBe(true);
  });

  it('detects a nested path under a worktree checkout', () => {
    const nested = join(REAL_ROOT, 'data', 'cos', 'worktrees', 'agent-x', 'server');
    expect(isWorktreeRoot(nested)).toBe(true);
  });

  it('treats the real install root as NOT a worktree (fresh install safe)', () => {
    expect(isWorktreeRoot(REAL_ROOT)).toBe(false);
  });

  it('does not false-positive on an unrelated data/ path', () => {
    expect(isWorktreeRoot(join(REAL_ROOT, 'data', 'cos', 'agents'))).toBe(false);
  });

  it('returns false for empty or non-string input', () => {
    expect(isWorktreeRoot('')).toBe(false);
    expect(isWorktreeRoot(undefined)).toBe(false);
    expect(isWorktreeRoot(null)).toBe(false);
  });
});

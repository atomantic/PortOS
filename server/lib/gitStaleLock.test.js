import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { STALE_GIT_LOCK_MIN_AGE_MS, clearStaleGitLock, clearStaleGitLocksIn, gitLockPathFromError, isStaleGitLock } from './gitStaleLock.js';

/** Old enough that no running git command could still hold it. */
const ABANDONED = STALE_GIT_LOCK_MIN_AGE_MS + 60_000;

// The message git actually prints, verbatim — the whole helper keys off this
// wording, so a paraphrase here would stop proving it parses the real thing.
const gitLockError = (path) => `fatal: Unable to create '${path}': File exists.\n\nAnother git process seems to be running in this repository, or the lock file may be stale`;

let dir;

/** A lock file whose mtime says it was created `ageMs` ago. */
function writeLock(relativePath, ageMs) {
  const full = join(dir, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, '');
  const seconds = (Date.now() - ageMs) / 1000;
  utimesSync(full, seconds, seconds);
  return full;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'git-stale-lock-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('gitLockPathFromError', () => {
  it('extracts the lock path git names in a contention failure', () => {
    expect(gitLockPathFromError(gitLockError('/repo/.git/modules/lib/slashdo/index.lock')))
      .toBe('/repo/.git/modules/lib/slashdo/index.lock');
  });

  it('extracts the lock path from ref-lock wording, not just index-lock wording', () => {
    const message = "error: cannot lock ref 'refs/heads/main': Unable to create '/repo/.git/refs/heads/main.lock': File exists";
    expect(gitLockPathFromError(message)).toBe('/repo/.git/refs/heads/main.lock');
  });

  it('returns null for a failure that is not lock contention', () => {
    expect(gitLockPathFromError("fatal: invalid reference: 'origin/nope'")).toBeNull();
    expect(gitLockPathFromError(undefined)).toBeNull();
  });
});

describe('isStaleGitLock', () => {
  it('accepts an abandoned lock under .git', () => {
    expect(isStaleGitLock(writeLock('.git/modules/lib/dep/index.lock', ABANDONED))).toBe(true);
  });

  it('refuses a lock young enough to belong to a running git command', () => {
    // The destructive half of the guard: a live `git worktree add` holds its
    // lock for as long as the checkout runs, and unlinking it corrupts that write.
    expect(isStaleGitLock(writeLock('.git/index.lock', 5 * 60_000))).toBe(false);
  });

  it('refuses a stale-aged .lock that is NOT under a .git directory', () => {
    // `yarn.lock` ends in `.lock` and lives in the repo root. Nothing may aim
    // the unlink at a repository file, however old it is.
    expect(isStaleGitLock(writeLock('yarn.lock', STALE_GIT_LOCK_MIN_AGE_MS * 10))).toBe(false);
  });

  it('refuses a path that is not a lock file at all', () => {
    expect(isStaleGitLock(writeLock('.git/index', STALE_GIT_LOCK_MIN_AGE_MS * 10))).toBe(false);
  });

  it('refuses a lock that is already gone', () => {
    expect(isStaleGitLock(join(dir, '.git/index.lock'))).toBe(false);
  });
});

describe('clearStaleGitLock', () => {
  it('removes the abandoned lock named by a git error and reports the path', () => {
    const lock = writeLock('.git/modules/lib/dep/index.lock', ABANDONED);

    expect(clearStaleGitLock(gitLockError(lock))).toBe(lock);
    expect(existsSync(lock)).toBe(false);
  });

  it('leaves a live competitor\'s lock on disk and reports nothing cleared', () => {
    const lock = writeLock('.git/index.lock', 60_000);

    expect(clearStaleGitLock(gitLockError(lock))).toBeNull();
    expect(existsSync(lock)).toBe(true);
  });

  it('reports nothing cleared for a failure that names no lock', () => {
    expect(clearStaleGitLock('fatal: not a git repository')).toBeNull();
  });
});

describe('clearStaleGitLocksIn', () => {
  it('sweeps abandoned locks anywhere under the git dir, submodules included', () => {
    // The wedge this exists for: the parent index lock and a submodule lock in
    // .git/modules/, which every worktree of the repo shares.
    const index = writeLock('.git/index.lock', ABANDONED);
    const submodule = writeLock('.git/modules/lib/dep/index.lock', ABANDONED);
    const ref = writeLock('.git/refs/heads/main.lock', ABANDONED);

    expect(clearStaleGitLocksIn(join(dir, '.git')).sort()).toEqual([index, submodule, ref].sort());
    for (const lock of [index, submodule, ref]) expect(existsSync(lock)).toBe(false);
  });

  it('leaves a lock a running git command may still hold', () => {
    const live = writeLock('.git/index.lock', 60_000);

    expect(clearStaleGitLocksIn(join(dir, '.git'))).toEqual([]);
    expect(existsSync(live)).toBe(true);
  });

  it('does not walk objects/, where the sweep would pay for tens of thousands of entries', () => {
    const inObjects = writeLock('.git/objects/pack/tmp.lock', ABANDONED);

    expect(clearStaleGitLocksIn(join(dir, '.git'))).toEqual([]);
    expect(existsSync(inObjects)).toBe(true);
  });

  it('reports nothing for a repo with no git dir', () => {
    expect(clearStaleGitLocksIn(join(dir, 'nope'))).toEqual([]);
  });

  // Every CoS agent runs in a worktree, where `.git` is a FILE pointing at
  // `<common>/.git/worktrees/<name>` — and the lock that wedges submodule
  // checkout is not in there, it is in the COMMON dir both trees share.
  it('follows a worktree\'s .git FILE out to the shared common dir', () => {
    const shared = writeLock('.git/modules/lib/dep/index.lock', ABANDONED);
    const worktreeGitDir = join(dir, '.git/worktrees/agent-1');
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeGitDir, 'commondir'), '../..\n');
    mkdirSync(join(dir, 'tree'), { recursive: true });
    const pointerFile = join(dir, 'tree/.git');
    writeFileSync(pointerFile, `gitdir: ${worktreeGitDir}\n`);

    expect(clearStaleGitLocksIn(pointerFile)).toEqual([shared]);
    expect(existsSync(shared)).toBe(false);
  });
});

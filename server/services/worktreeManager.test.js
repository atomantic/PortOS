import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

// Stub every git operation; lifecycle tests exercise the real service without
// creating, changing or removing a live repository.
const execGitMock = vi.fn();
vi.mock('../lib/execGit.js', () => ({ execGit: (...args) => execGitMock(...args) }));

// Stub filesystem effects as well as git so destructive cleanup stays in fixtures.
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  realpathSync: vi.fn((p) => p),
}));
vi.mock('fs/promises', () => ({
  lstat: vi.fn().mockResolvedValue({}),
  readdir: vi.fn().mockResolvedValue([]),
  rm: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  readlink: vi.fn().mockResolvedValue(''),
  symlink: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  // adoptWorktree ensures the worktrees root exists before moving a tree into it.
  mkdir: vi.fn().mockResolvedValue(undefined),
}));
// The retry path asks whether the lock it just hit was abandoned. Mocked here
// (the `fs` stub above has no `statSync`, and real mtimes would make this a
// clock test); `lib/gitStaleLock.test.js` owns which locks it agrees to remove.
const clearStaleGitLockMock = vi.fn().mockReturnValue(null);
vi.mock('../lib/gitStaleLock.js', () => ({ clearStaleGitLock: (...args) => clearStaleGitLockMock(...args) }));
vi.mock('./instanceIdentity.js', () => ({ ensureInstanceId: vi.fn().mockResolvedValue('instance-1') }));
const getDefaultBranchMock = vi.fn().mockResolvedValue('main');
const hasBranchMergeEvidenceMock = vi.fn().mockResolvedValue(false);
vi.mock('./git.js', () => ({
  getDefaultBranch: (...args) => getDefaultBranchMock(...args),
  hasBranchMergeEvidence: (...args) => hasBranchMergeEvidenceMock(...args),
}));

const {
  shouldRefuseDefaultBranchMerge,
  isHumanClaimWorktree,
  classifyWorktreeDirt,
  isGitLockError,
  addWorktreeWithRetry,
  isPreexistingRefError,
  isBranchCheckedOutElsewhereError,
  removeWorktree,
  adoptWorktree,
  findAdoptableWorktreeForBranch,
  createWorktree,
  createPersistentWorktree,
  linkWorktreeDependencies,
  unlinkWorktreeDependencies,
  listWorktrees,
  cleanupOrphanedWorktrees,
  WORKTREE_ADD_TIMEOUT_MS,
} = await import('./worktreeManager.js');
const { isPathInsideDir } = await import('../lib/fileUtils.js');
const { win32 } = await import('path');
const { existsSync, realpathSync } = await import('fs');
const { lstat, readdir, rm, stat, readlink, symlink, unlink } = await import('fs/promises');
const { PATHS } = await import('../lib/fileUtils.js');

describe('Worktree dependency preparation', () => {
  const directories = ['client', 'server', 'admin', 'uninstalled', 'assets', '.hidden', 'node_modules', 'nested'];
  const missing = () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  const normalize = path => path.replaceAll('\\', '/');

  beforeEach(() => {
    lstat.mockReset();
    readlink.mockReset();
    symlink.mockClear();
    unlink.mockClear();
    existsSync.mockImplementation(path => normalize(path) === '/repo/nested/.git');
    readdir.mockResolvedValue([
      ...directories.map(name => ({ name, isDirectory: () => true })),
      { name: 'linked-package', isDirectory: () => false },
    ]);
    stat.mockImplementation(path => normalize(path) === '/repo/uninstalled/node_modules'
      ? missing() : Promise.resolve({ isDirectory: () => true }));
    lstat.mockImplementation(path => {
      const normalized = normalize(path);
      if (directories.filter(name => name !== 'node_modules').some(name => normalized === `/repo/${name}`)) {
        return Promise.resolve({ isDirectory: () => true });
      }
      if (normalized.endsWith('/package.json') && normalized !== '/worktree/assets/package.json') {
        return Promise.resolve({ isFile: () => true });
      }
      return missing();
    });
  });

  afterEach(() => {
    lstat.mockReset().mockResolvedValue({});
    readdir.mockReset().mockResolvedValue([]);
    stat.mockReset().mockResolvedValue({ isDirectory: () => true });
    existsSync.mockReset().mockReturnValue(true);
  });

  it('links installed immediate packages including admin and skips non-packages, hidden and nested repos', async () => {
    await linkWorktreeDependencies('/repo', '/worktree');

    expect(symlink.mock.calls.map(([source, target]) => [normalize(source), normalize(target)]))
      .toEqual(expect.arrayContaining(['', '/client', '/server', '/admin'].map(part => [
        `/repo${part}/node_modules`, `/worktree${part}/node_modules`,
      ])));
    expect(symlink).toHaveBeenCalledTimes(4);
  });

  it('preserves existing real directories and foreign links', async () => {
    const original = lstat.getMockImplementation();
    lstat.mockImplementation(path => normalize(path).endsWith('/node_modules')
      ? Promise.resolve({ isSymbolicLink: () => normalize(path).includes('/admin/') })
      : original(path));

    await linkWorktreeDependencies('/repo', '/worktree');
    expect(symlink).not.toHaveBeenCalled();
  });

  it('removes only owned links including admin, even if source dependencies were removed', async () => {
    lstat.mockImplementation(path => {
      const normalized = normalize(path);
      if (['/worktree/node_modules', '/worktree/admin/node_modules', '/worktree/client/node_modules', '/worktree/server/node_modules'].includes(normalized)) {
        return Promise.resolve({ isSymbolicLink: () => normalized !== '/worktree/client/node_modules' });
      }
      return missing();
    });
    stat.mockImplementation(missing);
    readlink.mockImplementation(path => Promise.resolve(normalize(path).includes('/server/')
      ? join('/foreign', 'node_modules')
      : path.replace('worktree', 'repo')));

    await unlinkWorktreeDependencies('/repo', '/worktree');

    expect(unlink.mock.calls.map(([path]) => normalize(path)).sort()).toEqual([
      '/worktree/admin/node_modules', '/worktree/node_modules',
    ]);
  });
});

describe('classifyWorktreeDirt (real exported helper)', () => {
  it('reports clean for empty / whitespace-only porcelain', () => {
    expect(classifyWorktreeDirt('')).toEqual({ clean: true, lockfileOnly: false, lockfilePaths: [], realChangePaths: [], hasRealChanges: false });
    expect(classifyWorktreeDirt('  \n  ').clean).toBe(true);
    expect(classifyWorktreeDirt(null).clean).toBe(true);
  });

  it('flags real (non-lockfile) changes', () => {
    const r = classifyWorktreeDirt(' M src/index.js');
    expect(r.clean).toBe(false);
    expect(r.hasRealChanges).toBe(true);
    expect(r.lockfileOnly).toBe(false);
  });

  it('recognizes a lockfile-only working tree and extracts paths', () => {
    const r = classifyWorktreeDirt(' M package-lock.json\n M client/package-lock.json');
    expect(r.lockfileOnly).toBe(true);
    expect(r.hasRealChanges).toBe(false);
    expect(r.lockfilePaths).toEqual(['package-lock.json', 'client/package-lock.json']);
  });

  it('treats mixed lockfile + real changes as real changes', () => {
    const r = classifyWorktreeDirt(' M package-lock.json\n M src/app.js');
    expect(r.lockfileOnly).toBe(false);
    expect(r.hasRealChanges).toBe(true);
  });

  // realChangePaths feeds branch reconciliation's supersession check — it
  // intersects them with what the default branch changed since the branch
  // diverged, so the paths must be bare and lockfile-free.
  it('extracts the non-lockfile paths, excluding lockfiles and untangling renames', () => {
    const r = classifyWorktreeDirt(' M package-lock.json\n M src/app.js\n?? src/new.js\nR  src/old.js -> src/renamed.js');
    expect(r.realChangePaths).toEqual(['src/app.js', 'src/new.js', 'src/renamed.js']);
    expect(r.realChangePaths).not.toContain('package-lock.json');
  });

  it('handles a trimmed first line (no leading status space)', () => {
    const r = classifyWorktreeDirt('M yarn.lock');
    expect(r.lockfileOnly).toBe(true);
    expect(r.lockfilePaths).toEqual(['yarn.lock']);
  });

  it('can ignore a consumed completion sentinel without hiding real work', () => {
    expect(classifyWorktreeDirt('?? .agent-done', { ignoredPaths: ['.agent-done'] }).clean).toBe(true);

    const r = classifyWorktreeDirt('?? .agent-done\n M src/index.js', { ignoredPaths: ['.agent-done'] });
    expect(r.hasRealChanges).toBe(true);
    expect(r.realChangePaths).toEqual(['src/index.js']);
  });

  it('ignores the per-agent sentinel name without hiding real work', () => {
    // The sentinel filename carries the agent id (see doneSentinelName), so the
    // caller passes THIS run's name — not a wildcard that would also swallow a
    // sibling agent's sentinel.
    const ignoredPaths = ['.agent-done', '.agent-done-agent-1'];
    expect(classifyWorktreeDirt('?? .agent-done-agent-1', { ignoredPaths }).clean).toBe(true);

    const r = classifyWorktreeDirt('?? .agent-done-agent-1\n M src/index.js', { ignoredPaths });
    expect(r.hasRealChanges).toBe(true);
    expect(r.realChangePaths).toEqual(['src/index.js']);
    // Another agent's sentinel is NOT ignored — an unrelated run's file in a
    // shared checkout is still dirt this caller must not silently discard.
    expect(classifyWorktreeDirt('?? .agent-done-agent-2', { ignoredPaths }).clean).toBe(false);
  });

  // PortOS materializes the public-review bundle INTO the worktree it hands a
  // reviewer model and never commits it. Subtracted for EVERY caller rather than
  // passed in per call: counted as work, it made `removeWorktree` preserve the
  // tree, `reapMergedWorktrees` hold it, and branch-reconcile spend a coordinator
  // run per pass concluding "no real work product, a human should discard it".
  it('subtracts PortOS runtime scratch with no ignoredPaths from the caller', () => {
    expect(classifyWorktreeDirt('?? PORTOS_PUBLIC_REVIEW_INPUT.json').clean).toBe(true);
    // Untracked directories arrive collapsed to their root…
    expect(classifyWorktreeDirt('?? .portos-public-review/').clean).toBe(true);
    // …and expanded to files under -uall.
    expect(classifyWorktreeDirt('?? .portos-public-review/PR-42.patch').clean).toBe(true);
    expect(classifyWorktreeDirt('?? PORTOS_PUBLIC_REVIEW_INPUT.json\n?? .portos-public-review/').clean).toBe(true);
  });

  it('still reports real work sitting beside the scratch', () => {
    const r = classifyWorktreeDirt('?? PORTOS_PUBLIC_REVIEW_INPUT.json\n M src/index.js');
    expect(r.hasRealChanges).toBe(true);
    expect(r.realChangePaths).toEqual(['src/index.js']);
    // A sibling that merely shares the prefix is real work, not scratch.
    expect(classifyWorktreeDirt('?? .portos-public-review-notes.md').hasRealChanges).toBe(true);
  });
});

// Git reports POSIX separators on every platform, while PATHS.worktrees is
// backslash-separated on Windows — so a bare `startsWith` matched nothing there:
// `cleanupOrphanedWorktrees` skipped every CoS worktree and `reapMergedWorktrees`
// filed them all as `unmanaged-location`, which is why the daily line read
// "reaped 0 merged + 0 orphaned" on a Windows install with orphans on disk.
// These pin the properties the module RELIES ON from the shared helpers, so a
// change to either one surfaces here rather than as silent dead cleanup.
describe('git-vs-PortOS path comparison', () => {
  it('matches a git-reported POSIX path against a Windows worktrees dir', () => {
    // win32-only: `resolvePath` folds `/` to `\` on Windows, which is what makes
    // the mixed-separator comparison work. On POSIX a backslash is a legal
    // filename character, so this case can't arise and isn't asserted.
    if (process.platform !== 'win32') return;
    expect(isPathInsideDir('H:\\repo\\data\\cos\\worktrees', 'H:/repo/data/cos/worktrees/agent-abc')).toBe(true);
  });

  it('does not match a sibling directory that merely shares a prefix', () => {
    expect(isPathInsideDir('/repo/data/cos/worktrees', '/repo/data/cos/worktrees-old/agent-abc')).toBe(false);
  });

  it('does not treat the directory itself as being under itself', () => {
    expect(isPathInsideDir('/repo/data/cos/worktrees', '/repo/data/cos/worktrees')).toBe(false);
  });

  it('reads the agent id off either separator', () => {
    expect(win32.basename('H:/repo/data/cos/worktrees/agent-abc')).toBe('agent-abc');
    expect(win32.basename('H:\\repo\\data\\cos\\worktrees\\agent-abc')).toBe('agent-abc');
  });
});

describe('isHumanClaimWorktree', () => {
  it('is true for /claim worktree dir names', () => {
    expect(isHumanClaimWorktree('claim-extract-compare-helpers')).toBe(true);
    expect(isHumanClaimWorktree('claim-codex5-onboarding-capability-map')).toBe(true);
  });

  it('is false for CoS agent worktree dir names', () => {
    expect(isHumanClaimWorktree('agent-1a2b3c4d')).toBe(false);
    expect(isHumanClaimWorktree('cos-task-xyz')).toBe(false);
  });

  it('is false for non-string / empty input (fail safe)', () => {
    expect(isHumanClaimWorktree(undefined)).toBe(false);
    expect(isHumanClaimWorktree(null)).toBe(false);
    expect(isHumanClaimWorktree('')).toBe(false);
  });
});

describe('Default-Branch Merge Gate (defense-in-depth)', () => {
  it('allows merge when source repo HEAD matches the default branch', () => {
    expect(shouldRefuseDefaultBranchMerge('main', 'main')).toBe(false);
  });

  it('allows merge for a non-main default (e.g. master, dev)', () => {
    expect(shouldRefuseDefaultBranchMerge('master', 'master')).toBe(false);
    expect(shouldRefuseDefaultBranchMerge('develop', 'develop')).toBe(false);
  });

  it('refuses merge when HEAD is on a TUI claim branch', () => {
    expect(shouldRefuseDefaultBranchMerge('claim/extend-syncorchestrator', 'main')).toBe(true);
  });

  it('refuses merge when HEAD is on any feature branch', () => {
    expect(shouldRefuseDefaultBranchMerge('feature/x', 'main')).toBe(true);
    expect(shouldRefuseDefaultBranchMerge('fix/bug-123', 'main')).toBe(true);
  });

  it('refuses merge when HEAD is on another in-flight CoS branch', () => {
    expect(shouldRefuseDefaultBranchMerge('cos/task-abc/agent-xyz', 'main')).toBe(true);
  });

  it('refuses merge when default branch detection failed (fail closed)', () => {
    expect(shouldRefuseDefaultBranchMerge('main', null)).toBe(true);
    expect(shouldRefuseDefaultBranchMerge('main', '')).toBe(true);
    expect(shouldRefuseDefaultBranchMerge('main', undefined)).toBe(true);
  });

  it('refuses merge when source repo HEAD is unknown', () => {
    expect(shouldRefuseDefaultBranchMerge('', 'main')).toBe(true);
    expect(shouldRefuseDefaultBranchMerge(null, 'main')).toBe(true);
    expect(shouldRefuseDefaultBranchMerge(undefined, 'main')).toBe(true);
  });

  it('refuses merge when both inputs are missing', () => {
    expect(shouldRefuseDefaultBranchMerge(null, null)).toBe(true);
  });
});

describe('isGitLockError (worktree add lock detection, #2193)', () => {
  it('recognizes the canonical worktree/index lock errors', () => {
    expect(isGitLockError("fatal: Unable to create '/repo/.git/worktrees/agent-x/index.lock': File exists.")).toBe(true);
    expect(isGitLockError('fatal: could not lock config file .git/config: File exists')).toBe(true);
    expect(isGitLockError('error: cannot lock ref')).toBe(true);
    expect(isGitLockError('Another git process seems to be running in this repository')).toBe(true);
  });

  it('does NOT flag permanent failures — including "already exists", which is NOT lock contention', () => {
    // These fast-fail identically on every retry, so matching them would just
    // burn the retry budget and spam misleading "lock contention" logs (#2193).
    expect(isGitLockError("fatal: invalid reference: origin/nope")).toBe(false);
    expect(isGitLockError('fatal: not a valid object name')).toBe(false);
    expect(isGitLockError("fatal: '/repo/data/cos/worktrees/agent-x' already exists")).toBe(false);
    expect(isGitLockError("fatal: a branch named 'cos/task/agent' already exists")).toBe(false);
    expect(isGitLockError('')).toBe(false);
    expect(isGitLockError(undefined)).toBe(false);
  });

  // A per-file checkout failure is NOT lock contention. It reads "unable to
  // create", but it only happens after git has written most of the tree — so
  // retrying it costs a full checkout per attempt. With the 10-minute add
  // timeout that is 4 × 10 min of head-of-line blocking on the per-repo queue,
  // for an error that never clears. This is the Windows AV-filter failure mode
  // the long timeout exists to tolerate, so the two must not compound.
  it('does NOT flag a per-file checkout failure as lock contention', () => {
    expect(isGitLockError('error: unable to create file some/deep/path.js: Permission denied')).toBe(false);
    expect(isGitLockError('error: unable to create symlink foo/bar: Operation not permitted')).toBe(false);
  });

  it('still flags a genuine lock-FILE creation failure', () => {
    expect(isGitLockError("fatal: Unable to create '/repo/.git/config.lock': File exists")).toBe(true);
  });
});

// Windows git emits CRLF, and a bare split('\n') leaves a trailing \r on every
// parsed value. That is invisible on Linux and silently breaks the reaper on
// Windows: the path and branch carry the \r so containment and equality match
// nothing, and the flag lines stop comparing equal so bare/detached/locked/
// prunable all read false. It failed a real Windows CI job for hours while every
// Linux run stayed green, so the contract is pinned against BOTH line endings.
describe('listWorktrees line endings', () => {
  beforeEach(() => { execGitMock.mockReset(); });

  const PORCELAIN = [
    'worktree /repo',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /repo/.claude/worktrees/wt',
    'HEAD def456',
    'branch refs/heads/feature',
    'locked',
    'prunable',
    '',
    'worktree /repo/detached',
    'HEAD fed789',
    'detached',
    '',
    'worktree /repo/bare',
    'bare',
  ];

  it.each([['LF', '\n'], ['CRLF', '\r\n']])('parses %s porcelain identically', async (_label, eol) => {
    execGitMock.mockResolvedValueOnce({ stdout: PORCELAIN.join(eol), stderr: '', exitCode: 0 });

    const worktrees = await listWorktrees('/repo');

    expect(worktrees).toHaveLength(4);
    // No stray \r anywhere — these values are compared against filesystem paths
    // and branch names, where a trailing carriage return matches nothing.
    expect(worktrees[0]).toMatchObject({ path: '/repo', head: 'abc123', branch: 'refs/heads/main' });
    expect(worktrees[1]).toMatchObject({
      path: '/repo/.claude/worktrees/wt',
      head: 'def456',
      branch: 'refs/heads/feature',
      locked: true,
      prunable: true,
    });
    expect(worktrees[2]).toEqual({ path: '/repo/detached', head: 'fed789', detached: true });
    expect(worktrees[3]).toEqual({ path: '/repo/bare', bare: true });
  });

  it('returns an empty inventory when git lists no worktrees', async () => {
    execGitMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    expect(await listWorktrees('/repo')).toEqual([]);
  });
});

describe('addWorktreeWithRetry (lock-contention retry, #2193)', () => {
  beforeEach(() => {
    execGitMock.mockReset();
    clearStaleGitLockMock.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves without retrying on first-attempt success', async () => {
    execGitMock.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    await addWorktreeWithRetry(['worktree', 'add', '/wt', 'main'], '/repo');
    expect(execGitMock).toHaveBeenCalledTimes(1);
  });

  // See WORKTREE_ADD_TIMEOUT_MS for why 30s was not enough.
  it('gives the add far more than execGit\'s 30s default, since it writes a full checkout', async () => {
    execGitMock.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    await addWorktreeWithRetry(['worktree', 'add', '/wt', 'main'], '/repo');
    const [, , options] = execGitMock.mock.calls[0];
    expect(options?.timeout).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });

  it('does NOT retry a timeout — git is still running and would collide with itself', async () => {
    execGitMock.mockRejectedValueOnce(new Error('git command timed out after 600s: git worktree add -b cos/t/a /wt origin/main'));
    await expect(addWorktreeWithRetry(['worktree', 'add', '-b', 'cos/t/a', '/wt', 'origin/main'], '/repo'))
      .rejects.toThrow(/timed out/);
    expect(execGitMock).toHaveBeenCalledTimes(1);
  });

  it('retries a lock error then succeeds', async () => {
    execGitMock
      .mockRejectedValueOnce(new Error("Unable to create '/repo/.git/index.lock': File exists"))
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    const p = addWorktreeWithRetry(['worktree', 'add', '/wt', 'main'], '/repo');
    await vi.runAllTimersAsync();
    await p;
    expect(execGitMock).toHaveBeenCalledTimes(2);
  });

  // Retrying alone cannot clear an ABANDONED lock — nothing is coming to
  // release it, so all four attempts would fail and block the task.
  it('tries to clear an abandoned lock before backing off', async () => {
    const lockError = new Error("Unable to create '/repo/.git/index.lock': File exists");
    execGitMock
      .mockRejectedValueOnce(lockError)
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    const p = addWorktreeWithRetry(['worktree', 'add', '/wt', 'main'], '/repo');
    await vi.runAllTimersAsync();
    await p;
    expect(clearStaleGitLockMock).toHaveBeenCalledWith(lockError.message);
  });

  // `STALE_GIT_LOCK_MIN_AGE_MS`'s safety argument is "3x the longest git command
  // PortOS can have in flight", and that ceiling is THIS constant — in another
  // file, where raising it would silently erode the headroom and let the sweep
  // unlink a live `git worktree add`'s lock mid-checkout.
  it('keeps the stale-lock threshold clear of the longest git command in flight', async () => {
    const { STALE_GIT_LOCK_MIN_AGE_MS } = await vi.importActual('../lib/gitStaleLock.js');
    expect(STALE_GIT_LOCK_MIN_AGE_MS).toBeGreaterThanOrEqual(3 * WORKTREE_ADD_TIMEOUT_MS);
  });

  it('gives up after the max attempts on persistent lock contention', async () => {
    execGitMock.mockRejectedValue(new Error('cannot lock ref'));
    const p = addWorktreeWithRetry(['worktree', 'add', '/wt', 'main'], '/repo');
    const assertion = expect(p).rejects.toThrow(/cannot lock ref/);
    await vi.runAllTimersAsync();
    await assertion;
    // WORKTREE_ADD_MAX_ATTEMPTS === 4
    expect(execGitMock).toHaveBeenCalledTimes(4);
  });

  it('does NOT retry a non-lock (permanent) error', async () => {
    execGitMock.mockRejectedValueOnce(new Error('fatal: invalid reference: origin/nope'));
    await expect(addWorktreeWithRetry(['worktree', 'add', '/wt', 'origin/nope'], '/repo'))
      .rejects.toThrow(/invalid reference/);
    expect(execGitMock).toHaveBeenCalledTimes(1);
    // …and nothing reached for the unlink: a failure that named no lock must
    // never put the stale-lock sweep in motion.
    expect(clearStaleGitLockMock).not.toHaveBeenCalled();
  });

  it('does NOT retry an "already exists" precondition failure', async () => {
    execGitMock.mockRejectedValueOnce(new Error("fatal: a branch named 'cos/task/agent' already exists"));
    await expect(addWorktreeWithRetry(['worktree', 'add', '-b', 'cos/task/agent', '/wt', 'main'], '/repo'))
      .rejects.toThrow(/already exists/);
    expect(execGitMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the FIRST attempt error so a retry-induced "already exists" cannot mask the real cause', async () => {
    // Attempt 1 creates the branch then fails on a lock error; attempt 2 then
    // fails with a self-inflicted "branch already exists". The final rejection
    // must carry the ORIGINAL lock error so orphan cleanup still runs (#2193).
    execGitMock
      .mockRejectedValueOnce(new Error('error: cannot lock ref (attempt 1 created the branch)'))
      .mockRejectedValueOnce(new Error("fatal: a branch named 'cos/task/agent' already exists"));
    const settled = addWorktreeWithRetry(['worktree', 'add', '-b', 'cos/task/agent', '/wt', 'main'], '/repo').catch(e => e);
    await vi.runAllTimersAsync();
    const err = await settled;
    expect(err.message).toMatch(/already exists/);
    expect(err.firstAttemptError.message).toMatch(/cannot lock ref/);
    expect(execGitMock).toHaveBeenCalledTimes(2);
  });

  it('sets firstAttemptError to the sole error when the first attempt is non-retryable', async () => {
    const only = new Error("fatal: a branch named 'cos/task/agent' already exists");
    execGitMock.mockRejectedValueOnce(only);
    const err = await addWorktreeWithRetry(['worktree', 'add', '-b', 'cos/task/agent', '/wt', 'main'], '/repo').catch(e => e);
    expect(err.firstAttemptError).toBe(only);
  });
});

describe('isPreexistingRefError (orphan-cleanup guard, #2193)', () => {
  it('is true ONLY for a pre-existing BRANCH (git created nothing → skip cleanup)', () => {
    expect(isPreexistingRefError("fatal: a branch named 'cos/task/agent' already exists")).toBe(true);
    expect(isPreexistingRefError("fatal: a branch named 'main' already exists.")).toBe(true);
  });

  it('is FALSE for an occupied worktree PATH — git already created the branch there, so it IS an orphan to clean up', () => {
    expect(isPreexistingRefError("fatal: '/repo/data/cos/worktrees/agent-x' already exists")).toBe(false);
  });

  it('is false for lock contention and other failures (add may have left an orphan)', () => {
    expect(isPreexistingRefError('error: cannot lock ref')).toBe(false);
    expect(isPreexistingRefError('fatal: invalid reference')).toBe(false);
    expect(isPreexistingRefError('')).toBe(false);
    expect(isPreexistingRefError(undefined)).toBe(false);
  });
});

describe('isBranchCheckedOutElsewhereError (branch-busy pause gate)', () => {
  it('matches git\'s wording for a branch held by another worktree, old and new', () => {
    // Current git.
    expect(isBranchCheckedOutElsewhereError(
      "fatal: 'cos/task-x/agent-y' is already used by worktree at '/repo/data/cos/worktrees/agent-y'"
    )).toBe(true);
    // Pre-2.30 wording.
    expect(isBranchCheckedOutElsewhereError(
      "fatal: 'cos/task-x/agent-y' is already checked out at '/repo/data/cos/worktrees/agent-y'"
    )).toBe(true);
  });

  it('does NOT match the other "already exists" failures — those are permanent', () => {
    // An occupied worktree DIRECTORY is not a branch another tree is holding;
    // pausing on it would wait out a cooldown that can never clear it.
    expect(isBranchCheckedOutElsewhereError("fatal: '/repo/data/cos/worktrees/agent-x' already exists")).toBe(false);
    expect(isBranchCheckedOutElsewhereError("fatal: a branch named 'cos/task/agent' already exists")).toBe(false);
    expect(isBranchCheckedOutElsewhereError('error: cannot lock ref')).toBe(false);
    expect(isBranchCheckedOutElsewhereError('fatal: invalid reference: origin/nope')).toBe(false);
    expect(isBranchCheckedOutElsewhereError('')).toBe(false);
    expect(isBranchCheckedOutElsewhereError(undefined)).toBe(false);
  });

  it('stays out of the in-process add retry — that budget is sized for lock contention', () => {
    expect(isGitLockError("fatal: 'b' is already used by worktree at '/repo/wt'")).toBe(false);
  });
});

describe('findAdoptableWorktreeForBranch (take over the tree that holds the branch)', () => {
  const REPO = '/repo';
  const BRANCH = 'cos/task-x/agent-y';

  // `git worktree list --porcelain`: the primary checkout first, then whatever
  // entries a test names.
  function scriptWorktrees(entries) {
    execGitMock.mockReset();
    const stdout = [
      `worktree ${REPO}`, 'HEAD abc123', 'branch refs/heads/main', '',
      ...entries.flatMap(e => [
        `worktree ${e.path}`, 'HEAD def456',
        e.branch ? `branch ${e.branch}` : 'detached',
        ...(e.locked ? ['locked'] : []), ''
      ])
    ].join('\n');
    execGitMock.mockResolvedValue({ stdout, stderr: '' });
  }

  const cosTree = (agentId) => join(PATHS.worktrees, agentId);

  it('finds the CoS worktree holding the branch', async () => {
    scriptWorktrees([{ path: cosTree('agent-y'), branch: `refs/heads/${BRANCH}` }]);

    expect(await findAdoptableWorktreeForBranch(REPO, BRANCH))
      .toEqual({ path: cosTree('agent-y'), agentId: 'agent-y' });
  });

  it('returns null when nothing holds the branch', async () => {
    scriptWorktrees([{ path: cosTree('agent-z'), branch: 'refs/heads/cos/other/agent-z' }]);

    expect(await findAdoptableWorktreeForBranch(REPO, BRANCH)).toBeNull();
  });

  // Adoption MOVES the directory, so a holder PortOS doesn't own is never a
  // candidate — taking the user's own checkout is the branch-jacking this
  // codebase guards against everywhere else.
  it('refuses the primary checkout, and any tree outside the managed root', async () => {
    scriptWorktrees([{ path: '/repo/../elsewhere/tree', branch: `refs/heads/${BRANCH}` }]);
    expect(await findAdoptableWorktreeForBranch(REPO, BRANCH)).toBeNull();

    // The repo root itself, checked out on the branch.
    execGitMock.mockResolvedValue({
      stdout: `worktree ${REPO}\nHEAD abc\nbranch refs/heads/${BRANCH}\n`, stderr: ''
    });
    expect(await findAdoptableWorktreeForBranch(REPO, BRANCH)).toBeNull();
  });

  it('refuses a human /claim worktree — the claim flow owns its cleanup', async () => {
    scriptWorktrees([{ path: cosTree('claim-issue-42'), branch: `refs/heads/${BRANCH}` }]);

    expect(await findAdoptableWorktreeForBranch(REPO, BRANCH)).toBeNull();
  });

  // A review-loop resolve-and-merge follow-up is the one caller that names this
  // exact branch as the thing it exists to finish and land, so it opts in via
  // `allowLiveClaim` instead of retrying `git worktree add` against a branch a
  // `/do:next` claim already holds (#6243).
  it('adopts a human /claim worktree when the caller opts into allowLiveClaim', async () => {
    scriptWorktrees([{ path: cosTree('claim-issue-42'), branch: `refs/heads/${BRANCH}` }]);

    expect(await findAdoptableWorktreeForBranch(REPO, BRANCH, { allowLiveClaim: true }))
      .toEqual({ path: cosTree('claim-issue-42'), agentId: 'claim-issue-42' });
  });

  it('refuses a non-agent directory in the managed root', async () => {
    scriptWorktrees([{ path: cosTree('next-issue-42'), branch: `refs/heads/${BRANCH}` }]);

    expect(await findAdoptableWorktreeForBranch(REPO, BRANCH)).toBeNull();
  });

  it('refuses a tree whose agent is still running — it is mid-edit in there', async () => {
    scriptWorktrees([{ path: cosTree('agent-y'), branch: `refs/heads/${BRANCH}` }]);

    expect(await findAdoptableWorktreeForBranch(REPO, BRANCH, {
      activeAgentIds: new Set(['agent-y'])
    })).toBeNull();
  });

  it('refuses a locked worktree whatever else is true of it', async () => {
    scriptWorktrees([{ path: cosTree('agent-y'), branch: `refs/heads/${BRANCH}`, locked: true }]);

    expect(await findAdoptableWorktreeForBranch(REPO, BRANCH)).toBeNull();
  });

  it('returns null rather than throwing when the listing fails', async () => {
    execGitMock.mockReset();
    execGitMock.mockRejectedValue(new Error('not a git repository'));

    expect(await findAdoptableWorktreeForBranch(REPO, BRANCH)).toBeNull();
    expect(await findAdoptableWorktreeForBranch(REPO, '')).toBeNull();
    expect(await findAdoptableWorktreeForBranch('', BRANCH)).toBeNull();
  });
});

describe('removeWorktree identity, dirt and branch preservation', () => {
  // Routes each git invocation this path makes to a scripted answer, keyed on the
  // subcommand, so a test only has to state what it cares about instead of
  // ordering every call. The preserve/delete decision itself comes from the
  // mocked `hasBranchMergeEvidence` (see the ./git.js mock at the top of this file).
  function scriptGit({ porcelain = '', remoteTargetResolves = true, detectedToplevel } = {}) {
    execGitMock.mockReset();
    execGitMock.mockImplementation((args, cwd) => {
      const [sub] = args;
      // Whether this clone has an `origin/<default>` to prefer over the local branch.
      if (sub === 'rev-parse' && args[1] === '--verify' && String(args[2]).startsWith('origin/')) {
        return Promise.resolve({ stdout: remoteTargetResolves ? 'deadbeef' : '', stderr: '', exitCode: remoteTargetResolves ? 0 : 1 });
      }
      if (sub === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
        return Promise.resolve({ stdout: 'main', stderr: '', exitCode: 0 });
      }
      if (sub === 'rev-parse' && args[1] === '--show-toplevel') {
        return Promise.resolve({ stdout: detectedToplevel ?? cwd, stderr: '', exitCode: 0 });
      }
      if (sub === 'status') return Promise.resolve({ stdout: porcelain, stderr: '', exitCode: 0 });
      if (sub === 'rev-list') return Promise.resolve({ stdout: '0\n', stderr: '', exitCode: 0 });
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });
  }

  const calledWith = (subcommandArgs) =>
    execGitMock.mock.calls.some(([args]) => JSON.stringify(args) === JSON.stringify(subcommandArgs));

  beforeEach(() => {
    getDefaultBranchMock.mockResolvedValue('main');
    // mockReset (not just mockResolvedValue): the opt-in test asserts the merged
    // check was NOT consulted, so recorded calls must not leak in from a prior test.
    hasBranchMergeEvidenceMock.mockReset();
    hasBranchMergeEvidenceMock.mockResolvedValue(false);
    existsSync.mockReset().mockReturnValue(true);
    realpathSync.mockReset().mockImplementation(p => p);
    rm.mockClear();
    scriptGit();
  });

  it.each([
    ['a rejected ref read', () => Promise.reject(new Error('git command timed out'))],
    ['a nonzero ref read', () => Promise.resolve({ stdout: '1', stderr: 'bad ref', exitCode: 128 })],
    ['an empty ref count', () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })],
    ['a malformed ref count', () => Promise.resolve({ stdout: 'unknown', stderr: '', exitCode: 0 })],
  ])('preserves the worktree and branch when merge preflight returns %s', async (_description, readCount) => {
    const scripted = execGitMock.getMockImplementation();
    execGitMock.mockImplementation((args, ...rest) =>
      args[0] === 'rev-list' ? readCount() : scripted(args, ...rest));

    // This is the scheduled caller's option shape: merge enabled, with no
    // optional branch-preservation flag.
    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', { merge: true });

    expect(result).toMatchObject({ merged: false, removed: false, uncommittedSaved: false });
    expect(result.warnings.join(' ')).toMatch(/preserved.*retry/i);
    expect(rm).not.toHaveBeenCalled();
    expect(calledWith(['worktree', 'remove', join(PATHS.worktrees, 'agent-x'), '--force'])).toBe(false);
    expect(calledWith(['branch', '-D', 'cos/task-1/agent-x'])).toBe(false);
    expect(calledWith(['merge', 'cos/task-1/agent-x', '--no-edit'])).toBe(false);
  });

  it('still removes an empty branch after a verified zero commit count', async () => {
    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', { merge: true });

    expect(result.removed).toBe(true);
    expect(calledWith(['branch', '-D', 'cos/task-1/agent-x'])).toBe(true);
  });

  it('attempts and records a merge after a verified positive commit count', async () => {
    const scripted = execGitMock.getMockImplementation();
    execGitMock.mockImplementation((args, ...rest) =>
      args[0] === 'rev-list'
        ? Promise.resolve({ stdout: '2\n', stderr: '', exitCode: 0 })
        : scripted(args, ...rest));

    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', { merge: true });

    expect(result).toMatchObject({ merged: true, removed: true });
    expect(calledWith(['merge', 'cos/task-1/agent-x', '--no-edit'])).toBe(true);
    expect(calledWith(['branch', '-D', 'cos/task-1/agent-x'])).toBe(true);
  });

  it('preserves a branch after a verified positive count and failed merge', async () => {
    const scripted = execGitMock.getMockImplementation();
    execGitMock.mockImplementation((args, ...rest) => {
      if (args[0] === 'rev-list') return Promise.resolve({ stdout: '1\n', stderr: '', exitCode: 0 });
      if (args[0] === 'merge' && args[1] !== '--abort') return Promise.reject(new Error('merge conflict'));
      return scripted(args, ...rest);
    });

    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', { merge: true });

    expect(result.removed).toBe(true);
    expect(result.merged).toBe(false);
    expect(calledWith(['merge', 'cos/task-1/agent-x', '--no-edit'])).toBe(true);
    expect(calledWith(['branch', '-D', 'cos/task-1/agent-x'])).toBe(false);
  });

  afterEach(() => {
    realpathSync.mockReset().mockImplementation(p => p);
  });

  it('removes a broken tree resolving to the parent without trusting its dirty status', async () => {
    scriptGit({ detectedToplevel: '/repo', porcelain: ' M src/parent-work.js' });

    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x');

    expect(result).toEqual({ merged: false, removed: true, uncommittedSaved: false, warnings: [] });
    expect(rm).toHaveBeenCalledWith(join(PATHS.worktrees, 'agent-x'), { recursive: true, force: true });
    expect(calledWith(['branch', '-D', 'cos/task-1/agent-x'])).toBe(true);
    expect(execGitMock.mock.calls.some(([args]) => args[0] === 'status')).toBe(false);
    expect(execGitMock.mock.calls.some(([args]) => args[0] === 'worktree')).toBe(false);
  });

  it('preserves dirt when git reports a symlink-equivalent worktree identity', async () => {
    const worktreePath = join(PATHS.worktrees, 'agent-x');
    const alias = join('/alias', 'agent-x');
    realpathSync.mockImplementation(p => p === alias ? worktreePath : p);
    scriptGit({ detectedToplevel: alias, porcelain: ' M src/index.js' });

    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x');

    expect(result.removed).toBe(false);
    expect(result.warnings.join(' ')).toContain('src/index.js');
    expect(rm).not.toHaveBeenCalled();
    expect(calledWith(['branch', '-D', 'cos/task-1/agent-x'])).toBe(false);
  });

  it('preserves work when identity lookup and status both fail', async () => {
    const scripted = execGitMock.getMockImplementation();
    execGitMock.mockImplementation((args, ...rest) =>
      (args[0] === 'status' || (args[0] === 'rev-parse' && args[1] === '--show-toplevel'))
        ? Promise.reject(new Error('not a git repository'))
        : scripted(args, ...rest));

    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x');

    expect(result.removed).toBe(false);
    expect(result.warnings.join(' ')).toContain('git status failed');
    expect(rm).not.toHaveBeenCalled();
    expect(calledWith(['branch', '-D', 'cos/task-1/agent-x'])).toBe(false);
  });

  it('discards only lockfile churn before removing the worktree', async () => {
    scriptGit({ porcelain: ' M client/package-lock.json\n M yarn.lock\n M pnpm-lock.yaml' });

    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x');

    expect(result.removed).toBe(true);
    expect(execGitMock).toHaveBeenCalledWith(
      ['checkout', '--', 'client/package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
      join(PATHS.worktrees, 'agent-x')
    );
    expect(execGitMock).toHaveBeenCalledWith(
      ['worktree', 'remove', join(PATHS.worktrees, 'agent-x'), '--force'], '/repo'
    );
  });

  it.each(['?? src/new.js', 'A  src/staged.js', ' M package-lock.json\n M src/index.js'])(
    'preserves authored changes (%s) without discarding any files', async porcelain => {
      scriptGit({ porcelain });

      const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x');

      expect(result.removed).toBe(false);
      expect(rm).not.toHaveBeenCalled();
      expect(execGitMock.mock.calls.some(([args]) => ['checkout', 'worktree', 'branch'].includes(args[0]))).toBe(false);
    }
  );

  it('KEEPS the branch when it is not yet merged into the default branch', async () => {
    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', {
      merge: false, preserveBranchWithCommits: true,
    });

    expect(calledWith(['branch', '-D', 'cos/task-1/agent-x'])).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/preserved/i);
  });

  // Patch-equivalence matters here: PortOS merges with `--rebase`, so a landed
  // branch has new SHAs. `hasBranchMergeEvidence` is what sees through that — a bare
  // `rev-list --count` would report it ahead and preserve a merged branch forever.
  it('DELETES the branch once it is merged (including rebase/squash-merged)', async () => {
    hasBranchMergeEvidenceMock.mockResolvedValue(true);

    await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', {
      merge: false, preserveBranchWithCommits: true,
    });

    expect(calledWith(['branch', '-D', 'cos/task-1/agent-x'])).toBe(true);
  });

  it('calls an empty branch unused instead of already merged', async () => {
    hasBranchMergeEvidenceMock.mockResolvedValue(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    execGitMock.mockImplementation((args, cwd) => {
      if (args[0] === 'rev-list') return Promise.resolve({ stdout: '0\n', stderr: '', exitCode: 0 });
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return Promise.resolve({ stdout: cwd, stderr: '', exitCode: 0 });
      }
      if (args[0] === 'status') return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 1 });
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', {
      merge: false, preserveBranchWithCommits: true,
    });

    const lines = log.mock.calls.flat().join('\n');
    expect(lines).toContain('has no commits beyond');
    expect(lines).not.toContain('already merged');
    expect(calledWith(['branch', '-D', 'cos/task-1/agent-x'])).toBe(true);
    log.mockRestore();
  });

  it('fails CLOSED — keeps the branch when the merged check cannot be determined', async () => {
    hasBranchMergeEvidenceMock.mockRejectedValue(new Error('unknown revision'));

    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', {
      merge: false, preserveBranchWithCommits: true,
    });

    expect(calledWith(['branch', '-D', 'cos/task-1/agent-x'])).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/preserved/i);
  });

  // #7653: a PR merged on the forge moves ORIGIN's default branch — this clone's
  // `main` does not move until something fetches. Asking the local ref preserved
  // an already-landed branch and re-queued its task against shipped work.
  it('refreshes and asks origin/<default>, not the stale local branch', async () => {
    scriptGit({ remoteTargetResolves: true });

    await removeWorktree('agent-x', '/repo', 'claim/issue-7625', {
      merge: false, preserveBranchWithCommits: true,
    });

    expect(calledWith(['fetch', 'origin', '--prune'])).toBe(true);
    expect(hasBranchMergeEvidenceMock).toHaveBeenCalledWith('/repo', 'claim/issue-7625', 'origin/main');
  });

  it('falls back to the local branch when origin has no copy of the default', async () => {
    scriptGit({ remoteTargetResolves: false });

    await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', {
      merge: false, preserveBranchWithCommits: true,
    });

    expect(hasBranchMergeEvidenceMock).toHaveBeenCalledWith('/repo', 'cos/task-1/agent-x', 'main');
  });

  it('is opt-in: without the flag the no-merge path still deletes an unmerged branch', async () => {
    await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', { merge: false });

    expect(calledWith(['branch', '-D', 'cos/task-1/agent-x'])).toBe(true);
    // The resume gate never consulted the merged check for THIS branch.
    expect(hasBranchMergeEvidenceMock).not.toHaveBeenCalledWith('/repo', 'cos/task-1/agent-x', 'main');
  });

  // The bare "uncommitted changes detected" message left the user unable to tell
  // real abandoned work from a transient read of a worktree already being removed
  // — and the worktree is gone by the time anyone looks. Name the paths.
  it('NAMES the dirty paths in the preserved-worktree warning', async () => {
    scriptGit({ porcelain: ' M server/services/foo.js\n?? notes.md' });

    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', { merge: false });

    expect(result.removed).toBe(false);
    expect(result.warnings.join(' ')).toContain('server/services/foo.js');
    expect(result.warnings.join(' ')).toContain('notes.md');
  });

  it('removes a completed worktree whose only dirt is the consumed per-agent sentinel', async () => {
    scriptGit({ porcelain: '?? .agent-done-agent-x' });

    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', { merge: false });

    expect(result.removed).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('removes a completed worktree whose only dirt is the consumed sentinel', async () => {
    scriptGit({ porcelain: '?? .agent-done' });

    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', { merge: false });

    expect(result.removed).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('preserves real work while excluding the completion sentinel from the warning', async () => {
    scriptGit({ porcelain: '?? .agent-done\n M src/index.js' });

    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', { merge: false });

    expect(result.removed).toBe(false);
    expect(result.warnings.join(' ')).toContain('src/index.js');
    expect(result.warnings.join(' ')).not.toContain('.agent-done');
  });

  it('caps the named paths so a broad sweep cannot flood the notification', async () => {
    scriptGit({ porcelain: Array.from({ length: 9 }, (_, i) => ` M src/f${i}.js`).join('\n') });

    const result = await removeWorktree('agent-x', '/repo', 'cos/task-1/agent-x', { merge: false });

    const warning = result.warnings.join(' ');
    expect(warning).toContain('src/f0.js');
    expect(warning).toContain('(+4 more)');
    expect(warning).not.toContain('src/f8.js');
  });
});

describe('adoptWorktree — resuming an interrupted run in its own worktree', () => {
  const WORKTREES = PATHS.worktrees;
  const DEAD_TREE = join(WORKTREES, 'agent-dead');
  const NEW_TREE = join(WORKTREES, 'agent-new');

  // The dead run's tree is on disk; the retry's destination is not.
  function scriptPaths({ source = true, target = false } = {}) {
    existsSync.mockImplementation((p) => {
      if (p === DEAD_TREE) return source;
      if (p === NEW_TREE) return target;
      return true;
    });
  }

  beforeEach(() => {
    execGitMock.mockReset();
    execGitMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    scriptPaths();
  });

  afterEach(() => { existsSync.mockReturnValue(true); });

  // Renaming to the retry's own id keeps `<worktrees>/<agentId>` == "the agent that
  // owns this tree" — the invariant cleanupOrphanedWorktrees reaps on. Adopted in
  // place, the live retry's worktree would be reaped out from under it.
  it('moves the dead run’s tree to the retrying agent’s directory', async () => {
    const result = await adoptWorktree('agent-new', '/repo', DEAD_TREE, 'cos/task-1/agent-dead');

    // Third arg is the long add/move timeout — a move relocates a whole checkout,
    // so it needs the same headroom as the add it shares a wrapper with.
    expect(execGitMock).toHaveBeenCalledWith(
      ['worktree', 'move', DEAD_TREE, NEW_TREE],
      '/repo',
      expect.objectContaining({ timeout: expect.any(Number) })
    );
    expect(result).toMatchObject({
      worktreePath: NEW_TREE, branchName: 'cos/task-1/agent-dead',
      existingBranch: true, adopted: true
    });
  });

  it('returns null (caller starts clean) when the leftover tree is gone', async () => {
    scriptPaths({ source: false });

    await expect(adoptWorktree('agent-new', '/repo', DEAD_TREE, 'cos/task-1/agent-dead')).resolves.toBeNull();
    expect(execGitMock).not.toHaveBeenCalled();
  });

  it('refuses to clobber an occupied destination', async () => {
    scriptPaths({ target: true });

    await expect(adoptWorktree('agent-new', '/repo', DEAD_TREE, 'cos/task-1/agent-dead')).resolves.toBeNull();
    expect(execGitMock).not.toHaveBeenCalled();
  });

  // git refuses to move a locked worktree or one with initialized submodules —
  // never throw at the spawn path, just decline so the caller builds a fresh tree.
  it('returns null rather than throwing when git refuses the move', async () => {
    execGitMock.mockRejectedValue(new Error('working trees containing submodules cannot be moved'));

    await expect(adoptWorktree('agent-new', '/repo', DEAD_TREE, 'cos/task-1/agent-dead')).resolves.toBeNull();
  });

  it('is a no-op when the tree already sits at the destination', async () => {
    scriptPaths({ source: true, target: true });

    const result = await adoptWorktree('agent-new', '/repo', NEW_TREE, 'cos/task-1/agent-dead');

    expect(execGitMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ worktreePath: NEW_TREE, adopted: true });
  });

  // removeWorktree discards lockfile churn rather than preserving it, and the
  // resume prompt tells the retry that everything uncommitted is its own work to
  // finish and commit — so an adopted tree carrying only a stale `npm install`
  // lockfile bump would ship it in the PR.
  it('discards lockfile-only churn in the adopted tree', async () => {
    execGitMock.mockImplementation((args) => Promise.resolve(
      args[0] === 'status'
        ? { stdout: ' M package-lock.json\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 }
    ));

    await adoptWorktree('agent-new', '/repo', DEAD_TREE, 'cos/task-1/agent-dead');

    expect(execGitMock).toHaveBeenCalledWith(['checkout', '--', 'package-lock.json'], NEW_TREE);
  });

  it('keeps every uncommitted change when the tree holds real work too', async () => {
    execGitMock.mockImplementation((args) => Promise.resolve(
      args[0] === 'status'
        ? { stdout: ' M package-lock.json\n M server/services/thing.js\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 }
    ));

    await adoptWorktree('agent-new', '/repo', DEAD_TREE, 'cos/task-1/agent-dead');

    expect(execGitMock).not.toHaveBeenCalledWith(expect.arrayContaining(['checkout']), expect.anything());
  });

  it('returns null on incomplete input instead of guessing', async () => {
    await expect(adoptWorktree(null, '/repo', DEAD_TREE, 'b')).resolves.toBeNull();
    await expect(adoptWorktree('agent-new', '/repo', DEAD_TREE, null)).resolves.toBeNull();
    expect(execGitMock).not.toHaveBeenCalled();
  });
});

describe('createWorktree upstream safety (#4172)', () => {
  // Wiring-level coverage: that the branch invariant itself HOLDS against real
  // git is proved in lib/branchUpstreamGuard.test.js (real repos, real config).
  // What can only be checked here is that createWorktree actually reaches for
  // it — the flag on the add, and the guard on the result.
  // `originHasBranch` / `forkRemoteUrl` / `forkRefResolves` script the three
  // lookups the existingBranch resolve order makes, so a test can put the tree
  // in the fork-PR state: no local branch, no origin ref, a fork that answers.
  function scriptGit({ mergeReadings = [], originHasBranch = true, forkRemoteUrl = null, forkRefResolves = true } = {}) {
    const readings = [...mergeReadings];
    execGitMock.mockReset();
    execGitMock.mockImplementation((args) => {
      if (args[0] === 'config' && args[1] === '--get' && /\.merge$/.test(args[2] || '')) {
        const answer = readings.length ? readings.shift() : '';
        // exitCode 1 mirrors `git config --get` on an unset key, which the guard
        // must read as "no upstream" rather than as an error.
        return Promise.resolve({ stdout: answer, stderr: '', exitCode: answer ? 0 : 1 });
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        const ref = args[2] || '';
        const resolves = ref.startsWith('origin/') ? originHasBranch : forkRefResolves;
        return Promise.resolve({ stdout: resolves ? 'deadbeef' : '', stderr: '', exitCode: resolves ? 0 : 1 });
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return forkRemoteUrl
          ? Promise.resolve({ stdout: `${forkRemoteUrl}\n`, stderr: '', exitCode: 0 })
          : Promise.resolve({ stdout: '', stderr: 'No such remote', exitCode: 2 });
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });
  }

  const argsFor = (predicate) => execGitMock.mock.calls.map(([args]) => args).filter(predicate);

  beforeEach(() => {
    getDefaultBranchMock.mockResolvedValue('main');
    scriptGit();
  });

  it('creates the branch with --no-track so git cannot record refs/heads/main as its upstream', async () => {
    const result = await createWorktree('agent-1', '/repo', 'task-1');

    expect(result).toMatchObject({
      worktreePath: join(PATHS.worktrees, 'agent-1'),
      branchName: 'cos/task-1/agent-1',
      baseBranch: 'main',
      instanceId: 'instance-1',
    });
    expect(execGitMock).toHaveBeenCalledWith(
      ['worktree', 'add', '--no-track', '-b', 'cos/task-1/agent-1', join(PATHS.worktrees, 'agent-1'), 'origin/main'],
      '/repo', expect.objectContaining({ timeout: WORKTREE_ADD_TIMEOUT_MS })
    );

  });

  it.each([
    ['issue-42', 'cos/sys-1/issue-42/agent-plan'],
    ['', 'cos/sys-1/agent-plan'],
  ])('creates and returns the branch for planId %j', async (planId, branchName) => {
    const worktreePath = join(PATHS.worktrees, 'agent-plan');

    expect(await createWorktree('agent-plan', '/repo', 'sys-1', { planId }))
      .toMatchObject({ worktreePath, branchName });
    expect(execGitMock).toHaveBeenCalledWith(
      ['worktree', 'add', '--no-track', '-b', branchName, worktreePath, 'origin/main'],
      '/repo', expect.objectContaining({ timeout: WORKTREE_ADD_TIMEOUT_MS })
    );
  });

  it('keeps dependency-update worktrees detached from source dependencies', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    lstat.mockReset();
    lstat.mockRejectedValue(missing);
    symlink.mockClear();

    await createWorktree('agent-deps', '/repo', 'task-deps', { linkDependencies: false });

    expect(symlink).not.toHaveBeenCalled();
  });

  it('drops an upstream that still points at the default branch', async () => {
    // An older git, or a repo whose config re-tracks despite the flag: the first
    // read finds `main`, the guard unsets, the re-read confirms.
    scriptGit({ mergeReadings: ['refs/heads/main'] });

    await createWorktree('agent-2', '/repo', 'task-2');

    expect(argsFor(a => a[0] === 'branch' && a[1] === '--unset-upstream')).toHaveLength(1);
  });

  it('leaves a healthy branch untouched', async () => {
    await createWorktree('agent-3', '/repo', 'task-3');

    expect(argsFor(a => a[0] === 'branch' && a[1] === '--unset-upstream')).toHaveLength(0);
  });

  it('undoes the add when the upstream cannot be made safe, instead of stranding a worktree', async () => {
    // The guard throws AFTER `worktree add` succeeded, so without an undo the
    // caller sees a failed create while a registered worktree and an orphan
    // branch stay on disk — the debris cleanupOrphanBranch prevents on the add.
    scriptGit({ mergeReadings: ['refs/heads/main', 'refs/heads/main'] });

    await expect(createWorktree('agent-5', '/repo', 'task-5')).rejects.toThrow(/still resolves to/);

    expect(argsFor(a => a[0] === 'worktree' && a[1] === 'remove')).toHaveLength(1);
    expect(argsFor(a => a[0] === 'branch' && a[1] === '-D')).toHaveLength(1);
  });

  it('does NOT delete the branch when undoing an existingBranch attach', async () => {
    // That branch pre-dates this add and may hold real commits — same
    // distinction cleanupOrphanBranch draws.
    scriptGit({ mergeReadings: ['refs/heads/main', 'refs/heads/main'] });

    await expect(createWorktree('agent-6', '/repo', 'task-6', { existingBranch: 'cos/task-0/agent-0' }))
      .rejects.toThrow(/still resolves to/);

    expect(argsFor(a => a[0] === 'worktree' && a[1] === 'remove')).toHaveLength(1);
    expect(argsFor(a => a[0] === 'branch' && a[1] === '-D')).toHaveLength(0);
  });

  it('attaches a FORK PR head from a fork remote and leaves its upstream on the fork (#6064)', async () => {
    // The regression: a fork PR's head has no `origin/<branch>` at all, so
    // before this every "work on this PR's branch" path threw at workspace prep
    // for exactly the PRs external contributors open.
    scriptGit({ originHasBranch: false });

    await createWorktree('agent-fork', '/repo', 'task-fork', {
      existingBranch: 'contributor/fix-thing',
      forkHead: { remoteUrl: 'https://github.com/contributor/widget.git', ownerLogin: 'contributor' },
    });

    expect(argsFor(a => a[0] === 'remote' && a[1] === 'add'))
      .toEqual([['remote', 'add', 'fork-contributor', 'https://github.com/contributor/widget.git']]);
    expect(argsFor(a => a[0] === 'fetch' && a[1] === 'fork-contributor'))
      .toEqual([['fetch', 'fork-contributor', 'contributor/fix-thing']]);
    // The start point is the whole point: it is what makes the branch track the
    // CONTRIBUTOR's fork, so a later `git push` lands there and not on upstream.
    const [add] = argsFor(a => a[0] === 'worktree' && a[1] === 'add');
    expect(add).toEqual([
      'worktree', 'add', '-B', 'contributor/fix-thing',
      join(PATHS.worktrees, 'agent-fork'), 'fork-contributor/contributor/fix-thing',
    ]);
    // ...and the #4172 guard must not "repair" that fork upstream away.
    expect(argsFor(a => a[0] === 'branch' && a[1] === '--unset-upstream')).toHaveLength(0);
  });

  it('re-points a stale fork remote instead of duplicating it or failing', async () => {
    // The remote is named from the OWNER so re-runs reuse it; a contributor who
    // renamed or moved their fork leaves the recorded URL stale.
    scriptGit({ originHasBranch: false, forkRemoteUrl: 'https://github.com/contributor/old-name.git' });

    await createWorktree('agent-fork2', '/repo', 'task-fork2', {
      existingBranch: 'contributor/fix-thing',
      forkHead: { remoteUrl: 'https://github.com/contributor/widget.git', ownerLogin: 'contributor' },
    });

    expect(argsFor(a => a[0] === 'remote' && a[1] === 'add')).toHaveLength(0);
    expect(argsFor(a => a[0] === 'remote' && a[1] === 'set-url'))
      .toEqual([['remote', 'set-url', 'fork-contributor', 'https://github.com/contributor/widget.git']]);
  });

  it('leaves a fork remote alone when it already points at the right URL', async () => {
    scriptGit({ originHasBranch: false, forkRemoteUrl: 'https://github.com/contributor/widget.git' });

    await createWorktree('agent-fork3', '/repo', 'task-fork3', {
      existingBranch: 'contributor/fix-thing',
      forkHead: { remoteUrl: 'https://github.com/contributor/widget.git', ownerLogin: 'contributor' },
    });

    expect(argsFor(a => a[0] === 'remote' && (a[1] === 'add' || a[1] === 'set-url'))).toHaveLength(0);
    const [add] = argsFor(a => a[0] === 'worktree' && a[1] === 'add');
    expect(add).toContain('fork-contributor/contributor/fix-thing');
  });

  it('still throws today\'s exact error when no forkHead is supplied', async () => {
    // The fork path is a third FALLBACK: a caller that passes no coordinates
    // must get the pre-#6064 behavior, message included.
    scriptGit({ originHasBranch: false });

    await expect(createWorktree('agent-fork4', '/repo', 'task-fork4', { existingBranch: 'contributor/fix-thing' }))
      .rejects.toThrow('Cannot attach worktree to contributor/fix-thing: branch missing locally and origin/contributor/fix-thing unavailable');

    expect(argsFor(a => a[0] === 'remote')).toHaveLength(0);
    expect(argsFor(a => a[0] === 'worktree' && a[1] === 'add')).toHaveLength(0);
  });

  it('falls back to the origin-only error when the fork fetch leaves no ref', async () => {
    // A fetch that "succeeded" but produced no remote-tracking ref must not send
    // `worktree add` at a start point git would resolve somewhere else.
    scriptGit({ originHasBranch: false, forkRefResolves: false });

    await expect(createWorktree('agent-fork5', '/repo', 'task-fork5', {
      existingBranch: 'contributor/fix-thing',
      forkHead: { remoteUrl: 'https://github.com/contributor/widget.git', ownerLogin: 'contributor' },
    })).rejects.toThrow(/branch missing locally and origin\/contributor\/fix-thing unavailable/);

    expect(argsFor(a => a[0] === 'worktree' && a[1] === 'add')).toHaveLength(0);
  });

  it('never consults the fork when origin already has the branch', async () => {
    await createWorktree('agent-fork6', '/repo', 'task-fork6', {
      existingBranch: 'shared/branch',
      forkHead: { remoteUrl: 'https://github.com/contributor/widget.git', ownerLogin: 'contributor' },
    });

    expect(argsFor(a => a[0] === 'remote')).toHaveLength(0);
    const [add] = argsFor(a => a[0] === 'worktree' && a[1] === 'add');
    expect(add).toContain('origin/shared/branch');
  });

  it('checks the re-attached branch of an existingBranch worktree too', async () => {
    // Branches created before this fix keep their bad upstream; a review-loop
    // agent re-attaching to one must not inherit a push aimed at main.
    scriptGit({ mergeReadings: ['refs/heads/main'] });

    await createWorktree('agent-4', '/repo', 'task-4', { existingBranch: 'cos/task-0/agent-0' });

    expect(argsFor(a => a[0] === 'branch' && a[1] === '--unset-upstream')).toHaveLength(1);
  });

  // The persistent feature-agent tree needs its own coverage, not just the CoS
  // one: it lives OUTSIDE `WORKTREES_DIR`, so neither `cleanupOrphanedWorktrees`
  // nor `reapMergedWorktrees` reaps it, and its only caller does not catch. A
  // stranded tree there blocks every retry with "already exists" until a human
  // prunes it, so the undo has to happen here rather than being left to a sweeper.
  it('creates the persistent feature-agent branch with --no-track too', async () => {
    const worktreePath = join(PATHS.worktrees, '..', 'feature-agents', 'fa-1', 'worktree');
    expect(await createPersistentWorktree('fa-1', '/repo', 'feature/x', 'main'))
      .toEqual({ worktreePath, branchName: 'feature/x', baseBranch: 'main' });
    expect(execGitMock).toHaveBeenCalledWith(
      ['worktree', 'add', '--no-track', '-b', 'feature/x', worktreePath, 'origin/main'],
      '/repo', expect.objectContaining({ timeout: WORKTREE_ADD_TIMEOUT_MS })
    );
  });

  it('undoes the persistent add when the upstream cannot be made safe', async () => {
    scriptGit({ mergeReadings: ['refs/heads/main', 'refs/heads/main'] });

    await expect(createPersistentWorktree('fa-2', '/repo', 'feature/y', 'main'))
      .rejects.toThrow(/still resolves to/);

    expect(argsFor(a => a[0] === 'worktree' && a[1] === 'remove')).toHaveLength(1);
    expect(argsFor(a => a[0] === 'branch' && a[1] === '-D')).toHaveLength(1);
  });
});

describe('cleanupOrphanedWorktrees ownership and removal', () => {
  const tree = agentId => join(PATHS.worktrees, agentId);

  beforeEach(() => {
    existsSync.mockReset().mockReturnValue(true);
    readdir.mockReset().mockResolvedValue([]);
    rm.mockClear();
    getDefaultBranchMock.mockResolvedValue('main');
    execGitMock.mockReset();
  });

  afterEach(() => { readdir.mockReset().mockResolvedValue([]); });

  it('removes only the clean inactive agent and preserves active, human, locked and dirty trees', async () => {
    const entries = [
      { path: '/repo', branch: 'main' },
      { path: join(PATHS.worktrees + '-old', 'agent-outside'), branch: 'outside' },
      { path: tree('agent-active'), branch: 'cos/task/agent-active' },
      { path: tree('claim-issue-42'), branch: 'claim/issue-42' },
      { path: tree('agent-locked'), branch: 'cos/task/agent-locked', locked: true },
      { path: tree('agent-dead'), branch: 'cos/task/agent-dead' },
      { path: tree('agent-dirty'), branch: 'cos/task/agent-dirty' },
    ];
    const stdout = entries.flatMap(entry => [
      'worktree ' + entry.path, 'HEAD abc123', 'branch refs/heads/' + entry.branch,
      ...(entry.locked ? ['locked protected'] : []), '',
    ]).join('\n');
    // Include the same on-disk entries in the external-repo scan: ownership
    // holds must survive that second pass too.
    readdir.mockResolvedValue(entries.slice(2).map(entry => ({
      name: win32.basename(entry.path), isDirectory: () => true,
    })));
    execGitMock.mockImplementation((args, cwd) => {
      if (args[0] === 'worktree' && args[1] === 'list') return Promise.resolve({ stdout });
      if (args[0] === 'rev-parse') return Promise.resolve({ stdout: args[1] === '--show-toplevel' ? cwd : 'main' });
      if (args[0] === 'status') return Promise.resolve({ stdout: cwd === tree('agent-dirty') ? ' M src/work.js' : '' });
      if (args[0] === 'rev-list') return Promise.resolve({ stdout: '0', stderr: '', exitCode: 0 });
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    expect(await cleanupOrphanedWorktrees('/repo', new Set(['agent-active']))).toBe(1);
    expect(execGitMock.mock.calls.filter(([args]) => args[0] === 'worktree' && args[1] === 'remove'))
      .toEqual([[['worktree', 'remove', tree('agent-dead'), '--force'], '/repo']]);
    expect(execGitMock.mock.calls.filter(([args]) => args[0] === 'branch' && args[1] === '-D'))
      .toEqual([[['branch', '-D', 'cos/task/agent-dead'], '/repo']]);
    expect(execGitMock.mock.calls.filter(([args]) => args[0] === 'status').map(([, cwd]) => cwd))
      .toEqual([tree('agent-dead'), tree('agent-dirty')]);
    expect(rm).not.toHaveBeenCalled();
  });
});

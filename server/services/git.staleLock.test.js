import { beforeEach, describe, expect, it, vi } from 'vitest';

const execGitMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/execGit.js', () => ({ execGit: execGitMock,
  execGitSafe: (...args) => execGitMock(...args).catch(err => ({ exitCode: 1, stdout: '', stderr: err.message })) }));

// Mocked so the retry/no-retry decision is driven by a stub, not real file
// mtimes — `lib/gitStaleLock.test.js` owns proving WHICH locks it agrees to
// remove.
vi.mock('../lib/gitStaleLock.js', () => ({ clearStaleGitLock: vi.fn(() => null) }));

import { ensureLatest, pull, syncBranch } from './git.js';
import { clearStaleGitLock } from '../lib/gitStaleLock.js';

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = '', exitCode = 1) => ({ stdout: '', stderr, exitCode });
const key = (args) => args.join(' ');
const commands = () => execGitMock.mock.calls.map(([args]) => key(args));

beforeEach(() => {
  execGitMock.mockReset();
  clearStaleGitLock.mockReset();
  clearStaleGitLock.mockReturnValue(null);
});

// `pull`, `syncBranch`, and `ensureLatest` — the rest of the pull/fetch/rebase
// family `updateSubmodule` already covers (git.submodules.test.js) and
// `updateDefaultBranch` covers (git.updateDefaultBranch.test.js). A killed git
// process leaves a shared ref/index lock that wedges every worktree of the
// repo forever, so each of these clears an abandoned lock but never
// auto-retries a non-idempotent command (#7513).

describe('pull', () => {
  it('pulls with rebase and autostash, returning the combined output', async () => {
    execGitMock.mockResolvedValue(ok('Already up to date.\n'));

    const result = await pull('/repo');

    expect(result).toEqual({ success: true, output: 'Already up to date.\n' });
    expect(execGitMock).toHaveBeenCalledWith(['pull', '--rebase', '--autostash'], '/repo');
  });

  it('clears an abandoned lock without retrying the pull', async () => {
    const lockError = new Error("fatal: Unable to create '/repo/.git/index.lock': File exists");
    execGitMock.mockRejectedValue(lockError);
    clearStaleGitLock.mockReturnValue('/repo/.git/index.lock');

    await expect(pull('/repo')).rejects.toThrow(/Cleared an abandoned git lock.*index\.lock/);
    expect(clearStaleGitLock).toHaveBeenCalledWith(lockError.message);
    expect(execGitMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces the original failure unchanged when the lock is too young to clear', async () => {
    const lockError = new Error("fatal: Unable to create '/repo/.git/index.lock': File exists");
    execGitMock.mockRejectedValue(lockError);

    await expect(pull('/repo')).rejects.toThrow(/Unable to create/);
    expect(execGitMock).toHaveBeenCalledTimes(1);
  });
});

describe('syncBranch', () => {
  it('pulls with rebase then pushes', async () => {
    execGitMock.mockImplementation((args) => {
      if (args[0] === 'pull') return Promise.resolve(ok('Already up to date.\n'));
      if (args[0] === 'push') return Promise.resolve(ok('everything up-to-date\n'));
      return Promise.resolve(ok());
    });

    const result = await syncBranch('/repo', 'feature/work');

    expect(result).toMatchObject({ success: true, pulled: true, pushed: true });
    expect(execGitMock).toHaveBeenCalledWith(
      ['pull', '--rebase', '--autostash', 'origin', 'feature/work'], '/repo', { ignoreExitCode: true }
    );
  });

  it('clears an abandoned pull lock without retrying, and does not push', async () => {
    execGitMock.mockImplementation((args) => {
      if (args[0] === 'pull') return Promise.resolve(fail("fatal: Unable to create '/repo/.git/index.lock': File exists"));
      return Promise.resolve(ok());
    });
    clearStaleGitLock.mockReturnValue('/repo/.git/index.lock');

    const result = await syncBranch('/repo', 'feature/work');

    expect(result).toMatchObject({ success: false, pulled: false, pushed: false });
    expect(result.error).toContain('/repo/.git/index.lock');
    expect(commands()).not.toContain('push origin feature/work');
  });

  it('surfaces the raw pull failure unchanged when the lock is too young to clear', async () => {
    execGitMock.mockImplementation((args) => {
      if (args[0] === 'pull') return Promise.resolve(fail("fatal: Unable to create '/repo/.git/index.lock': File exists"));
      return Promise.resolve(ok());
    });

    const result = await syncBranch('/repo', 'feature/work');

    expect(result).toMatchObject({ success: false, pulled: false, pushed: false });
    expect(result.error).toContain('Unable to create');
  });
});

describe('ensureLatest', () => {
  // A local branch already diverged from origin (different SHAs), a clean
  // working tree, so the flow always reaches the fast-forward-or-rebase steps.
  const base = {
    'rev-parse --is-inside-work-tree': ok('true\n'),
    'rev-parse --abbrev-ref HEAD': ok('main\n'),
    'remote -v': ok('origin git@example.com:example/example.git (fetch)\norigin git@example.com:example/example.git (push)\n'),
    'fetch origin': ok(),
    'rev-parse origin/main': ok('b'.repeat(40)),
    'rev-parse HEAD': ok('a'.repeat(40)),
    'status --porcelain': ok(),
    'merge --ff-only origin/main': ok('Fast-forward'),
    'rebase origin/main': ok('Successfully rebased'),
    'rebase --abort': ok()
  };

  const withGit = (overrides = {}) => {
    const table = { ...base, ...overrides };
    execGitMock.mockImplementation((args) => Promise.resolve(table[key(args)] ?? ok()));
  };

  beforeEach(() => withGit());

  it('fast-forwards a diverged branch without rebasing', async () => {
    const result = await ensureLatest('/repo');

    expect(result).toMatchObject({ success: true, branch: 'main', conflict: false });
    expect(commands()).toContain('merge --ff-only origin/main');
    expect(commands()).not.toContain('rebase origin/main');
  });

  // `fetch` is idempotent, so a lock here is cleared and retried once rather
  // than reported as a permanent failure.
  it('clears an abandoned fetch lock and retries once', async () => {
    withGit({ 'fetch origin': fail("fatal: Unable to create '/repo/.git/refs/remotes/origin/main.lock': File exists") });
    let fetches = 0;
    const scripted = execGitMock.getMockImplementation();
    execGitMock.mockImplementation(async (args, cwd, options) => {
      if (key(args) === 'fetch origin' && ++fetches === 1) return scripted(args, cwd, options);
      if (key(args) === 'fetch origin') return ok();
      return scripted(args, cwd, options);
    });
    clearStaleGitLock.mockReturnValue('/repo/.git/refs/remotes/origin/main.lock');

    const result = await ensureLatest('/repo');

    expect(result).toMatchObject({ success: true, branch: 'main' });
    expect(clearStaleGitLock).toHaveBeenCalledWith(expect.stringContaining('main.lock'));
    expect(commands().filter((c) => c === 'fetch origin')).toHaveLength(2);
  });

  it('surfaces the fetch lock failure without retrying when the lock is too young', async () => {
    withGit({ 'fetch origin': fail("fatal: Unable to create '/repo/.git/refs/remotes/origin/main.lock': File exists") });

    const result = await ensureLatest('/repo');

    expect(result).toMatchObject({ success: false, branch: 'main' });
    expect(result.error).toContain('Unable to create');
    expect(commands().filter((c) => c === 'fetch origin')).toHaveLength(1);
  });

  it('clears an abandoned merge lock without falling through to rebase', async () => {
    withGit({ 'merge --ff-only origin/main': fail("fatal: Unable to create '/repo/.git/index.lock': File exists") });
    clearStaleGitLock.mockReturnValue('/repo/.git/index.lock');

    const result = await ensureLatest('/repo');

    expect(result).toMatchObject({ success: false, branch: 'main', conflict: true });
    expect(result.error).toContain('/repo/.git/index.lock');
    expect(commands()).not.toContain('rebase origin/main');
  });

  it('clears an abandoned rebase lock, aborts the rebase, and does not retry', async () => {
    withGit({
      'merge --ff-only origin/main': fail('fatal: Not possible to fast-forward, aborting.'),
      'rebase origin/main': fail("fatal: Unable to create '/repo/.git/index.lock': File exists")
    });
    // The merge failure above names no lock — only the rebase failure should
    // clear one, or this would (wrongly) short-circuit before the rebase runs.
    clearStaleGitLock.mockImplementation((message) => (message.includes('.lock') ? '/repo/.git/index.lock' : null));

    const result = await ensureLatest('/repo');

    expect(result).toMatchObject({ success: false, branch: 'main', conflict: true });
    expect(result.error).toContain('/repo/.git/index.lock');
    expect(commands()).toContain('rebase --abort');
  });

  it('reports a genuine rebase conflict unchanged when there is no lock', async () => {
    withGit({
      'merge --ff-only origin/main': fail('fatal: Not possible to fast-forward, aborting.'),
      'rebase origin/main': fail('CONFLICT (content): Merge conflict in server/index.js')
    });

    const result = await ensureLatest('/repo');

    expect(result).toMatchObject({ success: false, branch: 'main', conflict: true });
    expect(result.error).toContain('diverged from origin and rebase has conflicts');
    expect(commands()).toContain('rebase --abort');
  });
});

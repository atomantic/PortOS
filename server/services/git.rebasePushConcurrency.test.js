import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'os';

const execGitMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/execGit.js', () => ({ execGit: execGitMock, execGitSafe: execGitMock }));
vi.mock('../lib/checkoutRetirementAdmission.js', () => ({ withCheckoutPublication: (_dir, work) => work() }));

import { checkout, rebaseAndPushDefaultBranch, resetToDefaultBranch, syncBranch } from './git.js';

const SHA = 'a'.repeat(40);
const ok = stdout => ({ stdout: stdout || '', stderr: '', exitCode: 0 });

beforeEach(() => vi.resetAllMocks());

describe('rebase and push checkout ownership', () => {
  it('refuses to start while a checkout mutation is already running', async () => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    execGitMock.mockImplementation(() => pending);
    const switching = checkout(tmpdir(), 'feature/work');
    try {
      await expect(rebaseAndPushDefaultBranch(tmpdir())).rejects.toMatchObject({ code: 'GIT_BUSY' });
    } finally { finish(ok()); }
    await switching;
  });

  it('refuses checkout, reset and sync during its fetch and pushes the verified default-branch SHA', async () => {
    let releaseFetch;
    let markFetching;
    const fetching = new Promise(resolve => { markFetching = resolve; });
    const fetchResult = new Promise(resolve => { releaseFetch = resolve; });
    execGitMock.mockImplementation(async (args) => {
      const command = args.join(' ');
      if (command === 'fetch origin') { markFetching(); return fetchResult; }
      if (command === 'rev-parse --absolute-git-dir') return ok(`${tmpdir()}/missing-git-fixture`);
      if (command === 'rev-parse --abbrev-ref HEAD') return ok('main');
      if (command === 'symbolic-ref --short refs/remotes/origin/HEAD') return ok('origin/main');
      if (command.startsWith('rev-parse --verify')) return ok(SHA);
      if (args[0] === 'rev-list' && args.includes('--count')) return ok('1\t2');
      return ok();
    });
    const result = rebaseAndPushDefaultBranch(tmpdir());
    await fetching;
    try {
      await expect(checkout(tmpdir(), 'feature/work')).rejects.toMatchObject({ code: 'GIT_BUSY' });
      await expect(resetToDefaultBranch(tmpdir())).rejects.toMatchObject({ code: 'GIT_BUSY' });
      await expect(syncBranch(tmpdir())).rejects.toMatchObject({ code: 'GIT_BUSY' });
    } finally { releaseFetch(ok()); }
    expect(await result).toMatchObject({ success: true });
    expect(execGitMock.mock.calls.map(([args]) => args)).toContainEqual(['push', 'origin', `${SHA}:refs/heads/main`]);
    expect(execGitMock.mock.calls.some(([args]) => args[0] === 'checkout')).toBe(false);
    await expect(checkout(tmpdir(), 'feature/work')).resolves.toMatchObject({ success: true });
  });

  it('stops if an external checkout changes the branch during fetch', async () => {
    let branch = 'main';
    execGitMock.mockImplementation(async (args) => {
      const command = args.join(' ');
      if (command === 'fetch origin') branch = 'feature/work';
      if (command === 'rev-parse --absolute-git-dir') return ok(`${tmpdir()}/missing-git-fixture`);
      if (command === 'rev-parse --abbrev-ref HEAD') return ok(branch);
      if (command === 'symbolic-ref --short refs/remotes/origin/HEAD') return ok('origin/main');
      if (command.startsWith('rev-parse --verify')) return ok(SHA);
      return ok();
    });
    expect(await rebaseAndPushDefaultBranch(tmpdir())).toMatchObject({ success: false, pushed: false, error: expect.stringContaining('checkout changed') });
    expect(execGitMock.mock.calls.some(([args]) => ['rebase', 'push'].includes(args[0]))).toBe(false);
  });
});

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/childProcess.js', () => ({ spawn: vi.fn() }));
// The managed-app registry read is the only thing forge auth needs from the app
// layer; doubling it keeps this suite off the filesystem and makes the pinned
// vs. inferred account split explicit per test.
vi.mock('./agentAppWorkspace.js', () => ({ listForgePinnedApps: vi.fn(async () => []) }));

import { spawn } from '../lib/childProcess.js';
import { listForgePinnedApps } from './agentAppWorkspace.js';
import { resolveForgeForRepo, resolveForgeTokenEnv } from './forgeAuth.js';

// Exercise remote discovery and authentication without a real credential store.
function respond({ stdout = '', stderr = '', code = 0 } = {}) {
  spawn.mockImplementationOnce(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    queueMicrotask(() => {
      child.stdout.emit('data', stdout);
      child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child;
  });
}

function githubAccount({ host = 'github.com', tokenCode = 0 } = {}) {
  respond({ stdout: `git@${host}:example-owner/project.git\n` });
  respond({ stderr: 'Logged in to github.com account other-account\nLogged in to github.com account example-owner\n' });
  respond({ stdout: tokenCode === 0 ? 'test-owner-token\n' : '', code: tokenCode });
}

beforeEach(() => {
  vi.resetAllMocks();
  listForgePinnedApps.mockResolvedValue([]);
  vi.stubEnv('GH_TOKEN', 'test-ambient-token');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('forge credential resolution', () => {
  it('pins the repository owner for PR operations without mutating ambient auth', async () => {
    githubAccount();
    const forge = await resolveForgeForRepo('/example/repo');
    expect(forge).toEqual({
      cli: 'gh', host: 'github.com', owner: 'example-owner', account: 'example-owner',
      env: { ...process.env, GH_TOKEN: 'test-owner-token' }, identity: null
    });
    expect(spawn).toHaveBeenNthCalledWith(3, 'gh', ['auth', 'token', '-u', 'example-owner', '-h', 'github.com'], { shell: false });
    expect(process.env.GH_TOKEN).toBe('test-ambient-token');
  });

  it('gives agent launches only the newly resolved token', async () => {
    githubAccount();
    await expect(resolveForgeTokenEnv('/example/repo')).resolves.toEqual({ GH_TOKEN: 'test-owner-token' });
  });

  it.each([
    ['failed token lookup', { tokenCode: 1 }],
    ['a non-github.com host', { host: 'github.example.com' }]
  ])('does not overlay ambient or wrong-host credentials after %s', async (_label, options) => {
    githubAccount(options);
    await expect(resolveForgeTokenEnv('/example/repo')).resolves.toEqual({});
  });

  it('keeps GitLab host auth ambient and never probes GitHub accounts', async () => {
    respond({ stdout: 'git@gitlab.example.com:group/project.git\n' });
    const forge = await resolveForgeForRepo('/example/repo');
    expect(forge).toEqual({ cli: 'glab', host: 'gitlab.example.com', owner: 'group', account: null, env: process.env, identity: null });
    expect(forge.env).toBe(process.env);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('leaves auth untouched when origin cannot be read or no owner account matches', async () => {
    respond({ code: 1, stderr: 'no origin' });
    await expect(resolveForgeTokenEnv('/example/repo')).resolves.toEqual({});
    respond({ stdout: 'git@github.com:example-owner/project.git\n' });
    respond({ stdout: 'Logged in to github.com account other-account\n' });
    await expect(resolveForgeTokenEnv('/example/repo')).resolves.toEqual({});
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('bounds a stalled credential probe so an agent launch can continue', async () => {
    vi.useFakeTimers();
    respond({ stdout: 'git@github.com:example-owner/project.git\n' });
    const stalled = new EventEmitter();
    stalled.stdout = new EventEmitter();
    stalled.stderr = new EventEmitter();
    stalled.kill = vi.fn();
    spawn.mockImplementationOnce(() => stalled);
    const pending = resolveForgeTokenEnv('/example/repo', { timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toEqual({});
    expect(stalled.kill).toHaveBeenCalledWith('SIGKILL');

    // A close emitted after the timeout must not change the settled result.
    stalled.emit('close', 1);
    await expect(pending).resolves.toEqual({});
  });

  it('aborts a token probe that starts near the end of the whole lookup budget', async () => {
    vi.useFakeTimers();
    respond({ stdout: 'git@github.com:example-owner/project.git\n' });

    const status = new EventEmitter();
    status.stdout = new EventEmitter();
    status.stderr = new EventEmitter();
    status.kill = vi.fn();
    spawn.mockImplementationOnce(() => {
      setTimeout(() => {
        status.stderr.emit('data', 'Logged in to github.com account example-owner\n');
        status.emit('close', 0);
      }, 9);
      return status;
    });

    const token = new EventEmitter();
    token.stdout = new EventEmitter();
    token.stderr = new EventEmitter();
    token.kill = vi.fn();
    spawn.mockImplementationOnce(() => token);

    const pending = resolveForgeTokenEnv('/example/repo', { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(9);
    expect(spawn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({});
    expect(token.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not start an auth probe when git finishes after the whole lookup budget', async () => {
    vi.useFakeTimers();
    const git = new EventEmitter();
    git.stdout = new EventEmitter();
    git.stderr = new EventEmitter();
    git.kill = vi.fn();
    spawn.mockImplementationOnce(() => git);

    const pending = resolveForgeTokenEnv('/example/repo', { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toEqual({});

    git.stdout.emit('data', 'git@github.com:example-owner/project.git\n');
    git.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('per-app forge account pinning', () => {
  // `git remote get-url origin` → `git rev-parse --git-common-dir` (only when an
  // app pins an account) → `gh auth token` → `gh api user`. `gh auth status` is
  // deliberately absent: a named account is not something to second-guess
  // against the owner.
  function pinnedAccount({ tokenCode = 0, identity = '4242\tacme-bot\tAcme Bot\n', identityCode = 0 } = {}) {
    listForgePinnedApps.mockResolvedValue([{ repoPath: '/example/repo', forgeAccount: 'acme-bot' }]);
    respond({ stdout: 'git@github.com:acme/widget.git\n' });
    respond({ stdout: '/example/repo/.git\n' });
    respond({ stdout: tokenCode === 0 ? 'acme-bot-token\n' : '', code: tokenCode });
    respond({ stdout: identity, code: identityCode });
  }

  it('authenticates and commits as the pinned account, not the repo owner', async () => {
    pinnedAccount();
    await expect(resolveForgeTokenEnv('/example/repo')).resolves.toEqual({
      GH_TOKEN: 'acme-bot-token',
      GIT_AUTHOR_NAME: 'Acme Bot',
      GIT_AUTHOR_EMAIL: '4242+acme-bot@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'Acme Bot',
      GIT_COMMITTER_EMAIL: '4242+acme-bot@users.noreply.github.com',
    });
    // The owner (`acme`) never matched a logged-in login, so the pre-pin code
    // would have resolved no account at all — and `gh auth status` is not run.
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(spawn).toHaveBeenNthCalledWith(3, 'gh', ['auth', 'token', '-u', 'acme-bot', '-h', 'github.com'], { shell: false });
  });

  it('runs the identity probe as the pinned account rather than gh\u2019s active user', async () => {
    pinnedAccount();
    await resolveForgeTokenEnv('/example/repo');
    const [, args, options] = spawn.mock.calls[3];
    expect(args).toContain('user');
    expect(options.env.GH_TOKEN).toBe('acme-bot-token');
  });

  it('still pins the token when the identity probe fails', async () => {
    // A commit authored as nobody is worse than one authored ambiently, so an
    // unreadable identity must drop the override without dropping the credential.
    pinnedAccount({ identityCode: 1 });
    await expect(resolveForgeTokenEnv('/example/repo')).resolves.toEqual({ GH_TOKEN: 'acme-bot-token' });
  });

  it('does not fall back to an owner match when the pinned account has no token', async () => {
    pinnedAccount({ tokenCode: 1 });
    await expect(resolveForgeTokenEnv('/example/repo')).resolves.toEqual({});
  });

  it('maps an agent worktree back to the checkout the pin is registered against', async () => {
    listForgePinnedApps.mockResolvedValue([{ repoPath: '/example/repo', forgeAccount: 'acme-bot' }]);
    respond({ stdout: 'git@github.com:acme/widget.git\n' });
    // A CoS worktree lives under PortOS's own data dir and never matches an
    // app repoPath; --git-common-dir is what points back at the checkout.
    respond({ stdout: '/example/repo/.git\n' });
    respond({ stdout: 'acme-bot-token\n' });
    respond({ stdout: '4242\tacme-bot\t\n' });
    const env = await resolveForgeTokenEnv('/portos/data/cos/worktrees/agent-1');
    // A null `.name` falls back to the login rather than committing as "".
    expect(env.GIT_AUTHOR_NAME).toBe('acme-bot');
    expect(env.GH_TOKEN).toBe('acme-bot-token');
  });

  it('leaves an unpinned app on the inferred account with ambient commit identity', async () => {
    githubAccount();
    await expect(resolveForgeTokenEnv('/example/repo')).resolves.toEqual({ GH_TOKEN: 'test-owner-token' });
    // No rev-parse: nothing pins an account, so the worktree lookup is skipped.
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('ignores a pin registered against a different repository', async () => {
    listForgePinnedApps.mockResolvedValue([{ repoPath: '/other/repo', forgeAccount: 'acme-bot' }]);
    respond({ stdout: 'git@github.com:example-owner/project.git\n' });
    respond({ stdout: '/example/repo/.git\n' });
    respond({ stderr: 'Logged in to github.com account example-owner\n' });
    respond({ stdout: 'test-owner-token\n' });
    await expect(resolveForgeTokenEnv('/example/repo')).resolves.toEqual({ GH_TOKEN: 'test-owner-token' });
  });

  it('honors explicit forgeAccount option directly and strips conflicting env tokens', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ambient-github-token');
    vi.stubEnv('GH_ENTERPRISE_TOKEN', 'ambient-enterprise-token');
    respond({ stdout: 'git@github.com:example-owner/project.git\n' });
    respond({ stdout: 'direct-account-token\n' });
    respond({ stdout: '9999\tdirect-bot\tDirect Bot\n' });

    const forge = await resolveForgeForRepo('/example/repo', { forgeAccount: 'direct-bot' });
    expect(forge.account).toBe('direct-bot');
    expect(forge.env.GH_TOKEN).toBe('direct-account-token');
    expect(forge.env.GITHUB_TOKEN).toBeUndefined();
    expect(forge.env.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(listForgePinnedApps).not.toHaveBeenCalled();
  });
});

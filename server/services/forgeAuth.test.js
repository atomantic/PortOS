import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../lib/childProcess.js', () => ({ spawn: vi.fn() }));
// The managed-app registry read is the only thing forge auth needs from the app
// layer; doubling it keeps this suite off the filesystem and makes the pinned
// vs. inferred account split explicit per test.
vi.mock('./agentAppWorkspace.js', () => ({ listForgePinnedApps: vi.fn(async () => []) }));

import { spawn } from '../lib/childProcess.js';
import { listForgePinnedApps } from './agentAppWorkspace.js';
import { resolveForgeForRepo, resolveForgeTokenEnv } from './forgeAuth.js';
import { resolveForgeExecOptions } from './forgeExecOptions.js';

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
    // The resolver strips every other ambient token; derive the expectation the
    // same way so a CI/proxy environment that exports GITHUB_TOKEN can't fail it.
    const expectedEnv = { ...process.env, GH_HOST: 'github.com', GH_TOKEN: 'test-owner-token' };
    for (const key of ['GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete expectedEnv[key];
    expect(forge).toEqual({
      cli: 'gh', host: 'github.com', owner: 'example-owner', account: 'example-owner',
      env: expectedEnv, identity: null
    });
    expect(spawn).toHaveBeenNthCalledWith(3, 'gh', ['auth', 'token', '-u', 'example-owner', '-h', 'github.com'], { shell: false, env: expect.objectContaining({ GH_HOST: 'github.com' }) });
    expect(process.env.GH_TOKEN).toBe('test-ambient-token');
  });

  it('gives agent launches only the newly resolved token', async () => {
    githubAccount();
    await expect(resolveForgeTokenEnv('/example/repo')).resolves.toEqual({ GH_HOST: 'github.com', GH_TOKEN: 'test-owner-token' });
  });

  it.each([
    ['failed token lookup', { tokenCode: 1 }],
    ['another host returned by gh status', { host: 'github.example.com' }]
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

  it('refuses a stalled lookup rather than launching an agent as an unverified account', async () => {
    vi.useFakeTimers();
    respond({ stdout: 'git@github.com:example-owner/project.git\n' });
    const stalled = new EventEmitter();
    stalled.stdout = new EventEmitter();
    stalled.stderr = new EventEmitter();
    stalled.kill = vi.fn();
    spawn.mockImplementationOnce(() => stalled);
    const pending = resolveForgeTokenEnv('/example/repo', { timeoutMs: 25 });
    const refused = expect(pending).rejects.toMatchObject({ code: 'FORGE_AUTH_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(25);
    await refused;
    expect(stalled.kill).toHaveBeenCalledWith('SIGKILL');

    // A close emitted after the timeout must not change the settled result.
    stalled.emit('close', 1);
    await expect(pending).rejects.toMatchObject({ code: 'FORGE_AUTH_TIMEOUT' });
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
    const refused = expect(pending).rejects.toMatchObject({ code: 'FORGE_AUTH_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(9);
    expect(spawn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);

    await refused;
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
    const refused = expect(pending).rejects.toMatchObject({ code: 'FORGE_AUTH_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(10);
    await refused;

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
      GH_HOST: 'github.com',
      GH_TOKEN: 'acme-bot-token',
      GIT_AUTHOR_NAME: 'Acme Bot',
      GIT_AUTHOR_EMAIL: '4242+acme-bot@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'Acme Bot',
      GIT_COMMITTER_EMAIL: '4242+acme-bot@users.noreply.github.com',
    });
    // The owner (`acme`) never matched a logged-in login, so the pre-pin code
    // would have resolved no account at all — and `gh auth status` is not run.
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(spawn).toHaveBeenNthCalledWith(3, 'gh', ['auth', 'token', '-u', 'acme-bot', '-h', 'github.com'], { shell: false, env: expect.objectContaining({ GH_HOST: 'github.com' }) });
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
    await expect(resolveForgeTokenEnv('/example/repo')).resolves.toEqual({ GH_HOST: 'github.com', GH_TOKEN: 'acme-bot-token' });
  });

  it('does not fall back to an owner match when the pinned account has no token', async () => {
    pinnedAccount({ tokenCode: 1 });
    await expect(resolveForgeTokenEnv('/example/repo')).rejects.toMatchObject({ code: 'FORGE_ACCOUNT_UNAVAILABLE' });
    expect(spawn).toHaveBeenCalledTimes(3);
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

  it('matches a pin registered against the real path when the checkout is reached through a symlink', async () => {
    // A lexical compare never matches the symlinked side, so the pin was
    // silently missed and auth fell back to the wrong account.
    const home = mkdtempSync(join(tmpdir(), 'portos-forge-'));
    const real = join(home, 'repo');
    const link = join(home, 'link');
    mkdirSync(real);
    symlinkSync(real, link);
    try {
      listForgePinnedApps.mockResolvedValue([{ repoPath: real, forgeAccount: 'acme-bot' }]);
      respond({ stdout: 'git@github.com:acme/widget.git\n' });
      respond({ stdout: `${link}/.git\n` });
      respond({ stdout: 'acme-bot-token\n' });
      respond({ stdout: '4242\tacme-bot\tAcme Bot\n' });
      await expect(resolveForgeTokenEnv(link)).resolves.toMatchObject({ GH_HOST: 'github.com', GH_TOKEN: 'acme-bot-token' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('leaves an unpinned app on the inferred account with ambient commit identity', async () => {
    githubAccount();
    await expect(resolveForgeTokenEnv('/example/repo')).resolves.toEqual({ GH_HOST: 'github.com', GH_TOKEN: 'test-owner-token' });
    // No rev-parse: nothing pins an account, so the worktree lookup is skipped.
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('ignores a pin registered against a different repository', async () => {
    listForgePinnedApps.mockResolvedValue([{ repoPath: '/other/repo', forgeAccount: 'acme-bot' }]);
    respond({ stdout: 'git@github.com:example-owner/project.git\n' });
    respond({ stdout: '/example/repo/.git\n' });
    respond({ stderr: 'Logged in to github.com account example-owner\n' });
    respond({ stdout: 'test-owner-token\n' });
    await expect(resolveForgeTokenEnv('/example/repo')).resolves.toEqual({ GH_HOST: 'github.com', GH_TOKEN: 'test-owner-token' });
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


describe('host-bound execution and child credentials', () => {
  // The same owner and pinned login exist on both hosts; every credential and
  // identity must follow the origin, even when all ambient tokens are present.
  it.each([
    ['github.com', 'GH_TOKEN', '4242+acme-bot@users.noreply.github.com'],
    ['ghe.example.com', 'GH_ENTERPRISE_TOKEN', 'bot@example.com'],
    ['acme.ghe.com', 'GH_TOKEN', 'bot@example.com'],
  ])('isolates pinned credentials and commit identity on %s', async (host, tokenKey, email) => {
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) vi.stubEnv(key, `ambient-${key}`);
    vi.stubEnv('GH_HOST', 'other.example.com');
    const queuePin = () => {
      respond({ stdout: `git@${host}:acme/widget.git` });
      respond({ stdout: `${host}-token` });
      respond({ stdout: '4242\tacme-bot\tAcme Bot\tbot@example.com\n' });
    };
    queuePin();
    const options = await resolveForgeExecOptions('/example/repo', { forgeAccount: 'acme-bot' });
    expect(options).toMatchObject({ cwd: '/example/repo', env: { GH_HOST: host, [tokenKey]: `${host}-token` } });
    expect(options.customEnv).toBe(options.env);
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
      expect(spawn.mock.calls[1][2].env[key]).toBeUndefined();
      if (key !== tokenKey) expect(options.env[key]).toBeUndefined();
    }
    expect(spawn.mock.calls[1][1]).toEqual(['auth', 'token', '-u', 'acme-bot', '-h', host]);
    expect(spawn.mock.calls[2][1]).toEqual(['api', 'user', '--hostname', host, '--jq', '[.id, .login, .name, .email] | @tsv']);
    expect(spawn.mock.calls[2][2].env).toEqual(options.env);

    queuePin();
    const overlay = await resolveForgeTokenEnv('/example/repo', { forgeAccount: 'acme-bot' });
    expect(overlay).toEqual({
      GH_HOST: host, [tokenKey]: `${host}-token`,
      GIT_AUTHOR_NAME: 'Acme Bot', GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: 'Acme Bot', GIT_COMMITTER_EMAIL: email,
    });
    expect(process.env[tokenKey]).toBe(`ambient-${tokenKey}`);
  });

  it('owner-matches only accounts reported for the enterprise origin', async () => {
    respond({ stdout: 'git@ghe.example.com:acme/widget.git' });
    respond({ stdout: 'Logged in to github.com account acme\nLogged in to ghe.example.com account acme\n' });
    respond({ stdout: 'enterprise-token' });
    const options = await resolveForgeExecOptions('/example/repo');
    expect(options.env.GH_ENTERPRISE_TOKEN).toBe('enterprise-token');
    expect(options.env.GH_TOKEN).toBeUndefined();
    expect(spawn.mock.calls[1][1]).toEqual(['auth', 'status', '-h', 'ghe.example.com']);
    expect(spawn.mock.calls[2][1]).toEqual(['auth', 'token', '-u', 'acme', '-h', 'ghe.example.com']);
  });

  it('refuses unavailable enterprise pins before callers can execute with ambient auth', async () => {
    respond({ stdout: 'git@ghe.example.com:acme/widget.git' });
    respond({ code: 1 });
    await expect(resolveForgeExecOptions('/example/repo', { forgeAccount: 'acme-bot' }))
      .rejects.toMatchObject({ code: 'FORGE_ACCOUNT_UNAVAILABLE' });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][1]).toEqual(['auth', 'token', '-u', 'acme-bot', '-h', 'ghe.example.com']);
  });

  it('does not invent a public-host noreply identity when enterprise email is unavailable', async () => {
    respond({ stdout: 'git@ghe.example.com:acme/widget.git' });
    respond({ stdout: 'enterprise-token' });
    respond({ stdout: '4242\tacme-bot\tAcme Bot\t\n' });
    await expect(resolveForgeTokenEnv('/example/repo', { forgeAccount: 'acme-bot' }))
      .resolves.toEqual({ GH_HOST: 'ghe.example.com', GH_ENTERPRISE_TOKEN: 'enterprise-token' });
  });

  it('keeps an unknown forge ambient without querying public GitHub credentials', async () => {
    respond({ stdout: 'git@bitbucket.org:acme/widget.git' });
    respond({ code: 1 });
    const options = await resolveForgeExecOptions('/example/repo');
    expect(options.env).toBe(process.env);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][1]).toEqual(['auth', 'status', '-h', 'bitbucket.org']);
    expect(spawn.mock.calls[1][2].env.GH_TOKEN).toBeUndefined();
  });
});

it('refuses an explicit account pin when its repository cannot be resolved', async () => {
  await expect(resolveForgeExecOptions(null, { forgeAccount: 'acme-bot' }))
    .rejects.toMatchObject({ code: 'FORGE_ACCOUNT_UNAVAILABLE' });
  expect(spawn).not.toHaveBeenCalled();
  respond({ code: 1 });
  await expect(resolveForgeExecOptions('/example/repo', { forgeAccount: 'acme-bot' }))
    .rejects.toMatchObject({ code: 'FORGE_ACCOUNT_UNAVAILABLE' });
  expect(spawn).toHaveBeenCalledTimes(1);
});

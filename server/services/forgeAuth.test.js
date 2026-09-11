import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/childProcess.js', () => ({ spawn: vi.fn() }));

import { spawn } from '../lib/childProcess.js';
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
      env: { ...process.env, GH_TOKEN: 'test-owner-token' }
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
    expect(forge).toEqual({ cli: 'glab', host: 'gitlab.example.com', owner: 'group', account: null, env: process.env });
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
});

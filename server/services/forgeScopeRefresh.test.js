import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.fn();
vi.mock('../lib/childProcess.js', () => ({ spawn: (...args) => spawnMock(...args) }));
vi.mock('./github.js', () => ({ execGh: vi.fn() }));

import { execGh } from './github.js';
import {
  startForgeScopeRefresh,
  attachForgeScopeRefreshClient,
  cancelForgeScopeRefresh,
  forgeScopeMissingError,
  FORGE_REFRESH_TIMEOUT_MS,
} from './forgeScopeRefresh.js';

const DEVICE_PROMPT = '\n! First copy your one-time code: ABCD-1234\nOpen this URL to continue in your web browser: https://ghe.example.com/login/device\n';

const fakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => { setImmediate(() => child.emit('close', null)); return true; });
  return child;
};

// An SSE response double: every frame the job broadcasts, parsed.
const attachFrames = (jobId) => {
  const frames = [];
  const res = { writeHead: vi.fn(), write: (msg) => frames.push(JSON.parse(msg.replace(/^data: /, ''))), end: vi.fn(), req: { on: vi.fn() } };
  expect(attachForgeScopeRefreshClient(jobId, res)).toBe(true);
  return frames;
};

let child;
// Settle a job so the per-host slot frees between tests.
const settle = async (jobId) => { cancelForgeScopeRefresh(jobId); await vi.advanceTimersByTimeAsync(10); };

beforeEach(() => {
  vi.useFakeTimers();
  child = fakeChild();
  spawnMock.mockReset().mockReturnValue(child);
  execGh.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startForgeScopeRefresh', () => {
  it('runs gh against the host with no env token and publishes the device code, then completes', async () => {
    process.env.GH_TOKEN = 'ambient-token';
    const { jobId, adopted } = await startForgeScopeRefresh({ host: 'ghe.example.com', scopes: ['workflow'] });
    delete process.env.GH_TOKEN;
    const frames = attachFrames(jobId);

    const [cmd, args, options] = spawnMock.mock.calls[0];
    expect([cmd, args]).toEqual(['gh', ['auth', 'refresh', '-h', 'ghe.example.com', '-s', 'workflow']]);
    // An env token outranks the keyring and gh refuses to refresh it.
    expect(options.env.GH_TOKEN).toBeUndefined();
    expect(options.shell).toBe(false);
    expect(adopted).toBe(false);

    child.stderr.emit('data', Buffer.from(DEVICE_PROMPT));
    expect(frames).toEqual([{ type: 'device-code', host: 'ghe.example.com', scopes: ['workflow'], code: 'ABCD-1234', url: 'https://ghe.example.com/login/device' }]);

    child.emit('close', 0);
    expect(frames.at(-1)).toEqual({ type: 'complete', host: 'ghe.example.com', scopes: ['workflow'] });
  });

  it('replays the device code to a client that attaches after it was printed', async () => {
    const { jobId } = await startForgeScopeRefresh({ host: 'ghe.example.com', scopes: ['workflow'] });
    child.stderr.emit('data', Buffer.from(DEVICE_PROMPT));

    expect(attachFrames(jobId)).toEqual([expect.objectContaining({ type: 'device-code', code: 'ABCD-1234' })]);
    await settle(jobId);
  });

  it('reports gh failing (user declined, restricted OAuth app) as an error frame', async () => {
    const { jobId } = await startForgeScopeRefresh({ host: 'ghe.example.com', scopes: ['workflow'] });
    const frames = attachFrames(jobId);

    child.stderr.emit('data', Buffer.from('X Authentication failed: access_denied\n'));
    child.emit('close', 1);

    expect(frames.at(-1)).toEqual({ type: 'error', error: 'X Authentication failed: access_denied' });
  });

  it('reports a gh that cannot start as an error frame, not a crash', async () => {
    const { jobId } = await startForgeScopeRefresh({ host: 'ghe.example.com', scopes: ['workflow'] });
    const frames = attachFrames(jobId);

    child.emit('error', new Error('spawn gh ENOENT'));

    expect(frames.at(-1)).toMatchObject({ type: 'error', error: expect.stringContaining('ENOENT') });
  });

  it('cancel stops gh and ends the stream with a canceled frame', async () => {
    const { jobId } = await startForgeScopeRefresh({ host: 'ghe.example.com', scopes: ['workflow'] });
    const frames = attachFrames(jobId);

    expect(cancelForgeScopeRefresh(jobId)).toBe(true);
    await vi.advanceTimersByTimeAsync(10);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(frames.at(-1)).toEqual({ type: 'canceled' });
    expect(cancelForgeScopeRefresh(jobId)).toBe(false);
  });

  it('gives up when the one-time code expires unapproved', async () => {
    const { jobId } = await startForgeScopeRefresh({ host: 'ghe.example.com', scopes: ['workflow'] });
    const frames = attachFrames(jobId);

    await vi.advanceTimersByTimeAsync(FORGE_REFRESH_TIMEOUT_MS + 1);

    expect(child.kill).toHaveBeenCalled();
    expect(frames.at(-1)).toMatchObject({ type: 'error', error: expect.stringContaining('expired') });
  });

  it('adopts the running refresh for a host instead of starting a second device flow', async () => {
    const first = await startForgeScopeRefresh({ host: 'ghe.example.com', scopes: ['workflow'] });
    const second = await startForgeScopeRefresh({ host: 'ghe.example.com', scopes: ['workflow'] });

    expect(second).toMatchObject({ jobId: first.jobId, adopted: true });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await settle(first.jobId);
  });

  it('refuses to adopt a refresh for a different account or insufficient scopes', async () => {
    execGh.mockResolvedValue('owner-acct');
    const first = await startForgeScopeRefresh({ host: 'github.com', scopes: ['workflow'], expectedAccount: 'owner-acct' });

    await expect(startForgeScopeRefresh({ host: 'github.com', scopes: ['workflow'], expectedAccount: 'other-acct' }))
      .rejects.toMatchObject({ code: 'FORGE_REFRESH_IN_PROGRESS' });
    await expect(startForgeScopeRefresh({ host: 'github.com', scopes: ['workflow', 'gist'], expectedAccount: 'owner-acct' }))
      .rejects.toMatchObject({ code: 'FORGE_REFRESH_IN_PROGRESS' });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await settle(first.jobId);
  });

  it('refuses a scope outside the closed set before spawning anything', async () => {
    await expect(startForgeScopeRefresh({ host: 'ghe.example.com', scopes: ['admin:org'] }))
      .rejects.toMatchObject({ status: 400, code: 'FORGE_SCOPE_NOT_REFRESHABLE' });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // `gh auth refresh` re-scopes the keyring only; an env token outranks it, so a
  // "successful" refresh would leave the failing credential untouched.
  it('refuses when the credential in use comes from an environment token', async () => {
    process.env.GH_ENTERPRISE_TOKEN = 'ambient-token';
    try {
      await expect(startForgeScopeRefresh({ host: 'ghe.example.com', scopes: ['workflow'] }))
        .rejects.toMatchObject({ status: 409, code: 'FORGE_TOKEN_FROM_ENV', context: { variable: 'GH_ENTERPRISE_TOKEN' } });
    } finally {
      delete process.env.GH_ENTERPRISE_TOKEN;
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses when the active account cannot be verified and releases the host reservation', async () => {
    execGh.mockRejectedValue(new Error('network unavailable'));

    await expect(startForgeScopeRefresh({ host: 'github.com', scopes: ['workflow'], expectedAccount: 'owner-acct' }))
      .rejects.toMatchObject({ status: 409, code: 'FORGE_ACCOUNT_UNVERIFIED' });
    expect(spawnMock).not.toHaveBeenCalled();

    execGh.mockResolvedValue('owner-acct');
    const { jobId, adopted } = await startForgeScopeRefresh({ host: 'github.com', scopes: ['workflow'], expectedAccount: 'owner-acct' });
    expect(adopted).toBe(false);
    await settle(jobId);
  });

  it('does not hand an adopting request a job whose account check later fails', async () => {
    let resolveLogin;
    execGh.mockImplementation(() => new Promise((resolve) => { resolveLogin = resolve; }));
    const options = { host: 'github.com', scopes: ['workflow'], expectedAccount: 'owner-acct' };
    const first = startForgeScopeRefresh(options);
    const second = startForgeScopeRefresh(options);
    const outcomes = Promise.allSettled([first, second]);

    resolveLogin('someone-else');
    expect(await outcomes).toEqual([
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'FORGE_ACCOUNT_NOT_ACTIVE' }) }),
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'FORGE_ACCOUNT_NOT_ACTIVE' }) }),
    ]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // gh refreshes only the host's ACTIVE login; refreshing it would leave a merge
  // that runs as another account failing with the same error.
  it('refuses when the account merges run as is not the host\'s active gh account', async () => {
    execGh.mockResolvedValue('someone-else');

    await expect(startForgeScopeRefresh({ host: 'github.com', scopes: ['workflow'], expectedAccount: 'owner-acct' }))
      .rejects.toMatchObject({ status: 409, code: 'FORGE_ACCOUNT_NOT_ACTIVE' });
    expect(spawnMock).not.toHaveBeenCalled();

    // The reservation is released, so the user can switch and retry at once.
    execGh.mockResolvedValue('owner-acct');
    const { jobId } = await startForgeScopeRefresh({ host: 'github.com', scopes: ['workflow'], expectedAccount: 'owner-acct' });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await settle(jobId);
  });
});

describe('forgeScopeMissingError', () => {
  it('does not offer a refresh, or a command, for a personal access token', () => {
    const error = forgeScopeMissingError({
      host: 'ghe.example.com',
      scopes: ['workflow'],
      error: 'refusing to allow a Personal Access Token to create or update workflow without `workflow` scope',
    });

    expect(error.context).toMatchObject({ credential: 'personal-access-token', refreshable: false, command: null });
  });

  it('marks a scope PortOS will not request as not refreshable, but still gives the command', () => {
    const error = forgeScopeMissingError({ host: null, scopes: ['admin:org'], error: 'needs the "admin:org" scope' });

    expect(error.status).toBe(403);
    expect(error.context).toEqual({
      host: 'github.com',
      scopes: ['admin:org'],
      command: 'gh auth refresh -h github.com -s admin:org',
      credential: 'oauth',
      refreshable: false,
    });
  });
});

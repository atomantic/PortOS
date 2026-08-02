import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// `github.js` reaches for the data dir at module load; keep it off the real one.
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { root: '/mock', data: '/mock/data' },
  readJSONFile: vi.fn().mockResolvedValue({ repos: {}, secrets: {} }),
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  ensureDir: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./settings.js', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  updateSettings: vi.fn().mockResolvedValue(undefined)
}));

const spawnMock = vi.fn();
vi.mock('child_process', () => ({ spawn: (...args) => spawnMock(...args) }));

const { classifyGhProbe, ghRemedy, checkGhHealth, __resetGhHealthCache } = await import('./github.js');

/** A fake `gh` child that emits the given outcome on the next tick. */
function fakeChild({ code = 0, stderr = '', spawnError = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setImmediate(() => {
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    if (spawnError) child.emit('error', spawnError);
    else child.emit('close', code);
  });
  return child;
}

describe('classifyGhProbe', () => {
  it('reports ok on a clean exit', () => {
    expect(classifyGhProbe({ code: 0 })).toEqual({ status: 'ok', detail: null });
  });

  it('reports not-installed only for ENOENT, and error for other spawn faults', () => {
    const enoent = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    expect(classifyGhProbe({ spawnError: enoent }).status).toBe('not-installed');

    const eacces = Object.assign(new Error('spawn gh EACCES'), { code: 'EACCES' });
    expect(classifyGhProbe({ spawnError: eacces }).status).toBe('error');
  });

  it('classifies an outbound firewall denial as unreachable, not a local error', () => {
    // Little Snitch (and any NetworkExtension content filter) denies the
    // connect() rather than refusing it, and Go reports EBADF. Reading that as
    // a local bug is exactly the misdiagnosis this mapping exists to prevent.
    const probe = classifyGhProbe({
      code: 1,
      stderr: 'Get "https://api.github.com/rate_limit": dial tcp 140.82.116.6:443: connect: bad file descriptor'
    });
    expect(probe.status).toBe('unreachable');
    expect(probe.detail).toContain('bad file descriptor');
  });

  it.each([
    ['dial tcp 140.82.116.6:443: i/o timeout', 'unreachable'],
    ['dial tcp: lookup api.github.com: no such host', 'unreachable'],
    ['connection refused', 'unreachable'],
    ['net/http: TLS handshake timeout', 'unreachable'],
    ['gh api rate_limit timed out after 10000ms', 'unreachable']
  ])('treats %j as %s', (stderr, expected) => {
    expect(classifyGhProbe({ code: 1, stderr }).status).toBe(expected);
  });

  it.each([
    'You are not logged in to any GitHub hosts. To log in, run: gh auth login',
    'HTTP 401: Bad credentials (https://api.github.com/rate_limit)',
    'error: authentication required'
  ])('treats %j as not-authenticated', (stderr) => {
    expect(classifyGhProbe({ code: 1, stderr }).status).toBe('not-authenticated');
  });

  it('prefers the auth verdict when a message carries both auth and network wording', () => {
    // `gh auth status` on a blocked network prints an auth-shaped line; the
    // credential problem is the actionable one, so auth must win the tie.
    const probe = classifyGhProbe({
      code: 1,
      stderr: 'The token in GH_TOKEN is invalid. To log in, run: gh auth login (dial tcp failed)'
    });
    expect(probe.status).toBe('not-authenticated');
  });

  it('falls back to error with the exit code when stderr says nothing recognisable', () => {
    expect(classifyGhProbe({ code: 3, stderr: '' })).toEqual({
      status: 'error',
      detail: 'gh exited with code 3'
    });
  });

  it('does not collapse an unrecognised failure into ok', () => {
    expect(classifyGhProbe({ code: 1, stderr: 'something new' }).status).toBe('error');
  });
});

describe('ghRemedy', () => {
  it('names the outbound-firewall case for unreachable', () => {
    expect(ghRemedy('unreachable')).toMatch(/firewall/i);
  });

  it('gives a remedy for every non-ok status and none for ok', () => {
    for (const s of ['not-installed', 'not-authenticated', 'unreachable', 'error']) {
      expect(ghRemedy(s), s).toBeTruthy();
    }
    expect(ghRemedy('ok')).toBeNull();
  });
});

describe('checkGhHealth', () => {
  beforeEach(() => {
    __resetGhHealthCache();
    spawnMock.mockReset();
  });

  afterEach(() => {
    __resetGhHealthCache();
  });

  it('probes the quota-free rate_limit endpoint', async () => {
    spawnMock.mockImplementation(() => fakeChild({ code: 0 }));
    const health = await checkGhHealth();
    expect(spawnMock).toHaveBeenCalledWith('gh', ['api', 'rate_limit'], expect.any(Object));
    expect(health.ok).toBe(true);
    expect(health.status).toBe('ok');
    expect(health.remedy).toBeNull();
  });

  it('surfaces a blocked connection as unreachable with a remedy', async () => {
    spawnMock.mockImplementation(() => fakeChild({
      code: 1,
      stderr: 'dial tcp 140.82.116.6:443: connect: bad file descriptor'
    }));
    const health = await checkGhHealth();
    expect(health.ok).toBe(false);
    expect(health.status).toBe('unreachable');
    expect(health.remedy).toMatch(/firewall/i);
    expect(health.checkedAt).toBeTruthy();
  });

  it('memoizes so a polled health endpoint does not spawn gh every request', async () => {
    spawnMock.mockImplementation(() => fakeChild({ code: 0 }));
    await checkGhHealth();
    await checkGhHealth();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('re-probes when forced', async () => {
    spawnMock.mockImplementation(() => fakeChild({ code: 0 }));
    await checkGhHealth();
    await checkGhHealth({ force: true });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('resolves rather than rejecting when gh is missing, so callers need no catch', async () => {
    spawnMock.mockImplementation(() => fakeChild({
      spawnError: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    }));
    await expect(checkGhHealth()).resolves.toMatchObject({ status: 'not-installed', ok: false });
  });

  it('kills and reports a probe that never returns', async () => {
    vi.useFakeTimers();
    const hung = new EventEmitter();
    hung.stdout = new EventEmitter();
    hung.stderr = new EventEmitter();
    hung.kill = vi.fn();
    spawnMock.mockImplementation(() => hung);

    const pending = checkGhHealth({ timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    const health = await pending;

    expect(hung.kill).toHaveBeenCalledWith('SIGKILL');
    expect(health.status).toBe('unreachable');
    vi.useRealTimers();
  });
});

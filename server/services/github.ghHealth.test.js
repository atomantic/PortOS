import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// `github.js` reaches for the data dir at module load; keep it off the real one.
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { root: '/mock', data: '/mock/data' },
  readJSONFile: vi.fn().mockResolvedValue({ repos: {}, secrets: {} }),
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  safeJSONParse: (raw, fallback) => { try { return JSON.parse(raw); } catch { return fallback; } }
}));

vi.mock('./settings.js', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  updateSettings: vi.fn().mockResolvedValue(undefined)
}));

const spawnMock = vi.fn();
vi.mock('../lib/childProcess.js', () => ({ spawn: (...args) => spawnMock(...args) }));

const {
  classifyGhProbe, ghRemedy, checkGhHealth, __resetGhHealthCache,
  ensureForgeReachable, findPullRequestForBranch
} = await import('./github.js');

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

  it('classifies gh 2.9x\'s own DNS/connect-failure wrapper as unreachable, not a generic error', () => {
    // Reproduced against a real gh 2.96.0 binary probing an unresolvable
    // `--hostname` — the exact shape a misconfigured or unreachable self-hosted
    // GitHub Enterprise host produces. This text carries none of the raw Go
    // transport strings above, so it was falling into the unhelpful 'error'
    // catch-all ("gh failed for an unrecognised reason").
    const probe = classifyGhProbe({
      code: 1,
      stderr: 'error connecting to github.enterprise.example\ncheck your internet connection or https://githubstatus.com'
    });
    expect(probe.status).toBe('unreachable');
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

  it('treats a GHES host with rate limiting disabled as ok, not error', () => {
    // Reproduced against a real GitHub Enterprise Server host with the
    // /rate_limit endpoint turned off: `gh api rate_limit --hostname <ghes>`
    // exits 1 with this exact message even though gh authenticated and
    // reached the host fine. That proves reachability — it must not be
    // reported as "gh failed for an unrecognised reason".
    const probe = classifyGhProbe({
      code: 1,
      stderr: 'HTTP 404: Rate limiting is not enabled. (https://github.enterprise.example/api/v3/rate_limit)'
    });
    expect(probe).toEqual({ status: 'ok', detail: null });
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

/**
 * The two helpers the #3358 sweep hangs off: a job-level gate that logs once and
 * a PR lookup with THREE answers instead of two.
 */
describe('ensureForgeReachable (#3358)', () => {
  beforeEach(() => { __resetGhHealthCache(); spawnMock.mockReset(); });

  it('passes silently when the probe is ok', async () => {
    spawnMock.mockImplementation(() => fakeChild({ code: 0 }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(ensureForgeReachable('some-job')).resolves.toMatchObject({ ok: true, status: 'ok' });
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('logs exactly one line naming the job and the probe status when it is not', async () => {
    spawnMock.mockImplementation(() => fakeChild({ code: 1, stderr: 'dial tcp: lookup api.github.com' }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const health = await ensureForgeReachable('pr-watcher');
    expect(health.ok).toBe(false);
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0][0]).toContain('pr-watcher');
    expect(err.mock.calls[0][0]).toContain('unreachable');
    err.mockRestore();
  });
});

describe('findPullRequestForBranch (#3358)', () => {
  beforeEach(() => { spawnMock.mockReset(); });

  /** A fake `gh` child that writes `stdout` then exits with `code`. */
  const ghChild = ({ code = 0, stdout = '' } = {}) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', code);
    });
    return child;
  };

  it('reports `found` with the PR number', async () => {
    spawnMock.mockImplementation(() => ghChild({ stdout: '[{"number":7,"url":"https://example.com/pr/7","state":"OPEN"}]' }));
    await expect(findPullRequestForBranch('claim/issue-1')).resolves.toMatchObject({ status: 'found', number: 7 });
  });

  it('reports `none` for an ANSWERED empty list', async () => {
    spawnMock.mockImplementation(() => ghChild({ stdout: '[]' }));
    await expect(findPullRequestForBranch('claim/issue-1')).resolves.toMatchObject({ status: 'none', number: null });
  });

  it('reports `unavailable` — never `none` — when gh fails', async () => {
    spawnMock.mockImplementation(() => ghChild({ code: 1 }));
    const result = await findPullRequestForBranch('claim/issue-1');
    expect(result.status).toBe('unavailable');
  });

  it('reports `unavailable` when a zero-exit gh emits unparseable output', async () => {
    spawnMock.mockImplementation(() => ghChild({ stdout: 'not json' }));
    await expect(findPullRequestForBranch('claim/issue-1')).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('reports `unavailable` with no branch to ask about', async () => {
    await expect(findPullRequestForBranch('')).resolves.toMatchObject({ status: 'unavailable' });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('checkGhHealth host keying (#3358)', () => {
  beforeEach(() => { __resetGhHealthCache(); spawnMock.mockReset(); });

  it('targets a named host with --hostname', async () => {
    spawnMock.mockImplementation(() => fakeChild({ code: 0 }));
    await checkGhHealth({ hostname: 'github.acme-corp.example' });
    expect(spawnMock).toHaveBeenCalledWith('gh', ['api', 'rate_limit', '--hostname', 'github.acme-corp.example'], expect.any(Object));
  });

  it('caches per host — a healthy github.com does not vouch for an enterprise host', async () => {
    spawnMock.mockImplementation((_cmd, args) => fakeChild(
      args.includes('github.acme-corp.example')
        ? { code: 1, stderr: 'HTTP 401: Bad credentials' }
        : { code: 0 }
    ));
    await expect(checkGhHealth()).resolves.toMatchObject({ ok: true });
    await expect(checkGhHealth({ hostname: 'github.acme-corp.example' }))
      .resolves.toMatchObject({ ok: false, status: 'not-authenticated' });
    // Both are memoized independently.
    expect(spawnMock).toHaveBeenCalledTimes(2);
    await checkGhHealth();
    await checkGhHealth({ hostname: 'github.acme-corp.example' });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});

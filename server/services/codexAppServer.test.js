import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// No real process and no real OAuth: a fake child speaks the protocol back, so
// this suite asserts the LIFECYCLE (handshake, settle-once, cancellation,
// timeouts, process exit) rather than whether codex happens to be installed.
vi.mock('../lib/childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: vi.fn(),
}));
vi.mock('../lib/processEnv.js', async (importOriginal) => ({
  ...(await importOriginal()),
  findCommandOnPath: vi.fn(() => '/usr/local/bin/codex'),
}));
// Spied, not replaced: the real pure functions still run (so the POSIX no-op
// path is exercised as shipped), while a test can force the Windows branch's
// result without pretending to be on win32.
vi.mock('../lib/bufferedSpawn.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    prepareWindowsSafeSpawn: vi.fn(actual.prepareWindowsSafeSpawn),
    killProcessTree: vi.fn(actual.killProcessTree),
  };
});

const { spawn } = await import('../lib/childProcess.js');
const { findCommandOnPath } = await import('../lib/processEnv.js');
const { killProcessTree, prepareWindowsSafeSpawn } = await import('../lib/bufferedSpawn.js');
const { CODEX_ACCOUNT_STATUS, CODEX_ERROR_CODES } = await import('../lib/codexAccount.js');
const {
  __resetCodexAppServer,
  cancelCodexChatGptLogin,
  codexLogout,
  getCodexAccountReadiness,
  peekCodexAccountReadiness,
  startCodexChatGptLogin,
  stopCodexAppServer,
} = await import('./codexAppServer.js');

const READY_ACCOUNT = { account: { type: 'chatgpt', planType: 'pro' } };

/**
 * A stand-in for the app-server child. `written` is every frame PortOS sent,
 * already parsed, so a test can assert the exact method and params that reached
 * the wire — including that nothing but the fixed argv was ever spawned.
 */
const makeChild = () => {
  const child = new EventEmitter();
  child.written = [];
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    write: (line, cb) => { child.written.push(JSON.parse(line)); cb?.(); return true; },
  });
  child.kill = vi.fn(() => { child.emit('exit', null, 'SIGTERM'); });
  child.emitFrame = (frame) => child.stdout.emit('data', `${JSON.stringify(frame)}\n`);
  // A cursor, not a search: the same method is requested several times in one
  // test, and answering the FIRST `account/read` again would settle nothing and
  // hang the second call.
  child.cursor = 0;
  child.take = (method) => {
    const index = child.written.findIndex((f, i) => i >= child.cursor && f.method === method);
    if (index === -1) return null;
    child.cursor = index + 1;
    return child.written[index];
  };
  child.lastRequest = (method) => [...child.written].reverse().find((f) => f.method === method);
  child.reply = (frame, result) => child.emitFrame({ jsonrpc: '2.0', id: frame.id, result });
  child.replyError = (frame, error) => child.emitFrame({ jsonrpc: '2.0', id: frame.id, error });
  return child;
};

/**
 * Drive one call to completion: PortOS's request is written asynchronously
 * (behind the serialized write tail), so each scripted answer waits a macrotask
 * for its frame to appear before replying.
 */
const scripted = async (child, promise, script) => {
  for (const [method, answer] of script) {
    let frame = null;
    await vi.waitFor(() => { frame = child.take(method); expect(frame).toBeTruthy(); });
    if (typeof answer === 'function') answer(frame);
    else child.reply(frame, answer);
  }
  return promise;
};

let child = null;

beforeEach(() => {
  vi.clearAllMocks();
  __resetCodexAppServer();
  child = makeChild();
  spawn.mockReturnValue(child);
  findCommandOnPath.mockReturnValue('/usr/local/bin/codex');
});

afterEach(() => { __resetCodexAppServer(); });

describe('spawning the app-server', () => {
  it('spawns the fixed `codex app-server` argv and completes the handshake before any account read', async () => {
    const promise = getCodexAccountReadiness();
    await scripted(child, promise, [['initialize', {}], ['account/read', READY_ACCOUNT], ['account/rateLimits/read', { rateLimits: {} }]]);
    const readiness = await promise;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toBe('/usr/local/bin/codex');
    expect(spawn.mock.calls[0][1]).toEqual(['app-server']);
    // The `initialized` notification must follow the handshake and precede the read.
    expect(child.written.map((f) => f.method))
      .toEqual(['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
    expect(readiness.status).toBe(CODEX_ACCOUNT_STATUS.ready);
    expect(readiness.account).toEqual({ authMethod: 'chatgpt', planType: 'pro', usesCodexManagedCredentials: false });
  });

  it('reports runtime-missing WITHOUT spawning when the codex binary is absent', async () => {
    findCommandOnPath.mockReturnValue(null);

    const readiness = await getCodexAccountReadiness();

    expect(spawn).not.toHaveBeenCalled();
    expect(readiness.status).toBe(CODEX_ACCOUNT_STATUS.runtimeMissing);
    expect(readiness.runtimeInstalled).toBe(false);
  });

  it('routes the resolved binary through prepareWindowsSafeSpawn, so a Windows codex.cmd shim starts (#5838)', async () => {
    // The reported bug: `codex` installs as a `.cmd` npm shim on Windows, and
    // Node's CVE-2024-27980 patch refuses that target under `shell: false`
    // ("spawn EINVAL"), so every account read and ChatGPT sign-in failed there.
    // The fix is the canonical wrap — asserted here with a sentinel, because
    // the wrap itself is platform-gated and owned by bufferedSpawn.
    findCommandOnPath.mockReturnValue('C:\\npm\\codex.cmd');
    vi.mocked(prepareWindowsSafeSpawn).mockReturnValueOnce({
      command: 'cmd.exe',
      args: ['/c', 'C:\\npm\\codex.cmd', 'app-server'],
    });

    const promise = getCodexAccountReadiness();
    await scripted(child, promise, [['initialize', {}], ['account/read', { account: null }]]);
    await promise;

    expect(prepareWindowsSafeSpawn).toHaveBeenCalledWith('C:\\npm\\codex.cmd', ['app-server']);
    // spawn() received the wrapped pair, NOT the raw shim path.
    expect(spawn.mock.calls[0][0]).toBe('cmd.exe');
    expect(spawn.mock.calls[0][1]).toEqual(['/c', 'C:\\npm\\codex.cmd', 'app-server']);
  });

  it('tears the child down through killProcessTree, so a cmd.exe shim cannot orphan codex', async () => {
    const promise = getCodexAccountReadiness();
    await scripted(child, promise, [['initialize', {}], ['account/read', { account: null }]]);
    await promise;

    await stopCodexAppServer();

    expect(killProcessTree).toHaveBeenCalledWith(child, 'SIGTERM');
  });

  it('reuses one child across calls, so a page poll cannot fan out processes', async () => {
    const first = getCodexAccountReadiness();
    await scripted(child, first, [['initialize', {}], ['account/read', { account: null }]]);
    await first;

    const second = getCodexAccountReadiness({ fresh: true });
    await scripted(child, second, [['account/read', { account: null }]]);
    await second;

    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('readiness verdicts', () => {
  const readOnce = async (script) => {
    const promise = getCodexAccountReadiness({ fresh: true });
    await scripted(child, promise, [['initialize', {}], ...script]);
    return promise;
  };

  it('says signed-out for a read that reported no account', async () => {
    expect((await readOnce([['account/read', { account: null }]])).status).toBe(CODEX_ACCOUNT_STATUS.signedOut);
  });

  it('says reauth-required when the app-server answers with a revoked-auth error', async () => {
    const readiness = await readOnce([['account/read', (frame) => child.replyError(frame, { code: -32000, message: 'request failed with status 401' })]]);

    expect(readiness.status).toBe(CODEX_ACCOUNT_STATUS.reauthRequired);
    expect(readiness.error.code).toBe(CODEX_ERROR_CODES.authRevoked);
  });

  it('says unknown — not signed-out — when the read fails for any other reason', async () => {
    const readiness = await readOnce([['account/read', (frame) => child.replyError(frame, { code: -32000, message: 'connection refused' })]]);

    expect(readiness.status).toBe(CODEX_ACCOUNT_STATUS.unknown);
    expect(readiness.accountFetched).toBe(false);
  });

  it('stays ready when the quota read fails, and keeps rateLimits at the null sentinel', async () => {
    const readiness = await readOnce([
      ['account/read', READY_ACCOUNT],
      ['account/rateLimits/read', (frame) => child.replyError(frame, { message: 'boom' })],
    ]);

    expect(readiness.status).toBe(CODEX_ACCOUNT_STATUS.ready);
    expect(readiness.rateLimits).toBeNull();
  });

  it('says quota-exhausted for a spent window', async () => {
    const readiness = await readOnce([
      ['account/read', READY_ACCOUNT],
      ['account/rateLimits/read', { rateLimits: { primary: { usedPercent: 100, resetsAt: '2026-09-02T00:00:00Z' } } }],
    ]);

    expect(readiness.status).toBe(CODEX_ACCOUNT_STATUS.quotaExhausted);
  });

  it('publishes no token, account id, or credential path even when the app-server sends them', async () => {
    const readiness = await readOnce([
      ['account/read', { account: { type: 'chatgpt', planType: 'pro', accountId: 'acct-1', accessToken: 'secret-value', authFile: '/home/example/.codex/auth.json' } }],
      ['account/rateLimits/read', { rateLimits: {} }],
    ]);

    expect(JSON.stringify(readiness)).not.toContain('secret-value');
    expect(JSON.stringify(readiness)).not.toContain('acct-1');
    expect(JSON.stringify(readiness)).not.toContain('auth.json');
  });
});

describe('the cached snapshot the provider list reads', () => {
  it('peeks null until an explicit read has filled it, so a cold boot accuses nobody', async () => {
    expect(peekCodexAccountReadiness()).toBeNull();

    const promise = getCodexAccountReadiness();
    await scripted(child, promise, [['initialize', {}], ['account/read', { account: null }]]);
    await promise;

    expect(peekCodexAccountReadiness().status).toBe(CODEX_ACCOUNT_STATUS.signedOut);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('is dropped by an account/updated notification so the next read is real', async () => {
    const promise = getCodexAccountReadiness();
    await scripted(child, promise, [['initialize', {}], ['account/read', { account: null }]]);
    await promise;

    child.emitFrame({ jsonrpc: '2.0', method: 'account/updated', params: {} });

    expect(peekCodexAccountReadiness()).toBeNull();
  });
});

describe('the ChatGPT sign-in flow', () => {
  const connect = async () => {
    const promise = getCodexAccountReadiness();
    await scripted(child, promise, [['initialize', {}], ['account/read', { account: null }]]);
    await promise;
  };

  it('returns only the sign-in URL and a bounded login id', async () => {
    await connect();

    const promise = startCodexChatGptLogin();
    await scripted(child, promise, [['account/login/start', { loginId: 'login-1', authUrl: 'https://auth.example.com/x', accessToken: 'secret-value' }]]);
    const login = await promise;

    expect(child.lastRequest('account/login/start').params).toEqual({ type: 'chatgpt' });
    expect(login.loginId).toBe('login-1');
    expect(login.authUrl).toBe('https://auth.example.com/x');
    expect(login.expiresAt).toBeGreaterThan(login.startedAt);
    expect(JSON.stringify(login)).not.toContain('secret-value');
  });

  it('asks for the device-code flow when the caller does', async () => {
    await connect();

    const promise = startCodexChatGptLogin({ deviceCode: true });
    await scripted(child, promise, [['account/login/start', { loginId: 'login-2', verificationUrl: 'https://auth.example.com/device', userCode: 'ABCD-EFGH' }]]);
    const login = await promise;

    expect(child.lastRequest('account/login/start').params).toEqual({ type: 'chatgptDeviceCode' });
    expect(login.userCode).toBe('ABCD-EFGH');
  });

  it('reports login-pending while the flow is live, then ready once it completes', async () => {
    await connect();
    const started = startCodexChatGptLogin();
    await scripted(child, started, [['account/login/start', { loginId: 'login-3', authUrl: 'https://auth.example.com/x' }]]);
    await started;

    const pending = getCodexAccountReadiness({ fresh: true });
    await scripted(child, pending, [['account/read', { account: null }]]);
    expect((await pending).status).toBe(CODEX_ACCOUNT_STATUS.loginPending);

    child.emitFrame({ jsonrpc: '2.0', method: 'account/login/completed', params: { loginId: 'login-3', success: true } });

    const settled = getCodexAccountReadiness({ fresh: true });
    await scripted(child, settled, [['account/read', READY_ACCOUNT], ['account/rateLimits/read', { rateLimits: {} }]]);
    expect((await settled).status).toBe(CODEX_ACCOUNT_STATUS.ready);
  });

  it('ignores a completion for a login PortOS did not start', async () => {
    await connect();
    const started = startCodexChatGptLogin();
    await scripted(child, started, [['account/login/start', { loginId: 'login-4', authUrl: 'https://auth.example.com/x' }]]);
    await started;

    child.emitFrame({ jsonrpc: '2.0', method: 'account/login/completed', params: { loginId: 'someone-elses', success: true } });

    const readiness = getCodexAccountReadiness({ fresh: true });
    await scripted(child, readiness, [['account/read', { account: null }]]);
    expect((await readiness).status).toBe(CODEX_ACCOUNT_STATUS.loginPending);
  });

  it('refuses a second concurrent sign-in rather than orphaning the first', async () => {
    await connect();
    const started = startCodexChatGptLogin();
    await scripted(child, started, [['account/login/start', { loginId: 'login-5', authUrl: 'https://auth.example.com/x' }]]);
    await started;

    await expect(startCodexChatGptLogin()).rejects.toMatchObject({ status: 409, code: CODEX_ERROR_CODES.loginFailed });
  });

  it('cancels the pending login and settles back to signed-out', async () => {
    await connect();
    const started = startCodexChatGptLogin();
    await scripted(child, started, [['account/login/start', { loginId: 'login-6', authUrl: 'https://auth.example.com/x' }]]);
    await started;

    const cancelled = cancelCodexChatGptLogin('login-6');
    await scripted(child, cancelled, [['account/login/cancel', {}], ['account/read', { account: null }]]);

    expect(child.lastRequest('account/login/cancel').params).toEqual({ loginId: 'login-6' });
    expect((await cancelled).status).toBe(CODEX_ACCOUNT_STATUS.signedOut);
  });

  it('refuses a cancel for an id that is not the pending login, so a stale tab cannot kill a new flow', async () => {
    await connect();
    const started = startCodexChatGptLogin();
    await scripted(child, started, [['account/login/start', { loginId: 'login-7', authUrl: 'https://auth.example.com/x' }]]);
    await started;

    await expect(cancelCodexChatGptLogin('login-6')).rejects.toMatchObject({ status: 409, code: CODEX_ERROR_CODES.unknownLogin });
    expect(child.lastRequest('account/login/cancel')).toBeUndefined();
  });

  it('times out an abandoned sign-in instead of pinning the card in login-pending', async () => {
    vi.useFakeTimers();
    try {
      await connect();
      const started = startCodexChatGptLogin();
      await scripted(child, started, [['account/login/start', { loginId: 'login-8', authUrl: 'https://auth.example.com/x' }]]);
      await started;

      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    } finally {
      vi.useRealTimers();
    }

    const readiness = getCodexAccountReadiness({ fresh: true });
    await scripted(child, readiness, [['account/read', { account: null }]]);
    expect((await readiness).status).toBe(CODEX_ACCOUNT_STATUS.signedOut);
  });

  it('signs out and re-reads, holding no credential of its own to clear', async () => {
    await connect();

    const promise = codexLogout();
    await scripted(child, promise, [['account/logout', {}], ['account/read', { account: null }]]);

    expect((await promise).status).toBe(CODEX_ACCOUNT_STATUS.signedOut);
  });
});

describe('failure paths settle exactly once', () => {
  it('fails every pending request when the child exits mid-flight', async () => {
    const promise = getCodexAccountReadiness();
    await vi.waitFor(() => expect(child.lastRequest('initialize')).toBeTruthy());
    child.emit('exit', 1, null);

    const readiness = await promise;
    expect(readiness.status).toBe(CODEX_ACCOUNT_STATUS.unknown);
    expect(readiness.error.code).toBe(CODEX_ERROR_CODES.exited);
  });

  it('reports a spawn failure as a typed start error rather than crashing the process', async () => {
    spawn.mockImplementation(() => { throw new Error('EACCES'); });

    const readiness = await getCodexAccountReadiness();

    expect(readiness.status).toBe(CODEX_ACCOUNT_STATUS.unknown);
    expect(readiness.error.code).toBe(CODEX_ERROR_CODES.startFailed);
  });

  it('bounds the handshake, so a child that never answers cannot hang the page', async () => {
    vi.useFakeTimers();
    try {
      const promise = getCodexAccountReadiness();
      await vi.advanceTimersByTimeAsync(20_001);
      const readiness = await promise;

      expect(readiness.status).toBe(CODEX_ACCOUNT_STATUS.unknown);
      expect(readiness.error.code).toBe(CODEX_ERROR_CODES.timeout);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a malformed frame and a late duplicate answer without settling twice', async () => {
    const promise = getCodexAccountReadiness();
    await vi.waitFor(() => expect(child.lastRequest('initialize')).toBeTruthy());
    child.stdout.emit('data', 'not json at all\n');
    child.reply(child.take('initialize'), {});
    let readFrame = null;
    await vi.waitFor(() => { readFrame = child.take('account/read'); expect(readFrame).toBeTruthy(); });
    child.reply(readFrame, { account: null });
    // A second answer for an id already settled must be ignored, not thrown.
    child.emitFrame({ jsonrpc: '2.0', id: readFrame.id, result: READY_ACCOUNT });

    expect((await promise).status).toBe(CODEX_ACCOUNT_STATUS.signedOut);
  });

  it('terminates the child on shutdown and clears the cache', async () => {
    const promise = getCodexAccountReadiness();
    await scripted(child, promise, [['initialize', {}], ['account/read', { account: null }]]);
    await promise;

    await stopCodexAppServer();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(peekCodexAccountReadiness()).toBeNull();
  });

  it('terminates a child that is still handshaking when shutdown begins', async () => {
    const promise = getCodexAccountReadiness();
    await vi.waitFor(() => expect(child.lastRequest('initialize')).toBeTruthy());

    await stopCodexAppServer();

    const readiness = await promise;
    expect(readiness.status).toBe(CODEX_ACCOUNT_STATUS.unknown);
    expect(readiness.error.code).toBe(CODEX_ERROR_CODES.exited);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('is a no-op on shutdown when nothing was ever spawned', async () => {
    await expect(stopCodexAppServer()).resolves.toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });
});

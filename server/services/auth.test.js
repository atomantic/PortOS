import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'fs';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-auth-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

// High-level auth tests exercise state/session behavior, not production KDF
// throughput. Keep the real scrypt implementation with a small test cost;
// lib/sidecarAuthGate.test.js retains the production-parameter compatibility
// path shared by the main server and sidecars.
vi.mock('../../lib/portosAuthCore.js', async () => {
  const actual = await vi.importActual('../../lib/portosAuthCore.js');
  const testParams = { N: 1024, r: 8, p: 1, maxmem: 8 * 1024 * 1024 };
  const hashPassword = (password, salt) =>
    actual.__hashPasswordWithParamsForTests(password, salt, testParams);
  return {
    ...actual,
    hashPassword,
    verifyPasswordAgainst: async (auth, password) => {
      if (!auth?.enabled || !auth.passwordHash || !auth.salt || typeof password !== 'string' || password.length === 0) return false;
      return actual.constantEqual(await hashPassword(password, auth.salt), auth.passwordHash);
    },
  };
});

// Reset settings.json between tests so a password-set in one test doesn't bleed
// into the next. The auth service uses the real settings.js, which writes to
// PATHS.data → tempRoot.
import { writeFileSync } from 'fs';
import { join } from 'path';

const resetSettings = () => {
  writeFileSync(join(tempRoot, 'settings.json'), '{}\n');
  // Also blow away the session file so verifySession() doesn't carry tokens
  // across tests.
  writeFileSync(join(tempRoot, 'auth-sessions.json'), '{"tokens":[]}\n');
};

beforeEach(() => {
  vi.resetModules();
  resetSettings();
});

afterAll(() => {
  cleanup();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('auth service', () => {
  it('starts disabled when no password has been set', async () => {
    const auth = await import('./auth.js');
    expect(await auth.isAuthEnabled()).toBe(false);
    expect(await auth.getAuthStatus()).toEqual({ enabled: false });
  });

  it('rejects passwords shorter than 8 characters', async () => {
    const auth = await import('./auth.js');
    await expect(auth.setPassword({ newPassword: 'short' })).rejects.toMatchObject({
      code: 'AUTH_PASSWORD_TOO_SHORT',
    });
  });

  it('enables auth after a first-time set and returns a session token', async () => {
    const auth = await import('./auth.js');
    const session = await auth.setPassword({ newPassword: 'correct-horse' });
    expect(session.token).toMatch(/^[0-9a-f]{64}$/);
    expect(await auth.isAuthEnabled()).toBe(true);
    expect(await auth.verifySession(session.token)).toBe(true);
  });

  it('verifies the correct password and rejects the wrong one', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    expect(await auth.verifyPassword('correct-horse')).toBe(true);
    expect(await auth.verifyPassword('battery-staple')).toBe(false);
    expect(await auth.verifyPassword('')).toBe(false);
  });

  it('blocks a password change without the current password', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    await expect(auth.setPassword({ newPassword: 'new-password' })).rejects.toMatchObject({
      code: 'AUTH_BAD_CURRENT',
    });
    await expect(auth.setPassword({
      newPassword: 'new-password',
      currentPassword: 'wrong-old',
    })).rejects.toMatchObject({ code: 'AUTH_BAD_CURRENT' });
  });

  it('rotates the password and invalidates old sessions', async () => {
    const auth = await import('./auth.js');
    const first = await auth.setPassword({ newPassword: 'correct-horse' });
    expect(await auth.verifySession(first.token)).toBe(true);
    const next = await auth.setPassword({
      newPassword: 'second-attempt',
      currentPassword: 'correct-horse',
    });
    expect(await auth.verifySession(first.token)).toBe(false);
    expect(await auth.verifySession(next.token)).toBe(true);
  });

  it('clears the password only when the current one matches', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    await expect(auth.clearPassword({ currentPassword: 'wrong' })).rejects.toMatchObject({
      code: 'AUTH_BAD_CURRENT',
    });
    await auth.clearPassword({ currentPassword: 'correct-horse' });
    expect(await auth.isAuthEnabled()).toBe(false);
  });

  it('revokes individual sessions', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { token } = await auth.createSession();
    expect(await auth.verifySession(token)).toBe(true);
    await auth.revokeSession(token);
    expect(await auth.verifySession(token)).toBe(false);
  });

  it('lists sessions with their label and expiry but never the token or its hash', async () => {
    const auth = await import('./auth.js');
    const { token: setupToken } = await auth.setPassword({ newPassword: 'correct-horse' });
    const { token: agentToken, id } = await auth.createSession({ label: 'agent' });

    const sessions = await auth.listSessions();
    expect(sessions).toHaveLength(2);
    const agentEntry = sessions.find((s) => s.id === id);
    expect(agentEntry).toEqual({ id, label: 'agent', expiresAt: expect.any(Number) });
    expect(JSON.stringify(sessions)).not.toContain(agentToken);
    expect(JSON.stringify(sessions)).not.toContain(setupToken);
    // The un-labeled browser session from setPassword() is listed too.
    expect(sessions.some((s) => s.label === null)).toBe(true);
  });

  it('revokes a session by its opaque id without touching any other session', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { token: browserToken } = await auth.createSession();
    const { token: agentToken, id: agentId } = await auth.createSession({ label: 'agent' });

    expect(await auth.revokeSessionById(agentId)).toBe(true);
    expect(await auth.verifySession(agentToken)).toBe(false);
    expect(await auth.verifySession(browserToken)).toBe(true);
  });

  it('returns false revoking an id that does not match any live session', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    expect(await auth.revokeSessionById('not-a-real-id')).toBe(false);
  });

  it('carries a missing label/id on an older record forward without invalidating it', async () => {
    const { readFileSync } = await import('fs');
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { token } = await auth.createSession();

    // Simulate a record written before `label`/`id` existed by stripping them
    // straight out of the persisted file, then reloading the module fresh.
    const sessionsPath = join(tempRoot, 'auth-sessions.json');
    const raw = JSON.parse(readFileSync(sessionsPath, 'utf8'));
    raw.tokens = raw.tokens.map(({ tokenHash, expiresAt }) => ({ tokenHash, expiresAt }));
    writeFileSync(sessionsPath, JSON.stringify(raw));

    vi.resetModules();
    const fresh = await import('./auth.js');
    expect(await fresh.verifySession(token)).toBe(true);
    const sessions = await fresh.listSessions();
    expect(sessions.find((s) => s.expiresAt === raw.tokens[0].expiresAt)).toMatchObject({ label: null });
  });

  it('extracts the token from a cookie header and Authorization: Bearer', async () => {
    const auth = await import('./auth.js');
    expect(auth.parseCookieToken('portos_auth=abc123; other=x')).toBe('abc123');
    expect(auth.parseCookieToken('other=x; portos_auth=abc123')).toBe('abc123');
    expect(auth.parseCookieToken('other=x')).toBe(null);
    expect(auth.parseCookieToken(null)).toBe(null);
    expect(auth.extractToken({ headers: { cookie: 'portos_auth=cookie-token' } })).toBe('cookie-token');
    expect(auth.extractToken({ headers: { authorization: 'Bearer header-token' } })).toBe('header-token');
    // RFC 6750: scheme name is case-insensitive — accept lowercase / mixed.
    expect(auth.extractToken({ headers: { authorization: 'bearer lowercase' } })).toBe('lowercase');
    expect(auth.extractToken({ headers: { authorization: 'BEARER mixed' } })).toBe('mixed');
    expect(auth.extractToken({
      headers: { cookie: 'portos_auth=cookie-wins', authorization: 'Bearer header-loses' },
    })).toBe('cookie-wins');
    expect(auth.extractToken({ headers: {} })).toBe(null);
  });

  it('scopes the session cookie name to the browser-facing port', async () => {
    const auth = await import('./auth.js');
    expect(auth.sessionCookieNameFor('127.0.0.1:15555')).toBe('portos_auth_15555');
    expect(auth.sessionCookieNameFor('box.tailnet.ts.net:5555')).toBe('portos_auth_5555');
    expect(auth.sessionCookieNameFor('[::1]:5553')).toBe('portos_auth_5553');
    // Default-port origins (e.g. `tailscale serve` on 443) keep the legacy name.
    expect(auth.sessionCookieNameFor('box.tailnet.ts.net')).toBe('portos_auth');
    expect(auth.sessionCookieNameFor('[::1]')).toBe('portos_auth');
    expect(auth.sessionCookieNameFor(undefined)).toBe('portos_auth');
    expect(auth.sessionCookieNameFor('host:0')).toBe('portos_auth');
    expect(auth.sessionCookieNameFor('host:99999')).toBe('portos_auth');
    expect(auth.buildSessionCookie('tok', { name: 'portos_auth_15555' })).toMatch(/^portos_auth_15555=tok; /);
    expect(auth.buildClearCookie({ name: 'portos_auth_15555' })).toMatch(/^portos_auth_15555=; .*Max-Age=0/);
  });

  it('extracts every PortOS session cookie, own port first, then Bearer', async () => {
    const auth = await import('./auth.js');
    const req = {
      headers: {
        host: '127.0.0.1:15555',
        cookie: 'portos_auth=legacy; other=x; portos_auth_5555=mac; portos_auth_15555=mine; portos_autofixer_auth=side; portos_auth_x=no',
        authorization: 'Bearer bearer-tok',
      },
    };
    expect(auth.extractTokens(req)).toEqual(['mine', 'legacy', 'mac', 'bearer-tok']);
    expect(auth.extractToken(req)).toBe('mine');
    expect(auth.parseSessionCookies('portos_auth=%E0; portos_auth_1=ok; portos_auth_1=ok')).toEqual([{ name: 'portos_auth_1', value: 'ok' }]);
    const many = Array.from({ length: 20 }, (_, i) => `portos_auth_${i + 1}=t${i}`).join('; ');
    expect(auth.parseSessionCookies(many)).toHaveLength(8);
  });

  it('verifyRequestSession accepts any live candidate so a stale same-host cookie cannot mask it', async () => {
    const auth = await import('./auth.js');
    const { token } = await auth.createSession();
    const headers = { host: '127.0.0.1:15555', cookie: `portos_auth=${'d'.repeat(64)}; portos_auth_15555=${token}` };
    expect(await auth.verifyRequestSession({ headers })).toBe(token);
    expect(await auth.verifyRequestSession({ headers: { cookie: `portos_auth=${'d'.repeat(64)}`, authorization: `Bearer ${token}` } })).toBe(token);
    expect(await auth.verifyRequestSession({ headers: { cookie: `portos_auth=${'d'.repeat(64)}` } })).toBe(null);
  });

  it('builds session and clear cookies with the right flags', async () => {
    const auth = await import('./auth.js');
    const cookie = auth.buildSessionCookie('tok', { secure: true });
    expect(cookie).toContain('portos_auth=tok');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    const insecure = auth.buildSessionCookie('tok', { secure: false });
    expect(insecure).not.toContain('Secure');
    const clear = auth.buildClearCookie();
    expect(clear).toContain('Max-Age=0');
    expect(clear).not.toContain('Secure');
    // Mirrors the live cookie's Secure flag so HTTPS deletion conforms
    // to RFC 6265bis attribute matching.
    const secureClear = auth.buildClearCookie({ secure: true });
    expect(secureClear).toContain('Secure');
  });

  it('persists sessions across reloads of the module', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { token } = await auth.createSession();

    // Simulate a server restart by re-importing the module.
    vi.resetModules();
    const fresh = await import('./auth.js');
    expect(await fresh.verifySession(token)).toBe(true);
  });

  it('picks up a session another process wrote to disk after this process loaded', async () => {
    // Keepalive mints via createSession in a separate Node process against the
    // same auth-sessions.json. The already-running server must accept that
    // token without a restart (mergeSessionsFromDisk on verify miss).
    const server = await import('./auth.js');
    await server.setPassword({ newPassword: 'correct-horse' });
    // Prime the server Map + mtime stamp.
    expect(await server.verifySession('not-a-real-token')).toBe(false);

    // Separate module namespace = separate Map, writing the shared session file
    // the way an out-of-process mint does.
    vi.resetModules();
    const mint = await import('./auth.js');
    const { token } = await mint.createSession({ label: 'keepalive' });

    // The original server namespace is still alive (resetModules only affects
    // subsequent imports). Its Map lacks `token` until the miss-path merge.
    expect(await server.verifySession(token)).toBe(true);
  });

  it('stores sessions hashed at rest (plaintext token never lands in the file)', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { token } = await auth.createSession();
    const raw = readFileSync(join(tempRoot, 'auth-sessions.json'), 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).toContain('tokenHash');
  });

  it('emits sessions:revoked-all on every auth-state change so the socket layer can kick connections', async () => {
    vi.useFakeTimers();
    const auth = await import('./auth.js');
    const events = [];
    auth.authEvents.on('sessions:revoked-all', () => events.push('event'));
    await auth.setPassword({ newPassword: 'correct-horse' });             // first-time enable
    await auth.setPassword({ newPassword: 'new-horse', currentPassword: 'correct-horse' }); // rotate
    await auth.clearPassword({ currentPassword: 'new-horse' });           // disable
    await vi.advanceTimersByTimeAsync(500);
    expect(events.length).toBe(3);
  });

  it('rate-limits login attempts per IP after a burst of failures', async () => {
    const auth = await import('./auth.js');
    const ip = '100.64.0.5';
    // First 10 attempts are NOT rate-limited (matches LOGIN_MAX_ATTEMPTS).
    for (let i = 0; i < 10; i++) {
      expect(auth.isLoginRateLimited(ip)).toBe(false);
      auth.recordLoginFailure(ip);
    }
    // 11th attempt is throttled.
    expect(auth.isLoginRateLimited(ip)).toBe(true);
    // A different IP is unaffected.
    expect(auth.isLoginRateLimited('100.64.0.6')).toBe(false);
    // Clearing wipes the window for that IP.
    auth.clearLoginFailures(ip);
    expect(auth.isLoginRateLimited(ip)).toBe(false);
  });

  it('coalesces concurrent verifySession calls so a burst right after restart sees the loaded sessions', async () => {
    // First enable auth (this writes both settings.json and an initial
    // auth-sessions.json with one session), THEN seed our fake session
    // so it survives the resetModules below — setPassword would otherwise
    // overwrite anything we wrote before it.
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { writeFileSync } = await import('fs');
    const { join } = await import('path');
    const { createHash } = await import('crypto');
    const fakeToken = 'a'.repeat(64);
    const fakeHash = createHash('sha256').update(fakeToken).digest('hex');
    writeFileSync(join(tempRoot, 'auth-sessions.json'), JSON.stringify({
      tokens: [{ tokenHash: fakeHash, expiresAt: Date.now() + 60_000 }],
    }) + '\n');
    // Simulate a server restart — fresh module = empty in-memory sessions Map.
    vi.resetModules();
    const fresh = await import('./auth.js');
    // Burst of concurrent calls — without coalescing, calls 2+ would see
    // the load-flag set but the Map still empty and return false.
    const results = await Promise.all([
      fresh.verifySession(fakeToken),
      fresh.verifySession(fakeToken),
      fresh.verifySession(fakeToken),
    ]);
    expect(results).toEqual([true, true, true]);
  });

  it('emits sessions:revoked-all on single-token logout too (kicks the tab\'s sockets)', async () => {
    vi.useFakeTimers();
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { token } = await auth.createSession();
    // Drain the setPassword's deferred-kick timer before we attach the
    // listener so it doesn't get counted against this test's expectation.
    await vi.advanceTimersByTimeAsync(500);
    const events = [];
    auth.authEvents.on('sessions:revoked-all', () => events.push('event'));
    await auth.revokeSession(token);
    // Kick event is deferred ~500ms so the response cookie can flush first.
    await vi.advanceTimersByTimeAsync(500);
    expect(events.length).toBe(1);
    // Revoking an unknown token must NOT fire — no state changed.
    await auth.revokeSession('not-a-real-token');
    // Kick event is deferred ~500ms so the response cookie can flush first.
    await vi.advanceTimersByTimeAsync(500);
    expect(events.length).toBe(1);
  });
});

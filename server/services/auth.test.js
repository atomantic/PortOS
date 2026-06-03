import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'fs';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-auth-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
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
    const auth = await import('./auth.js');
    const events = [];
    auth.authEvents.on('sessions:revoked-all', () => events.push('event'));
    await auth.setPassword({ newPassword: 'correct-horse' });             // first-time enable
    await auth.setPassword({ newPassword: 'new-horse', currentPassword: 'correct-horse' }); // rotate
    await auth.clearPassword({ currentPassword: 'new-horse' });           // disable
    // The emit is deferred via setImmediate so the response cookie can
    // flush first — let the event loop tick before asserting.
    // Kick event is deferred ~500ms so the response cookie can flush first.
    await new Promise((resolve) => setTimeout(resolve, 600));
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
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { token } = await auth.createSession();
    // Drain the setPassword's deferred-kick timer before we attach the
    // listener so it doesn't get counted against this test's expectation.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const events = [];
    auth.authEvents.on('sessions:revoked-all', () => events.push('event'));
    await auth.revokeSession(token);
    // Kick event is deferred ~500ms so the response cookie can flush first.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(events.length).toBe(1);
    // Revoking an unknown token must NOT fire — no state changed.
    await auth.revokeSession('not-a-real-token');
    // Kick event is deferred ~500ms so the response cookie can flush first.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(events.length).toBe(1);
  });
});

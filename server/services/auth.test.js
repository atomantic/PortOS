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
    // setPassword/clearPassword both call revokeAllSessions internally.
    expect(events.length).toBe(3);
  });
});

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { bindSettingsFile } from '../lib/settingsTestUtil.js';
import { request } from '../lib/testHelper.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-auth-routes-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

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

// Reset settings.json through the shared helper so the getSettings() read cache
// is dropped on every reset — see server/lib/settingsTestUtil.js. This suite
// passes today only because buildApp()'s vi.resetModules() incidentally discards
// the cache AFTER this write; routing through the helper makes the invalidation
// an explicit invariant so a future warm-then-direct-write can't regress silently.
const { writeSettingsFile } = bindSettingsFile(tempRoot);

const resetSettings = async () => {
  writeFileSync(join(tempRoot, 'auth-sessions.json'), '{"tokens":[]}\n');
  await writeSettingsFile({});
};

const buildApp = async () => {
  // Re-import the route module under the current mock state so the test sees
  // a fresh auth-service binding each time.
  vi.resetModules();
  const { default: authRoutes } = await import('./auth.js');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  return app;
};

beforeEach(async () => {
  await resetSettings();
});

afterAll(() => {
  cleanup();
});

describe('auth routes', () => {
  it('GET /api/auth/status reports disabled by default', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });
  });

  it('GET /api/auth/whoami reports authenticated when auth is off', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/auth/whoami');
    expect(res.body).toEqual({ authenticated: true, required: false });
  });

  it('POST /api/auth/password sets first-time password and returns a cookie', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/auth/password')
      .send({ newPassword: 'correct-horse' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true });
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toMatch(/portos_auth=/);
    expect(setCookie).toMatch(/HttpOnly/);
  });

  it('POST /api/auth/login rejects when auth is disabled', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/auth/login').send({ password: 'anything' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AUTH_NOT_ENABLED');
  });

  it('POST /api/auth/login throttles after the failure-window cap', async () => {
    let app = await buildApp();
    await request(app).post('/api/auth/password').send({ newPassword: 'correct-horse' });

    app = await buildApp();
    // Burn through the 10-failure window with bad passwords from one IP.
    for (let i = 0; i < 10; i++) {
      await request(app).post('/api/auth/login').send({ password: `wrong-${i}` });
    }
    // Next attempt should be throttled with 429 — and crucially WITHOUT
    // running scrypt (we can't easily assert that here, but the status
    // code confirms the throttle path fired).
    const throttled = await request(app).post('/api/auth/login').send({ password: 'correct-horse' });
    expect(throttled.status).toBe(429);
    expect(throttled.body.code).toBe('AUTH_RATE_LIMITED');
  });

  it('POST /api/auth/login rejects bad passwords and accepts correct ones', async () => {
    let app = await buildApp();
    await request(app).post('/api/auth/password').send({ newPassword: 'correct-horse' });

    app = await buildApp();
    const bad = await request(app).post('/api/auth/login').send({ password: 'wrong' });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('AUTH_BAD_PASSWORD');

    const good = await request(app).post('/api/auth/login').send({ password: 'correct-horse' });
    expect(good.status).toBe(200);
    expect(good.body).toEqual({ authenticated: true });
    expect(good.headers['set-cookie']).toMatch(/portos_auth=/);
  });

  it('POST /api/auth/logout always clears the cookie', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['set-cookie']).toMatch(/Max-Age=0/);
  });

  it('GET /api/auth/sessions lists live sessions without leaking the token', async () => {
    let app = await buildApp();
    const setupRes = await request(app).post('/api/auth/password').send({ newPassword: 'correct-horse' });
    const cookie = setupRes.headers['set-cookie'];

    app = await buildApp();
    const res = await request(app).get('/api/auth/sessions').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.sessions[0]).toEqual({ id: expect.any(String), label: null, expiresAt: expect.any(Number) });
    expect(JSON.stringify(res.body)).not.toMatch(/correct-horse/);
  });

  it('DELETE /api/auth/sessions/:id revokes only the targeted session', async () => {
    const app = await buildApp();
    const { createSession } = await import('../services/auth.js');
    const setupRes = await request(app).post('/api/auth/password').send({ newPassword: 'correct-horse' });
    const cookie = setupRes.headers['set-cookie'];
    const { id: agentId } = await createSession({ label: 'agent' });

    const listed = await request(app).get('/api/auth/sessions').set('Cookie', cookie);
    expect(listed.body.count).toBe(2);

    const revoke = await request(app).delete(`/api/auth/sessions/${agentId}`).set('Cookie', cookie);
    expect(revoke.status).toBe(200);
    expect(revoke.body).toEqual({ ok: true });

    // Revoking the agent session must not sign out the caller's own browser session.
    const after = await request(app).get('/api/auth/whoami').set('Cookie', cookie);
    expect(after.body.authenticated).toBe(true);

    const remaining = await request(app).get('/api/auth/sessions').set('Cookie', cookie);
    expect(remaining.body.count).toBe(1);
  });

  it('DELETE /api/auth/sessions/:id 404s on an id that matches no live session', async () => {
    const app = await buildApp();
    const res = await request(app).delete('/api/auth/sessions/deadbeefdeadbeef');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('AUTH_SESSION_NOT_FOUND');
  });

  it('DELETE /api/auth/password requires the current password', async () => {
    let app = await buildApp();
    await request(app).post('/api/auth/password').send({ newPassword: 'correct-horse' });

    app = await buildApp();
    const bad = await request(app)
      .delete('/api/auth/password')
      .send({ currentPassword: 'nope' });
    expect(bad.status).toBe(401);

    const good = await request(app)
      .delete('/api/auth/password')
      .send({ currentPassword: 'correct-horse' });
    expect(good.status).toBe(200);
    expect(good.body).toEqual({ enabled: false });
  });
});

describe('password-free risk acknowledgement', () => {
  it('enrolls existing installs, requires explicit consent, persists across restart, and re-arms after password removal', async () => {
    let app = await buildApp();
    expect((await request(app).get('/api/auth/password-risk')).body).toEqual({ enabled: false, acknowledgementRequired: true });
    expect((await request(app).post('/api/auth/password-risk').send({ acceptRisk: false })).status).toBe(400);
    expect((await request(app).get('/api/auth/password-risk')).body.acknowledgementRequired).toBe(true);
    expect((await request(app).post('/api/auth/password-risk').send({ acceptRisk: true })).body).toEqual({ enabled: false, acknowledgementRequired: false });
    app = await buildApp();
    expect((await request(app).get('/api/auth/password-risk')).body.acknowledgementRequired).toBe(false);
    await request(app).post('/api/auth/password').send({ newPassword: 'example-password' });
    expect((await request(app).get('/api/auth/password-risk')).body).toEqual({ enabled: true, acknowledgementRequired: false });
    await request(app).delete('/api/auth/password').send({ currentPassword: 'example-password' });
    expect((await request(app).get('/api/auth/password-risk')).body).toEqual({ enabled: false, acknowledgementRequired: true });
  });
  it('refuses corrupt settings for status and acknowledgement without removing password state', async () => {
    const app = await buildApp();
    writeFileSync(join(tempRoot, 'settings.json'), '{corrupt');
    expect((await request(app).get('/api/auth/password-risk')).status).toBe(503);
    expect((await request(app).post('/api/auth/password-risk').send({ acceptRisk: true })).status).toBe(503);
    const { readFileSync } = await import('fs');
    expect(readFileSync(join(tempRoot, 'settings.json'), 'utf8')).toBe('{corrupt');
  });
});

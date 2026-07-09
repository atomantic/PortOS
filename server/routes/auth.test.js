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

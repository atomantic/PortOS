import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { bindSettingsFile } from '../lib/settingsTestUtil.js';
import { closeLoopbackServer, request, startLoopbackServer } from '../lib/testHelper.js';

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

const instanceRegistry = vi.hoisted(() => ({ data: { self: null, peers: [] } }));
vi.mock('../services/instanceIdentity.js', async () => ({
  ...(await vi.importActual('../services/instanceIdentity.js')),
  loadData: async () => instanceRegistry.data,
}));

const buildApp = async ({ remoteAddress } = {}) => {
  // Re-import the route module under the current mock state so the test sees
  // a fresh auth-service binding each time.
  vi.resetModules();
  const { default: authRoutes } = await import('./auth.js');
  const app = express();
  if (remoteAddress) {
    // Model the socket peer, never an HTTP header, ahead of production gates.
    app.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress });
      next();
    });
    const { authGate, hostControlRouteGate, requireHostControl } = await import('../services/authGate.js');
    app.use(authGate);
    app.use(hostControlRouteGate);
    app.post('/api/commands/execute', requireHostControl, (_req, res) => res.json({ reached: true }));
  }
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  return app;
};

beforeEach(async () => {
  instanceRegistry.data = { self: null, peers: [] };
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
    // Port-scoped from Host (the harness listens on a random loopback port).
    expect(setCookie).toMatch(/portos_auth_\d+=/);
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
    expect(good.headers['set-cookie']).toMatch(/portos_auth_\d+=/);
  });

  it('POST /api/auth/logout always clears the cookie', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['set-cookie']).toMatch(/Max-Age=0/);
  });

  it('POST /api/auth/login names the cookie after the browser-facing port and never marks plain HTTP Secure', async () => {
    let app = await buildApp();
    await request(app).post('/api/auth/password').send({ newPassword: 'correct-horse' });
    app = await buildApp();
    const res = await request(app).post('/api/auth/login').send({ password: 'correct-horse' });
    expect(res.status).toBe(200);
    const setCookie = res.headers['set-cookie'];
    // One cookie, `portos_auth_<port>`, host-only (no Domain), Path=/, Lax,
    // and NOT Secure over plain HTTP — a Secure cookie would be dropped on
    // http://127.0.0.1:15555 behind a tailcat forward.
    expect(setCookie).toMatch(/^portos_auth_\d+=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
    expect(setCookie).not.toMatch(/Secure|Domain=/);
  });

  it('GET /api/auth/whoami accepts a valid session even when a sibling install\'s same-host cookie comes first', async () => {
    let app = await buildApp();
    await request(app).post('/api/auth/password').send({ newPassword: 'correct-horse' });
    app = await buildApp();
    const login = await request(app).post('/api/auth/login').send({ password: 'correct-horse' });
    const [, name, token] = /^(portos_auth_\d+)=([a-f0-9]+)/.exec(login.headers['set-cookie']);
    // e.g. the Mac's own PortOS on 127.0.0.1:5555 left `portos_auth` and
    // `portos_auth_5555` behind — cookies ignore port, so both ride along.
    const res = await request(app).get('/api/auth/whoami')
      .set('Cookie', `portos_auth=${'a'.repeat(64)}; portos_auth_5555=${'b'.repeat(64)}; ${name}=${token}`);
    expect(res.body).toEqual({ authenticated: true, required: true });
    const foreignOnly = await request(app).get('/api/auth/whoami')
      .set('Cookie', `portos_auth=${'a'.repeat(64)}; portos_auth_5555=${'b'.repeat(64)}`);
    expect(foreignOnly.body).toEqual({ authenticated: false, required: true });
  });

  it('POST /api/auth/logout revokes a pre-upgrade legacy cookie and leaves a sibling install\'s cookie alone', async () => {
    let app = await buildApp();
    const { token: legacy } = await (await import('../services/auth.js')).setPassword({ newPassword: 'correct-horse' });
    app = await buildApp();
    const foreign = 'c'.repeat(64);
    // A real socket + getSetCookie(): the shared request() helper collapses
    // repeated Set-Cookie headers to the last one.
    const server = await startLoopbackServer(app);
    const { port } = server.address();
    let setCookies;
    try {
      const out = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
        method: 'POST',
        headers: { cookie: `portos_auth=${legacy}; portos_auth_5555=${foreign}` },
      });
      setCookies = out.headers.getSetCookie();
    } finally {
      await closeLoopbackServer(server);
    }
    expect(setCookies).toEqual([
      `portos_auth_${port}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      // Our pre-upgrade legacy cookie is cleared; the sibling's is not.
      'portos_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    ]);
    const after = await request(app).get('/api/auth/whoami').set('Cookie', `portos_auth=${legacy}`);
    expect(after.body).toEqual({ authenticated: false, required: true });
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

describe('password-free risk status', () => {
  it('enrolls existing installs without letting network callers acknowledge the warning', async () => {
    let app = await buildApp();
    const initial = { enabled: false, revision: 'initial' };
    expect((await request(app).get('/api/auth/password-risk')).body).toEqual(initial);
    expect((await request(app).post('/api/auth/password-risk').send({ acceptRisk: true })).status).toBe(404);
    app = await buildApp();
    expect((await request(app).get('/api/auth/password-risk')).body).toEqual(initial);

    await request(app).post('/api/auth/password').send({ newPassword: 'example-password' });
    const protectedStatus = (await request(app).get('/api/auth/password-risk')).body;
    expect(protectedStatus).toEqual({ enabled: true, revision: expect.any(String) });
    expect(protectedStatus.revision).not.toBe(initial.revision);
    await request(app).delete('/api/auth/password').send({ currentPassword: 'example-password' });
    const unprotectedStatus = (await request(app).get('/api/auth/password-risk')).body;
    expect(unprotectedStatus.enabled).toBe(false);
    expect(unprotectedStatus.revision).not.toBe(initial.revision);
    expect(unprotectedStatus.revision).not.toBe(protectedStatus.revision);
    app = await buildApp();
    expect((await request(app).get('/api/auth/password-risk')).body).toEqual(unprotectedStatus);
  });

  it('refuses corrupt settings without removing password state', async () => {
    const app = await buildApp();
    writeFileSync(join(tempRoot, 'settings.json'), '{corrupt');
    expect((await request(app).get('/api/auth/password-risk')).status).toBe(503);
    const { readFileSync } = await import('fs');
    expect(readFileSync(join(tempRoot, 'settings.json'), 'utf8')).toBe('{corrupt');
  });
});

describe('password setup through production authorization gates (#8771)', () => {
  const stores = () => ['settings.json', 'auth-sessions.json']
    .map((name) => readFileSync(join(tempRoot, name), 'utf8'));
  const passwordBody = { newPassword: 'example-password' };

  it.each([
    ['direct remote caller', '192.0.2.10', {}],
    ['forged forwarding headers', '192.0.2.10', {
      'X-Forwarded-For': '127.0.0.1',
      'X-PortOS-Dev-Proxy-Client-Address': '127.0.0.1',
    }],
    ['remote Vite client', '127.0.0.1', {
      'X-PortOS-Dev-Proxy-Client-Address': '192.0.2.10',
    }],
  ])('refuses %s without changing settings or sessions or granting host control', async (_name, remoteAddress, headers) => {
    const app = await buildApp({ remoteAddress });
    const auth = await import('../services/auth.js');
    // Even an existing session must survive a rejected setup unchanged.
    await auth.createSession();
    const before = stores();
    const send = (path) => Object.entries(headers).reduce(
      (req, [key, value]) => req.set(key, value), request(app).post(path),
    );
    const refused = await send('/api/auth/password').send(passwordBody);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('HOST_CONTROL_FORBIDDEN');
    expect(refused.headers['set-cookie']).toBeUndefined();
    expect(stores()).toEqual(before);
    const command = await send('/api/commands/execute').send({});
    expect(command.status).toBe(403);
    expect(command.body.code).toBe('HOST_CONTROL_FORBIDDEN');
  });

  it.each([undefined, '127.0.0.1'])('allows local setup with Vite client marker %s', async (proxyClient) => {
    const app = await buildApp({ remoteAddress: '127.0.0.1' });
    let setup = request(app).post('/api/auth/password');
    if (proxyClient) setup = setup.set('X-PortOS-Dev-Proxy-Client-Address', proxyClient);
    const response = await setup.send(passwordBody);
    expect(response.status).toBe(200);
    expect(response.headers['set-cookie']).toMatch(/portos_auth_\d+=/);
    const command = await request(app).post('/api/commands/execute')
      .set('Cookie', response.headers['set-cookie']).send({});
    expect(command.body).toEqual({ reached: true });
  });

  it('rotates only with an operator session and current password, never peer credentials', async () => {
    const app = await buildApp({ remoteAddress: '192.0.2.10' });
    const auth = await import('../services/auth.js');
    const { token } = await auth.setPassword(passwordBody);
    const peer = { id: 'example-peer', instanceId: 'example-instance', enabled: true,
      syncSecret: 'example-pair-secret-0123456789-abcdef' };
    instanceRegistry.data.peers = [peer];
    const { derivePeerAuthToken } = await import('../lib/peerHttpClient.js');
    const body = { currentPassword: 'example-password', newPassword: 'example-replacement' };
    const before = stores();
    const scoped = await request(app).post('/api/auth/password')
      .set('X-PortOS-Instance-Id', peer.instanceId)
      .set('X-PortOS-Peer-Auth', derivePeerAuthToken(peer.syncSecret, peer.instanceId)).send(body);
    expect(scoped.status).toBe(403);
    expect(scoped.body.code).toBe('PEER_SCOPE_FORBIDDEN');
    expect(scoped.headers['set-cookie']).toBeUndefined();
    const basic = await request(app).post('/api/auth/password')
      .set('Authorization', 'Basic ' + Buffer.from(':example-password').toString('base64')).send(body);
    expect(basic.status).toBe(403);
    expect(basic.body.code).toBe('HOST_CONTROL_FORBIDDEN');
    expect(basic.headers['set-cookie']).toBeUndefined();
    const cookie = `portos_auth=${token}`;
    const wrong = await request(app).post('/api/auth/password').set('Authorization', `Bearer ${token}`)
      .send({ ...body, currentPassword: 'wrong-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('AUTH_BAD_CURRENT');
    expect(stores()).toEqual(before);
    const rotated = await request(app).post('/api/auth/password').set('Authorization', `Bearer ${token}`).send(body);
    expect(rotated.status).toBe(200);
    expect(rotated.headers['set-cookie']).toMatch(/portos_auth_\d+=/);
    expect((await request(app).post('/api/commands/execute').set('Cookie', cookie).send({})).status).toBe(401);
    expect((await request(app).post('/api/commands/execute')
      .set('Cookie', rotated.headers['set-cookie']).send({})).body).toEqual({ reached: true });
    expect(await auth.verifyPassword(body.newPassword)).toBe(true);
  });
});

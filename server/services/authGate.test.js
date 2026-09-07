import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { bindSettingsFile } from '../lib/settingsTestUtil.js';
import { request } from '../lib/testHelper.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-authgate-' });

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

// Direct settings.json writes that also drop the getSettings() read cache —
// see server/lib/settingsTestUtil.js for why the reset is required here
// (a prior setPassword() warms the cache; a bypass-save() write leaves it stale).
const { mergeSettingsFile } = bindSettingsFile(tempRoot);

const resetSettings = () => {
  writeFileSync(join(tempRoot, 'settings.json'), '{}\n');
  writeFileSync(join(tempRoot, 'auth-sessions.json'), '{"tokens":[]}\n');
};

// Merge an apiAccess block into settings.json (preserving any auth secrets a
// prior setPassword() call wrote). setPassword persists secrets to the same
// file, so read-modify-write rather than clobbering.
const writeApiAccess = (apiAccess) => mergeSettingsFile({ apiAccess });

beforeEach(() => {
  vi.resetModules();
  resetSettings();
});

afterAll(() => {
  cleanup();
});

const runGate = async (gate, req) => new Promise((resolve) => {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    type(value) { this.headers['Content-Type'] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; resolve({ res, called: false }); return this; },
    send(payload) { this.body = payload; resolve({ res, called: false }); return this; },
  };
  gate(req, res, () => resolve({ res, called: true }));
});

describe('authGate middleware', () => {
  it('is a no-op when auth is disabled', async () => {
    const { authGate } = await import('./authGate.js');
    const req = { path: '/api/cos', headers: {} };
    const result = await runGate(authGate, req);
    expect(result.called).toBe(true);
    expect(req.portosAuthContext).toEqual({ enabled: false, authenticated: false, method: null });
  });

  it('passes /api/auth/login through even when auth is enabled', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, { path: '/api/auth/login', headers: {} });
    expect(result.called).toBe(true);
  });

  it('exposes only the bearer guest descriptor while travel controls remain password gated', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    expect((await runGate(authGate, { path: '/api/eidoverse/travel/guest', headers: {} })).called).toBe(true);
    for (const suffix of ['destinations', 'depart', 'federation/visit', 'federation/chat', 'federation/leave']) {
      const result = await runGate(authGate, { path: `/api/eidoverse/travel/${suffix}`, headers: {} });
      expect(result.called).toBe(false);
      expect(result.res.statusCode).toBe(401);
      expect(result.res.body.code).toBe('AUTH_REQUIRED');
    }
  });

  it('fails closed (auth ON) when settings.json exists but is corrupt (#2684)', async () => {
    // A present-but-malformed settings.json must NOT silently disable the gate.
    // isAuthEnabled() reads it strictly, can't confirm auth is off, and assumes
    // ON — gated routes are blocked while public discovery paths stay reachable.
    writeFileSync(join(tempRoot, 'settings.json'), '{ this is not valid json');
    const { authGate } = await import('./authGate.js');

    // Public discovery path (health) is still reachable — a client must be able
    // to identify the instance even when settings can't be read.
    const health = await runGate(authGate, { path: '/api/system/health', headers: {} });
    expect(health.called).toBe(true);

    // A gated route is blocked (401) — fail closed, not fail open.
    const gated = await runGate(authGate, { path: '/api/cos', headers: {} });
    expect(gated.called).toBe(false);
    expect(gated.res.statusCode).toBe(401);
    expect(gated.res.body).toEqual({ error: 'Authentication required', code: 'AUTH_REQUIRED', timestamp: expect.any(Number) });
  });

  it('stays fail-closed when a corrupt settings.json is loaded via reloadSettings (#2684)', async () => {
    // A backup restore of a malformed snapshot calls reloadSettings(). It must NOT
    // broadcast the corrupt file as {} and prime the auth cache to disabled — that
    // would reopen the gate (fail open) and stick, since the cache is no longer null.
    writeFileSync(join(tempRoot, 'settings.json'), '{ corrupt snapshot');
    const { reloadSettings } = await import('./settings.js');
    const { authGate } = await import('./authGate.js');

    await reloadSettings();

    // Gated route stays blocked (fail closed), public discovery stays reachable.
    const gated = await runGate(authGate, { path: '/api/cos', headers: {} });
    expect(gated.called).toBe(false);
    expect(gated.res.statusCode).toBe(401);
    const health = await runGate(authGate, { path: '/api/system/health', headers: {} });
    expect(health.called).toBe(true);
  });

  it('treats an absent settings.json as auth OFF (fresh install, no regression)', async () => {
    // ENOENT is the one non-failure case — a fresh install legitimately has no
    // settings and auth is off, so gated routes pass through.
    rmSync(join(tempRoot, 'settings.json'), { force: true });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, { path: '/api/cos', headers: {} });
    expect(result.called).toBe(true);
  });

  it('blocks /api routes with no token', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, { path: '/api/cos', headers: {} });
    expect(result.called).toBe(false);
    expect(result.res.statusCode).toBe(401);
    expect(result.res.body).toEqual({ error: 'Authentication required', code: 'AUTH_REQUIRED', timestamp: expect.any(Number) });
  });

  it('allows /api routes when the cookie token is valid', async () => {
    const auth = await import('./auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, {
      path: '/api/cos',
      headers: { cookie: `portos_auth=${token}` },
    });
    expect(result.called).toBe(true);
  });

  it('allows /api routes when the Authorization Bearer token is valid', async () => {
    const auth = await import('./auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, {
      path: '/api/cos',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(result.called).toBe(true);
  });

  it('lets static client paths through when auth is on', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, { path: '/assets/index.js', headers: {} });
    expect(result.called).toBe(true);
  });

  it('returns plain-text 401 for blocked /data/* asset requests', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, { path: '/data/images/foo.png', headers: {} });
    expect(result.called).toBe(false);
    expect(result.res.statusCode).toBe(401);
    expect(result.res.body).toBe('Unauthorized');
  });

  it('gates the /sdapi/* AUTOMATIC1111-compatible surface', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, { path: '/sdapi/v1/sd-models', headers: {} });
    expect(result.called).toBe(false);
    expect(result.res.statusCode).toBe(401);
    expect(result.res.body).toEqual({ error: 'Authentication required', code: 'AUTH_REQUIRED', timestamp: expect.any(Number) });
  });

  it('treats a malformed cookie value as no token (clean 401, not 500)', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    // %E0 is a partial percent-escape — decodeURIComponent throws URIError.
    const result = await runGate(authGate, { path: '/api/cos', headers: { cookie: 'portos_auth=%E0' } });
    expect(result.called).toBe(false);
    expect(result.res.statusCode).toBe(401);
    expect(result.res.body.code).toBe('AUTH_REQUIRED');
  });

  it('rejects cross-origin requests with 403 before consulting the session', async () => {
    const auth = await import('./auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    // Even a VALID session cookie can't rescue a cross-origin request —
    // the gate must reject before reading the cookie, since CSRF
    // side-effects land regardless of whether the response is visible.
    const result = await runGate(authGate, {
      path: '/api/cos',
      headers: {
        host: 'portos.tailnet.ts.net',
        origin: 'https://evil.tailnet.ts.net',
        cookie: `portos_auth=${token}`,
      },
    });
    expect(result.called).toBe(false);
    expect(result.res.statusCode).toBe(403);
    expect(result.res.body.code).toBe('CROSS_ORIGIN_BLOCKED');
  });

  it('allows same-origin requests when Origin matches Host', async () => {
    const auth = await import('./auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, {
      path: '/api/cos',
      headers: {
        host: 'portos.tailnet.ts.net',
        origin: 'https://portos.tailnet.ts.net',
        cookie: `portos_auth=${token}`,
      },
    });
    expect(result.called).toBe(true);
  });

  it('allows requests without an Origin header (curl, server-to-server)', async () => {
    const auth = await import('./auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, {
      path: '/api/cos',
      headers: {
        host: 'portos.tailnet.ts.net',
        cookie: `portos_auth=${token}`,
      },
    });
    expect(result.called).toBe(true);
  });

  it('allows mixed-case same-origin hostnames (RFC 3986 case-insensitive)', async () => {
    const auth = await import('./auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, {
      path: '/api/cos',
      headers: {
        host: 'PortOS.Tailnet.ts.net',
        origin: 'https://portos.tailnet.ts.net',
        cookie: `portos_auth=${token}`,
      },
    });
    expect(result.called).toBe(true);
  });

  it('allows loopback↔loopback cross-port (Vite dev proxy)', async () => {
    const auth = await import('./auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, {
      path: '/api/cos',
      headers: {
        host: 'localhost:5555',
        origin: 'http://localhost:5554',
        cookie: `portos_auth=${token}`,
      },
    });
    expect(result.called).toBe(true);
  });

  it('rejects a cross-origin logout (public path still gets the CSRF check)', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, {
      path: '/api/auth/logout',
      headers: {
        host: 'portos.tailnet.ts.net',
        origin: 'https://evil.tailnet.ts.net',
      },
    });
    expect(result.called).toBe(false);
    expect(result.res.statusCode).toBe(403);
    expect(result.res.body.code).toBe('CROSS_ORIGIN_BLOCKED');
  });

  it('treats a malformed Origin header as cross-origin', async () => {
    const auth = await import('./auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, {
      path: '/api/cos',
      headers: {
        host: 'portos.tailnet.ts.net',
        origin: 'not a valid url',
        cookie: `portos_auth=${token}`,
      },
    });
    expect(result.res.statusCode).toBe(403);
  });
});

describe('authGate per-API public registry (apiAccess)', () => {
  it('opens /api/voice/public/* when voice is exposed + passwordless', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    await writeApiAccess({ voice: { exposed: true, requireAuth: false } });
    const { authGate } = await import('./authGate.js');
    const synth = await runGate(authGate, { path: '/api/voice/public/synthesize', headers: {} });
    expect(synth.called).toBe(true);
    const voices = await runGate(authGate, { path: '/api/voice/public/voices', headers: {} });
    expect(voices.called).toBe(true);
  });

  it('KEEPS mutation routes gated even when voice is exposed + passwordless', async () => {
    // The key safety invariant: exposing the public surface must NOT open the
    // config / process-control routes on the main /api/voice router.
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    await writeApiAccess({ voice: { exposed: true, requireAuth: false } });
    const { authGate } = await import('./authGate.js');
    for (const path of ['/api/voice/config', '/api/voice/whisper', '/api/voice/test']) {
      const result = await runGate(authGate, { path, headers: {} });
      expect(result.called).toBe(false);
      expect(result.res.statusCode).toBe(401);
    }
  });

  it('gates the public surface when exposed but requireAuth is true', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    await writeApiAccess({ voice: { exposed: true, requireAuth: true } });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, { path: '/api/voice/public/synthesize', headers: {} });
    expect(result.called).toBe(false);
    expect(result.res.statusCode).toBe(401);
  });

  it('gates the public surface when not exposed', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    await writeApiAccess({ voice: { exposed: false, requireAuth: false } });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, { path: '/api/voice/public/synthesize', headers: {} });
    expect(result.called).toBe(false);
    expect(result.res.statusCode).toBe(401);
  });

  it('opens /sdapi/* when sdapi is exposed + passwordless', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    await writeApiAccess({ sdapi: { exposed: true, requireAuth: false } });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, { path: '/sdapi/v1/txt2img', headers: {} });
    expect(result.called).toBe(true);
  });

  it('still applies the CSRF cross-origin guard to an exposed public path', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    await writeApiAccess({ voice: { exposed: true, requireAuth: false } });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, {
      path: '/api/voice/public/synthesize',
      headers: { host: 'portos.tailnet.ts.net', origin: 'https://evil.tailnet.ts.net' },
    });
    expect(result.called).toBe(false);
    expect(result.res.statusCode).toBe(403);
    expect(result.res.body.code).toBe('CROSS_ORIGIN_BLOCKED');
  });

  it('ignores apiAccess entirely when auth is disabled (no regression)', async () => {
    // Auth off → everything passes regardless of apiAccess flags.
    await writeApiAccess({ voice: { exposed: false, requireAuth: true } });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, { path: '/api/voice/public/synthesize', headers: {} });
    expect(result.called).toBe(true);
  });
});

describe('authGate Express path matching', () => {
  // Real HTTP requests through ordinary Express mounts reproduce the routing
  // mismatch a direct middleware call cannot see. Auth uses this suite's temp
  // storage; fixture handlers avoid booting services or touching application data.
  const buildApp = async () => {
    const { authGate } = await import('./authGate.js');
    const { default: authRoutes } = await import('../routes/auth.js');
    const app = express();
    const mutations = [];
    const recordMutation = (req, res) => {
      mutations.push(req.body);
      res.json({ auth: req.portosAuthContext });
    };
    app.use(authGate);
    app.use(express.json());
    app.use('/api/auth', authRoutes);

    const api = express.Router();
    api.get('/records/:id', (req, res) => res.json({ id: req.params.id, auth: req.portosAuthContext }));
    api.post('/records', recordMutation);
    app.use('/api/example', api);
    app.use('/data/images', (req, res) => res.type('text/plain').send(req.path));

    const sdapi = express.Router();
    sdapi.get('/sd-models', (_req, res) => res.json([]));
    sdapi.post('/txt2img', recordMutation);
    app.use('/sdapi/v1', sdapi);

    const voice = express.Router();
    voice.post('/public/synthesize', recordMutation);
    voice.put('/config', recordMutation);
    voice.post('/publicity', recordMutation);
    app.use('/api/voice', voice);
    app.get('/api/system/health', (_req, res) => res.json({ status: 'ok' }));
    app.get('/assets/App.js', (_req, res) => res.type('text/javascript').send('// Example bundle'));
    return { app, mutations };
  };

  it('blocks protected reads and mutations regardless of prefix casing', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { app, mutations } = await buildApp();

    for (const path of [
      '/api/example/records/ExampleRecord', '/aPi/example/records/ExampleRecord',
      '/data/images/ExampleAsset.txt', '/DaTa/images/ExampleAsset.txt',
      '/sdapi/v1/sd-models', '/SdApI/v1/sd-models',
    ]) {
      const response = await request(app).get(path);
      expect(response.status, path).toBe(401);
      if (path.toLowerCase().startsWith('/data/')) expect(response.text).toBe('Unauthorized');
      else expect(response.body.code).toBe('AUTH_REQUIRED');
    }
    for (const path of ['/API/example/records', '/SDAPI/v1/txt2img']) {
      const response = await request(app).post(path).send({ name: 'Example Record' });
      expect(response.status, path).toBe(401);
    }
    expect(mutations).toEqual([]);
  });

  it('authenticates mixed-case routes without changing record IDs or asset paths', async () => {
    const auth = await import('./auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    const { app, mutations } = await buildApp();
    const record = await request(app).get('/API/example/records/CaseSensitiveID')
      .set('Cookie', `portos_auth=${token}`);
    expect(record.status).toBe(200);
    expect(record.body).toEqual({ id: 'CaseSensitiveID', auth: { enabled: true, authenticated: true, method: 'session' } });

    const asset = await request(app).get('/DaTa/images/ExampleAsset.txt')
      .set('Authorization', `Bearer ${token}`);
    expect(asset.status).toBe(200);
    expect(asset.text).toBe('/ExampleAsset.txt');

    const rendered = await request(app).post('/SDAPI/v1/txt2img')
      .set('Authorization', `Basic ${Buffer.from(':correct-horse').toString('base64')}`)
      .send({ prompt: 'Example scene' });
    expect(rendered.status).toBe(200);
    expect(rendered.body.auth).toEqual({ enabled: true, authenticated: true, method: 'basic' });
    expect(mutations).toEqual([{ prompt: 'Example scene' }]);
  });

  it('preserves public auth routes and keeps opt-in API exemptions within their prefixes', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { app, mutations } = await buildApp();
    const status = await request(app).get('/API/Auth/STATUS');
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ enabled: true });
    const login = await request(app).post('/API/Auth/LOGIN').send({ password: 'correct-horse' });
    expect(login.status).toBe(200);
    expect(login.headers['set-cookie']).toMatch(/portos_auth=/);
    const health = await request(app).get('/API/SYSTEM/HEALTH');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok' });
    expect((await request(app).get('/assets/App.js')).status).toBe(200);

    await writeApiAccess({ voice: { exposed: true, requireAuth: false }, sdapi: { exposed: true, requireAuth: false } });
    expect((await request(app).post('/API/VOICE/PUBLIC/synthesize').send({ text: 'Example speech' })).status).toBe(200);
    expect((await request(app).post('/SDAPI/v1/txt2img').send({ prompt: 'Example scene' })).status).toBe(200);
    expect((await request(app).put('/API/VOICE/config').send({ example: true })).status).toBe(401);
    expect((await request(app).post('/API/VOICE/publicity').send({ example: true })).status).toBe(401);
    expect(mutations).toEqual([{ text: 'Example speech' }, { prompt: 'Example scene' }]);

    await writeApiAccess({ voice: { exposed: true, requireAuth: true }, sdapi: { exposed: false, requireAuth: false } });
    expect((await request(app).post('/API/VOICE/PUBLIC/synthesize').send({ text: 'Example speech' })).status).toBe(401);
    expect((await request(app).post('/SDAPI/v1/txt2img').send({ prompt: 'Example scene' })).status).toBe(401);
    expect(mutations).toHaveLength(2);
  });

  it('keeps the default auth-off behavior on mixed-case routes', async () => {
    await writeApiAccess({ voice: { exposed: false, requireAuth: true } });
    const { app } = await buildApp();
    const record = await request(app).get('/API/example/records/ExampleRecord');
    expect(record.status).toBe(200);
    expect(record.body.auth).toEqual({ enabled: false, authenticated: false, method: null });
    expect((await request(app).post('/API/VOICE/PUBLIC/synthesize').send({ text: 'Example speech' })).status).toBe(200);
  });
});

describe('authGate HTTP Basic auth (peer federation)', () => {
  const basicHeader = (password, username = '') =>
    `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

  it('allows /api routes when Authorization: Basic carries the correct password', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'peer-secret' });
    const { authGate } = await import('./authGate.js');
    const req = {
      path: '/api/cos',
      headers: { authorization: basicHeader('peer-secret') },
    };
    const result = await runGate(authGate, req);
    expect(result.called).toBe(true);
    expect(req.portosAuthContext).toEqual({ enabled: true, authenticated: true, method: 'basic' });
  });

  it('also works with a non-empty username (username is ignored)', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'peer-secret' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, {
      path: '/api/cos',
      headers: { authorization: basicHeader('peer-secret', 'user') },
    });
    expect(result.called).toBe(true);
  });

  it('rejects Basic auth with a wrong password', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'peer-secret' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, {
      path: '/api/cos',
      headers: { authorization: basicHeader('wrong') },
    });
    expect(result.called).toBe(false);
    expect(result.res.statusCode).toBe(401);
  });

  it('does not cache failed password verification', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'future-secret' });
    const futureSettings = JSON.parse(readFileSync(join(tempRoot, 'settings.json'), 'utf-8'));
    await auth.setPassword({
      newPassword: 'current-secret',
      currentPassword: 'future-secret',
    });
    const { __testing } = await import('./authGate.js');

    expect(await __testing.verifyBasicPassword('future-secret')).toBe(false);

    // Replace the backing credential without emitting settings:updated. A failed
    // verification must not shadow the now-valid password for the cache TTL.
    await mergeSettingsFile({ secrets: futureSettings.secrets });
    expect(await __testing.verifyBasicPassword('future-secret')).toBe(true);
  });

  it.each([null, undefined, 123, {}, []])(
    'rejects malformed Basic password value %j without throwing',
    async (password) => {
      const auth = await import('./auth.js');
      await auth.setPassword({ newPassword: 'peer-secret' });
      const { __testing } = await import('./authGate.js');

      await expect(__testing.verifyBasicPassword(password)).resolves.toBe(false);
    },
  );
});

describe('socketAuthGate middleware', () => {
  it('is a no-op when auth is disabled', async () => {
    const { socketAuthGate } = await import('./authGate.js');
    const result = await new Promise((resolve) => {
      socketAuthGate({ handshake: { headers: {} } }, (err) => resolve(err));
    });
    expect(result).toBeUndefined();
  });

  it('rejects an unauthenticated handshake when auth is on', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { socketAuthGate } = await import('./authGate.js');
    const err = await new Promise((resolve) => {
      socketAuthGate({ handshake: { headers: {} } }, (e) => resolve(e));
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.data).toEqual({ code: 'AUTH_REQUIRED' });
  });

  it('accepts a handshake with a valid cookie', async () => {
    const auth = await import('./auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    const { socketAuthGate } = await import('./authGate.js');
    const err = await new Promise((resolve) => {
      socketAuthGate({ handshake: { headers: { cookie: `portos_auth=${token}` } } }, (e) => resolve(e));
    });
    expect(err).toBeUndefined();
  });

  it('accepts a peer relay handshake with correct Basic auth', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'peer-secret' });
    const { socketAuthGate } = await import('./authGate.js');
    const header = `Basic ${Buffer.from(':peer-secret').toString('base64')}`;
    const err = await new Promise((resolve) => {
      socketAuthGate({ handshake: { headers: { authorization: header } } }, (e) => resolve(e));
    });
    expect(err).toBeUndefined();
  });

  it('rejects a cross-origin handshake', async () => {
    const auth = await import('./auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    const { socketAuthGate } = await import('./authGate.js');
    const err = await new Promise((resolve) => {
      socketAuthGate({
        handshake: {
          headers: {
            host: 'portos.tailnet.ts.net',
            origin: 'https://evil.tailnet.ts.net',
            cookie: `portos_auth=${token}`,
          },
        },
      }, (e) => resolve(e));
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.data).toEqual({ code: 'CROSS_ORIGIN_BLOCKED' });
  });
});

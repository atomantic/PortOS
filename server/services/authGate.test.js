import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { bindSettingsFile } from '../lib/settingsTestUtil.js';
import { request } from '../lib/testHelper.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { PEER_AUTH_HEADER } from '../lib/peerHttpClient.js';

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

// The peer registry resolves its own path (not through the PATHS proxy), so
// contain both reads and wake-probe mutations in the same in-memory registry.
const instanceRegistry = vi.hoisted(() => ({ data: { self: null, peers: [] } }));
vi.mock('./instanceIdentity.js', async () => ({
  ...(await vi.importActual('./instanceIdentity.js')),
  loadData: async () => instanceRegistry.data,
  withData: async (mutate) => {
    const notifications = [];
    const result = await mutate(instanceRegistry.data, notify => notifications.push(notify));
    for (const notify of notifications) notify();
    return result;
  },
  getInstanceId: async () => 'self-example-instance',
}));

// Hoisted doubles also cover the instances module retained by the global
// no-peer mock across this suite's resetModules calls.
const peerProbe = vi.hoisted(() => ({ fetch: vi.fn(), connect: vi.fn() }));
vi.mock('../lib/peerHttpClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  peerFetch: peerProbe.fetch,
}));
vi.mock('./peerSocketRelay.js', () => ({
  connectToPeer: peerProbe.connect,
  disconnectFromPeer: vi.fn(),
}));
vi.mock('./instanceEvents.js', () => ({ instanceEvents: { emit: vi.fn() } }));

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
  it('keeps health details password-gated while public health remains reachable', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');

    const health = await runGate(authGate, { method: 'GET', path: '/api/system/health', headers: {} });
    expect(health.called).toBe(true);

    const details = await runGate(authGate, { method: 'GET', path: '/api/system/health/details', headers: {} });
    expect(details.called).toBe(false);
    expect(details.res.statusCode).toBe(401);
    expect(details.res.body).toEqual({
      error: 'Authentication required',
      code: 'AUTH_REQUIRED',
      timestamp: expect.any(Number),
    });
  });

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

  // The whole point of the agent token: a CoS agent holds no browser cookie, so
  // the credential PortOS injects into its environment has to satisfy this gate
  // or every canned `curl` in its own prompt is a 401 it reads as a dead
  // endpoint. Minted through the real service against the real gate — the two
  // halves are wired far apart (spawn env vs. Express middleware).
  it.each(['/api/code-review/local', '/api/code-review/cli-outcome'])('accepts the loopback agent token for %s', async (path) => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { resolveAgentApiEnv } = await import('./agentApiAuth.js');
    const { PORTOS_API_TOKEN } = await resolveAgentApiEnv();
    const { authGate } = await import('./authGate.js');

    const result = await runGate(authGate, {
      path,
      headers: { authorization: `Bearer ${PORTOS_API_TOKEN}` },
    });

    expect(PORTOS_API_TOKEN).toBeTruthy();
    expect(result.called).toBe(true);
  });

  // …and the `${PORTOS_API_TOKEN:-}` default in those prompts is not a bypass:
  // an agent that never received a token is still refused.
  it.each(['/api/code-review/local', '/api/code-review/cli-outcome'])('refuses an empty agent bearer for %s', async (path) => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');

    const result = await runGate(authGate, {
      path,
      headers: { authorization: 'Bearer ' },
    });

    expect(result.called).toBe(false);
    expect(result.res.statusCode).toBe(401);
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

  it('rejects a page on another loopback port (a managed app is a different principal)', async () => {
    const auth = await import('./auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:8080', 'http://[::1]:4173', 'http://127.0.0.2:8080', 'http://127.999.1.1:5554']) {
      const result = await runGate(authGate, {
        path: '/api/cos',
        headers: { host: 'localhost:5555', origin, cookie: `portos_auth=${token}` },
      });
      expect(result.called, origin).toBe(false);
      expect(result.res.statusCode).toBe(403);
    }
  });

  it('allows the same loopback port under another loopback name and PortOS-owned ports', async () => {
    const auth = await import('./auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    for (const [host, origin] of [
      ['127.0.0.1:5555', 'http://localhost:5555'],
      ['localhost:5560', 'http://localhost:5555'],
      ['localhost:5555', 'http://localhost:5553'],
      ['127.0.0.1:5555', 'http://127.0.0.2:5554'],
    ]) {
      const result = await runGate(authGate, { path: '/api/cos', headers: { host, origin, cookie: `portos_auth=${token}` } });
      expect(result.called, `${origin} -> ${host}`).toBe(true);
    }
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

  it('retains verified human and delegated agent sessions on a passwordless API', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'example-password' });
    await writeApiAccess({ sdapi: { exposed: true, requireAuth: false } });
    const { authGate, requestHasHostControl } = await import('./authGate.js');
    for (const label of [null, 'agent']) {
      const { token } = await auth.createSession({ label });
      const req = { path: '/sdapi/v1/txt2img', headers: { authorization: `Bearer ${token}` }, socket: { remoteAddress: '192.0.2.10' } };
      expect((await runGate(authGate, req)).called).toBe(true);
      expect(req.portosAuthContext).toEqual({ enabled: true, authenticated: true, method: 'session' });
      expect(requestHasHostControl(req)).toBe(true);
    }
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
      '/api/database/maintenance/status',
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
    expect(login.headers['set-cookie']).toMatch(/portos_auth_\d+=/);
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

  it('keeps refusing a wrong password on repeat attempts (failures never become cached successes)', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'peer-secret' });
    const { authGate } = await import('./authGate.js');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await runGate(authGate, {
        path: '/api/cos',
        headers: { authorization: basicHeader('wrong') },
      });
      expect(result.called).toBe(false);
      expect(result.res.statusCode).toBe(401);
    }
  });

  it('stops accepting a cached Basic password immediately after rotation', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'old-secret' });
    const { authGate } = await import('./authGate.js');
    const attempt = (password) => runGate(authGate, {
      path: '/api/cos',
      headers: { authorization: basicHeader(password) },
    });
    // Warm the success cache with the old password.
    expect((await attempt('old-secret')).called).toBe(true);

    await auth.setPassword({ newPassword: 'new-secret', currentPassword: 'old-secret' });

    const stale = await attempt('old-secret');
    expect(stale.called).toBe(false);
    expect(stale.res.statusCode).toBe(401);
    expect((await attempt('new-secret')).called).toBe(true);
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

describe('host-control authority', () => {
  it('accepts a real operator session and refuses peer Basic credentials even on loopback', async () => {
    const auth = await import('./auth.js');
    const { token } = await auth.setPassword({ newPassword: 'example-password' });
    const { authGate, requireHostControl } = await import('./authGate.js');
    const gate = (req, res, next) => authGate(req, res, () => requireHostControl(req, res, next));
    const req = { path: '/api/commands/execute', socket: { remoteAddress: '127.0.0.1' } };
    const operator = await runGate(gate, { ...req, headers: { cookie: `portos_auth=${token}` } });
    expect(operator.called).toBe(true);
    const peer = await runGate(gate, { ...req, headers: {
      authorization: `Basic ${Buffer.from(':example-password').toString('base64')}`,
    } });
    expect(peer.called).toBe(false);
    expect(peer.res.statusCode).toBe(403);
    expect(peer.res.body.code).toBe('HOST_CONTROL_FORBIDDEN');
  });

  // The socket twin (#8708): locality is recorded at the handshake from the
  // connection's own address, so a forged loopback dev-proxy marker on a
  // remote connection grants nothing, and a gate-less socket fails closed.
  it('records socket host-control locality at the handshake, never from a forged marker', async () => {
    const { socketAuthGate, socketHasHostControl } = await import('./authGate.js');
    const handshake = async (address, headers = {}) => {
      const socket = { handshake: { address, headers } };
      await new Promise((resolve) => socketAuthGate(socket, resolve));
      return socketHasHostControl(socket);
    };
    expect(await handshake('127.0.0.1')).toBe(true);
    expect(await handshake('::1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' })).toBe(true);
    expect(await handshake('::1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' })).toBe(false);
    expect(await handshake('192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' })).toBe(false);
    expect(socketHasHostControl({ handshake: { address: '127.0.0.1' } })).toBe(false);
  });

  it('revalidates live socket sessions at dispatch and preserves password-free locality', async () => {
    const auth = await import('./auth.js');
    const { token: cookieToken } = await auth.setPassword({ newPassword: 'correct-horse' });
    const bearerSession = await auth.createSession();
    const { socketHasCurrentHostControl } = await import('./authGate.js');
    const socketFor = (headers = {}, disconnected = false) => ({
      handshake: { headers },
      disconnected,
    });

    expect(await socketHasCurrentHostControl(socketFor({ cookie: `portos_auth=${cookieToken}` }))).toBe(true);
    expect(await socketHasCurrentHostControl(socketFor({ authorization: `Bearer ${bearerSession.token}` }))).toBe(true);
    expect(await socketHasCurrentHostControl(socketFor())).toBe(false);
    expect(await socketHasCurrentHostControl(socketFor({ authorization: 'Basic fixture' }))).toBe(false);
    expect(await socketHasCurrentHostControl(socketFor({ [PEER_AUTH_HEADER.toLowerCase()]: 'fixture' }))).toBe(false);
    expect(await socketHasCurrentHostControl(socketFor({ authorization: `Bearer ${bearerSession.token}` }, true))).toBe(false);

    await auth.revokeSession(bearerSession.token);
    expect(await socketHasCurrentHostControl(socketFor({ authorization: `Bearer ${bearerSession.token}` }))).toBe(false);

    const expiringSession = await auth.createSession();
    vi.setSystemTime(expiringSession.expiresAt + 1);
    expect(await socketHasCurrentHostControl(socketFor({ authorization: `Bearer ${expiringSession.token}` }))).toBe(false);
    vi.useRealTimers();
  });

  // The Tailcat ingress accepts remote peers on a loopback listener, so the
  // socket address reads as local. Only the listener's mark separates them;
  // it must refuse password-free host control for HTTP and for the Socket.IO
  // handshake (which engine.io intercepts before the app handler).
  it('refuses password-free host control to requests the Tailcat ingress marked remote', async () => {
    const { remoteRequestHandler, markRemoteServer } = await import('../lib/requestOrigin.js');
    const { hostControlBodyGate, requestHasHostControl, socketAuthGate, socketHasHostControl } = await import('./authGate.js');
    const local = { headers: {}, socket: { remoteAddress: '127.0.0.1' }, portosAuthContext: { enabled: false } };
    const viaIngress = { headers: {}, socket: { remoteAddress: '127.0.0.1' }, portosAuthContext: { enabled: false } };
    remoteRequestHandler(() => {})(viaIngress, {});
    expect(requestHasHostControl(local)).toBe(true);
    expect(requestHasHostControl(viaIngress)).toBe(false);

    const policyWrite = { ...viaIngress, method: 'PUT', path: '/api/cos/config', body: { autonomyMode: 'execute' } };
    remoteRequestHandler(() => {})(policyWrite, {});
    const bodyGate = await runGate(hostControlBodyGate, policyWrite);
    expect(bodyGate.called).toBe(false);
    expect(bodyGate.res.statusCode).toBe(403);
    expect(bodyGate.res.body.code).toBe('HOST_CONTROL_FORBIDDEN');

    const { EventEmitter } = await import('node:events');
    const server = markRemoteServer(new EventEmitter());
    const handshake = async (request) => {
      const socket = { request, handshake: { address: '127.0.0.1', headers: {} } };
      await new Promise((resolve) => socketAuthGate(socket, resolve));
      return socketHasHostControl(socket);
    };
    const upgradeRequest = {};
    server.emit('upgrade', upgradeRequest);
    const pollingRequest = {};
    server.emit('request', pollingRequest);
    expect(await handshake({})).toBe(true);
    expect(await handshake(upgradeRequest)).toBe(false);
    expect(await handshake(pollingRequest)).toBe(false);
  });

  it('keeps password-free socket host control limited to connected local sockets', async () => {
    const { socketHasCurrentHostControl } = await import('./authGate.js');
    expect(await socketHasCurrentHostControl({ data: { portosLocalConnection: true } })).toBe(true);
    expect(await socketHasCurrentHostControl({ data: { portosLocalConnection: false } })).toBe(false);
    expect(await socketHasCurrentHostControl({ data: { portosLocalConnection: true }, disconnected: true })).toBe(false);
  });
});

describe('mounted host-control trailing slashes (#8950)', () => {
  const buildApp = async (remoteAddress = '192.0.2.10') => {
    const { authGate, hostControlRouteGate, hostControlBodyGate } = await import('./authGate.js');
    const { createRunsRoutes } = await import('../lib/aiToolkit/routes/runs.js');
    const runner = {
      createRun: vi.fn().mockResolvedValue({ runId: 'example-run', provider: { type: 'cli' }, metadata: {} }),
      executeCliRun: vi.fn(),
      listRuns: vi.fn().mockResolvedValue([]),
    };
    const persist = vi.fn();
    const app = express();
    app.use((req, res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress, configurable: true });
      next();
    });
    app.use(authGate);
    app.use(hostControlRouteGate);
    app.use(express.json());
    app.use(hostControlBodyGate);
    app.use('/api/runs', createRunsRoutes(runner));
    const settings = express.Router();
    settings.put('/', (req, res) => {
      persist(req.body);
      res.json({ saved: true });
    });
    settings.patch('/slice', (req, res) => {
      persist(req.body);
      res.json({ saved: true });
    });
    app.use('/api/settings', settings);
    app.put('/api/settings/features/:featureId', (req, res) => {
      persist(req.body);
      res.json({ saved: true });
    });
    return { app, runner, persist };
  };
  const runBody = { providerId: 'example-cli', prompt: 'Example prompt' };
  const protectedBodies = [
    { harnesses: {} },
    { autofixer: { verifyCommand: 'npm test', autoPromote: true } },
    { imageGen: { codex: { codexPath: '/example/codex' } } },
    // A PATCH-shaped extra field must not change how a legacy PUT is gated.
    { slicePath: 'pipeline', partial: {}, imageGen: { local: { pythonPath: '/example/python3' } } },
  ];

  it('denies remote password-free dispatch and protected writes before either sink', async () => {
    const { app, runner, persist } = await buildApp();
    for (const suffix of ['', '/', '//']) {
      const run = await request(app).post('/api/runs' + suffix).send(runBody);
      expect(run.status).toBe(403);
      expect(run.body.code).toBe('HOST_CONTROL_FORBIDDEN');
      for (const body of protectedBodies) {
        const write = await request(app).put('/api/settings' + suffix).send(body);
        expect(write.status).toBe(403);
        expect(write.body.code).toBe('HOST_CONTROL_FORBIDDEN');
      }
    }
    expect(runner.createRun).not.toHaveBeenCalled();
    expect(runner.executeCliRun).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect((await request(app).get('/api/runs//')).status).toBe(200);
    expect((await request(app).put('/api/settings//').send({ location: {} })).status).toBe(200);
    expect(persist).toHaveBeenCalledExactlyOnceWith({ location: {} });
  });

  it('applies the PUT authority policy to slice patches, preserving delegated agents', async () => {
    const remote = await buildApp();
    const protectedPatches = [
      { slicePath: 'autoUpdate', partial: { enabled: true } },
      { slicePath: 'seriesAutopilot', partial: { schedules: [] } },
      { slicePath: 'imageGen.local', partial: { pythonPath: '/example/python3' } },
    ];
    for (const suffix of ['', '/', '//']) {
      for (const body of protectedPatches) {
        const response = await request(remote.app).patch('/api/settings/slice' + suffix).send(body);
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('HOST_CONTROL_FORBIDDEN');
      }
    }
    expect(remote.persist).not.toHaveBeenCalled();
    // The existing PUT allows data-only updates and clearing executable pins.
    expect((await request(remote.app).patch('/api/settings/slice').send({
      slicePath: 'localLlm.mtplx', partial: { keepLoaded: true },
    })).status).toBe(200);
    expect((await request(remote.app).patch('/api/settings/slice').send({
      slicePath: 'imageGen.local', partial: { pythonPath: null },
    })).status).toBe(200);
    const local = await buildApp('127.0.0.1');
    for (const body of protectedPatches) {
      expect((await request(local.app).patch('/api/settings/slice').send(body)).status).toBe(200);
    }
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'example-password' });
    const { resolveAgentApiEnv } = await import('./agentApiAuth.js');
    const { PORTOS_API_TOKEN: token } = await resolveAgentApiEnv();
    expect(token).toBeTruthy();
    for (const body of protectedPatches) {
      expect((await request(local.app).patch('/api/settings/slice')
        .set('Authorization', `Bearer ${token}`).send(body)).status).toBe(200);
    }
    expect(local.persist).toHaveBeenCalledTimes(6);
  });

  it('requires operator authority to arm Eidoverse through either settings path', async () => {
    const remote = await buildApp();
    const body = { instanceFeatures: { eidoverse: { enabled: true } } };
    expect((await request(remote.app).put('/api/settings').send(body)).status).toBe(403);
    expect((await request(remote.app).put('/api/settings/features/eidoverse').send({ enabled: true })).status).toBe(403);
    expect(remote.persist).not.toHaveBeenCalled();
    const local = await buildApp('127.0.0.1');
    expect((await request(local.app).put('/api/settings').send(body)).status).toBe(200);
    expect((await request(local.app).put('/api/settings/features/eidoverse').send({ enabled: true })).status).toBe(200);
    expect(local.persist).toHaveBeenCalledTimes(2);
  });

  it.each(['local', 'session', 'agent', 'basic'])('preserves %s authority through mounted root handlers', async (authority) => {
    let header = ['X-Example', 'local'];
    if (authority !== 'local') {
      const { token } = await (await import('./auth.js')).setPassword({ newPassword: 'example-password' });
      if (authority === 'agent') {
        const { resolveAgentApiEnv } = await import('./agentApiAuth.js');
        const { PORTOS_API_TOKEN } = await resolveAgentApiEnv();
        header = ['Authorization', `Bearer ${PORTOS_API_TOKEN}`];
      } else {
        header = authority === 'session'
          ? ['Cookie', `portos_auth=${token}`]
          : ['Authorization', `Basic ${Buffer.from(':example-password').toString('base64')}`];
      }
    }
    const { app, runner, persist } = await buildApp(authority === 'session' ? '192.0.2.10' : '127.0.0.1');
    const allowed = authority !== 'basic';
    for (const suffix of ['', '/', '//']) {
      const run = await request(app).post('/api/runs' + suffix).set(...header).send(runBody);
      expect(run.status).toBe(allowed ? 202 : 403);
      for (const body of protectedBodies) {
        const write = await request(app).put('/api/settings' + suffix).set(...header).send(body);
        expect(write.status).toBe(allowed ? 200 : 403);
        if (!allowed) expect(write.body.code).toBe('HOST_CONTROL_FORBIDDEN');
      }
      if (!allowed) expect(run.body.code).toBe('HOST_CONTROL_FORBIDDEN');
    }
    expect(runner.executeCliRun).toHaveBeenCalledTimes(allowed ? 3 : 0);
    expect(persist).toHaveBeenCalledTimes(allowed ? protectedBodies.length * 3 : 0);
  });
});

// A remote caller who picks where PortOS sends audio, prompts or a stored
// token can read them, answer with forged results, or 307 the request back to
// PortOS's own loopback port, where it counts as a local operator. Picking a
// store's host file path lets them rewrite any JSON file the host user owns.
describe('outbound endpoint and host file settings authority', () => {
  const buildApp = async (remoteAddress = '192.0.2.10') => {
    const { authGate, hostControlRouteGate, hostControlBodyGate } = await import('./authGate.js');
    const persist = vi.fn();
    const ok = (req, res) => { persist(req.body); res.json({ saved: true }); };
    const app = express();
    app.use((req, res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress, configurable: true });
      next();
    });
    app.use(authGate);
    app.use(hostControlRouteGate);
    app.use(express.json());
    app.use(hostControlBodyGate);
    app.put('/api/settings', ok);
    app.patch('/api/settings/slice', ok);
    app.put('/api/voice/config', ok);
    app.put('/api/lmstudio/config', ok);
    return { app, persist };
  };
  const attacker = 'http://attacker.example:7860';
  const redirects = [
    ['put', '/api/settings', { imageGen: { mode: 'external', external: { sdapiUrl: attacker } } }],
    ['put', '/api/settings', { imageGen: { sdapiUrl: attacker } }],
    ['patch', '/api/settings/slice', { slicePath: 'imageGen.external', partial: { sdapiUrl: attacker } }],
    ['put', '/api/settings', { beeper: { baseUrl: attacker, allowNonLoopbackBaseUrl: true } }],
    ['patch', '/api/settings/slice', { slicePath: 'beeper', partial: { baseUrl: attacker } }],
    ['put', '/api/settings', { mortalloom: { enabled: true, path: '/example/target.json' } }],
    ['put', '/api/voice/config', { stt: { endpoint: attacker } }],
    ['put', '/api/lmstudio/config', { baseUrl: attacker }],
  ];
  const stored = {
    imageGen: { mode: 'external', sdapiUrl: 'http://192.0.2.20:7860', external: { sdapiUrl: 'http://192.0.2.20:7860' } },
    beeper: { enabled: true, baseUrl: 'http://localhost:23373', allowNonLoopbackBaseUrl: false },
    mortalloom: { enabled: true, path: '/example/MortalLoom.json' },
  };

  it('refuses a remote password-free caller before any write', async () => {
    mergeSettingsFile(stored);
    const { app, persist } = await buildApp();
    for (const [method, path, body] of redirects) {
      const response = await request(app)[method](path).send(body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(response.body.code).toBe('HOST_CONTROL_FORBIDDEN');
    }
    expect(persist).not.toHaveBeenCalled();
  });

  it('keeps unchanged resends, clears and unrelated fields open to a remote caller', async () => {
    mergeSettingsFile(stored);
    const { app, persist } = await buildApp();
    const open = [
      ['put', '/api/settings', { imageGen: { ...stored.imageGen, external: { sdapiUrl: stored.imageGen.external.sdapiUrl, denoise: true } } }],
      ['put', '/api/settings', { beeper: { ...stored.beeper, intervalMinutes: 30 } }],
      ['put', '/api/settings', { mortalloom: { enabled: true, path: '' } }],
      ['put', '/api/voice/config', { stt: { endpoint: 'http://127.0.0.1:5562', language: 'en' } }],
    ];
    for (const [method, path, body] of open) {
      expect((await request(app)[method](path).send(body)).status, JSON.stringify(body)).toBe(200);
    }
    expect(persist).toHaveBeenCalledTimes(open.length);
  });

  it('preserves local and delegated agent operators', async () => {
    mergeSettingsFile(stored);
    const local = await buildApp('127.0.0.1');
    for (const [method, path, body] of redirects) {
      expect((await request(local.app)[method](path).send(body)).status, `${method} ${path}`).toBe(200);
    }
    await (await import('./auth.js')).setPassword({ newPassword: 'example-password' });
    const { PORTOS_API_TOKEN: token } = await (await import('./agentApiAuth.js')).resolveAgentApiEnv();
    expect(token).toBeTruthy();
    const agent = await buildApp();
    for (const [method, path, body] of redirects) {
      expect((await request(agent.app)[method](path).set('Authorization', `Bearer ${token}`).send(body)).status, `${method} ${path}`).toBe(200);
    }
    expect(local.persist).toHaveBeenCalledTimes(redirects.length);
    expect(agent.persist).toHaveBeenCalledTimes(redirects.length);
  });
});

describe('outbound mail dispatch authority (#11273)', () => {
  let mailDependencies;

  const buildApp = async (remoteAddress = '192.0.2.10') => {
    const { authGate, hostControlRouteGate } = await import('./authGate.js');
    if (!mailDependencies) {
      const approvedDraft = {
        id: '33333333-3333-3333-3333-333333333333',
        status: 'approved',
        accountId: '11111111-1111-1111-1111-111111111111',
        sendVia: 'api',
        to: ['recipient@example.test'],
        cc: [],
        subject: 'Synthetic test message',
        body: 'This message is never sent outside the test.',
      };
      vi.doMock('../services/messageDrafts.js', () => ({
        getDraft: vi.fn(async (id) => ({ ...approvedDraft, id })),
        claimDraftForSend: vi.fn(async (id) => ({ ...approvedDraft, id, sendAttemptId: `attempt-${id}` })),
        finishDraftSend: vi.fn(),
        releaseDraftSend: vi.fn(),
      }));
      vi.doMock('../services/messageAccounts.js', () => ({
        getAccount: vi.fn().mockResolvedValue({ id: approvedDraft.accountId, type: 'gmail', canSend: true }),
      }));
      vi.doMock('../services/messageGmailSync.js', () => ({
        sendGmail: vi.fn().mockResolvedValue({ success: true }),
      }));
      const { default: messagesRoutes } = await import('../routes/messages.js');
      const drafts = await import('../services/messageDrafts.js');
      const { sendGmail } = await import('../services/messageGmailSync.js');
      mailDependencies = { messagesRoutes, drafts, sendGmail };
    }
    const app = express();
    app.use((req, res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress, configurable: true });
      next();
    });
    app.use(authGate);
    app.use(hostControlRouteGate);
    app.use(express.json());
    app.use('/api/messages', mailDependencies.messagesRoutes);
    return { app, drafts: mailDependencies.drafts, sendGmail: mailDependencies.sendGmail };
  };

  it('refuses remote password-free send before draft lookup or claim while preserving local and delegated operator access', async () => {
    const remote = await buildApp();
    const attackerCreatedDraft = '33333333-3333-3333-3333-333333333333';
    const operatorApprovedDraft = '44444444-4444-4444-4444-444444444444';
    for (const draftId of [attackerCreatedDraft, operatorApprovedDraft]) {
      const denied = await request(remote.app).post(`/api/messages/drafts/${draftId}/send`);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('HOST_CONTROL_FORBIDDEN');
    }
    expect(remote.drafts.getDraft).not.toHaveBeenCalled();
    expect(remote.drafts.claimDraftForSend).not.toHaveBeenCalled();
    expect(remote.sendGmail).not.toHaveBeenCalled();

    const local = await buildApp('127.0.0.1');
    expect((await request(local.app).post(`/api/messages/drafts/${attackerCreatedDraft}/send`)).status).toBe(200);
    expect(local.drafts.claimDraftForSend).toHaveBeenCalledOnce();
    expect(local.sendGmail).toHaveBeenCalledOnce();

    const { token } = await (await import('./auth.js')).setPassword({ newPassword: 'example-password' });
    const session = await buildApp();
    expect((await request(session.app).post(`/api/messages/drafts/${operatorApprovedDraft}/send`)
      .set('Cookie', `portos_auth=${token}`)).status).toBe(200);

    const { PORTOS_API_TOKEN: agentToken } = await (await import('./agentApiAuth.js')).resolveAgentApiEnv();
    expect(agentToken).toBeTruthy();
    const agent = await buildApp();
    expect((await request(agent.app).post(`/api/messages/drafts/${operatorApprovedDraft}/send`)
      .set('Authorization', `Bearer ${agentToken}`)).status).toBe(200);
    expect(session.sendGmail).toHaveBeenCalledTimes(3);
    expect(agent.sendGmail).toHaveBeenCalledTimes(3);
    expect(agent.drafts.claimDraftForSend).toHaveBeenCalledTimes(3);
  });
});

describe('paired peer credential (#8356)', () => {
  const PAIR_SECRET = 'example-pair-secret-0123456789-abcdef';
  const PEER_ID = 'peer-example-instance';
  const basicHeader = (password) => `Basic ${Buffer.from(`:${password}`).toString('base64')}`;
  const writePeers = (peers) => { instanceRegistry.data = { self: null, peers }; };
  const pairedPeer = (overrides = {}) => ({
    id: 'peer-record', name: 'Example Peer', instanceId: PEER_ID, enabled: true, syncSecret: PAIR_SECRET, ...overrides,
  });
  const peerHeaders = async (instanceId = PEER_ID, secret = PAIR_SECRET) => {
    const { derivePeerAuthToken } = await import('../lib/peerHttpClient.js');
    return { 'X-PortOS-Instance-Id': instanceId, 'X-PortOS-Peer-Auth': derivePeerAuthToken(secret, instanceId) };
  };
  const buildApp = async () => {
    const { authGate, requireHostControl } = await import('./authGate.js');
    const { default: authRoutes } = await import('../routes/auth.js');
    const app = express();
    app.use(authGate);
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    app.get('/api/example', (req, res) => res.json({ auth: req.portosAuthContext }));
    app.get('/api/peer-sync/manifest', (req, res) => res.json({ auth: req.portosAuthContext }));
    app.post('/api/cos/tasks', (req, res) => res.json({ auth: req.portosAuthContext }));
    app.post('/api/apps/:id/restart', (req, res) => res.json({ auth: req.portosAuthContext }));
    app.put('/api/settings', (req, res) => res.json({ auth: req.portosAuthContext }));
    app.post('/api/peer-sync/push', (req, res) => res.json({ auth: req.portosAuthContext }));
    app.all('/api/peer-media/delete', (req, res) => res.json({ auth: req.portosAuthContext }));
    app.get('/api/federation/media/v1/status', (req, res) => res.json({ auth: req.portosAuthContext }));
    app.post('/api/providers/fleet-host/key', (req, res) => res.json({ auth: req.portosAuthContext }));
    app.all(['/data/image-thumbnails/:name', '/data/video-thumbnails/:name'], (req, res) => res.json({ auth: req.portosAuthContext }));
    app.post('/api/commands/execute', requireHostControl, (_req, res) => res.json({ ran: true }));
    return app;
  };
  const withHeaders = (req, headers) => Object.entries(headers).reduce((r, [k, v]) => r.set(k, v), req);

  afterEach(() => {
    instanceRegistry.data = { self: null, peers: [] };
    vi.restoreAllMocks();
  });

  it('authenticates federation reads and pushes as method "peer" but never host control or a session', async () => {
    const auth = await import('./auth.js');
    const { token } = await auth.setPassword({ newPassword: 'example-password' });
    writePeers([pairedPeer()]);
    const app = await buildApp();
    const headers = await peerHeaders();

    const read = await withHeaders(request(app).get('/api/peer-sync/manifest'), headers);
    expect(read.status).toBe(200);
    expect(read.body.auth).toEqual({ enabled: true, authenticated: true, method: 'peer', peerId: 'peer-record' });
    expect((await withHeaders(request(app).post('/api/peer-sync/push').send({}), headers)).body.auth.method).toBe('peer');
    // A peer's media and LLM services need only the token, not a stored password.
    expect((await withHeaders(request(app).get('/api/federation/media/v1/status'), headers)).body.auth.method).toBe('peer');
    expect((await withHeaders(request(app).post('/api/providers/fleet-host/key').send({}), headers)).body.auth.method).toBe('peer');

    const exec = await withHeaders(request(app).post('/api/commands/execute').send({}), headers);
    expect(exec.status).toBe(403);
    // The gate's peer scope refuses it before requireHostControl is reached.
    expect(exec.body.code).toBe('PEER_SCOPE_FORBIDDEN');

    // The token is not the password, so it cannot be exchanged for a session.
    const login = await request(app).post('/api/auth/login').send({ password: headers['X-PortOS-Peer-Auth'] });
    expect(login.status).toBe(401);
    expect(login.headers['set-cookie']).toBeUndefined();

    // Operator session still passes; legacy Basic still reads but is refused host control.
    expect((await request(app).post('/api/commands/execute').set('Cookie', `portos_auth=${token}`).send({})).status).toBe(200);
    const basic = { Authorization: basicHeader('example-password') };
    expect((await withHeaders(request(app).get('/api/example'), basic)).body.auth.method).toBe('basic');
    expect((await withHeaders(request(app).post('/api/commands/execute').send({}), basic)).status).toBe(403);
  });

  it('confines the peer credential to the federation surface (#8387)', async () => {
    const auth = await import('./auth.js');
    const { token } = await auth.setPassword({ newPassword: 'example-password' });
    writePeers([pairedPeer()]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await buildApp();
    const headers = await peerHeaders();
    const basic = { Authorization: basicHeader('example-password') };
    const operatorMutations = [
      () => request(app).post('/api/cos/tasks').send({}),
      () => request(app).post('/api/apps/example-app/restart').send({}),
      () => request(app).put('/api/settings').send({}),
      () => request(app).get('/api/example'),
    ];
    for (const send of operatorMutations) {
      const refused = await withHeaders(send(), headers);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('PEER_SCOPE_FORBIDDEN');
      // Presenting the password alongside the token does not widen the peer's reach.
      expect((await withHeaders(send(), { ...headers, ...basic })).status).toBe(403);
      expect((await send().set('Cookie', `portos_auth=${token}`)).body.auth.method).toBe('session');
      // Basic is the operator password (the companion-app contract), not a peer scope.
      expect((await withHeaders(send(), basic)).body.auth.method).toBe('basic');
    }
    const asset = await withHeaders(request(app).get('/data/voice-profiles/example.wav'), headers);
    expect(asset.status).toBe(403);
    expect(asset.text).toBe('Forbidden');
    expect(warn.mock.calls.some(([line]) => line.includes('POST /api/cos/tasks'))).toBe(true);
  });

  it('allows paired peers to read thumbnails while keeping writes and anonymous reads gated', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'example-password' });
    writePeers([pairedPeer()]);
    const app = await buildApp();
    const headers = await peerHeaders();
    for (const path of ['/data/image-thumbnails/example.webp', '/data/video-thumbnails/example.jpg']) {
      const read = await withHeaders(request(app).get(path), headers);
      expect(read.status).toBe(200);
      expect(read.body.auth.method).toBe('peer');
      expect((await withHeaders(request(app).head(path), headers)).status).toBe(200);
      expect((await withHeaders(request(app).post(path), headers)).status).toBe(403);
      expect((await request(app).get(path)).status).toBe(401);
    }
  });

  // The route admits only `method: 'peer'`; this pins that the gate yields it
  // for the pair credential, and only for the POST, in both auth modes.
  it('marks the pair credential, not Basic or anonymous callers, as a peer on the remote media delete route', async () => {
    writePeers([pairedPeer()]);
    const headers = await peerHeaders();
    let app = await buildApp();
    expect((await withHeaders(request(app).post('/api/peer-media/delete').send({}), headers)).body.auth.method).toBe('peer');
    expect((await request(app).post('/api/peer-media/delete').send({})).body.auth.method).toBeNull();

    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'example-password' });
    app = await buildApp();
    expect((await withHeaders(request(app).post('/api/peer-media/delete').send({}), headers)).body.auth)
      .toEqual({ enabled: true, authenticated: true, method: 'peer', peerId: 'peer-record' });
    expect((await withHeaders(request(app).get('/api/peer-media/delete'), headers)).body.code).toBe('PEER_SCOPE_FORBIDDEN');
    const basic = { Authorization: basicHeader('example-password') };
    expect((await withHeaders(request(app).post('/api/peer-media/delete').send({}), basic)).body.auth.method).toBe('basic');
    expect((await request(app).post('/api/peer-media/delete').send({})).status).toBe(401);
  });

  it('still identifies a paired peer on the federation surface after the instance password is removed', async () => {
    writePeers([pairedPeer()]);
    const app = await buildApp();
    const headers = await peerHeaders();

    const media = await withHeaders(request(app).get('/api/federation/media/v1/status'), headers);
    expect(media.body.auth).toEqual({ enabled: false, authenticated: true, method: 'peer', peerId: 'peer-record' });
    // Off the surface, and with a wrong secret, the caller stays anonymous.
    expect((await withHeaders(request(app).get('/api/example'), headers)).body.auth.method).toBeNull();
    const forged = await peerHeaders(PEER_ID, 'a-different-pair-secret-0123456789-xyz');
    expect((await withHeaders(request(app).get('/api/federation/media/v1/status'), forged)).body.auth.method).toBeNull();
  });

  it('rejects a token for another instance, a wrong secret, a disabled peer, or an unpaired peer', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'example-password' });
    const app = await buildApp();
    const forged = { ...(await peerHeaders('other-instance')), 'X-PortOS-Instance-Id': PEER_ID };
    const cases = [
      [[pairedPeer()], forged],
      [[pairedPeer()], await peerHeaders(PEER_ID, 'a-different-pair-secret-0123456789-xyz')],
      [[pairedPeer({ enabled: false })], await peerHeaders()],
      [[pairedPeer({ syncSecret: undefined })], await peerHeaders()],
    ];
    for (const [peers, headers] of cases) {
      writePeers(peers);
      expect((await withHeaders(request(app).get('/api/example'), headers)).status).toBe(401);
    }
  });

  it('refuses a pair secret shorter than 32 characters even with a correctly derived token', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'example-password' });
    const app = await buildApp();
    const shortSecret = 'x'.repeat(31);
    writePeers([pairedPeer({ syncSecret: shortSecret })]);
    expect((await withHeaders(request(app).get('/api/example'), await peerHeaders(PEER_ID, shortSecret))).status).toBe(401);

    const okSecret = 'x'.repeat(32);
    writePeers([pairedPeer({ syncSecret: okSecret })]);
    // A 32-character secret authenticates as a peer (then hits the peer scope fence).
    expect((await withHeaders(request(app).get('/api/example'), await peerHeaders(PEER_ID, okSecret))).status).toBe(403);
  });

  it('keeps an unpaired or older peer federating over Basic, warning once when a paired peer still uses it', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'example-password' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writePeers([pairedPeer(), pairedPeer({ id: 'unpaired', instanceId: 'unpaired-instance', syncSecret: undefined })]);
    const app = await buildApp();
    const basic = (instanceId) => ({ Authorization: basicHeader('example-password'), 'X-PortOS-Instance-Id': instanceId });

    expect((await withHeaders(request(app).get('/api/example'), basic('unpaired-instance'))).status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i++) {
      expect((await withHeaders(request(app).get('/api/example'), basic(PEER_ID))).body.auth.method).toBe('basic');
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Example Peer');
  });

  it('admits a paired peer relay handshake on the socket gate', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'example-password' });
    writePeers([pairedPeer()]);
    const { socketAuthGate } = await import('./authGate.js');
    const handshake = async (headers) => new Promise((resolve) => {
      socketAuthGate({ handshake: { headers } }, (err) => resolve(err));
    });
    const headers = Object.fromEntries(Object.entries(await peerHeaders()).map(([k, v]) => [k.toLowerCase(), v]));
    expect(await handshake(headers)).toBeUndefined();
    expect((await handshake({ ...headers, 'x-portos-peer-auth': 'f'.repeat(64) }))?.data).toEqual({ code: 'AUTH_REQUIRED' });
  });

  it('wakes probe on inbound peer-authenticated request at most once per 30 s per peer (#12621)', async () => {
    const instances = await import('./instances.js');
    instances.__resetPeerWakesForTests();
    const wakeSpy = vi.spyOn(instances, 'wakePeerProbe');
    const probeFetch = peerProbe.fetch.mockImplementation(async () => ({
      ok: true,
      json: async () => ({}),
    }));
    const connect = peerProbe.connect;

    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'example-password' });
    const peerRecord = pairedPeer({ address: '192.0.2.30', port: 5555, status: 'offline' });
    const putPeerInBackoff = () => Object.assign(peerRecord, {
      status: 'offline', nextProbeAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    putPeerInBackoff();
    writePeers([peerRecord]);
    const app = await buildApp();
    const headers = await peerHeaders();

    vi.useFakeTimers();
    try {
      // 1st inbound request: wakes probe
      const res1 = await withHeaders(request(app).get('/api/peer-sync/manifest'), headers);
      expect(res1.status).toBe(200);
      expect(res1.body.auth.method).toBe('peer');
      await vi.waitFor(() => expect(wakeSpy).toHaveBeenCalledTimes(1));
      expect(wakeSpy).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'peer-record' }));
      await vi.runAllTimersAsync();
      expect(connect).toHaveBeenCalledTimes(1);
      expect(peerRecord.nextProbeAt).toBeNull();
      expect(probeFetch.mock.calls.map(([url]) => url)).toEqual([
        'http://192.0.2.30:5555/api/system/health/details',
        'http://192.0.2.30:5555/api/apps?view=probe',
        'http://192.0.2.30:5555/api/instances/sync-status?forPeer=self-example-instance',
      ]);
      putPeerInBackoff();

      // 2nd inbound request immediately: auth succeeds, calls wakePeerProbe which rate-limits
      const res2 = await withHeaders(request(app).get('/api/peer-sync/manifest'), headers);
      expect(res2.status).toBe(200);
      expect(res2.body.auth.method).toBe('peer');
      await vi.waitFor(() => expect(wakeSpy).toHaveBeenCalledTimes(2));

      // Verify rate limiter directly rejects duplicate wake within 30s
      expect(instances.wakePeerProbe(peerRecord)).toBe(false);
      await vi.runAllTimersAsync();
      expect(probeFetch).toHaveBeenCalledTimes(3);

      // The real rate limiter admits another wake after its 30s window.
      vi.advanceTimersByTime(instances.PEER_WAKE_RATE_LIMIT_MS);
      expect(instances.wakePeerProbe(peerRecord)).toBe(true);
      await vi.runAllTimersAsync();
      expect(connect).toHaveBeenCalledTimes(2);
      expect(probeFetch).toHaveBeenCalledTimes(6);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      // authGate starts a dynamic import and wakePeerProbe detaches its work.
      // Drain both before restoring collaborators, including on assertion failure.
      await vi.dynamicImportSettled();
      await vi.runAllTimersAsync();
      instances.__resetPeerWakesForTests();
      vi.useRealTimers();
      wakeSpy.mockRestore();
      probeFetch.mockReset();
      connect.mockClear();
    }
  });
});

// #8707: without a password, the browser-relay guard is the only thing between
// an arbitrary web page and the loopback-trusted host-control routes.
describe('browser-relay guard in both auth modes', () => {
  const enableAuth = async () => (await import('./auth.js')).setPassword({ newPassword: 'correct-horse' });
  const gateWith = async (headers) => {
    const { authGate } = await import('./authGate.js');
    return runGate(authGate, { path: '/api/cos', method: 'POST', headers });
  };

  it.each([false, true])('rejects a foreign Origin and an opaque one (auth enabled: %s)', async (enabled) => {
    if (enabled) await enableAuth();
    for (const origin of ['https://attacker.example', 'null']) {
      const result = await gateWith({ host: '127.0.0.1:5555', origin, 'sec-fetch-site': 'cross-site' });
      expect(result.called).toBe(false);
      expect(result.res.statusCode).toBe(403);
      expect(result.res.body.code).toBe('CROSS_ORIGIN_BLOCKED');
    }
  });

  it.each([false, true])('rejects a DNS-rebinding Host whose Origin matches (auth enabled: %s)', async (enabled) => {
    if (enabled) await enableAuth();
    for (const headers of [
      { host: 'rebind.attacker.example:5555', origin: 'http://rebind.attacker.example:5555' },
      // A same-origin GET carries no Origin, only Sec-Fetch-Site.
      { host: 'rebind.attacker.example:5555', 'sec-fetch-site': 'same-origin' },
    ]) {
      const result = await gateWith(headers);
      expect(result.called).toBe(false);
      expect(result.res.statusCode).toBe(403);
      expect(result.res.body.code).toBe('HOST_NOT_ALLOWED');
    }
  });

  it('accepts same-origin browser requests on loopback, tailnet, LAN, and short names', async () => {
    for (const host of ['localhost:5555', '127.0.0.1:5555', '[::1]:5555', 'portos.tailnet.ts.net', '192.0.2.10:5555', 'portos-box:5555', 'portos-box.local:5555']) {
      const result = await gateWith({ host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' });
      expect(result.called, host).toBe(true);
    }
  });

  it('leaves Origin-less native, agent, and peer callers alone', async () => {
    const result = await gateWith({ host: 'custom-name.example:5555', authorization: 'Bearer example-agent-token' });
    expect(result.called).toBe(true);
  });

  it('admits an operator-listed custom hostname through PORTOS_ALLOWED_HOSTS', async () => {
    const { isAllowedHost } = await import('../../lib/portosAuthCore.js');
    const env = { PORTOS_ALLOWED_HOSTS: 'portos.example.com, .home.example.net' };
    expect(isAllowedHost('portos.example.com:5555', { env, machineHostname: 'other' })).toBe(true);
    expect(isAllowedHost('box.home.example.net', { env, machineHostname: 'other' })).toBe(true);
    expect(isAllowedHost('evil-portos.example.com', { env, machineHostname: 'other' })).toBe(false);
    expect(isAllowedHost('portos.example.com', { env: {}, machineHostname: 'portos.example.com' })).toBe(true);
    expect(isAllowedHost('portos.example.com', { env: {}, machineHostname: 'other' })).toBe(false);
  });

  it('lets the Vite dev proxy vouch only for a request same-origin to itself', async () => {
    const { devProxyForwardedOrigin } = await import('../../lib/portosAuthCore.js');
    const target = 'http://localhost:5555';
    // What the API sees after changeOrigin rewrites Host to the target.
    const proxied = (browserHeaders) => {
      const origin = devProxyForwardedOrigin({ headers: browserHeaders }, target) ?? browserHeaders.origin;
      return gateWith({ host: 'localhost:5555', origin, 'sec-fetch-site': browserHeaders['sec-fetch-site'] });
    };
    const tailnet = await proxied({ host: 'portos.tailnet.ts.net:5554', origin: 'https://portos.tailnet.ts.net:5554', 'sec-fetch-site': 'same-origin' });
    expect(tailnet.called).toBe(true);
    const foreign = await proxied({ host: 'portos.tailnet.ts.net:5554', origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' });
    expect(foreign.called).toBe(false);
    expect(foreign.res.body.code).toBe('CROSS_ORIGIN_BLOCKED');
  });

  it('refuses a foreign Socket.IO handshake at the transport and the namespace gate', async () => {
    const { allowSocketRequest, socketAuthGate } = await import('./authGate.js');
    const foreign = { host: '127.0.0.1:5555', origin: 'https://attacker.example' };
    const admitted = (headers) => new Promise((resolve) => allowSocketRequest({ headers }, (_e, ok) => resolve(ok)));
    expect(await admitted(foreign)).toBe(false);
    expect(await admitted({ host: 'rebind.attacker.example:5555', origin: 'http://rebind.attacker.example:5555' })).toBe(false);
    // Same-origin UI, the Vite dev proxy's loopback pairing, and Origin-less peers.
    expect(await admitted({ host: 'portos.tailnet.ts.net', origin: 'https://portos.tailnet.ts.net' })).toBe(true);
    expect(await admitted({ host: 'localhost:5555', origin: 'http://localhost:5554' })).toBe(true);
    expect(await admitted({ host: 'portos.tailnet.ts.net' })).toBe(true);
    const err = await new Promise((resolve) => socketAuthGate({ handshake: { headers: foreign } }, resolve));
    expect(err).toBeInstanceOf(Error);
    expect(err.data).toEqual({ code: 'CROSS_ORIGIN_BLOCKED' });
  });
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

  it('rejects a peer relay handshake with a wrong Basic password', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'peer-secret' });
    const { socketAuthGate } = await import('./authGate.js');
    const header = `Basic ${Buffer.from(':wrong-secret').toString('base64')}`;
    const err = await new Promise((resolve) => {
      socketAuthGate({ handshake: { headers: { authorization: header } } }, (e) => resolve(e));
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.data.code).toBe('AUTH_REQUIRED');
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

describe('authGate loopback status bypass', () => {
  const enable = async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
  };
  const probe = (overrides = {}) => ({
    method: 'GET', path: '/api/cos/mind/runtime', headers: {},
    socket: { remoteAddress: '127.0.0.1' }, ...overrides,
  });

  it('lets a direct loopback GET read each allowlisted status endpoint', async () => {
    await enable();
    const { authGate } = await import('./authGate.js');
    for (const path of ['/api/cos/mind', '/api/cos/mind/runtime', '/api/cos/mind/visibility', '/api/eidoverse/world/status']) {
      for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        const result = await runGate(authGate, probe({ path, socket: { remoteAddress } }));
        expect(result.called, `${path} from ${remoteAddress}`).toBe(true);
      }
    }
  });

  it.each([
    ['a non-loopback socket', probe({ socket: { remoteAddress: '100.64.0.5' } })],
    ['X-Forwarded-For', probe({ headers: { 'x-forwarded-for': '127.0.0.1' } })],
    ['Forwarded', probe({ headers: { forwarded: 'for=127.0.0.1' } })],
    ['X-Real-IP', probe({ headers: { 'x-real-ip': '127.0.0.1' } })],
    ['a non-GET method', probe({ method: 'POST' })],
    ['a path outside the allowlist', probe({ path: '/api/cos/mind/journal' })],
    ['a sub-path of an allowlisted path', probe({ path: '/api/cos/mind/runtime/x' })],
  ])('still requires auth for %s', async (_label, req) => {
    await enable();
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, req);
    expect(result.called).toBe(false);
    expect(result.res.statusCode).toBe(401);
  });

  it('refuses a loopback request the Tailcat ingress marked remote', async () => {
    await enable();
    const { authGate } = await import('./authGate.js');
    const { remoteRequestHandler } = await import('../lib/requestOrigin.js');
    const req = probe();
    remoteRequestHandler(() => {})(req, {});
    const result = await runGate(authGate, req);
    expect(result.called).toBe(false);
    expect(result.res.statusCode).toBe(401);
  });

  it('refuses a request relayed through the dev proxy for a remote client', async () => {
    await enable();
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, probe({ headers: { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '100.64.0.5' } }));
    expect(result.called).toBe(false);
  });
});

describe('host-control refuses originless cross-site browser requests (#14268)', () => {
  const buildApp = async () => {
    const { authGate, hostControlRouteGate, requestHasHostControl } = await import('./authGate.js');
    const checkSetup = vi.fn();
    const decode = vi.fn();
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: '127.0.0.1', configurable: true });
      next();
    });
    app.use(authGate);
    app.use(hostControlRouteGate);
    app.get('/api/youtube/setup-check', (_req, res) => { checkSetup(); res.json({ ok: true }); });
    // In-handler read, like the Music Video song-master decode.
    app.get('/api/example/in-handler', (req, res) => {
      if (!requestHasHostControl(req)) return res.status(403).json({ code: 'HOST_CONTROL_FORBIDDEN' });
      decode();
      return res.json({ ok: true });
    });
    app.get('/data/images/example.png', (_req, res) => res.send('png'));
    return { app, checkSetup, decode };
  };
  const base = { host: 'localhost:5555' };
  const send = (app, path, headers) => Object.entries(headers).reduce((r, [k, v]) => r.set(k, v), request(app).get(path));

  it.each([false, true])('refuses cross-site and same-site no-Origin GETs, keeps the rest (auth enabled: %s)', async (enabled) => {
    const cookie = enabled
      ? { cookie: `portos_auth=${(await (await import('./auth.js')).setPassword({ newPassword: 'correct-horse' })).token}` }
      : {};
    const { app, checkSetup, decode } = await buildApp();
    const get = (path, headers = {}) => send(app, path, { ...base, ...cookie, ...headers });

    for (const site of ['cross-site', 'same-site']) {
      const res = await get('/api/youtube/setup-check', { 'sec-fetch-site': site });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('HOST_CONTROL_FORBIDDEN');
      expect((await get('/api/example/in-handler', { 'sec-fetch-site': site })).status).toBe(403);
    }
    expect(checkSetup).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();

    for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, {}]) {
      expect((await get('/api/youtube/setup-check', headers)).status).toBe(200);
      expect((await get('/api/example/in-handler', headers)).status).toBe(200);
    }
    // Origin-carrying requests keep the isCrossOrigin decision (dev proxy pairing).
    const proxied = await get('/api/youtube/setup-check', { origin: 'http://localhost:5554', 'sec-fetch-site': 'same-site' });
    expect(proxied.status).toBe(200);
    // Peer-hosted media previews are not host-control routes.
    const media = await get('/data/images/example.png', { 'sec-fetch-site': 'cross-site' });
    expect(media.status).toBe(200);
  });

  it('keeps an agent bearer session working without fetch metadata', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { token } = await auth.createSession();
    const { app, checkSetup } = await buildApp();
    const res = await send(app, '/api/youtube/setup-check', { ...base, authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(checkSetup).toHaveBeenCalledTimes(1);
  });
});

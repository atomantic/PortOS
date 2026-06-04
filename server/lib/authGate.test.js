import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from './mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-authgate-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

const resetSettings = () => {
  writeFileSync(join(tempRoot, 'settings.json'), '{}\n');
  writeFileSync(join(tempRoot, 'auth-sessions.json'), '{"tokens":[]}\n');
};

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
    const result = await runGate(authGate, { path: '/api/cos', headers: {} });
    expect(result.called).toBe(true);
  });

  it('passes /api/auth/login through even when auth is enabled', async () => {
    const auth = await import('../services/auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, { path: '/api/auth/login', headers: {} });
    expect(result.called).toBe(true);
  });

  it('blocks /api routes with no token', async () => {
    const auth = await import('../services/auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, { path: '/api/cos', headers: {} });
    expect(result.called).toBe(false);
    expect(result.res.statusCode).toBe(401);
    expect(result.res.body).toEqual({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  });

  it('allows /api routes when the cookie token is valid', async () => {
    const auth = await import('../services/auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, {
      path: '/api/cos',
      headers: { cookie: `portos_auth=${token}` },
    });
    expect(result.called).toBe(true);
  });

  it('allows /api routes when the Authorization Bearer token is valid', async () => {
    const auth = await import('../services/auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, {
      path: '/api/cos',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(result.called).toBe(true);
  });

  it('lets static client paths through when auth is on', async () => {
    const auth = await import('../services/auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, { path: '/assets/index.js', headers: {} });
    expect(result.called).toBe(true);
  });

  it('returns plain-text 401 for blocked /data/* asset requests', async () => {
    const auth = await import('../services/auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, { path: '/data/images/foo.png', headers: {} });
    expect(result.called).toBe(false);
    expect(result.res.statusCode).toBe(401);
    expect(result.res.body).toBe('Unauthorized');
  });

  it('gates the /sdapi/* AUTOMATIC1111-compatible surface', async () => {
    const auth = await import('../services/auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    const result = await runGate(authGate, { path: '/sdapi/v1/sd-models', headers: {} });
    expect(result.called).toBe(false);
    expect(result.res.statusCode).toBe(401);
    expect(result.res.body).toEqual({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  });

  it('treats a malformed cookie value as no token (clean 401, not 500)', async () => {
    const auth = await import('../services/auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { authGate } = await import('./authGate.js');
    // %E0 is a partial percent-escape — decodeURIComponent throws URIError.
    const result = await runGate(authGate, { path: '/api/cos', headers: { cookie: 'portos_auth=%E0' } });
    expect(result.called).toBe(false);
    expect(result.res.statusCode).toBe(401);
    expect(result.res.body.code).toBe('AUTH_REQUIRED');
  });

  it('rejects cross-origin requests with 403 before consulting the session', async () => {
    const auth = await import('../services/auth.js');
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
    const auth = await import('../services/auth.js');
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
    const auth = await import('../services/auth.js');
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
    const auth = await import('../services/auth.js');
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
    const auth = await import('../services/auth.js');
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
    const auth = await import('../services/auth.js');
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
    const auth = await import('../services/auth.js');
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

describe('socketAuthGate middleware', () => {
  it('is a no-op when auth is disabled', async () => {
    const { socketAuthGate } = await import('./authGate.js');
    const result = await new Promise((resolve) => {
      socketAuthGate({ handshake: { headers: {} } }, (err) => resolve(err));
    });
    expect(result).toBeUndefined();
  });

  it('rejects an unauthenticated handshake when auth is on', async () => {
    const auth = await import('../services/auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    const { socketAuthGate } = await import('./authGate.js');
    const err = await new Promise((resolve) => {
      socketAuthGate({ handshake: { headers: {} } }, (e) => resolve(e));
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.data).toEqual({ code: 'AUTH_REQUIRED' });
  });

  it('accepts a handshake with a valid cookie', async () => {
    const auth = await import('../services/auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    const { socketAuthGate } = await import('./authGate.js');
    const err = await new Promise((resolve) => {
      socketAuthGate({ handshake: { headers: { cookie: `portos_auth=${token}` } } }, (e) => resolve(e));
    });
    expect(err).toBeUndefined();
  });

  it('rejects a cross-origin handshake', async () => {
    const auth = await import('../services/auth.js');
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

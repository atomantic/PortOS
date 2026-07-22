import { describe, it, expect, afterEach, beforeAll, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSidecarAuthGate } from './sidecarAuthGate.js';
import { hashPassword, hashToken } from './portosAuthCore.js';

const PASSWORD = 'correct horse battery';
const SALT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

// scrypt at PortOS's cost parameters takes ~1s, so hash once for the suite.
let PASSWORD_HASH;
beforeAll(async () => { PASSWORD_HASH = await hashPassword(PASSWORD, SALT); }, 30_000);

const COOKIE = 'portos_sidecar_test';

let dataDir;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sidecar-auth-'));
});

const writeSettings = (settings) =>
  writeFile(join(dataDir, 'settings.json'), JSON.stringify(settings));

const writeSessions = (tokens) =>
  writeFile(join(dataDir, 'auth-sessions.json'), JSON.stringify({ tokens }));

const authOn = () => writeSettings({
  secrets: { auth: { enabled: true, kdf: 'scrypt', passwordHash: PASSWORD_HASH, salt: SALT } },
});

// Each test builds its own gate so the 5s config cache never leaks across
// tests (a cached "auth off" would mask a later "auth on" write).
const makeGate = () => createSidecarAuthGate({ dataDir, cookieName: COOKIE, publicPaths: ['/'] });

const makeRes = () => {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  return res;
};

const run = async (gate, req) => {
  const res = makeRes();
  let nexted = false;
  await gate(req, res, () => { nexted = true; });
  return { res, nexted };
};

const req = (path, headers = {}) => ({ path, headers, socket: { remoteAddress: '10.0.0.5' } });

describe('createSidecarAuthGate', () => {
  it('requires a dataDir and a cookieName', () => {
    expect(() => createSidecarAuthGate({ cookieName: COOKIE })).toThrow(/dataDir/);
    expect(() => createSidecarAuthGate({ dataDir: '/tmp' })).toThrow(/cookieName/);
  });

  describe('when the install has no password', () => {
    it('passes every request through when settings.json is absent', async () => {
      const { gate, isEnabled } = makeGate();
      expect(await isEnabled()).toBe(false);
      expect((await run(gate, req('/api/restart/portos-server'))).nexted).toBe(true);
    });

    it('passes through when secrets.auth exists but is disabled', async () => {
      await writeSettings({ secrets: { auth: { enabled: false } } });
      const { gate } = makeGate();
      expect((await run(gate, req('/api/stop/portos-server'))).nexted).toBe(true);
    });

    it('reports enabled:false + authenticated:true from the status handler', async () => {
      const { handleStatus } = makeGate();
      const res = makeRes();
      await handleStatus(req('/api/auth/status'), res);
      expect(res.body).toEqual({ enabled: false, authenticated: true });
    });
  });

  describe('when the install is password protected', () => {
    beforeEach(authOn);

    it('401s an unauthenticated mutation request', async () => {
      const { gate } = makeGate();
      const { res, nexted } = await run(gate, req('/api/restart/portos-server'));
      expect(nexted).toBe(false);
      expect(res.statusCode).toBe(401);
      expect(res.body.code).toBe('AUTH_REQUIRED');
    });

    it('401s read endpoints and the log stream too', async () => {
      const { gate } = makeGate();
      for (const path of ['/api/apps', '/api/history', '/api/status', '/logs']) {
        const { res, nexted } = await run(gate, req(path));
        expect(nexted, path).toBe(false);
        expect(res.statusCode, path).toBe(401);
      }
    });

    it('leaves the static shell and the auth routes public', async () => {
      const { gate } = makeGate();
      for (const path of ['/', '/api/auth/status', '/api/auth/login', '/api/auth/logout']) {
        expect((await run(gate, req(path))).nexted, path).toBe(true);
      }
    });

    it('accepts a portos_auth session cookie minted by the main server', async () => {
      await writeSessions([{ tokenHash: hashToken('tok-live'), expiresAt: Date.now() + 60_000 }]);
      const { gate } = makeGate();
      const ok = await run(gate, req('/api/apps', { cookie: 'portos_auth=tok-live' }));
      expect(ok.nexted).toBe(true);
    });

    it('rejects an expired or unknown session token', async () => {
      await writeSessions([{ tokenHash: hashToken('tok-old'), expiresAt: Date.now() - 1 }]);
      const { gate } = makeGate();
      expect((await run(gate, req('/api/apps', { cookie: 'portos_auth=tok-old' }))).nexted).toBe(false);
      expect((await run(gate, req('/api/apps', { authorization: 'Bearer nope' }))).nexted).toBe(false);
    });

    it('accepts a Bearer session token', async () => {
      await writeSessions([{ tokenHash: hashToken('tok-bearer'), expiresAt: Date.now() + 60_000 }]);
      const { gate } = makeGate();
      expect((await run(gate, req('/api/apps', { authorization: 'Bearer tok-bearer' }))).nexted).toBe(true);
    });

    it('issues a cookie on login that then authenticates requests', async () => {
      const { gate, handleLogin } = makeGate();
      const res = makeRes();
      await handleLogin({ ...req('/api/auth/login'), body: { password: PASSWORD } }, res);
      expect(res.body.success).toBe(true);
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toContain(`${COOKIE}=`);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      const value = setCookie.split(';')[0];
      expect((await run(gate, req('/api/apps', { cookie: value }))).nexted).toBe(true);
    }, 30_000);

    it('rejects a wrong password without issuing a cookie', async () => {
      const { handleLogin } = makeGate();
      const res = makeRes();
      await handleLogin({ ...req('/api/auth/login'), body: { password: 'wrong' } }, res);
      expect(res.statusCode).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    }, 30_000);

    it('rejects a tampered sidecar cookie', async () => {
      const { gate, handleLogin } = makeGate();
      const res = makeRes();
      await handleLogin({ ...req('/api/auth/login'), body: { password: PASSWORD } }, res);
      const [name, signed] = res.headers['set-cookie'].split(';')[0].split('=');
      const [exp, mac] = decodeURIComponent(signed).split('.');
      // Extend the expiry without re-signing — the HMAC covers it.
      const forged = `${name}=${encodeURIComponent(`${Number(exp) + 1}.${mac}`)}`;
      expect((await run(gate, req('/api/apps', { cookie: forged }))).nexted).toBe(false);
    }, 30_000);

    it('invalidates its cookie when the stored password changes', async () => {
      const { handleLogin } = makeGate();
      const res = makeRes();
      await handleLogin({ ...req('/api/auth/login'), body: { password: PASSWORD } }, res);
      const cookie = res.headers['set-cookie'].split(';')[0];
      // Rotate the password (new salt ⇒ new signing key) and build a fresh gate.
      await writeSettings({
        secrets: { auth: { enabled: true, passwordHash: PASSWORD_HASH, salt: 'ffffffffffffffffffffffffffffffff' } },
      });
      const { gate } = makeGate();
      expect((await run(gate, req('/api/apps', { cookie }))).nexted).toBe(false);
    }, 30_000);

    it('accepts HTTP Basic credentials for scripts', async () => {
      const { gate } = makeGate();
      const basic = Buffer.from(`:${PASSWORD}`).toString('base64');
      expect((await run(gate, req('/api/apps', { authorization: `Basic ${basic}` }))).nexted).toBe(true);
    }, 30_000);

    it('rejects cross-origin requests before the public-path bypass', async () => {
      const { gate } = makeGate();
      const { res, nexted } = await run(gate, req('/api/auth/logout', {
        origin: 'https://evil.example.ts.net',
        host: 'portos.example.ts.net:5560',
      }));
      expect(nexted).toBe(false);
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe('CROSS_ORIGIN_BLOCKED');
    });

    it('allows a same-origin browser request', async () => {
      await writeSessions([{ tokenHash: hashToken('tok-same'), expiresAt: Date.now() + 60_000 }]);
      const { gate } = makeGate();
      const ok = await run(gate, req('/api/apps', {
        origin: 'https://portos.example.ts.net:5560',
        host: 'portos.example.ts.net:5560',
        cookie: 'portos_auth=tok-same',
      }));
      expect(ok.nexted).toBe(true);
    });

    it('fails CLOSED when settings.json is present but unparseable', async () => {
      await writeFile(join(dataDir, 'settings.json'), '{ this is not json');
      const { gate, isEnabled } = makeGate();
      expect(await isEnabled()).toBe(true);
      const { res, nexted } = await run(gate, req('/api/restart/portos-server'));
      expect(nexted).toBe(false);
      expect(res.statusCode).toBe(401);
    });

    it('clears its cookie on logout without touching the portos_auth session', async () => {
      const { handleLogout } = makeGate();
      const res = makeRes();
      handleLogout(req('/api/auth/logout'), res);
      expect(res.headers['set-cookie']).toContain('Max-Age=0');
      expect(res.headers['set-cookie']).not.toContain('portos_auth=');
    });
  });
});

// Temp dirs are per-test; clean them all at the end of the file run.
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

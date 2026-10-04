import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword, hashToken } from '../lib/portosAuthCore.js';

const harness = vi.hoisted(() => ({ routes: new Map(), gates: [], auth: null, execPm2: vi.fn() }));
vi.mock('express', () => {
  const express = () => ({
    use: (handler) => harness.gates.push(handler),
    get: () => {},
    post: (path, ...handlers) => harness.routes.set(path, handlers),
  });
  express.json = () => (_req, _res, next) => next();
  return { default: express };
});
vi.mock('../lib/sidecarAuthGate.js', async (original) => ({
  ...await original(), createSidecarAuthGate: () => harness.auth,
}));
vi.mock('../lib/tailscale-https.js', () => ({
  createTailscaleServers: () => ({ server: { listen: vi.fn() }, httpsEnabled: false }),
  watchCertReload: vi.fn(),
}));
vi.mock('./shared.js', () => ({
  PM2_BIN: 'example-pm2', DATA_DIR: 'unused', AUTOFIXER_DIR: 'unused', INDEX_FILE: 'unused',
  execPm2: harness.execPm2, listProcessesStrict: vi.fn(),
  loadApps: async () => [{ pm2ProcessNames: ['example-process'] }],
}));

const PASSWORD = 'example-password';
const SALT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
let passwordHash;
let dataDir;
beforeAll(async () => { passwordHash = await hashPassword(PASSWORD, SALT); }, 30_000);
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'autofixer-authority-'));
  harness.execPm2.mockReset().mockResolvedValue({ stdout: 'ok', stderr: '' });
  harness.gates.length = 0;
  harness.routes.clear();
});
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

const loadUi = async (enabled = false) => {
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ secrets: { auth: {
    enabled, passwordHash, salt: SALT,
  } } }));
  await writeFile(join(dataDir, 'auth-sessions.json'), JSON.stringify({ tokens: [
    { tokenHash: hashToken('example-session'), expiresAt: Date.now() + 60_000 },
  ] }));
  const { createSidecarAuthGate } = await vi.importActual('../lib/sidecarAuthGate.js');
  harness.auth = createSidecarAuthGate({ dataDir, cookieName: 'portos_autofixer_auth' });
  vi.resetModules();
  const processOn = vi.spyOn(process, 'on').mockReturnValue(process);
  try { await import('./ui.js'); } finally { processOn.mockRestore(); }
};

const response = () => {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  return res;
};
const mutate = async (action, address = '192.0.2.10', headers = {}) => {
  const req = { path: `/api/${action}/example-process`, params: { process: 'example-process' },
    headers, socket: { remoteAddress: address } };
  const res = response();
  for (const handler of [...harness.gates, ...harness.routes.get(`/api/${action}/:process`)]) {
    let nexted = false;
    await handler(req, res, () => { nexted = true; });
    if (!nexted) break;
  }
  return res;
};

describe('Autofixer process-control authority', () => {
  it('gates both staged patch actions before touching session files', async () => {
    await loadUi();
    for (const action of ['apply', 'discard']) {
      const req = { path: `/api/fixes/autofixer_example_123/${action}`, params: { session: 'autofixer_example_123' }, headers: {}, socket: { remoteAddress: '192.0.2.10' } };
      const res = response();
      for (const handler of [...harness.gates, ...harness.routes.get(`/api/fixes/:session/${action}`)]) {
        let nexted = false;
        await handler(req, res, () => { nexted = true; });
        if (!nexted) break;
      }
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe('HOST_CONTROL_FORBIDDEN');
    }
  });
  it('refuses remote, forged forwarding, and remote dev-proxy callers before PM2', async () => {
    await loadUi();
    for (const action of ['restart', 'stop']) {
      for (const [address, headers] of [
        ['192.0.2.10', {}],
        ['192.0.2.10', { 'x-portos-dev-proxy-client-address': '127.0.0.1', 'x-forwarded-for': '127.0.0.1' }],
        ['127.0.0.1', { 'x-portos-dev-proxy-client-address': '192.0.2.10' }],
      ]) {
        const res = await mutate(action, address, headers);
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('HOST_CONTROL_FORBIDDEN');
      }
    }
    expect(harness.execPm2).not.toHaveBeenCalled();
  });

  it('preserves password-free genuine loopback controls', async () => {
    await loadUi();
    expect((await mutate('restart', '::1')).body).toEqual({ success: true });
    expect((await mutate('stop', '::ffff:127.0.0.1')).body).toEqual({ success: true });
    expect(harness.execPm2.mock.calls).toEqual([[['restart', 'example-process']], [['stop', 'example-process']]]);
  });

  it('refuses Basic-only authority but accepts primary and sidecar sessions', async () => {
    await loadUi(true);
    const basic = `Basic ${Buffer.from(`:${PASSWORD}`).toString('base64')}`;
    for (const action of ['restart', 'stop']) {
      expect((await mutate(action, '127.0.0.1', { authorization: basic })).body.code).toBe('HOST_CONTROL_FORBIDDEN');
    }
    expect(harness.execPm2).not.toHaveBeenCalled();
    const loginRes = response();
    await harness.auth.handleLogin({ headers: {}, body: { password: PASSWORD } }, loginRes);
    const sidecarCookie = loginRes.headers['Set-Cookie'].split(';')[0];
    for (const headers of [{ cookie: 'portos_auth_5555=example-session' }, { authorization: 'Bearer example-session' }, { cookie: sidecarCookie }]) {
      for (const action of ['restart', 'stop']) {
        expect((await mutate(action, '192.0.2.10', headers)).body).toEqual({ success: true });
      }
    }
    expect(harness.execPm2).toHaveBeenCalledTimes(6);
  }, 30_000);

  it('keeps corrupt config and cross-origin requests closed without PM2 effects', async () => {
    await loadUi();
    expect((await mutate('restart', '127.0.0.1', { origin: 'https://attacker.example', host: 'localhost:5560' })).body.code).toBe('CROSS_ORIGIN_BLOCKED');
    await writeFile(join(dataDir, 'settings.json'), '{broken');
    expect((await mutate('stop', '127.0.0.1')).body.code).toBe('AUTH_REQUIRED');
    const { createSidecarAuthGate } = await vi.importActual('../lib/sidecarAuthGate.js');
    harness.auth = createSidecarAuthGate({ dataDir, cookieName: 'portos_autofixer_auth' });
    const res = response();
    await harness.auth.requireHostControl({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res, vi.fn());
    expect(res.body.code).toBe('HOST_CONTROL_FORBIDDEN');
    expect(harness.execPm2).not.toHaveBeenCalled();
  });
});

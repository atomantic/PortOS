import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { hashPassword, hashToken } from '../lib/portosAuthCore.js';

const harness = vi.hoisted(() => ({ routes: new Map(), gates: [], auth: null, execPm2: vi.fn(), loadApps: vi.fn(), spawn: vi.fn(), listProcessesStrict: vi.fn() }));
vi.mock('child_process', () => ({ spawn: harness.spawn }));
vi.mock('node:module', async (original) => {
  const actual = await original();
  const express = () => ({
    use: (handler) => harness.gates.push(handler),
    get: (path, ...handlers) => harness.routes.set(path, handlers),
    post: (path, ...handlers) => harness.routes.set(path, handlers),
  });
  express.json = () => (_req, _res, next) => next();
  return { ...actual, createRequire: (from) => {
    const require = actual.createRequire(from);
    return name => name === 'express' ? express : require(name);
  } };
});
vi.mock('../lib/sidecarAuthGate.js', async (original) => ({
  ...await original(), createSidecarAuthGate: () => harness.auth,
}));
vi.mock('../lib/tailscale-https.js', () => ({
  createTailscaleServers: () => {
    const server = new EventEmitter();
    server.listen = () => server.emit('listening');
    server.address = () => ({ port: 5560 });
    return { server, httpsEnabled: false };
  },
  watchCertReload: vi.fn(),
}));
vi.mock('./shared.js', () => ({
  PM2_BIN: 'example-pm2', DATA_DIR: 'unused', AUTOFIXER_DIR: 'unused', INDEX_FILE: 'unused',
  execPm2: harness.execPm2, listProcessesStrict: harness.listProcessesStrict,
  loadApps: harness.loadApps,
}));

const PASSWORD = 'example-password';
const SALT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
let passwordHash;
let dataDir;
beforeAll(async () => { passwordHash = await hashPassword(PASSWORD, SALT); }, 30_000);
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'autofixer-authority-'));
  harness.spawn.mockReset();
  harness.listProcessesStrict.mockReset().mockResolvedValue([]);
  harness.execPm2.mockReset().mockResolvedValue({ stdout: 'ok', stderr: '' });
  harness.loadApps.mockReset().mockResolvedValue([{ pm2ProcessNames: ['example-process'] }]);
  harness.gates.length = 0;
  harness.routes.clear();
});
afterEach(async () => { vi.useRealTimers(); await rm(dataDir, { recursive: true, force: true }); });

const loadUi = async (enabled = false, { corrupt = false } = {}) => {
  const settings = { secrets: { auth: { enabled, passwordHash, salt: SALT } } };
  await writeFile(join(dataDir, 'settings.json'), corrupt ? '{broken' : JSON.stringify(settings));
  await writeFile(join(dataDir, 'auth-sessions.json'), JSON.stringify({ tokens: [
    { tokenHash: hashToken('example-session'), expiresAt: Date.now() + 60_000 },
  ] }));
  const { createSidecarAuthGate } = await vi.importActual('../lib/sidecarAuthGate.js');
  harness.auth = createSidecarAuthGate({ dataDir, cookieName: 'portos_autofixer_auth' });
  vi.resetModules();
  const { startAutofixerUi } = await import('./ui.js');
  const { createStagedFixStore } = await import('./stagedFixes.js');
  await startAutofixerUi(createStagedFixStore({ root: dataDir, loadApps: harness.loadApps, execPm2: harness.execPm2 }));
};

const response = () => {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  return res;
};
const mutate = async (action, address = '192.0.2.10', headers = {}, process = 'example-process') => {
  const req = { path: `/api/${action}/${process}`, params: { process },
    headers, socket: { remoteAddress: address } };
  const res = response();
  for (const handler of [...harness.gates.filter(handler => handler.length !== 4), ...harness.routes.get(`/api/${action}/:process`)]) {
    let nexted = false;
    await handler(req, res, () => { nexted = true; });
    if (!nexted) break;
  }
  return res;
};

describe('Autofixer process-control authority', () => {
  it('retires only the legacy dashboard from this checkout during startup', async () => {
    harness.listProcessesStrict.mockResolvedValue([
      { name: 'portos-autofixer-ui', pm_id: 8, pm2_env: { pm_exec_path: '/example/other-install/autofixer/ui.js' } },
      { name: 'portos-autofixer-ui', pm_id: 9, pm2_env: { pm_exec_path: fileURLToPath(new URL('./ui.js', import.meta.url)) } },
    ]);
    await loadUi();
    expect(harness.execPm2.mock.calls).toEqual([[['delete', '9']], [['save']]]);
  });

  it('returns sanitized unavailability for app reads and blocks controls before PM2', async () => {
    await loadUi();
    harness.loadApps.mockRejectedValue(Object.assign(new Error('App registry unavailable'), { code: 'APPS_UNAVAILABLE' }));
    const errorBoundary = harness.gates.find(handler => handler.length === 4);
    for (const path of ['/api/apps', '/api/restart/:process', '/api/stop/:process']) {
      const handler = harness.routes.get(path).at(-1);
      const res = response();
      await handler({ params: { process: 'example-process' } }, res).catch(error => errorBoundary(error, {}, res, vi.fn()));
      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({ error: 'App registry unavailable', code: 'APPS_UNAVAILABLE' });
    }
    expect(harness.execPm2).not.toHaveBeenCalled();
  });

  it('gates both staged patch actions before touching session files', async () => {
    await loadUi();
    for (const action of ['apply', 'discard']) {
      const req = { path: `/api/fixes/autofixer_example_123/${action}`, params: { session: 'autofixer_example_123' }, headers: {}, socket: { remoteAddress: '192.0.2.10' } };
      const res = response();
      for (const handler of [...harness.gates.filter(handler => handler.length !== 4), ...harness.routes.get(`/api/fixes/:session/${action}`)]) {
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

  it('acknowledges self-control before the dashboard goes down', async () => {
    await loadUi();
    harness.loadApps.mockResolvedValue([{ pm2ProcessNames: ['portos-autofixer'] }]);
    for (const action of ['restart', 'stop']) {
      const res = await mutate(action, '127.0.0.1', {}, 'portos-autofixer');
      expect(res.statusCode).toBe(202);
      expect(res.body.success).toBe(true);
      expect(harness.execPm2).toHaveBeenLastCalledWith([action, 'portos-autofixer']);
    }
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
    await loadUi(false, { corrupt: true });
    expect((await mutate('restart', '127.0.0.1', { origin: 'https://attacker.example', host: 'localhost:5560' })).body.code).toBe('CROSS_ORIGIN_BLOCKED');
    expect((await mutate('stop', '127.0.0.1')).body.code).toBe('AUTH_REQUIRED');
    const { createSidecarAuthGate } = await vi.importActual('../lib/sidecarAuthGate.js');
    harness.auth = createSidecarAuthGate({ dataDir, cookieName: 'portos_autofixer_auth' });
    const res = response();
    await harness.auth.requireHostControl({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res, vi.fn());
    expect(res.body.code).toBe('HOST_CONTROL_FORBIDDEN');
    expect(harness.execPm2).not.toHaveBeenCalled();
  });
});


describe('Autofixer log child lifecycle', () => {
  const child = () => {
    const proc = new EventEmitter();
    proc.stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    proc.stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    proc.kill = vi.fn(() => true);
    proc.unref = vi.fn();
    return proc;
  };
  const openLogs = (query = {}) => {
    const req = Object.assign(new EventEmitter(), { query });
    const res = Object.assign(new EventEmitter(), response(), { write: vi.fn(), end: vi.fn() });
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    const done = harness.routes.get('/logs')[0](req, res);
    return { req, res, done };
  };

  it('refuses an option-shaped or repeated process name before spawning pm2', async () => {
    await loadUi();
    for (const name of ['--no-daemon', '-s', ['example-process', '--json']]) {
      const { res, done } = openLogs({ process: name });
      await done;
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_PROCESS_NAME' });
      expect(res.write).not.toHaveBeenCalled();
    }
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it('streams a named process as the positional pm2 argument', async () => {
    await loadUi();
    const initial = child();
    harness.spawn.mockReturnValue(initial);
    const { done } = openLogs({ process: 'example-process' });
    initial.emit('close', 1);
    await done;
    expect(harness.spawn.mock.calls[0][1].slice(0, 3)).toEqual(['example-pm2', 'logs', 'example-process']);
  });

  it('reports an initial spawn error and ends SSE without starting a live stream', async () => {
    await loadUi();
    const initial = child();
    harness.spawn.mockReturnValue(initial);
    const { res, done } = openLogs();
    initial.emit('error', new Error('example spawn failure'));
    initial.emit('close', -1);
    await done;
    expect(res.write.mock.calls.flat().join('')).toContain('example spawn failure');
    expect(res.end).toHaveBeenCalledOnce();
    expect(harness.spawn).toHaveBeenCalledOnce();
    expect(res.listenerCount('close')).toBe(0);
  });

  it('cancels the initial read on disconnect and never starts a later stream', async () => {
    await loadUi();
    vi.useFakeTimers();
    const initial = child();
    harness.spawn.mockReturnValue(initial);
    const { res, done } = openLogs();
    res.destroyed = true;
    res.emit('close');
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    initial.emit('close', 0);
    expect(initial.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(initial.unref).toHaveBeenCalledOnce();
    expect(harness.spawn).toHaveBeenCalledOnce();
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('delivers initial and live logs then cleans the streaming child on disconnect', async () => {
    await loadUi();
    vi.useFakeTimers();
    const initial = child();
    const live = child();
    harness.spawn.mockReturnValueOnce(initial).mockReturnValueOnce(live);
    const { req, res, done } = openLogs();
    initial.stdout.emit('data', 'initial log\n');
    initial.emit('close', 0);
    await Promise.resolve();
    // A completed request body does not close an SSE response.
    req.emit('close');
    live.stdout.emit('data', 'live log\n');
    expect(res.write.mock.calls.flat().join('')).toContain('initial log');
    expect(res.write.mock.calls.flat().join('')).toContain('live log');
    res.destroyed = true;
    res.emit('close');
    live.emit('close', null);
    await done;
    expect(live.kill.mock.calls).toEqual([['SIGTERM']]);
    expect(live.stdout.listenerCount('data')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

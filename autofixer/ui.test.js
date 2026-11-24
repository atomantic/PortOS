import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { hashPassword, hashToken } from '../lib/portosAuthCore.js';

const harness = vi.hoisted(() => ({ routes: new Map(), gates: [], auth: null, listen: vi.fn(), execPm2: vi.fn(), loadApps: vi.fn(), spawn: vi.fn(), listProcessesStrict: vi.fn() }));
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
    server.listen = (...args) => {
      harness.listen(...args);
      server.emit('listening');
    };
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
  harness.listen.mockClear();
  harness.listProcessesStrict.mockReset().mockResolvedValue([]);
  harness.execPm2.mockReset().mockResolvedValue({ stdout: 'ok', stderr: '' });
  harness.loadApps.mockReset().mockResolvedValue([{ pm2ProcessNames: ['example-process'] }]);
  harness.gates.length = 0;
  harness.routes.clear();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(dataDir, { recursive: true, force: true });
});

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
  res.send = (body) => { res.body = body; return res; };
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
  it.each([
    ['5559', 5560],
    [undefined, 5560],
    ['4560', '4560'],
  ])('binds the dashboard for PORT=%s', async (port, expected) => {
    vi.stubEnv('PORT', port);
    await loadUi();
    expect(harness.listen).toHaveBeenCalledWith(expected, '0.0.0.0');
  });

  it('retires only the legacy dashboard from this checkout during startup', async () => {
    harness.listProcessesStrict.mockResolvedValue([
      { name: 'portos-autofixer-ui', pm_id: 8, pm2_env: { pm_exec_path: '/example/other-install/autofixer/ui.js' } },
      { name: 'portos-autofixer-ui', pm_id: 9, pm2_env: { pm_exec_path: fileURLToPath(new URL('./ui.js', import.meta.url)) } },
    ]);
    await loadUi();
    expect(harness.execPm2.mock.calls).toEqual([[['delete', '9']], [['save']]]);
  });

  it('returns sanitized unavailability for app reads and blocks controls and logs before PM2', async () => {
    await loadUi();
    harness.loadApps.mockRejectedValue(Object.assign(new Error('App registry unavailable'), { code: 'APPS_UNAVAILABLE' }));
    const errorBoundary = harness.gates.find(handler => handler.length === 4);
    for (const [path, req] of [
      ['/api/apps', { params: {} }],
      ['/api/restart/:process', { params: { process: 'example-process' } }],
      ['/api/stop/:process', { params: { process: 'example-process' } }],
      ['/logs', { query: { process: 'example-process' } }],
    ]) {
      const handler = harness.routes.get(path).at(-1);
      const res = response();
      await handler(req, res).catch(error => errorBoundary(error, {}, res, vi.fn()));
      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({ error: 'App registry unavailable', code: 'APPS_UNAVAILABLE' });
    }
    expect(harness.execPm2).not.toHaveBeenCalled();
    expect(harness.spawn).not.toHaveBeenCalled();
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


describe('Autofixer log child lifecycle and authority', () => {
  const child = () => {
    const proc = new EventEmitter();
    proc.stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    proc.stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    proc.kill = vi.fn(() => true);
    proc.unref = vi.fn();
    return proc;
  };
  const nextSpawn = (proc) => {
    let resolve;
    const spawned = new Promise((r) => { resolve = r; });
    harness.spawn.mockImplementationOnce((...args) => {
      resolve(args);
      return proc;
    });
    return spawned;
  };
  const openLogs = (query = {}, { address = '127.0.0.1', headers = {} } = {}) => {
    const req = Object.assign(new EventEmitter(), {
      path: '/logs',
      query,
      headers,
      socket: { remoteAddress: address },
    });
    const res = Object.assign(new EventEmitter(), response(), { write: vi.fn(), end: vi.fn() });
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    const handlers = [...harness.gates.filter(handler => handler.length !== 4), ...harness.routes.get('/logs')];
    const done = (async () => {
      for (const handler of handlers) {
        let nexted = false;
        await handler(req, res, () => { nexted = true; });
        if (!nexted) break;
      }
    })();
    return { req, res, done };
  };

  it('refuses remote, forged forwarding, remote dev-proxy, and originless cross-site callers before spawn', async () => {
    await loadUi();
    for (const [address, headers] of [
      ['192.0.2.10', {}],
      ['192.0.2.10', { 'x-portos-dev-proxy-client-address': '127.0.0.1', 'x-forwarded-for': '127.0.0.1' }],
      ['127.0.0.1', { 'x-portos-dev-proxy-client-address': '192.0.2.10' }],
      ['127.0.0.1', { host: 'localhost:5560', 'sec-fetch-site': 'cross-site' }],
      ['127.0.0.1', { host: 'localhost:5560', 'sec-fetch-site': 'same-site' }],
    ]) {
      const { res, done } = openLogs({ process: 'example-process' }, { address, headers });
      await done;
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe('HOST_CONTROL_FORBIDDEN');
      expect(res.write).not.toHaveBeenCalled();
    }
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it('refuses Basic-auth-only and originless cross-site session GETs while allowing primary, sidecar, and Bearer agent sessions', async () => {
    await loadUi(true);
    const basic = `Basic ${Buffer.from(`:${PASSWORD}`).toString('base64')}`;
    for (const headers of [
      { authorization: basic },
      { host: 'localhost:5560', cookie: 'portos_auth_5555=example-session', 'sec-fetch-site': 'cross-site' },
      { host: 'localhost:5560', cookie: 'portos_auth_5555=example-session', 'sec-fetch-site': 'same-site' },
    ]) {
      const { res, done } = openLogs({ process: 'example-process' }, { address: '127.0.0.1', headers });
      await done;
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe('HOST_CONTROL_FORBIDDEN');
      expect(res.write).not.toHaveBeenCalled();
    }
    expect(harness.spawn).not.toHaveBeenCalled();

    const loginRes = response();
    await harness.auth.handleLogin({ headers: {}, body: { password: PASSWORD } }, loginRes);
    const sidecarCookie = loginRes.headers['Set-Cookie'].split(';')[0];

    for (const [headers, query] of [
      [{ host: 'portos.example.ts.net:5560', cookie: 'portos_auth_5555=example-session', 'sec-fetch-site': 'same-origin' }, { process: 'example-process' }],
      [{ host: 'portos.example.ts.net:5560', cookie: sidecarCookie, 'sec-fetch-site': 'same-origin' }, {}],
      [{ authorization: 'Bearer example-session' }, { process: 'example-process' }],
      [{ authorization: 'Bearer example-session' }, {}],
    ]) {
      const initial = child();
      const spawned = nextSpawn(initial);
      const { res, done } = openLogs(query, { address: '192.0.2.10', headers });
      await spawned;
      initial.emit('close', 1);
      await done;
      expect(res.statusCode).toBe(200);
      expect(res.write.mock.calls[0][0]).toBe(': connected\n\n');
    }
    expect(harness.spawn).toHaveBeenCalledTimes(4);
  }, 30_000);

  it('allows genuine loopback password-free browsers and dev-proxy origins to stream logs', async () => {
    await loadUi();
    for (const [address, headers] of [
      ['127.0.0.1', { host: 'localhost:5560', 'sec-fetch-site': 'same-origin' }],
      ['::1', { host: 'localhost:5560', 'sec-fetch-site': 'none' }],
      ['::ffff:127.0.0.1', { origin: 'http://localhost:5554', host: 'localhost:5560', 'sec-fetch-site': 'same-site' }],
    ]) {
      const initial = child();
      const spawned = nextSpawn(initial);
      const { res, done } = openLogs({}, { address, headers });
      await spawned;
      initial.emit('close', 1);
      await done;
      expect(res.statusCode).toBe(200);
      expect(res.write.mock.calls[0][0]).toBe(': connected\n\n');
    }
    expect(harness.spawn).toHaveBeenCalledTimes(3);
  });

  it('refuses an option-shaped, repeated, or unregistered process name before spawning pm2', async () => {
    await loadUi();
    for (const name of ['--no-daemon', '-s', ['example-process', '--json']]) {
      const { res, done } = openLogs({ process: name });
      await done;
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_PROCESS_NAME' });
      expect(res.write).not.toHaveBeenCalled();
    }
    const { res, done } = openLogs({ process: 'unregistered-process' });
    await done;
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Unknown process', code: 'UNKNOWN_PROCESS' });
    expect(res.write).not.toHaveBeenCalled();
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it('streams a named registered process as the positional pm2 argument', async () => {
    await loadUi();
    const initial = child();
    const spawned = nextSpawn(initial);
    const { done } = openLogs({ process: 'example-process' });
    await spawned;
    initial.emit('close', 1);
    await done;
    expect(harness.spawn.mock.calls[0][1].slice(0, 3)).toEqual(['example-pm2', 'logs', 'example-process']);
  });

  it('reports an initial spawn error and ends SSE without starting a live stream', async () => {
    await loadUi();
    const initial = child();
    const spawned = nextSpawn(initial);
    const { res, done } = openLogs();
    await spawned;
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
    const spawned = nextSpawn(initial);
    const { res, done } = openLogs();
    await spawned;
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
    const initialSpawned = nextSpawn(initial);
    const liveSpawned = nextSpawn(live);
    const { req, res, done } = openLogs();
    await initialSpawned;
    initial.stdout.emit('data', 'initial log\n');
    initial.emit('close', 0);
    await liveSpawned;
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

function createDomStub() {
  const docListeners = new Map();
  const byId = new Map();
  const intervals = [];

  const doc = {
    body: { nodeName: 'BODY' },
    activeElement: null,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    dispatchEvent(event) {
      for (const fn of docListeners.get(event.type) ?? []) fn(event);
    },
    getElementById(id) { return byId.get(id) ?? null; },
    querySelector(selector) {
      if (selector === 'header') return header;
      if (selector === '.container') return container;
      return null;
    },
    contains(target) {
      return Boolean(target && (target === doc.body || walk(root).includes(target)));
    },
    createElement(tagName) { return makeElement(tagName); },
    createTextNode(text) { return { nodeType: 3, textContent: text, parentNode: null }; },
  };

  function walk(node) {
    const out = [node];
    for (const child of node.children ?? []) {
      if (child.nodeType !== 3) out.push(...walk(child));
    }
    return out;
  }

  function makeElement(tagName, { id = '', className = '', hidden = false, disabled = false, attrs = {} } = {}) {
    const listeners = new Map();
    const attrsMap = new Map(Object.entries(attrs));
    const classes = new Set(className ? className.split(/\s+/).filter(Boolean) : []);
    const el = {
      tagName: tagName.toUpperCase(),
      id,
      hidden,
      disabled,
      inert: false,
      value: '',
      href: '',
      type: '',
      textContent: '',
      dataset: {},
      style: {},
      parentNode: null,
      children: [],
      classList: {
        add(...names) { names.forEach(n => classes.add(n)); },
        remove(...names) { names.forEach(n => classes.delete(n)); },
        toggle(name, force) {
          const next = force === undefined ? !classes.has(name) : Boolean(force);
          if (next) classes.add(name);
          else classes.delete(name);
          return next;
        },
        contains(name) { return classes.has(name); },
      },
      set className(val) {
        classes.clear();
        String(val).split(/\s+/).filter(Boolean).forEach(n => classes.add(n));
      },
      get className() { return [...classes].join(' '); },
      setAttribute(name, value) { attrsMap.set(name, String(value)); },
      getAttribute(name) { return attrsMap.get(name) ?? null; },
      appendChild(child) {
        child.parentNode = el;
        el.children.push(child);
        return child;
      },
      append(...nodes) { nodes.forEach(n => el.appendChild(n)); },
      replaceChildren(...nodes) {
        el.children.forEach(c => { c.parentNode = null; });
        el.children.length = 0;
        nodes.forEach(n => el.appendChild(n));
      },
      remove() {
        if (!el.parentNode) return;
        el.parentNode.children = el.parentNode.children.filter(c => c !== el);
        el.parentNode = null;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      async dispatchEvent(event) {
        for (const fn of listeners.get(event.type) ?? []) await fn(event);
      },
      async click() { await el.dispatchEvent({ type: 'click', preventDefault() {} }); },
      focus() { doc.activeElement = el; },
      contains(other) { return walk(el).includes(other); },
      closest(selector) {
        let cur = el;
        while (cur) {
          if (selector === '[hidden]' && cur.hidden) return cur;
          if (selector === 'button.process-item' && cur.tagName === 'BUTTON' && cur.classList.contains('process-item')) return cur;
          cur = cur.parentNode;
        }
        return null;
      },
      querySelectorAll(selector) {
        const nodes = walk(el).slice(1);
        if (selector === 'button.process-item') {
          return nodes.filter(n => n.tagName === 'BUTTON' && n.classList.contains('process-item'));
        }
        if (selector.includes('button:not([disabled])')) {
          return nodes.filter(n => (n.tagName === 'INPUT' || n.tagName === 'BUTTON') && !n.disabled);
        }
        return [];
      },
    };
    if (id) byId.set(id, el);
    return el;
  }

  const root = makeElement('div');
  const header = makeElement('header');
  const container = makeElement('div', { className: 'container' });
  const portosDashboardLink = makeElement('a', { id: 'portosDashboardLink' });
  const logsTab = makeElement('button', { id: 'logsTab', className: 'active', attrs: { 'aria-selected': 'true', tabindex: '0' } });
  const historyTab = makeElement('button', { id: 'historyTab', attrs: { 'aria-selected': 'false', tabindex: '-1' } });
  const logoutLink = makeElement('button', { id: 'logoutLink', hidden: true });
  header.append(portosDashboardLink, logsTab, historyTab, logoutLink);

  const processList = makeElement('ul', { id: 'processList' });
  const currentProcess = makeElement('span', { id: 'currentProcess' });
  const restartBtn = makeElement('button', { id: 'restartBtn', disabled: true });
  const stopBtn = makeElement('button', { id: 'stopBtn', disabled: true });
  const clearBtn = makeElement('button', { id: 'clearBtn' });
  const pauseBtn = makeElement('button', { id: 'pauseBtn', attrs: { 'aria-pressed': 'false' } });
  const logs = makeElement('div', { id: 'logs' });
  const historyPanel = makeElement('div', { id: 'historyPanel', hidden: true });
  const statusDot = makeElement('div', { id: 'statusDot', attrs: { 'aria-hidden': 'true' } });
  const statusText = makeElement('span', { id: 'statusText' });
  const lineCount = makeElement('span', { id: 'lineCount' });
  container.append(processList, currentProcess, restartBtn, stopBtn, clearBtn, pauseBtn, logs, historyPanel, statusDot, statusText, lineCount);

  const toast = makeElement('div', { id: 'toast', attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } });
  const loginOverlay = makeElement('div', { id: 'loginOverlay', hidden: true, attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'loginTitle' } });
  const loginForm = makeElement('form', { id: 'loginForm' });
  const loginPassword = makeElement('input', { id: 'loginPassword' });
  const loginSubmit = makeElement('button', { id: 'loginSubmit' });
  const loginError = makeElement('div', { id: 'loginError', attrs: { role: 'alert' } });
  loginForm.append(loginPassword, loginSubmit, loginError);
  loginOverlay.append(loginForm);
  root.append(header, container, toast, loginOverlay);

  return { doc, header, container, loginOverlay, loginForm, loginPassword, loginSubmit, loginError, logoutLink, processList, restartBtn, stopBtn, pauseBtn, logsTab, historyTab, logs, historyPanel, toast, intervals };
}

function mountUiScript(html, fetchImpl) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Expected inline script in autofixer UI HTML');
  const dom = createDomStub();
  const win = { location: { protocol: 'http:', hostname: 'localhost' } };
  const context = {
    document: dom.doc,
    window: win,
    fetch: fetchImpl,
    EventSource: function FakeEventSource() { this.close = () => {}; },
    setInterval: (fn) => { dom.intervals.push(fn); return dom.intervals.length; },
    setTimeout: () => 1,
    clearTimeout: () => {},
    requestAnimationFrame: (fn) => fn(),
    encodeURIComponent,
    Map,
    Array,
    Date,
    Math,
    JSON,
    String,
    Boolean,
  };
  runInNewContext(match[1], context);
  return { dom, context };
}

describe('Autofixer UI accessibility DOM and markup contracts', () => {
  it('ships semantic landmarks, tablist/tabpanel, dialog, live regions, contrast tokens, and zoom flex layout', async () => {
    await loadUi();
    const res = response();
    harness.routes.get('/').at(-1)({}, res);
    const html = res.body;

    expect(html).toContain('<nav class="nav-links"');
    expect(html).toContain('<main class="main-content">');
    expect(html).toContain('<ul class="process-list" id="processList">');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('<button type="button" class="active" id="logsTab" role="tab" aria-selected="true" aria-controls="logs" tabindex="0">Logs</button>');
    expect(html).toContain('<button type="button" id="historyTab" role="tab" aria-selected="false" aria-controls="historyPanel" tabindex="-1">History</button>');
    expect(html).toContain('<button type="button" id="logoutLink" hidden>Log out</button>');
    expect(html).toContain('<button type="button" id="pauseBtn" aria-pressed="false">Pause</button>');
    expect(html).toContain('<span aria-hidden="true">🔧</span>');
    expect(html).toContain('<span aria-hidden="true">🔒</span>');
    expect(html).toContain('<div class="status-indicator" role="status" aria-live="polite">');
    expect(html).toContain('<div class="status-dot" id="statusDot" aria-hidden="true"></div>');
    expect(html).toContain('<div id="toast" class="toast" role="status" aria-live="polite" aria-atomic="true"></div>');
    expect(html).toContain('<div class="login-overlay" id="loginOverlay" role="dialog" aria-modal="true" aria-labelledby="loginTitle" hidden>');
    expect(html).toContain('<div class="login-error" id="loginError" role="alert"></div>');

    expect(html).not.toContain('#666');
    expect(html).not.toContain('calc(100vh');
    expect(html).not.toContain('outline: none');
    expect(html).not.toMatch(/\.history-item\s*\{[^}]*cursor:\s*pointer/);
    expect(html).toContain('#9ca3af');
    expect(html).toContain('#fca5a5');
    expect(html).toContain('#4f46e5');
    expect(html).toContain('height: 100dvh;');
    expect(html).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('renders native process buttons with status text and preserves focus across selection and status polls', async () => {
    await loadUi();
    const res = response();
    harness.routes.get('/').at(-1)({}, res);

    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/auth/status') return { ok: true, status: 200, json: async () => ({ enabled: false }) };
      if (url === '/api/apps') return { ok: true, status: 200, json: async () => [{ name: 'Example App', pm2ProcessNames: ['example-api', 'example-worker'] }] };
      if (url === '/api/status') return { ok: true, status: 200, json: async () => [{ name: 'example-api', status: 'online' }, { name: 'example-worker', status: 'errored' }] };
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const { dom, context } = mountUiScript(res.body, fetchMock);
    await vi.waitFor(() => {
      expect(dom.processList.querySelectorAll('button.process-item')).toHaveLength(2);
    });

    const buttons = dom.processList.querySelectorAll('button.process-item');
    expect(buttons[0].parentNode.tagName).toBe('LI');
    expect(buttons[0].type).toBe('button');
    expect(buttons[0].children[0].children[0].getAttribute('aria-hidden')).toBe('true');
    expect(buttons[0].children[0].children[2].textContent).toBe(' (online)');
    expect(buttons[1].children[0].children[2].textContent).toBe(' (errored)');

    buttons[0].focus();
    await buttons[0].click();

    expect(dom.restartBtn.disabled).toBe(false);
    expect(dom.stopBtn.disabled).toBe(false);
    expect(dom.doc.activeElement.dataset.name).toBe('example-api');
    expect(dom.doc.activeElement.getAttribute('aria-current')).toBe('true');

    await context.fetchStatus();
    expect(dom.doc.activeElement.dataset.name).toBe('example-api');
    expect(dom.doc.activeElement).not.toBe(buttons[0]);
  });

  it('isolates background with inert, traps Tab/Shift+Tab inside #loginOverlay, and updates toast/pause/tabs/history focus', async () => {
    await loadUi();
    const res = response();
    harness.routes.get('/').at(-1)({}, res);

    let authenticated = false;
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/auth/status') return { ok: true, status: 200, json: async () => ({ enabled: true, authenticated }) };
      if (url === '/api/auth/login') {
        authenticated = true;
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      if (url === '/api/apps') return { ok: true, status: 200, json: async () => [] };
      if (url === '/api/status') return { ok: true, status: 200, json: async () => [] };
      if (url === '/api/history') {
        return { ok: true, status: 200, json: async () => [{ sessionId: 's1', processName: 'example-api', appName: 'Example', startTime: '2026-01-01T00:00:00Z', duration: 1000, success: true, staged: true }] };
      }
      if (url === '/api/fixes/s1') return { ok: true, status: 200, json: async () => ({ patch: '+fix' }) };
      if (url === '/api/fixes/s1/discard') return { ok: true, status: 200, json: async () => ({ disposition: 'discarded' }) };
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const { dom, context } = mountUiScript(res.body, fetchMock);
    await vi.waitFor(() => {
      expect(dom.loginOverlay.hidden).toBe(false);
    });

    expect(dom.header.inert).toBe(true);
    expect(dom.container.inert).toBe(true);
    expect(dom.doc.activeElement).toBe(dom.loginPassword);

    const shiftTab = { type: 'keydown', key: 'Tab', shiftKey: true, prevented: false, preventDefault() { this.prevented = true; } };
    await dom.doc.dispatchEvent(shiftTab);
    expect(shiftTab.prevented).toBe(true);
    expect(dom.doc.activeElement).toBe(dom.loginSubmit);

    const forwardTab = { type: 'keydown', key: 'Tab', shiftKey: false, prevented: false, preventDefault() { this.prevented = true; } };
    await dom.doc.dispatchEvent(forwardTab);
    expect(forwardTab.prevented).toBe(true);
    expect(dom.doc.activeElement).toBe(dom.loginPassword);

    dom.loginPassword.value = 'example-password';
    await dom.loginForm.dispatchEvent({ type: 'submit', preventDefault() {} });
    await vi.waitFor(() => {
      expect(dom.loginOverlay.hidden).toBe(true);
    });
    expect(dom.header.inert).toBe(false);
    expect(dom.container.inert).toBe(false);
    expect(dom.logoutLink.hidden).toBe(false);

    await dom.pauseBtn.click();
    expect(dom.pauseBtn.getAttribute('aria-pressed')).toBe('true');
    expect(dom.pauseBtn.textContent).toBe('Resume');

    context.showToast('Action failed', 'error');
    expect(dom.toast.getAttribute('role')).toBe('alert');
    expect(dom.toast.getAttribute('aria-live')).toBe('assertive');

    await dom.logsTab.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() {} });
    expect(dom.historyTab.getAttribute('aria-selected')).toBe('true');
    expect(dom.logsTab.getAttribute('tabindex')).toBe('-1');
    expect(dom.historyTab.getAttribute('tabindex')).toBe('0');
    expect(dom.logs.hidden).toBe(true);
    expect(dom.historyPanel.hidden).toBe(false);

    await vi.waitFor(() => {
      expect(dom.historyPanel.children).toHaveLength(1);
    });
    const historyItem = dom.historyPanel.children[0];
    const reviewBtn = historyItem.children[3];
    expect(reviewBtn.type).toBe('button');
    await reviewBtn.click();
    await vi.waitFor(() => {
      expect(dom.doc.activeElement.textContent).toBe('Apply and restart');
    });
    const discardBtn = historyItem.children.at(-1);
    expect(discardBtn.type).toBe('button');
    await discardBtn.click();
    await vi.waitFor(() => {
      expect(dom.doc.activeElement.textContent).toBe('Discarded');
    });
    expect(dom.doc.activeElement.getAttribute('tabindex')).toBe('-1');
  });
});

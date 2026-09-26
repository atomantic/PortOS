import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { Router } from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';

// The real authGate and both host-control gates over the #8721 families,
// pinned to a password-free install so the developer's own settings cannot
// change what these cases observe.
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn().mockResolvedValue(false),
}));

const featureAgents = vi.hoisted(() => ({
  createFeatureAgent: vi.fn(),
  activateFeatureAgent: vi.fn(),
  triggerFeatureAgent: vi.fn(),
  stopFeatureAgent: vi.fn(),
}));
vi.mock('../services/featureAgents.js', () => featureAgents);

const loops = vi.hoisted(() => ({
  createLoop: vi.fn(),
  triggerLoop: vi.fn(),
  stopLoop: vi.fn(),
}));
vi.mock('../services/loops.js', () => loops);

const installer = vi.hoisted(() => ({
  getProviderRuntime: vi.fn(),
  getProviderRuntimeStatus: vi.fn(),
  getProviderRuntimeStatuses: vi.fn(),
  spawnRuntimeInstaller: vi.fn(),
  stopRuntimeInstaller: vi.fn(),
  describeRuntimeInstall: vi.fn(),
  buildRuntimeActionCommand: vi.fn(),
  RUNTIME_ACTIONS: ['install', 'update', 'uninstall'],
}));
vi.mock('../services/providerRuntimeInstaller.js', () => installer);

import { authGate, hostControlBodyGate, hostControlRouteGate } from '../services/authGate.js';
import featureAgentsRoutes from './featureAgents.js';
import loopsRoutes from './loops.js';
import { createPortOSProviderRoutes } from './providers.js';

// Stand-ins for the two policy-store handlers: the gate, not the store, is
// under test, and a handler that never runs is the proof nothing was written.
const settingsWrite = vi.fn((req, res) => res.json({ saved: Object.keys(req.body) }));
const cosConfigWrite = vi.fn((req, res) => res.json({ saved: Object.keys(req.body) }));

// Mirrors the order server/index.js mounts them in.
const buildGatedApp = (remoteAddress) => {
  const app = express();
  app.use((req, _res, next) => {
    // Model the server's socket observation, never an HTTP header.
    Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress });
    next();
  });
  app.use(authGate);
  app.use(hostControlRouteGate);
  app.use(express.json());
  app.use(hostControlBodyGate);
  app.use('/api/feature-agents', featureAgentsRoutes);
  app.use('/api/loops', loopsRoutes);
  app.use('/api/providers', createPortOSProviderRoutes({ services: { providers: {} }, routes: { providers: Router() } }));
  app.put('/api/settings', settingsWrite);
  app.put('/api/cos/config', cosConfigWrite);
  app.use(errorMiddleware);
  return app;
};

const remote = () => buildGatedApp('192.0.2.10');
const local = () => buildGatedApp('127.0.0.1');

// `proxyClient` is the address the Vite dev proxy reports for the browser it
// forwarded, which is what makes a loopback socket a remote caller.
const call = (app, [method, path, body = {}], proxyClient) => {
  const pending = request(app)[method](path);
  if (proxyClient) pending.set(DEV_PROXY_CLIENT_ADDRESS_HEADER, proxyClient);
  return pending.send(body);
};

const expectRefused = (response) => {
  expect(response.status).toBe(403);
  expect(response.body.code).toBe('HOST_CONTROL_FORBIDDEN');
};

const REFUSED_WRITES = [
  ['post', '/api/feature-agents', { name: 'Example agent' }],
  ['post', '/api/feature-agents/agent-1/start', {}],
  ['post', '/api/feature-agents/agent-1/trigger', {}],
  ['post', '/api/loops', { prompt: 'run the example', interval: '5m' }],
  ['post', '/api/loops/loop-1/trigger', {}],
  ['post', '/api/providers/runtimes/install?runtime=codex', {}],
  ['put', '/api/settings', { harnesses: { claude: { enabled: true } } }],
  ['put', '/api/cos/config', { avatarStyle: 'svg', maxConcurrentAgents: 9 }],
];

describe('host-control gate on agent, loop, provider and policy writes (#8721)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    featureAgents.activateFeatureAgent.mockResolvedValue({ id: 'agent-1', status: 'active' });
    featureAgents.stopFeatureAgent.mockResolvedValue({ id: 'agent-1', status: 'stopped' });
    loops.triggerLoop.mockResolvedValue({ id: 'loop-1' });
    loops.stopLoop.mockResolvedValue({ id: 'loop-1', status: 'stopped' });
  });

  it('refuses a remote password-free caller, direct or proxied, before anything runs or is written', async () => {
    for (const write of REFUSED_WRITES) {
      expectRefused(await call(remote(), write));
      expectRefused(await call(local(), write, '192.0.2.10'));
    }
    expect(featureAgents.createFeatureAgent).not.toHaveBeenCalled();
    expect(featureAgents.activateFeatureAgent).not.toHaveBeenCalled();
    expect(featureAgents.triggerFeatureAgent).not.toHaveBeenCalled();
    expect(loops.createLoop).not.toHaveBeenCalled();
    expect(loops.triggerLoop).not.toHaveBeenCalled();
    expect(installer.getProviderRuntimeStatus).not.toHaveBeenCalled();
    expect(installer.spawnRuntimeInstaller).not.toHaveBeenCalled();
    expect(settingsWrite).not.toHaveBeenCalled();
    expect(cosConfigWrite).not.toHaveBeenCalled();
  });

  it('leaves a remote caller the writes that only stop work or change no execution policy', async () => {
    const statuses = [];
    for (const write of [
      ['post', '/api/feature-agents/agent-1/stop'],
      ['post', '/api/loops/loop-1/stop'],
      ['put', '/api/settings', { location: { lat: null, lon: null } }],
      ['put', '/api/cos/config', { avatarStyle: 'svg' }],
    ]) statuses.push((await call(remote(), write)).status);
    expect(statuses).toEqual([200, 200, 200, 200]);
    expect(featureAgents.stopFeatureAgent).toHaveBeenCalledTimes(1);
    expect(loops.stopLoop).toHaveBeenCalledTimes(1);
    expect([settingsWrite, cosConfigWrite].map((write) => write.mock.calls.length)).toEqual([1, 1]);
  });

  it('keeps a local caller, direct or through the dev proxy, able to run and configure everything', async () => {
    for (const proxyClient of [undefined, '::ffff:127.0.0.1']) {
      const statuses = [];
      for (const write of [
        ['post', '/api/feature-agents/agent-1/start'],
        ['post', '/api/loops/loop-1/trigger'],
        ['put', '/api/settings', { codeReview: { reviewers: ['claude'] } }],
        ['put', '/api/cos/config', { maxConcurrentAgents: 2 }],
      ]) statuses.push((await call(local(), write, proxyClient)).status);
      expect(statuses).toEqual([200, 200, 200, 200]);
    }
    expect(featureAgents.activateFeatureAgent).toHaveBeenCalledTimes(2);
    expect(loops.triggerLoop).toHaveBeenCalledTimes(2);
    expect([settingsWrite, cosConfigWrite].map((write) => write.mock.calls.length)).toEqual([2, 2]);
  });
});

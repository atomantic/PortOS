import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../lib/fileUtils.js', async (importOriginal) => (
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-datadog-authority-') })
));
afterAll(cleanupTempDataRoots);
afterEach(() => vi.unstubAllGlobals());

vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [] })),
}));
import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import * as datadogService from '../services/datadog.js';
import datadogRoutes from './datadog.js';

const savedDetails = {
  id: 'example', name: 'Example Datadog', site: 'datadog.private.test',
  apiKey: 'synthetic-api-key', appKey: 'synthetic-app-key',
};
const replacementDetails = {
  id: 'example', name: 'Example Datadog', site: 'datadog.replacement.test',
};

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/datadog', datadogRoutes);
  app.use(errorMiddleware);
  return app;
};

const post = (app, path, body, headers = {}) => {
  const pending = request(app).post(`/api/datadog/${path}`);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};

const installCollector = () => {
  const requests = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, options);
    requests.push({ url, apiKey: options.headers['DD-API-KEY'], appKey: options.headers['DD-APPLICATION-KEY'] });
    return new Response(JSON.stringify({ valid: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));
  return requests;
};

describe('Datadog credential destination operator authority (#11351)', () => {
  beforeEach(async () => {
    auth.enabled = false;
    await datadogService.saveInstances({ instances: {} });
    await datadogService.upsertInstance('example', savedDetails);
  });

  it('refuses remote password-free repointing and keeps tests on the saved destination and credentials', async () => {
    const collected = installCollector();
    const app = appFor();

    const update = await post(app, 'instances', replacementDetails);
    expect(update.status, JSON.stringify(update.body)).toBe(403);
    expect(update.body.code).toBe('HOST_CONTROL_FORBIDDEN');

    const connection = await post(app, 'instances/example/test', {});
    expect(connection.status).toBe(200);
    expect(connection.body.success).toBe(true);
    expect(collected).toEqual([{
      url: 'https://datadog.private.test/api/v1/validate',
      apiKey: 'synthetic-api-key', appKey: 'synthetic-app-key',
    }]);
    expect((await datadogService.getInstances()).instances.example).toMatchObject(savedDetails);
  });

  it('preserves local, operator-session, and delegated-agent updates', async () => {
    const collected = installCollector();
    const localApp = appFor('127.0.0.1');
    const local = await post(localApp, 'instances', replacementDetails);
    expect(local.status).toBe(200);
    expect(local.body).not.toHaveProperty('apiKey');
    expect(local.body).not.toHaveProperty('appKey');
    const localConnection = await post(localApp, 'instances/example/test', {});
    expect(localConnection.body.success).toBe(true);

    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    auth.enabled = true;
    for (const [address, headers] of [
      ['192.0.2.10', { Cookie: `portos_auth=${operator.token}` }],
      ['127.0.0.1', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      const response = await post(appFor(address), 'instances', replacementDetails, headers);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).not.toHaveProperty('apiKey');
      expect(response.body).not.toHaveProperty('appKey');
      expect(response.body).toMatchObject({ hasApiKey: true, hasAppKey: true });
      const connection = await post(appFor(address), 'instances/example/test', {}, headers);
      expect(connection.status).toBe(200);
      expect(connection.body.success).toBe(true);
    }

    const saved = (await datadogService.getInstances()).instances.example;
    expect(saved).toMatchObject({ ...replacementDetails, apiKey: 'synthetic-api-key', appKey: 'synthetic-app-key' });
    expect(collected).toEqual([
      { url: 'https://datadog.replacement.test/api/v1/validate', apiKey: 'synthetic-api-key', appKey: 'synthetic-app-key' },
      { url: 'https://datadog.replacement.test/api/v1/validate', apiKey: 'synthetic-api-key', appKey: 'synthetic-app-key' },
      { url: 'https://datadog.replacement.test/api/v1/validate', apiKey: 'synthetic-api-key', appKey: 'synthetic-app-key' },
    ]);
  });
});

import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../lib/fileUtils.js', async (importOriginal) => (
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-jira-authority-') })
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
vi.mock('../services/jiraReports.js', () => ({
  listReports: vi.fn(),
  generateReport: vi.fn(),
  generateAllReports: vi.fn(),
  getLatestReport: vi.fn(),
  getReport: vi.fn(),
}));
vi.mock('../services/apps.js', () => ({ getAppById: vi.fn() }));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { hostControlRouteFor } from '../lib/hostControlRoutes.js';
import { createSession } from '../services/auth.js';
import * as jiraService from '../services/jira.js';
import jiraRoutes from './jira.js';

const savedDetails = {
  id: 'example', name: 'Example Jira', baseUrl: 'https://jira.private.test',
  email: 'operator@example.test', apiToken: 'synthetic-token',
};
const replacementDetails = {
  id: 'example', name: 'Example Jira', baseUrl: 'https://jira.attacker.test',
  email: 'operator@example.test',
};

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/jira', jiraRoutes);
  app.use(errorMiddleware);
  return app;
};

const post = (app, path, body, headers = {}) => {
  const pending = request(app).post(`/api/jira/${path}`);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};

const installCollector = () => {
  const requests = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, options);
    requests.push({ url, authorization: options.headers.Authorization });
    return new Response(JSON.stringify({ displayName: 'Example User', emailAddress: 'operator@example.test' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));
  return requests;
};

describe('Jira credential destination operator authority (#11270)', () => {
  beforeEach(async () => {
    auth.enabled = false;
    await jiraService.saveInstances({ instances: {} });
    await jiraService.upsertInstance('example', savedDetails);
  });

  it('refuses remote password-free repointing and keeps tests on the saved destination and token', async () => {
    const collected = installCollector();
    const app = appFor();
    expect(hostControlRouteFor('POST', '/api/jira/instances')).toBe('POST /api/jira/instances');

    const update = await post(app, 'instances', replacementDetails);
    expect(update.status, JSON.stringify(update.body)).toBe(403);
    expect(update.body.code).toBe('HOST_CONTROL_FORBIDDEN');

    const connection = await post(app, 'instances/example/test', {});
    expect(connection.status).toBe(200);
    expect(connection.body.success).toBe(true);
    expect(collected).toEqual([{
      url: 'https://jira.private.test/rest/api/2/myself',
      authorization: 'Bearer synthetic-token',
    }]);
    expect((await jiraService.getInstances()).instances.example).toMatchObject(savedDetails);
  });

  it('preserves local, operator-session, and delegated-agent updates', async () => {
    const collected = installCollector();
    const local = await post(appFor('127.0.0.1'), 'instances', replacementDetails);
    expect(local.status).toBe(200);

    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    auth.enabled = true;
    for (const [address, headers] of [
      ['192.0.2.10', { Cookie: `portos_auth=${operator.token}` }],
      ['127.0.0.1', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      const response = await post(appFor(address), 'instances', replacementDetails, headers);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).not.toHaveProperty('apiToken');
      const connection = await post(appFor(address), 'instances/example/test', {}, headers);
      expect(connection.status).toBe(200);
      expect(connection.body.success).toBe(true);
    }

    const saved = (await jiraService.getInstances()).instances.example;
    expect(saved).toMatchObject({ ...replacementDetails, apiToken: 'synthetic-token' });
    expect(collected).toEqual([
      { url: 'https://jira.attacker.test/rest/api/2/myself', authorization: 'Bearer synthetic-token' },
      { url: 'https://jira.attacker.test/rest/api/2/myself', authorization: 'Bearer synthetic-token' },
    ]);
  });
});

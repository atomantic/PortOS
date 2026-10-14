import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-jira-authority-') }));
afterAll(cleanupTempDataRoots);
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));

// Real router and authorization middleware; only outbound domain effects are
// doubled. Refused requests must never reach the saved-account write workflow.
const effects = vi.hoisted(() => ({
  createTicket: vi.fn(async () => ({ ticketId: 'EXAMPLE-1' })),
  updateTicket: vi.fn(async () => ({ success: true })),
  addLabels: vi.fn(async () => ({ success: true })),
  addComment: vi.fn(async () => ({ success: true })),
  transitionTicket: vi.fn(async () => ({ success: true })),
  addIssuesToSprint: vi.fn(async () => ({ success: true })),
  getIssue: vi.fn(async () => ({ key: 'EXAMPLE-1' })),
}));
vi.mock('../services/jira.js', () => effects);
vi.mock('../services/jiraReports.js', () => ({}));
vi.mock('../services/apps.js', () => ({}));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import jiraRoutes from './jira.js';

const instance = '/api/jira/instances/example';
const ticket = `${instance}/tickets/EXAMPLE-1`;
const operations = [
  ['post', `${instance}/tickets`, { projectKey: 'EXAMPLE', summary: 'Example ticket', epicKey: 'EXAMPLE-2', sprintId: '1' }, effects.createTicket],
  ['put', ticket, { summary: 'Updated example' }, effects.updateTicket],
  ['post', `${ticket}/labels`, { labels: ['example'] }, effects.addLabels],
  ['post', `${ticket}/comments`, { comment: 'Example comment' }, effects.addComment],
  ['post', `${ticket}/transition`, { transitionId: '1' }, effects.transitionTicket],
  ['post', `${instance}/sprints/1/issues`, { issueKeys: ['EXAMPLE-1'] }, effects.addIssuesToSprint],
];
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
const call = (app, [method, path, body], headers = {}) => {
  const pending = request(app)[method](path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
const expectNoWrites = () => {
  for (const [, , , effect] of operations) expect(effect).not.toHaveBeenCalled();
};
beforeEach(() => { vi.clearAllMocks(); auth.enabled = false; });

describe('Jira outbound write authority', () => {
  it('refuses direct, proxied and alternate route spellings before account writes', async () => {
    for (const operation of operations) {
      for (const [address, headers] of [
        ['192.0.2.10', {}],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
      ]) {
        const response = await call(appFor(address), operation, headers);
        expect([response.status, response.body.code], operation[1]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
      const variant = [...operation];
      variant[1] = variant[1].toUpperCase() + '/';
      const response = await call(appFor(), variant);
      expect([response.status, response.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoWrites();
  });

  it('refuses anonymous and non-session credentials when authentication is enabled', async () => {
    auth.enabled = true;
    for (const operation of operations) {
      for (const [headers, status, code] of [
        [{}, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
        [{ [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
          [PEER_INSTANCE_HEADER]: 'example-instance' }, 403, 'PEER_SCOPE_FORBIDDEN'],
      ]) {
        const response = await call(appFor(), operation, headers);
        expect([response.status, response.body.code], operation[1]).toEqual([status, code]);
      }
    }
    expectNoWrites();
  });

  it('preserves local, human-session and delegated-agent writes with unchanged inputs', async () => {
    const owner = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Cookie: `portos_auth=${owner.token}` }],
      [true, '127.0.0.1', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const operation of operations) {
        const response = await call(appFor(address), operation, headers);
        expect(response.status, operation[1]).toBe(200);
      }
    }
    for (const [, , , effect] of operations) expect(effect).toHaveBeenCalledTimes(3);
    expect(effects.createTicket).toHaveBeenLastCalledWith('example', operations[0][2]);
    expect(effects.addComment).toHaveBeenLastCalledWith('example', 'EXAMPLE-1', 'Example comment');
  });

  it('preserves remote reads under the password-free policy', async () => {
    const response = await request(appFor()).get(ticket);
    expect(response.status).toBe(200);
    expect(effects.getIssue).toHaveBeenCalledWith('example', 'EXAMPLE-1');
    expectNoWrites();
  });
});

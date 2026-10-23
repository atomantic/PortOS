import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-github-inbox-host-control-') }));
afterAll(cleanupTempDataRoots);

// GitHub notifications inbox writes (#12952). Real router behind the real auth
// and host-control gates; the inbox, account and audit services are doubled,
// so a refused request provably reaches no `gh` write, CoS job or account store.
const auth = vi.hoisted(() => ({ enabled: false }));
const accounts = vi.hoisted(() => ({
  listAccounts: vi.fn(async () => []),
  createAccount: vi.fn(async (body) => ({ id: 'acct-example', ...body })),
  getAccount: vi.fn(async (id) => ({ id, trust: 'public', trustInstanceUsers: false })),
  updateAccount: vi.fn(async (id, body) => ({ id, trust: 'public', trustInstanceUsers: false, ...body })),
  deleteAccount: vi.fn(async () => ({ deleted: true })),
  getAccountStatus: vi.fn(async () => ({ ok: true })),
}));
const inbox = vi.hoisted(() => ({
  listNotifications: vi.fn(async () => ({ notifications: [] })),
  syncAccountNotifications: vi.fn(async (accountId) => ({ accountId })),
  syncAllNotifications: vi.fn(async () => []),
  getNotification: vi.fn(async () => ({})),
  applyNotificationAction: vi.fn(async () => ({ state: 'done' })),
  resolveWithAgent: vi.fn(async () => ({})),
  getAutomationsOverview: vi.fn(async () => ({})),
  setNotificationCadence: vi.fn(async (cadence) => ({ cadence })),
  listAutomationActivity: vi.fn(async () => []),
  undoAutomationAction: vi.fn(async () => ({ undone: true })),
  listLearnedRules: vi.fn(async () => []),
  deleteLearnedRule: vi.fn(async () => ({ deleted: true })),
}));
const audit = vi.hoisted(() => ({
  listAuditChanges: vi.fn(async () => []),
  undoAuditChange: vi.fn(async () => ({ undone: true })),
  getLastAudit: vi.fn(async () => null),
  runAccountAudit: vi.fn(async () => ({ suggestions: [] })),
  applyAuditSuggestion: vi.fn(async () => ({ applied: true })),
}));

vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/githubAccounts.js', () => accounts);
vi.mock('../services/githubNotifications.js', () => inbox);
vi.mock('../services/githubNotificationAudit.js', () => audit);

const { authGate, hostControlRouteGate } = await import('../services/authGate.js');
const { createSession } = await import('../services/auth.js');
const { default: githubRoutes } = await import('./github.js');

// [method, path, body, the service the request must not reach when refused]
const writes = [
  ['post', '/api/github/notifications/example-account/123', { action: 'unsubscribe' }, inbox.applyNotificationAction],
  ['post', '/api/github/notifications/example-account/123/agent', { provider: 'example-provider', effort: 'high' }, inbox.resolveWithAgent],
  ['post', '/api/github/audit/example-account/apply', { suggestionId: 'unwatch:example/repo' }, audit.applyAuditSuggestion],
  ['post', '/api/github/audit-changes/7/undo', {}, audit.undoAuditChange],
  ['post', '/api/github/automations/activity/7/undo', {}, inbox.undoAutomationAction],
  ['put', '/api/github/automations/schedule', { cadence: 'weekdays-15m' }, inbox.setNotificationCadence],
  ['post', '/api/github/accounts', { host: 'github.com', login: 'octocat', label: 'Example' }, accounts.createAccount],
  ['put', '/api/github/accounts/acct-example', { mode: 'autopilot' }, accounts.updateAccount],
];

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/github', githubRoutes);
  app.use(errorMiddleware);
  return app;
};
const send = (app, [method, path, body], headers = {}) => {
  const pending = request(app)[method](path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('GitHub inbox writes require operator authority (#12952)', () => {
  it('refuses a remote password-free caller, direct or proxied, before any gh write, CoS job or account change', async () => {
    for (const write of writes) {
      for (const [address, headers] of [
        ['192.0.2.10', {}],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
      ]) {
        const response = await send(appFor(address), write, headers);
        expect([response.status, response.body.code], write[1]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
      expect(write[3], write[1]).not.toHaveBeenCalled();
    }
  });

  it('keeps every write working for local callers, operator sessions and delegated agent sessions', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: `Bearer ${operator.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const write of writes) {
        const response = await send(appFor(address), write, headers);
        expect(response.status, `${write[1]}: ${JSON.stringify(response.body)}`).toBeLessThan(300);
      }
    }
    for (const write of writes) expect(write[3], write[1]).toHaveBeenCalledTimes(3);
  });

  it('leaves the refresh, deletions and the read-only audit run open, with automation only for host control', async () => {
    for (const write of [
      ['delete', '/api/github/accounts/acct-example', undefined, accounts.deleteAccount],
      ['delete', '/api/github/automations/rules/7', undefined, inbox.deleteLearnedRule],
      ['post', '/api/github/audit/example-account', {}, audit.runAccountAudit],
    ]) {
      expect((await send(appFor(), write)).status, write[1]).toBe(200);
      expect(write[3]).toHaveBeenCalledTimes(1);
    }

    const remote = await send(appFor(), ['post', '/api/github/notifications/sync', { accountId: 'example-account' }]);
    expect(remote.status).toBe(200);
    expect(inbox.syncAccountNotifications).toHaveBeenLastCalledWith('example-account', { automate: false });
    await send(appFor(), ['post', '/api/github/notifications/sync', {}]);
    expect(inbox.syncAllNotifications).toHaveBeenLastCalledWith({ automate: false });

    await send(appFor('127.0.0.1'), ['post', '/api/github/notifications/sync', { accountId: 'example-account' }]);
    expect(inbox.syncAccountNotifications).toHaveBeenLastCalledWith('example-account', { automate: true });
    auth.enabled = true;
    const agent = await createSession({ label: 'agent' });
    await send(appFor(), ['post', '/api/github/notifications/sync', {}], { Authorization: `Bearer ${agent.token}` });
    expect(inbox.syncAllNotifications).toHaveBeenLastCalledWith({ automate: true });
  });
});

describe('Resolve with agent run choice (#13191)', () => {
  it('passes a validated per-run provider/model/effort, null as Auto, and no keys as "use the defaults"', async () => {
    const app = appFor('127.0.0.1');
    const path = '/api/github/notifications/example-account/123/agent';
    expect((await send(app, ['post', path, { provider: 'example-provider', title: 'injected' }])).status).toBe(400);
    expect((await send(app, ['post', path, { effort: 'ludicrous' }])).status).toBe(400);
    expect(inbox.resolveWithAgent).not.toHaveBeenCalled();
    await send(app, ['post', path, {}]);
    expect(inbox.resolveWithAgent).toHaveBeenLastCalledWith('example-account', '123', undefined);
    await send(app, ['post', path, { provider: null, model: '', effort: 'high' }]);
    expect(inbox.resolveWithAgent).toHaveBeenLastCalledWith('example-account', '123', { provider: null, model: null, effort: 'high' });
  });
});

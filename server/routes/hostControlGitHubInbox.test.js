import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, expectAuthorizedWorkflows, expectRemoteRefusal, hostControlApp } from './hostControlTestHarness.js';
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
  setNotificationMute: vi.fn(async (body) => body),
  listNotifications: vi.fn(async () => ({ notifications: [] })),
  syncAccountNotifications: vi.fn(async (accountId) => ({ accountId })),
  syncAllNotifications: vi.fn(async () => []),
  getNotification: vi.fn(async () => ({})),
  applyNotificationAction: vi.fn(async () => ({ state: 'done' })),
  claimIssue: vi.fn(async () => ({ taskId: 'claim-task' })),
  resolveWithAgent: vi.fn(async () => ({})),
  actOnPullRequest: vi.fn(async () => ({})),
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

const { default: githubRoutes } = await import('./github.js');
const mounts = [['/api/github', githubRoutes]];

// [method, path, body, the service the request must not reach when refused]
const writes = [
  ['put', '/api/github/notifications/mutes', { accountId: 'example-account', repoFullName: 'example/repo', reason: 'review_requested', muted: true }, inbox.setNotificationMute],
  ['post', '/api/github/notifications/example-account/123', { action: 'unsubscribe' }, inbox.applyNotificationAction],
  ['post', '/api/github/notifications/example-account/123/claim-issue', { effort: 'medium' }, inbox.claimIssue],
  ['post', '/api/github/notifications/example-account/123/agent', { provider: 'example-provider', effort: 'high' }, inbox.resolveWithAgent],
  ['post', '/api/github/notifications/example-account/123/pull-request', { action: 'merge', method: 'squash' }, inbox.actOnPullRequest],
  ['post', '/api/github/audit/example-account/apply', { suggestionId: 'unwatch:example/repo' }, audit.applyAuditSuggestion],
  ['post', '/api/github/audit-changes/7/undo', {}, audit.undoAuditChange],
  ['post', '/api/github/automations/activity/7/undo', {}, inbox.undoAutomationAction],
  ['put', '/api/github/automations/schedule', { cadence: 'weekdays-15m' }, inbox.setNotificationCadence],
  ['post', '/api/github/accounts', { host: 'github.com', login: 'octocat', label: 'Example' }, accounts.createAccount],
  ['put', '/api/github/accounts/acct-example', { mode: 'autopilot' }, accounts.updateAccount],
];

const localApp = () => hostControlApp('127.0.0.1', mounts);
const send = async (app, write) => callRoute(await app, write);

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('GitHub inbox writes behind the default-deny gate (#12952, #16114)', () => {
  it('refuses a remote caller before any gh write, CoS job or account change', async () => {
    const [method, path, body, effect] = writes[0];
    await expectRemoteRefusal(mounts, [method, path, body, effect]);
  });

  it('validates that a mute targets one ordinary notification reason in one repository', async () => {
    const [method, path, body] = writes[0];
    for (const invalid of [{ repoFullName: 'example/*' }, { reason: 'security_alert' }, { muted: 'yes' }]) {
      const response = await send(localApp(), [method, path, { ...body, ...invalid }]);
      expect(response.status).toBe(400);
    }
    expect(inbox.setNotificationMute).not.toHaveBeenCalled();
  });

  it('keeps every write, deletion, audit and refresh working for local callers and agent sessions', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ...writes.map(([method, path, body, effect]) => [method, path, body, effect, path.endsWith('/accounts') ? 201 : 200]),
      ['delete', '/api/github/accounts/acct-example', undefined, accounts.deleteAccount, 200],
      ['delete', '/api/github/automations/rules/7', undefined, inbox.deleteLearnedRule, 200],
      ['post', '/api/github/audit/example-account', {}, audit.runAccountAudit, 200],
      ['post', '/api/github/notifications/sync', { accountId: 'example-account' }, inbox.syncAccountNotifications, 200],
      ['post', '/api/github/notifications/sync', {}, inbox.syncAllNotifications, 200],
    ] });
    // Refresh from a host-control caller runs the automation pass.
    expect(inbox.syncAccountNotifications).toHaveBeenLastCalledWith('example-account', { automate: true });
    expect(inbox.syncAllNotifications).toHaveBeenLastCalledWith({ automate: true });
  });
});

describe('Resolve with agent run choice (#13191)', () => {
  it('passes a validated per-run provider/model/effort, null as Auto, and no keys as "use the defaults"', async () => {
    const app = localApp();
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

describe('GitHub notification PR actions', () => {
  it('validates action and merge choices before reaching the service', async () => {
    const app = localApp();
    const path = '/api/github/notifications/example-account/123/pull-request';
    for (const body of [{ action: 'shell' }, { action: 'merge', method: 'force' }, { action: 'merge', deleteBranch: 'yes' }, { action: 'do-review', url: 'https://outside.example/pull/1' }]) {
      expect((await send(app, ['post', path, body])).status).toBe(400);
    }
    expect(inbox.actOnPullRequest).not.toHaveBeenCalled();
    await send(app, ['post', path, { action: 'merge', method: 'squash', deleteBranch: false }]);
    expect(inbox.actOnPullRequest).toHaveBeenLastCalledWith('example-account', '123', { action: 'merge', method: 'squash', deleteBranch: false });
  });
});

describe('claim a notified GitHub issue', () => {
  const path = '/api/github/notifications/example-account/123/claim-issue';
  it('accepts model options but never a client-supplied app, repo, or issue number', async () => {
    const app = localApp();
    const pin = { provider: 'example-provider', effort: 'medium' };
    const invalid = await send(app, ['post', path, { ...pin, app: 'wrong-app', target: '543' }]);
    expect(invalid.status).toBe(400);
    expect(inbox.claimIssue).not.toHaveBeenCalled();
    const allowed = await send(app, ['post', path, pin]);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ taskId: 'claim-task' });
    expect(inbox.claimIssue).toHaveBeenCalledWith('example-account', '123', pin);
    await expectRemoteRefusal(mounts, ['post', path, pin, vi.fn()]);
    expect(inbox.claimIssue).toHaveBeenCalledTimes(1);
  });
});

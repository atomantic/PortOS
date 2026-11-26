import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware, ServerError } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';
import * as github from '../services/github.js';
import * as audit from '../services/githubNotificationAudit.js';
import * as deployment from '../services/githubNotificationDeployment.js';
import * as notifications from '../services/githubNotifications.js';
import router from './github.js';

vi.mock('../services/github.js', () => ({
  getRepos: vi.fn(),
  syncRepos: vi.fn(),
  updateRepoFlags: vi.fn(),
  setRepoArchived: vi.fn(),
  getSecrets: vi.fn(),
  setSecret: vi.fn(),
  syncSecretToRepos: vi.fn(),
  getStatus: vi.fn(),
}));
vi.mock('../services/githubAccounts.js', () => ({}));
vi.mock('../services/githubNotifications.js', () => ({
  listNotifications: vi.fn(),
  setNotificationMute: vi.fn(),
  syncAccountNotifications: vi.fn(),
  syncAllNotifications: vi.fn(),
  clearFinishedNotifications: vi.fn(),
  getNotification: vi.fn(),
  applyNotificationAction: vi.fn(),
  resolveWithAgent: vi.fn(),
  claimIssue: vi.fn(),
  actOnPullRequest: vi.fn(),
  getAutomationsOverview: vi.fn(),
  setNotificationCadence: vi.fn(),
  listAutomationActivity: vi.fn(),
  undoAutomationAction: vi.fn(),
  listLearnedRules: vi.fn(),
  deleteLearnedRule: vi.fn(),
}));
vi.mock('../services/githubNotificationAudit.js', () => ({
  listAuditChanges: vi.fn(),
  undoAuditChange: vi.fn(),
  getLastAudit: vi.fn(),
  runAccountAudit: vi.fn(),
  applyAuditSuggestion: vi.fn(),
}));
vi.mock('../services/githubNotificationDeployment.js', () => ({
  getDeploymentReview: vi.fn(),
  reviewDeployment: vi.fn(),
}));
vi.mock('../services/githubNotificationTriage.js', () => ({ retriageOpenThreads: vi.fn() }));

const base = '/api/github';
const fullName = 'example-org/example-repo';
const repoPath = `/repos/${encodeURIComponent(fullName)}`;
const accountId = 'example-account';
const threadId = '12345678901234567890';
const threadPath = `/notifications/${accountId}/${threadId}`;
const auditPath = `/audit/${accountId}`;
const repo = { fullName, archived: false, flags: { deploy: true }, managedSecrets: ['BUILD_1'] };
const thread = { threadId, accountId, status: 'open' };
const syncResult = { accountId, fetched: 1 };
const mute = { accountId, repoFullName: fullName, reason: 'comment', muted: true };
const agentPin = { provider: 'example-provider', model: null, effort: 'medium' };
const pullRequest = { action: 'merge', method: 'squash', deleteBranch: false };
const review = { state: 'approved', environmentIds: [7], comment: 'Checked the preview' };
const auditReport = { accountId, suggestions: [{ id: 'suggestion-1' }] };
const activity = [{ id: '17', action: 'done' }];
const rules = [{ id: '29', action: 'mute' }];
const changes = [{ id: '36', type: 'unwatch' }];
const cadence = { cadence: 'weekdays-15m' };

const app = express();
app.use(express.json());
app.use(base, router);
app.use(errorMiddleware);

describe('GitHub routes', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    { method: 'get', path: '/repos', service: github.getRepos, args: [], result: [repo] },
    {
      method: 'put', path: repoPath, service: github.updateRepoFlags,
      input: { flags: repo.flags, managedSecrets: repo.managedSecrets },
      args: [fullName, { flags: repo.flags, managedSecrets: repo.managedSecrets }], result: repo,
    },
    {
      method: 'post', path: `${repoPath}/archive`, service: github.setRepoArchived,
      args: [fullName, true], result: { ...repo, archived: true },
    },
    {
      method: 'post', path: `${repoPath}/unarchive`, service: github.setRepoArchived,
      args: [fullName, false], result: repo,
    },
    {
      method: 'get', path: '/secrets', service: github.getSecrets,
      args: [], result: [{ name: 'BUILD_1', updatedAt: '2026-01-01T00:00:00.000Z' }],
    },
    {
      method: 'put', path: '/secrets/BUILD_1', service: github.setSecret,
      input: { value: 'example-value', ignored: true }, args: ['BUILD_1', 'example-value'], result: { synced: 1 },
    },
    {
      method: 'post', path: `/secrets/${'A'.repeat(100)}/sync`, service: github.syncSecretToRepos,
      args: ['A'.repeat(100)], result: { synced: 2 },
    },
    { method: 'get', path: '/status', service: github.getStatus, args: [], result: { githubUser: 'example-user' } },
    {
      method: 'get', path: '/notifications?accountId=%20example-account%20&view=needs-you',
      service: notifications.listNotifications, args: [{ accountId, view: 'needs-you' }], result: [thread],
    },
    {
      method: 'put', path: '/notifications/mutes', service: notifications.setNotificationMute,
      input: { ...mute, repoFullName: ` ${fullName} ` }, args: [mute], result: mute,
    },
    {
      method: 'post', path: '/notifications/sync', service: notifications.syncAllNotifications,
      args: [{ automate: true }], result: [{ ...syncResult, ok: false }], response: { results: [{ ...syncResult, ok: false }] },
    },
    {
      method: 'post', path: '/notifications/sync', service: notifications.syncAccountNotifications,
      input: { accountId }, args: [accountId, { automate: true }], result: syncResult, response: { results: [{ ...syncResult, ok: true }] },
    },
    {
      method: 'post', path: '/notifications/clear-finished', service: notifications.clearFinishedNotifications,
      input: { accountId }, args: [{ accountId }], result: { cleared: 2 },
    },
    { method: 'get', path: threadPath, service: notifications.getNotification, args: [accountId, threadId], result: thread },
    {
      method: 'post', path: threadPath, service: notifications.applyNotificationAction,
      input: { action: 'done' }, args: [accountId, threadId, 'done'], result: { ...thread, status: 'done' },
    },
    {
      method: 'post', path: `${threadPath}/agent`, service: notifications.resolveWithAgent,
      args: [accountId, threadId, undefined], result: { taskId: 'task-example' },
    },
    {
      method: 'post', path: `${threadPath}/agent`, service: notifications.resolveWithAgent,
      input: { ...agentPin, provider: ' example-provider ' }, args: [accountId, threadId, agentPin], result: { taskId: 'task-example' },
    },
    {
      method: 'post', path: `${threadPath}/claim-issue`, service: notifications.claimIssue,
      input: { model: '', effort: 'medium' }, args: [accountId, threadId, { model: null, effort: 'medium' }], result: { taskId: 'task-example' },
    },
    {
      method: 'post', path: `${threadPath}/pull-request`, service: notifications.actOnPullRequest,
      input: pullRequest, args: [accountId, threadId, pullRequest], result: { merged: true },
    },
    {
      method: 'get', path: `${threadPath}/deployment`, service: deployment.getDeploymentReview,
      args: [accountId, threadId], result: { environments: [{ id: 7, name: 'preview' }] },
    },
    {
      method: 'post', path: `${threadPath}/deployment`, service: deployment.reviewDeployment,
      input: { ...review, comment: ' Checked the preview ' }, args: [accountId, threadId, review], result: { state: 'approved' },
    },
    { method: 'get', path: '/automations', service: notifications.getAutomationsOverview, args: [], result: { cadence: 'off' } },
    {
      method: 'put', path: '/automations/schedule', service: notifications.setNotificationCadence,
      input: cadence, args: ['weekdays-15m'], result: cadence,
    },
    {
      method: 'get', path: '/automations/activity', service: notifications.listAutomationActivity,
      args: [], result: activity, response: { actions: activity },
    },
    {
      method: 'post', path: '/automations/activity/17/undo', service: notifications.undoAutomationAction,
      args: ['17'], result: { undone: true },
    },
    {
      method: 'get', path: '/automations/rules', service: notifications.listLearnedRules,
      args: [], result: rules, response: { rules },
    },
    {
      method: 'delete', path: '/automations/rules/29', service: notifications.deleteLearnedRule,
      args: ['29'], result: { deleted: true },
    },
    {
      method: 'get', path: '/audit-changes', service: audit.listAuditChanges,
      args: [], result: changes, response: { changes },
    },
    {
      method: 'post', path: '/audit-changes/36/undo', service: audit.undoAuditChange,
      args: ['36'], result: { undone: true },
    },
    { method: 'get', path: auditPath, service: audit.getLastAudit, args: [accountId], result: null, response: { audit: null } },
    {
      method: 'post', path: auditPath, service: audit.runAccountAudit,
      args: [accountId], result: auditReport, response: { audit: auditReport },
    },
    {
      method: 'post', path: `${auditPath}/apply`, service: audit.applyAuditSuggestion,
      input: { suggestionId: ' suggestion-1 ' }, args: [accountId, 'suggestion-1'], result: { applied: true },
    },
  ])('$method $path accepts $input and returns the expected JSON', async ({
    method, path, service, input, args, result, response = result,
  }) => {
    service.mockResolvedValue(result);
    const { status, body } = await request(app)[method](`${base}${path}`).send(input);
    expect(status).toBe(200);
    expect(body).toEqual(response);
    expect(service).toHaveBeenCalledExactlyOnceWith(...args);
  });

  it('returns only the repo sync summary', async () => {
    const summary = {
      repos: [repo],
      lastRepoSync: '2026-01-01T00:00:00.000Z',
      githubUser: 'example-user',
      truncated: true,
    };
    github.syncRepos.mockResolvedValue({ ...summary, diagnostics: 'internal detail' });
    const { status, body } = await request(app).post(`${base}/repos/sync`);
    expect(status).toBe(200);
    expect(body).toEqual(summary);
  });

  it.each(['lowercase', 'BUILD-1', 'A'.repeat(101)])('rejects invalid secret name %s for writes and syncs', async (name) => {
    const path = `${base}/secrets/${name}`;
    const put = await request(app).put(path).send({ value: 'example-value' });
    const sync = await request(app).post(`${path}/sync`);
    for (const response of [put, sync]) {
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/invalid secret name/i);
    }
    expect(github.setSecret).not.toHaveBeenCalled();
    expect(github.syncSecretToRepos).not.toHaveBeenCalled();
  });

  it.each([
    { method: 'put', path: repoPath, service: github.updateRepoFlags, input: { flags: { deploy: 'true' } } },
    { method: 'put', path: '/secrets/BUILD_1', service: github.setSecret, input: { value: '' } },
    { method: 'get', path: '/notifications?view=unknown', service: notifications.listNotifications },
    { method: 'put', path: '/notifications/mutes', service: notifications.setNotificationMute, input: { ...mute, reason: 'security_alert' } },
    {
      method: 'post', path: '/notifications/sync', service: notifications.syncAccountNotifications,
      input: { accountId: ' ' },
    },
    {
      method: 'post', path: '/notifications/clear-finished', service: notifications.clearFinishedNotifications,
      input: { accountId: false },
    },
    { method: 'post', path: threadPath, service: notifications.applyNotificationAction, input: { action: 'unknown' } },
    { method: 'post', path: `${threadPath}/agent`, service: notifications.resolveWithAgent, input: { effort: 'unknown' } },
    { method: 'post', path: `${threadPath}/claim-issue`, service: notifications.claimIssue, input: { model: false } },
    { method: 'post', path: `${threadPath}/pull-request`, service: notifications.actOnPullRequest, input: { action: 'close' } },
    {
      method: 'post', path: `${threadPath}/deployment`, service: deployment.reviewDeployment,
      input: { state: 'approved', environmentIds: [] },
    },
    { method: 'put', path: '/automations/schedule', service: notifications.setNotificationCadence, input: { cadence: 'hourly' } },
    { method: 'post', path: `${auditPath}/apply`, service: audit.applyAuditSuggestion, input: { suggestionId: ' ' } },
  ])('$method $path rejects $input before calling the service', async ({ method, path, service, input }) => {
    const { status, body } = await request(app)[method](`${base}${path}`).send(input);
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(service).not.toHaveBeenCalled();
  });

  it.each([
    {
      method: 'get', path: `/notifications/${accountId}/not-numeric`,
      service: notifications.getNotification, error: 'Invalid notification thread id',
    },
    {
      method: 'post', path: `/notifications/${accountId}/${threadId}1/deployment`,
      input: review, service: deployment.reviewDeployment, error: 'Invalid notification thread id',
    },
    {
      method: 'post', path: '/automations/activity/1234567890123456789/undo',
      service: notifications.undoAutomationAction, error: 'Invalid id',
    },
    {
      method: 'delete', path: '/automations/rules/not-numeric',
      service: notifications.deleteLearnedRule, error: 'Invalid id',
    },
    {
      method: 'post', path: '/audit-changes/not-numeric/undo',
      service: audit.undoAuditChange, error: 'Invalid id',
    },
  ])('$method $path rejects an invalid ID before calling the service', async ({ method, path, service, input, error }) => {
    const { status, body } = await request(app)[method](`${base}${path}`).send(input);
    expect(status).toBe(400);
    expect(body.error).toBe(error);
    expect(service).not.toHaveBeenCalled();
  });

  it.each([
    {
      method: 'put', path: repoPath, service: github.updateRepoFlags,
      input: { flags: repo.flags }, code: 'REPO_NOT_FOUND',
    },
    { method: 'get', path: threadPath, service: notifications.getNotification, code: 'GITHUB_NOTIFICATION_NOT_FOUND' },
    { method: 'post', path: '/audit-changes/36/undo', service: audit.undoAuditChange, code: 'GITHUB_AUDIT_CHANGE_NOT_FOUND' },
  ])('$method $path preserves the service 404 code $code', async ({ method, path, service, input, code }) => {
    service.mockRejectedValue(new ServerError('Fixture not found', { status: 404, code }));
    const { status, body } = await request(app)[method](`${base}${path}`).send(input);
    expect(status).toBe(404);
    expect(body.code).toBe(code);
  });
});

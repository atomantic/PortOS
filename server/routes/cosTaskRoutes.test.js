/**
 * Route-level tests for the CoS task create/update endpoints, focused on the
 * federated instance pin (#4520): the pin must survive to the store on create,
 * be re-settable and CLEARABLE on update, and be refused when it names an
 * instance this install doesn't know — a pin nothing matches would leave the
 * task pending on every peer forever.
 *
 * Also the operator-action ledger hooks (#5594): these routes are the ONLY CoS
 * task writes that are a human pressing a button, so they are where the ledger
 * rows are produced. Those cases run against the real `services/userActions.js`
 * on its file backend (with `PATHS.data` re-rooted at a temp dir below) so they
 * assert a PERSISTED row rather than a mock call.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Re-root PATHS.data so the ledger writes land in a temp dir instead of the
// developer's live `data/` tree (#3683/#3687). Everything else in fileUtils
// stays real.
//
// `vi.hoisted` + an in-factory import, rather than the shorter
// `mockPathsDataRoot()` destructure: this file imports the router STATICALLY, so
// the mock factory runs during module linking — before any module-body const is
// initialized.
const tempRoot = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return mkdtempSync(joinPath(tmpdir(), 'portos-cos-task-routes-'));
});
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  const { makePathsProxy } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy(actual, { dataRoot: tempRoot });
});

vi.mock('../services/cos.js', () => ({
  addTask: vi.fn(),
  updateTask: vi.fn(),
  getAllTasks: vi.fn(),
  getUserTasks: vi.fn(),
  getCosTasks: vi.fn(),
  getTaskById: vi.fn(),
  deleteTask: vi.fn(),
  reorderTasks: vi.fn(),
  approveTask: vi.fn(),
  challengeTask: vi.fn(),
  resolveTaskChallenge: vi.fn(),
  resolveTaskChallengeWithRecheck: vi.fn(),
  evaluateTasks: vi.fn(),
  reviveBlockedTask: vi.fn(),
  forceSpawnTask: vi.fn(),
}));
vi.mock('../services/taskWatcher.js', () => ({ refreshTasks: vi.fn() }));
vi.mock('../services/taskEnhancer.js', () => ({ enhanceTaskPrompt: vi.fn() }));
vi.mock('../services/cosTaskGenerator.js', () => ({
  buildClaimWorkTask: vi.fn(),
  buildJiraTicketTask: vi.fn(),
}));
vi.mock('../services/apps.js', () => ({ getAppById: vi.fn(), getAppWorkTracker: vi.fn(), PORTOS_APP_ID: 'portos-default' }));
vi.mock('../services/streamingDetect.js', () => ({ NON_PM2_TYPES: new Set() }));
vi.mock('../services/instances.js', () => ({ getAssignableInstances: vi.fn() }));
vi.mock('../services/managedAppRepositories.js', () => ({ resolveManagedAppIssueTarget: vi.fn() }));

import * as cos from '../services/cos.js';
import { getAssignableInstances } from '../services/instances.js';
import { getAppById, getAppWorkTracker } from '../services/apps.js';
import { resolveManagedAppIssueTarget } from '../services/managedAppRepositories.js';
import cosTaskRoutes from './cosTaskRoutes.js';
import { listUserActions } from '../services/userActions.js';

const SELF = 'self-instance-id';
const PEER = 'peer-instance-id';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cos', cosTaskRoutes);
  app.use(errorMiddleware);
  return app;
};

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

beforeEach(() => {
  vi.clearAllMocks();
  rmSync(join(tempRoot, 'user-action-events.json'), { force: true });
  getAssignableInstances.mockResolvedValue([
    { instanceId: SELF, name: 'workstation', isSelf: true },
    { instanceId: PEER, name: 'render-box', isSelf: false },
  ]);
  cos.addTask.mockImplementation(async (taskData) => ({ id: 'task-1', ...taskData }));
  cos.updateTask.mockResolvedValue({ id: 'task-1' });
  getAppById.mockResolvedValue({ id: 'portos-default', name: 'PortOS', repoPath: '/example/portos' });
  resolveManagedAppIssueTarget.mockResolvedValue({
    role: 'upstream',
    forge: 'github',
    fullName: 'example-org/example-app',
    repoSpec: 'github.com/example-org/example-app',
  });
});

describe('POST /api/cos/tasks — targetInstanceId (#4520)', () => {
  it('passes a registry-known pin through to addTask', async () => {
    const res = await request(buildApp())
      .post('/api/cos/tasks')
      .send({ description: 'render the shot', targetInstanceId: PEER });
    expect(res.status).toBe(200);
    expect(cos.addTask).toHaveBeenCalledWith(expect.objectContaining({ targetInstanceId: PEER }), 'user');
  });

  it('rejects a pin naming an instance this install does not know', async () => {
    const res = await request(buildApp())
      .post('/api/cos/tasks')
      .send({ description: 'render the shot', targetInstanceId: 'ghost-instance-id' });
    expect(res.status).toBe(400);
    expect(cos.addTask).not.toHaveBeenCalled();
  });

  it('creates an unpinned task without consulting the registry', async () => {
    const res = await request(buildApp()).post('/api/cos/tasks').send({ description: 'anywhere' });
    expect(res.status).toBe(200);
    expect(getAssignableInstances).not.toHaveBeenCalled();
    expect(cos.addTask.mock.calls[0][0].targetInstanceId).toBeUndefined();
  });
});

describe('POST /api/cos/tasks — plan-only tracker gate', () => {
  it('rejects issue-only planning for a non-issue tracker', async () => {
    getAppWorkTracker.mockResolvedValue({ resolved: 'jira' });

    const res = await request(buildApp())
      .post('/api/cos/tasks')
      .send({ description: 'plan the change', app: 'jira-app', planOnly: true });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_PLAN_ONLY_TRACKER');
    expect(cos.addTask).not.toHaveBeenCalled();
  });

  it('allows issue-only planning for a GitLab tracker', async () => {
    getAppWorkTracker.mockResolvedValue({ resolved: 'gitlab' });

    const res = await request(buildApp())
      .post('/api/cos/tasks')
      .send({ description: 'plan the change', app: 'gitlab-app', planOnly: true });

    expect(res.status).toBe(200);
    expect(cos.addTask).toHaveBeenCalledWith(expect.objectContaining({ planOnly: true }), 'user');
  });

  it('pins plan-only GitHub commands to the detected upstream repository', async () => {
    getAppWorkTracker.mockResolvedValue({ resolved: 'github' });

    const res = await request(buildApp())
      .post('/api/cos/tasks')
      .send({ description: 'plan the change', app: 'forked-app', planOnly: true });

    expect(res.status).toBe(200);
    expect(resolveManagedAppIssueTarget).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/example/portos' }),
      'upstream',
    );
    expect(cos.addTask.mock.calls[0][0].prompt).toContain('github.com/example-org/example-app');
    expect(cos.addTask.mock.calls[0][0].prompt).toContain('canonical upstream');
  });

  it('honors a deliberate origin target for a plan-only task', async () => {
    getAppWorkTracker.mockResolvedValue({ resolved: 'github' });
    resolveManagedAppIssueTarget.mockResolvedValue({
      role: 'origin', fullName: 'example-owner/example-app', repoSpec: 'github.com/example-owner/example-app',
    });

    const res = await request(buildApp())
      .post('/api/cos/tasks')
      .send({ description: 'plan the change', app: 'forked-app', planOnly: true, issueTarget: 'origin' });

    expect(res.status).toBe(200);
    expect(resolveManagedAppIssueTarget).toHaveBeenCalledWith(expect.anything(), 'origin');
    expect(cos.addTask.mock.calls[0][0].prompt).toContain('configured origin');
  });
});

describe('PUT /api/cos/tasks/:id — targetInstanceId (#4520)', () => {
  const metadataOf = () => cos.updateTask.mock.calls[0][1].metadata;

  it('re-pins a task to a known instance', async () => {
    const res = await request(buildApp()).put('/api/cos/tasks/task-1').send({ targetInstanceId: PEER });
    expect(res.status).toBe(200);
    expect(metadataOf()).toEqual({ targetInstanceId: PEER });
  });

  it('clears the pin on an explicit null — the metadata key is dropped by the store', async () => {
    const res = await request(buildApp()).put('/api/cos/tasks/task-1').send({ targetInstanceId: null });
    expect(res.status).toBe(200);
    expect(metadataOf()).toHaveProperty('targetInstanceId', undefined);
  });

  it('treats the picker\'s empty value as the same explicit clear', async () => {
    const res = await request(buildApp()).put('/api/cos/tasks/task-1').send({ targetInstanceId: '' });
    expect(res.status).toBe(200);
    expect(metadataOf()).toHaveProperty('targetInstanceId', undefined);
  });

  it('leaves the pin untouched when the field is absent from the patch', async () => {
    const res = await request(buildApp()).put('/api/cos/tasks/task-1').send({ description: 'new title' });
    expect(res.status).toBe(200);
    expect(cos.updateTask.mock.calls[0][1].metadata).toBeUndefined();
  });

  it('rejects a re-pin to an unknown instance without writing anything', async () => {
    const res = await request(buildApp()).put('/api/cos/tasks/task-1').send({ targetInstanceId: 'ghost-instance-id' });
    expect(res.status).toBe(400);
    expect(cos.updateTask).not.toHaveBeenCalled();
  });

  it('keeps the blocked reason alongside a pin change rather than overwriting it', async () => {
    const res = await request(buildApp())
      .put('/api/cos/tasks/task-1')
      .send({ status: 'blocked', blockedReason: 'waiting on hardware', targetInstanceId: PEER });
    expect(res.status).toBe(200);
    expect(metadataOf()).toEqual({ targetInstanceId: PEER, blocker: 'waiting on hardware' });
  });
});


// ── Operator-action ledger (#5594) ──────────────────────────────────────────
describe('CoS task routes write operator-action rows (#5594)', () => {
  const onlyType = async (type) => (await listUserActions({ type }));

  it('records cos.task.create with the run settings, a truncated prompt, and no secret value', async () => {
    const prompt = `render the shot ${'x'.repeat(5000)}`;
    const res = await request(buildApp())
      .post('/api/cos/tasks')
      .send({
        description: 'Render the opening shot',
        prompt,
        provider: 'claude',
        model: 'opus',
        effort: 'high',
        app: 'portos-default',
        useWorktree: true,
        openPR: true,
        // `diagnostics` is the one create field with an open shape
        // (cosTaskDiagnosticsSchema passthrough), so a credential-shaped key
        // genuinely survives validation and reaches the recorder here.
        diagnostics: { category: 'render', apiKey: 'sk-EXAMPLE-not-a-real-key' },
      });

    expect(res.status).toBe(200);
    const [event] = await onlyType('cos.task.create');
    expect(event).toMatchObject({
      actor: 'user',
      target: 'task-1',
      success: true,
      dedupeKey: 'cos.task.create:task-1',
      source: { route: '/api/cos/tasks', method: 'POST' },
    });
    expect(event.payload).toMatchObject({
      taskId: 'task-1',
      provider: 'claude',
      model: 'opus',
      effort: 'high',
      app: 'portos-default',
      useWorktree: true,
      openPR: true,
    });
    expect(event.payload.prompt.length).toBeLessThan(prompt.length);
    expect(event.payload.truncated).toBe(true);
    expect(event.payload.redactedKeys).toEqual(['diagnostics.apiKey']);
    expect(JSON.stringify(event)).not.toContain('sk-EXAMPLE-not-a-real-key');
  });

  it('records nothing when the create is refused as a duplicate', async () => {
    cos.addTask.mockResolvedValueOnce({ id: 'task-1', duplicate: true, status: 'pending' });
    const res = await request(buildApp()).post('/api/cos/tasks').send({ description: 'Render the opening shot' });
    expect(res.status).toBe(409);
    expect(await listUserActions()).toEqual([]);
  });

  it('records cos.task.update with only the fields that changed', async () => {
    const res = await request(buildApp())
      .put('/api/cos/tasks/task-1')
      .send({ priority: 'HIGH', model: 'sonnet' });

    expect(res.status).toBe(200);
    const [event] = await onlyType('cos.task.update');
    expect(event).toMatchObject({ actor: 'user', target: 'task-1' });
    expect(event.payload).toEqual({ taskId: 'task-1', priority: 'HIGH', model: 'sonnet' });
    // Updates are not idempotent retries — the key carries the timestamp.
    expect(event.dedupeKey).toBe(`cos.task.update:task-1:${event.happenedAt}`);
  });

  it('records cos.task.delete with the description the task had before it was removed', async () => {
    cos.getTaskById.mockResolvedValue({ id: 'task-1', description: 'Render the opening shot' });
    cos.deleteTask.mockResolvedValue({ success: true, taskId: 'task-1' });

    const res = await request(buildApp()).delete('/api/cos/tasks/task-1');

    expect(res.status).toBe(200);
    const [event] = await onlyType('cos.task.delete');
    expect(event.payload).toEqual({ taskId: 'task-1', description: 'Render the opening shot' });
    expect(event.dedupeKey).toBe('cos.task.delete:task-1');
  });

  it('records cos.task.approve and cos.task.spawn', async () => {
    cos.approveTask.mockResolvedValue({ id: 'sys-1', description: 'Nightly sweep' });
    cos.forceSpawnTask.mockResolvedValue({ success: true });

    expect((await request(buildApp()).post('/api/cos/tasks/sys-1/approve')).status).toBe(200);
    expect((await request(buildApp()).post('/api/cos/tasks/sys-1/spawn')).status).toBe(200);

    const [approve] = await onlyType('cos.task.approve');
    expect(approve).toMatchObject({ target: 'sys-1', dedupeKey: 'cos.task.approve:sys-1' });
    const [spawn] = await onlyType('cos.task.spawn');
    expect(spawn.dedupeKey).toBe(`cos.task.spawn:sys-1:${spawn.happenedAt}`);
  });

  it('records nothing when the mutation itself failed', async () => {
    cos.updateTask.mockResolvedValueOnce({ error: 'Task not found' });
    expect((await request(buildApp()).put('/api/cos/tasks/ghost').send({ priority: 'HIGH' })).status).toBe(404);
    expect(await listUserActions()).toEqual([]);
  });
});

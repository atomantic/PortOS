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
  getAgents: vi.fn(),
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
vi.mock('../services/goalFidelityCalibration.js', () => ({ reportGoalFidelityFalsePositive: vi.fn() }));

import * as cos from '../services/cos.js';
import { getAssignableInstances } from '../services/instances.js';
import { getAppById, getAppWorkTracker } from '../services/apps.js';
import { resolveManagedAppIssueTarget } from '../services/managedAppRepositories.js';
import cosTaskRoutes from './cosTaskRoutes.js';
import { listUserActions } from '../services/userActions.js';
import { __resetInvestigationCircuit } from '../services/investigationTaskProducer.js';
import { clientInvestigationFingerprint } from '../lib/investigationTasks.js';
import { reportGoalFidelityFalsePositive } from '../services/goalFidelityCalibration.js';

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
  cos.getAllTasks.mockResolvedValue({ user: { tasks: [] }, cos: { tasks: [] } });
  cos.getAgents.mockResolvedValue([]);
  // The producer's storm counter is module state shared across this file's cases.
  __resetInvestigationCircuit();
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

describe('CoS task routes — orchestration profiles (#5992)', () => {
  const PROFILE = { architect: { provider: 'claude-code', model: 'opus', effort: 'xhigh' }, implementer: { model: 'haiku' } };

  it('passes the mode + profile through to addTask', async () => {
    const res = await request(buildApp())
      .post('/api/cos/tasks')
      .send({ description: 'refactor the resolver', orchestrationMode: 'orchestrated', orchestrationProfile: PROFILE });
    expect(res.status).toBe(200);
    expect(cos.addTask).toHaveBeenCalledWith(
      expect.objectContaining({ orchestrationMode: 'orchestrated', orchestrationProfile: PROFILE }),
      'user'
    );
  });

  it('rejects an unknown role rather than persisting an assignment nothing reads', async () => {
    const res = await request(buildApp())
      .post('/api/cos/tasks')
      .send({ description: 'x', orchestrationProfile: { saboteur: { model: 'evil' } } });
    expect(res.status).toBe(400);
    expect(cos.addTask).not.toHaveBeenCalled();
  });

  it('rejects an effort rung outside the supported ladder', async () => {
    const res = await request(buildApp())
      .post('/api/cos/tasks')
      .send({ description: 'x', orchestrationProfile: { architect: { effort: 'galaxy-brain' } } });
    expect(res.status).toBe(400);
  });

  it('re-pins and clears the mode on update', async () => {
    const app = buildApp();
    const flip = await request(app).put('/api/cos/tasks/task-1').send({ orchestrationMode: 'orchestrated' });
    expect(flip.status).toBe(200);
    expect(cos.updateTask.mock.calls[0][1]).toHaveProperty('orchestrationMode', 'orchestrated');

    cos.updateTask.mockClear();
    const clear = await request(app).put('/api/cos/tasks/task-1').send({ orchestrationMode: '' });
    expect(clear.status).toBe(200);
    expect(cos.updateTask.mock.calls[0][1]).toHaveProperty('orchestrationMode', null);
  });

  it('leaves the pins untouched when the patch omits them', async () => {
    const res = await request(buildApp()).put('/api/cos/tasks/task-1').send({ description: 'new title' });
    expect(res.status).toBe(200);
    expect(cos.updateTask.mock.calls[0][1]).not.toHaveProperty('orchestrationMode');
    expect(cos.updateTask.mock.calls[0][1]).not.toHaveProperty('orchestrationProfile');
  });
});

describe('POST /api/cos/tasks — client-queued investigations (#6043)', () => {
  const INSTALL_FAILURE = 'Fix Example Runtime installer failure at the download stage';

  it('files through the investigation producer with the markers the shared machinery reads', async () => {
    const res = await request(buildApp())
      .post('/api/cos/tasks')
      .send({ description: INSTALL_FAILURE, isInvestigation: true });

    expect(res.status).toBe(200);
    expect(cos.addTask).toHaveBeenCalledWith(expect.objectContaining({
      description: INSTALL_FAILURE,
      // Recognized by isInvestigationTask() — which is also the meta-cascade
      // guard, so a failure of THIS task cannot file an investigation of itself.
      isInvestigation: true,
      // Server-derived: the request named no fingerprint.
      investigationFingerprint: clientInvestigationFingerprint({ description: INSTALL_FAILURE }),
    }), 'user');
  });

  it('applies the review-then-merge delivery posture rather than the unattended merge-on-green', async () => {
    await request(buildApp())
      .post('/api/cos/tasks')
      .send({ description: INSTALL_FAILURE, isInvestigation: true });

    expect(cos.addTask).toHaveBeenCalledWith(expect.objectContaining({
      useWorktree: true,
      openPR: true,
      prCompletion: 'review-then-merge',
      noChangeSuccess: true,
    }), 'user');
  });

  it('ignores a client-supplied fingerprint, so a client cannot collide with an auto-filed investigation', async () => {
    await request(buildApp())
      .post('/api/cos/tasks')
      .send({
        description: INSTALL_FAILURE,
        isInvestigation: true,
        investigationFingerprint: 'auth-error:provider-failure:Example CLI',
      });

    const filed = cos.addTask.mock.calls[0][0];
    expect(filed.investigationFingerprint).toBe(clientInvestigationFingerprint({ description: INSTALL_FAILURE }));
    expect(filed.investigationFingerprint).not.toBe('auth-error:provider-failure:Example CLI');
  });

  it('gives two different install failures different dedup keys, and the same failure one key', async () => {
    const app = buildApp();
    await request(app).post('/api/cos/tasks').send({ description: INSTALL_FAILURE, isInvestigation: true });
    await request(app).post('/api/cos/tasks').send({ description: 'Fix Other Runtime installer failure', isInvestigation: true });

    const [first, second] = cos.addTask.mock.calls.map(call => call[0].investigationFingerprint);
    expect(first).not.toBe(second);
    expect(clientInvestigationFingerprint({ description: INSTALL_FAILURE })).toBe(first);
  });

  it('leaves an ordinary task untouched by the investigation path', async () => {
    await request(buildApp()).post('/api/cos/tasks').send({ description: 'Render the opening shot' });
    const filed = cos.addTask.mock.calls[0][0];
    expect(filed).not.toHaveProperty('isInvestigation');
    expect(filed).not.toHaveProperty('investigationFingerprint');
  });

  it('records the posture it actually filed with in the operator ledger, not just the submitted fields', async () => {
    await request(buildApp())
      .post('/api/cos/tasks')
      .send({ description: INSTALL_FAILURE, isInvestigation: true });

    const [event] = await listUserActions({ type: 'cos.task.create' });
    expect(event.payload).toMatchObject({
      isInvestigation: true,
      useWorktree: true,
      openPR: true,
      prCompletion: 'review-then-merge',
      noChangeSuccess: true,
    });
  });

  it('still reports the store duplicate as a 409 so the button can say the task already exists', async () => {
    cos.addTask.mockResolvedValue({ id: 'task-1', status: 'pending', duplicate: true });
    const res = await request(buildApp())
      .post('/api/cos/tasks')
      .send({ description: INSTALL_FAILURE, isInvestigation: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_TASK');
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

// An agent registers as `running` a beat before `spawnAgentForTask` flips its
// task off `pending`, so every consumer that counted `grouped.pending` raw
// reported the one task already being worked as queued too — "1 pending and 1
// active" for a queue of one. The route settles that once, here, so no consumer
// has to know the window exists.
describe('GET /api/cos/tasks — the spawn window (lib/cosSpawnWindow.js)', () => {
  const live = (taskId) => ({ id: `agent-${taskId}`, taskId, status: 'running', startedAt: new Date().toISOString() });
  const source = () => ({
    tasks: [{ id: 'user/42', status: 'pending' }, { id: 'user/43', status: 'pending' }],
    grouped: { pending: [{ id: 'user/42', status: 'pending' }, { id: 'user/43', status: 'pending' }], in_progress: [] },
  });

  beforeEach(() => {
    cos.getAllTasks.mockResolvedValue({ user: source(), cos: { tasks: [], grouped: { pending: [], in_progress: [] } } });
  });

  it('regroups a task its agent already holds and stamps it spawning', async () => {
    cos.getAgents.mockResolvedValue([live('user/42')]);

    const res = await request(buildApp()).get('/api/cos/tasks');

    expect(res.status).toBe(200);
    expect(res.body.user.grouped.pending.map((t) => t.id)).toEqual(['user/43']);
    expect(res.body.user.grouped.in_progress.map((t) => t.id)).toEqual(['user/42']);
    // `status` stays the persisted truth — a client may PATCH against it, and the
    // row renders its mid-spawn state from `spawning`.
    expect(res.body.user.tasks.find((t) => t.id === 'user/42')).toMatchObject({ status: 'pending', spawning: true });
  });

  it('leaves the queue alone when the agent list cannot be read', async () => {
    // Over-reporting the queue is the safe direction: a failed probe may not be
    // what hides a task the user is waiting on.
    cos.getAgents.mockRejectedValue(new Error('state unreadable'));

    const res = await request(buildApp()).get('/api/cos/tasks');

    expect(res.status).toBe(200);
    expect(res.body.user.grouped.pending.map((t) => t.id)).toEqual(['user/42', 'user/43']);
  });
});

// The agent-facing half of the calibration loop (`lib/goalFidelityCalibration.js`).
// A follow-up investigator that overturned a fidelity finding POSTs here; the
// route's whole job is to keep the gap vocabulary honest and to never turn a
// queue decision into an error the reporting agent would try to recover from.
describe('POST /api/cos/goal-fidelity/false-positive', () => {
  const post = (body) => request(buildApp()).post('/api/cos/goal-fidelity/false-positive').send(body);

  it('passes a well-formed report through and answers with what was queued', async () => {
    reportGoalFidelityFalsePositive.mockResolvedValue({ queued: true, gap: 'rubric-gap', taskId: 'calib-1' });
    const res = await post({ gap: 'rubric-gap', detail: 'A supporting change read as unrequested.', taskId: 'task-7' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ queued: true, taskId: 'calib-1' });
    expect(reportGoalFidelityFalsePositive).toHaveBeenCalledWith(
      expect.objectContaining({ gap: 'rubric-gap', taskId: 'task-7' }),
    );
  });

  // The gap is a BOUNDED STRING here, not the enum: a report costs an agent an
  // investigation, and `normalizeGoalFidelityContextGap` folds a near-miss onto
  // `other` with the prose diagnosis intact. Rejecting here would throw the
  // expensive part away over a word.
  it('accepts a gap outside the vocabulary and lets the service fold it', async () => {
    reportGoalFidelityFalsePositive.mockResolvedValue({ queued: true, gap: 'other', taskId: 'calib-1' });
    const res = await post({ gap: 'the-model-was-confused', detail: 'the cap was already on main' });
    expect(res.status).toBe(200);
    expect(reportGoalFidelityFalsePositive).toHaveBeenCalledWith(
      expect.objectContaining({ gap: 'the-model-was-confused' }),
    );
  });

  it('still requires a gap — a report naming no missing context cannot be keyed at all', async () => {
    expect((await post({ detail: 'it was wrong' })).status).toBe(400);
    expect(reportGoalFidelityFalsePositive).not.toHaveBeenCalled();
  });

  // A refusal is an outcome, not an error: the reporting agent cannot fix a
  // disabled gate or an open circuit breaker, and a 4xx would send it into a
  // retry loop over a decision it does not own.
  it('answers 200 with the reason when the calibration was not queued', async () => {
    reportGoalFidelityFalsePositive.mockResolvedValue({ queued: false, gap: 'other', reason: 'the goal-fidelity gate is disabled on this install' });
    const res = await post({ gap: 'other' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ queued: false, reason: expect.stringContaining('disabled') });
  });
});

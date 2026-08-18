/**
 * Route-level tests for the CoS task create/update endpoints, focused on the
 * federated instance pin (#4520): the pin must survive to the store on create,
 * be re-settable and CLEARABLE on update, and be refused when it names an
 * instance this install doesn't know — a pin nothing matches would leave the
 * task pending on every peer forever.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

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
}));
vi.mock('../services/taskWatcher.js', () => ({ refreshTasks: vi.fn() }));
vi.mock('../services/taskEnhancer.js', () => ({ enhanceTaskPrompt: vi.fn() }));
vi.mock('../services/cosTaskGenerator.js', () => ({
  buildClaimWorkTask: vi.fn(),
  buildJiraTicketTask: vi.fn(),
}));
vi.mock('../services/apps.js', () => ({ getAppById: vi.fn() }));
vi.mock('../services/streamingDetect.js', () => ({ NON_PM2_TYPES: new Set() }));
vi.mock('../services/instances.js', () => ({ getAssignableInstances: vi.fn() }));

import * as cos from '../services/cos.js';
import { getAssignableInstances } from '../services/instances.js';
import cosTaskRoutes from './cosTaskRoutes.js';

const SELF = 'self-instance-id';
const PEER = 'peer-instance-id';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cos', cosTaskRoutes);
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  getAssignableInstances.mockResolvedValue([
    { instanceId: SELF, name: 'workstation', isSelf: true },
    { instanceId: PEER, name: 'render-box', isSelf: false },
  ]);
  cos.addTask.mockImplementation(async (taskData) => ({ id: 'task-1', ...taskData }));
  cos.updateTask.mockResolvedValue({ id: 'task-1' });
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

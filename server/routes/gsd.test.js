import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';

const mocks = vi.hoisted(() => ({
  activeApps: [],
  addTask: vi.fn(),
  atomicWrite: vi.fn(),
  generateConcernTasks: vi.fn(),
  getGsdProject: vi.fn(),
  getStatus: vi.fn(),
  stageFiles: vi.fn(),
  commit: vi.fn(),
}));

vi.mock('../services/apps.js', () => ({
  getActiveApps: vi.fn(async () => mocks.activeApps),
}));

vi.mock('../services/cos.js', () => ({
  addTask: mocks.addTask,
}));

vi.mock('../services/gsdService.js', () => ({
  generateConcernTasks: mocks.generateConcernTasks,
  getGsdProject: mocks.getGsdProject,
  getGsdPendingActions: vi.fn(),
  scanForGsdProjects: vi.fn(),
}));

vi.mock('../services/git.js', () => ({
  stageFiles: mocks.stageFiles,
  getStatus: mocks.getStatus,
  commit: mocks.commit,
}));

vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  atomicWrite: mocks.atomicWrite,
}));

import gsdRoutes from './gsd.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/cos/gsd', gsdRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('GSD routes', () => {
  let app;
  let repoPath;
  let planningPath;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = makeApp();
    repoPath = await mkdtemp(join(tmpdir(), 'portos-gsd-route-'));
    planningPath = join(repoPath, '.planning');
    await mkdir(planningPath);
    mocks.activeApps = [{ id: 'app-1', name: 'Example App', repoPath }];
    mocks.atomicWrite.mockResolvedValue(undefined);
    mocks.stageFiles.mockResolvedValue(undefined);
    mocks.getStatus.mockResolvedValue({ clean: false });
    mocks.commit.mockResolvedValue({ hash: 'abc1234' });
    mocks.addTask.mockImplementation(async (task) => ({ ...task, id: `task-${task.metadata.gsdConcern || task.metadata.gsdPhase}` }));
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it('reads an allowlisted planning document through the mounted route', async () => {
    await writeFile(join(planningPath, 'PROJECT.md'), '# Project\n');

    const response = await request(app).get('/api/cos/gsd/projects/app-1/documents/PROJECT.md');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ filename: 'PROJECT.md', content: '# Project\n' });
  });

  it('rejects unallowlisted and traversal document names before side effects', async () => {
    const unallowlisted = await request(app)
      .put('/api/cos/gsd/projects/app-1/documents/NOTES.md')
      .send({ content: 'nope' });
    const traversal = await request(app)
      .put('/api/cos/gsd/projects/app-1/documents/%2E%2E%2FPROJECT.md')
      .send({ content: 'nope' });

    expect(unallowlisted.status).toBe(400);
    expect(unallowlisted.body.code).toBe('INVALID_DOCUMENT');
    expect(traversal.status).toBe(400);
    expect(traversal.body.code).toBe('INVALID_DOCUMENT');
    expect(mocks.atomicWrite).not.toHaveBeenCalled();
    expect(mocks.stageFiles).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown app', false],
    ['an app without a planning directory', true],
  ])('returns 404 for %s', async (_label, appExists) => {
    mocks.activeApps = appExists
      ? [{ id: 'app-1', name: 'Example App', repoPath: join(repoPath, 'missing-app') }]
      : [];

    const response = await request(app).get('/api/cos/gsd/projects/app-1/documents/PROJECT.md');

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('GSD_PROJECT_NOT_FOUND');
  });

  it('writes, stages, and commits a document with the caller message', async () => {
    await writeFile(join(planningPath, 'STATE.md'), '# Previous\n');

    const response = await request(app)
      .put('/api/cos/gsd/projects/app-1/documents/STATE.md')
      .send({ content: '# Current\n', commitMessage: 'docs: refresh planning state' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, hash: 'abc1234', created: false });
    expect(mocks.atomicWrite).toHaveBeenCalledWith(join(planningPath, 'STATE.md'), '# Current\n');
    expect(mocks.stageFiles).toHaveBeenCalledWith(repoPath, ['.planning/STATE.md']);
    expect(mocks.commit).toHaveBeenCalledWith(repoPath, 'docs: refresh planning state');
  });

  it('uses the default commit message for a newly created document', async () => {
    const response = await request(app)
      .put('/api/cos/gsd/projects/app-1/documents/MILESTONES.md')
      .send({ content: '# Milestones\n' });

    expect(response.status).toBe(200);
    expect(response.body.created).toBe(true);
    expect(mocks.commit).toHaveBeenCalledWith(
      repoPath,
      'docs: update .planning/MILESTONES.md via PortOS',
    );
  });

  it('reports a clean staged document as a no-op without committing', async () => {
    mocks.getStatus.mockResolvedValue({ clean: true });

    const response = await request(app)
      .put('/api/cos/gsd/projects/app-1/documents/ROADMAP.md')
      .send({ content: '# Roadmap\n' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, noChanges: true });
    expect(mocks.atomicWrite).toHaveBeenCalledOnce();
    expect(mocks.stageFiles).toHaveBeenCalledWith(repoPath, ['.planning/ROADMAP.md']);
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('creates selected concern tasks with their service-mapped priorities', async () => {
    const low = { description: 'Low concern', priority: 'LOW', metadata: { gsdConcern: 'c-low' } };
    const high = { description: 'High concern', priority: 'HIGH', metadata: { gsdConcern: 'c-high' } };
    mocks.generateConcernTasks.mockResolvedValue([low, high]);

    const response = await request(app)
      .post('/api/cos/gsd/projects/app-1/concerns/tasks')
      .send({ concernIds: ['c-high'] });

    expect(response.status).toBe(200);
    expect(response.body.created).toBe(1);
    expect(mocks.addTask).toHaveBeenCalledOnce();
    expect(mocks.addTask).toHaveBeenCalledWith(high, 'internal');
  });

  it.each([
    ['plan', 'Run /gsd:plan-phase to create a detailed plan for phase 2'],
    ['execute', 'Run /gsd:execute-phase to execute phase 2'],
    ['verify', 'Run /gsd:verify-work to verify phase 2 implementation'],
  ])('creates the %s phase task through CoS', async (action, description) => {
    mocks.getGsdProject.mockResolvedValue({ phases: [{ id: '2' }] });

    const response = await request(app)
      .post('/api/cos/gsd/projects/app-1/phases/2/action')
      .send({ action });

    expect(response.status).toBe(200);
    expect(mocks.addTask).toHaveBeenCalledWith({
      description,
      app: 'app-1',
      priority: 'MEDIUM',
      metadata: { gsdPhase: '2', gsdAction: action },
    }, 'internal');
  });
});

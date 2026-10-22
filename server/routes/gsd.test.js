import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';

const mocks = vi.hoisted(() => ({
  activeApps: [],
  authEnabled: false,
  addTask: vi.fn(),
  atomicWrite: vi.fn(),
  generateConcernTasks: vi.fn(),
  getGsdProject: vi.fn(),
  getStatus: vi.fn(),
  stageFiles: vi.fn(),
  commit: vi.fn(),
}));

// Credential verification is already covered by authGate.test.js; these fixtures
// represent its verified human-cookie and delegated-agent bearer identities.
vi.mock('../services/auth.js', () => ({
  isAuthEnabled: async () => mocks.authEnabled,
  verifyPassword: async () => false,
  verifyRequestSession: async (req) => req.headers.cookie === 'portos_auth=synthetic-human'
    || req.headers.authorization === 'Bearer synthetic-agent',
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: async () => ({}),
}));
vi.mock('../services/instanceIdentity.js', () => ({ loadData: async () => ({ peers: [] }) }));
vi.mock('../lib/securityAuditLog.js', () => ({ logSecurityEvent: vi.fn() }));

vi.mock('../services/apps.js', () => ({
  getActiveApps: vi.fn(async () => mocks.activeApps),
}));

vi.mock('../services/cosTaskStore.js', () => ({
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
import { authGate, hostControlRouteGate } from '../services/authGate.js';

function makeApp(address = '127.0.0.1') {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
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
    mocks.getGsdProject.mockReset();
    mocks.authEnabled = false;
    app = makeApp();
    repoPath = await realpath(await mkdtemp(join(tmpdir(), 'portos-gsd-route-')));
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

  it.each(['leaf', 'directory'])('refuses a repository-controlled %s symlink before reading or writing outside', async (kind) => {
    const outside = await mkdtemp(join(tmpdir(), 'portos-gsd-outside-'));
    try {
      const secret = join(outside, 'PROJECT.md');
      await writeFile(secret, 'synthetic private content');
      if (kind === 'directory') {
        await rm(planningPath, { recursive: true });
        await symlink(outside, planningPath, 'junction');
      } else {
        await symlink(secret, join(planningPath, 'PROJECT.md'));
      }
      const url = '/api/cos/gsd/projects/app-1/documents/PROJECT.md';
      const read = await request(makeApp('192.0.2.10')).get(url);
      const write = await request(app).put(url).send({ content: 'replacement' });
      expect(read.status).toBe(400);
      expect(read.body.code).toBe('PATH_TRAVERSAL');
      expect(write.status).toBe(400);
      expect(write.body.code).toBe('PATH_TRAVERSAL');
      expect(mocks.atomicWrite).not.toHaveBeenCalled();
      expect(mocks.stageFiles).not.toHaveBeenCalled();
      expect(await readFile(secret, 'utf8')).toBe('synthetic private content');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it.each(['PROJECT.md', 'config.json', 'phases/01/01-PLAN.md', 'phases'])('contains project-detail reads of %s through the real GSD service', async (relativePath) => {
    const outside = await mkdtemp(join(tmpdir(), 'portos-gsd-detail-'));
    try {
      const target = join(outside, 'private.txt');
      await writeFile(target, 'synthetic private content');
      await mkdir(join(planningPath, 'phases', '01'), { recursive: true });
      if (relativePath === 'phases') {
        await rm(join(planningPath, 'phases'), { recursive: true });
        await symlink(outside, join(planningPath, 'phases'), 'junction');
      } else {
        await symlink(target, join(planningPath, relativePath));
      }
      const service = await vi.importActual('../services/gsdService.js');
      mocks.getGsdProject.mockImplementation(service.getGsdProject);
      mocks.activeApps[0].id = repoPath.split(/[\\/]/).pop(); // Unique cache key for this synthetic project.
      const response = await request(app).get(`/api/cos/gsd/projects/${encodeURIComponent(mocks.activeApps[0].id)}`);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('PATH_TRAVERSAL');
      expect(JSON.stringify(response.body)).not.toContain('synthetic private content');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reads a regular project and nested phase through a symlinked configured repository root', async () => {
    const alias = join(repoPath, 'repo-alias');
    await symlink(repoPath, alias, 'junction');
    mocks.activeApps[0].repoPath = alias;
    mocks.activeApps[0].id = repoPath.split(/[\\/]/).pop();
    await writeFile(join(planningPath, 'PROJECT.md'), '# Synthetic Project');
    await mkdir(join(planningPath, 'phases', '01'), { recursive: true });
    await writeFile(join(planningPath, 'phases', '01', '01-PLAN.md'), '- [ ] Synthetic task');
    const service = await vi.importActual('../services/gsdService.js');
    mocks.getGsdProject.mockImplementation(service.getGsdProject);
    const response = await request(app).get(`/api/cos/gsd/projects/${encodeURIComponent(mocks.activeApps[0].id)}`);
    expect(response.status).toBe(200);
    expect(response.body.projectDoc.raw).toBe('# Synthetic Project');
    expect(response.body.phases[0].plans[0].tasks).toEqual([{ completed: false, text: 'Synthetic task' }]);
  });

  it('preserves verified human and agent writes while refusing anonymous remote writes', async () => {
    const remote = makeApp('192.0.2.10');
    const url = '/api/cos/gsd/projects/app-1/documents/STATE.md';
    expect((await request(remote).put(url).send({ content: 'blocked' })).status).toBe(403);
    expect(mocks.atomicWrite).not.toHaveBeenCalled();
    mocks.authEnabled = true;
    for (const [header, value] of [
      ['Cookie', 'portos_auth=synthetic-human'],
      ['Authorization', 'Bearer synthetic-agent'],
    ]) {
      const response = await request(remote).put(url).set(header, value).send({ content: '# Authorized' });
      expect(response.status).toBe(200);
    }
    expect(mocks.atomicWrite).toHaveBeenCalledTimes(2);
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

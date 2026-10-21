import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { evaluateDockerEngine } from '../services/dockerEngine.js';

const gate = vi.hoisted(() => ({ enabled: false, settings: {}, resolveEngine: null, spawn: null }));
vi.mock('../services/instanceFeatures.js', () => ({ isInstanceFeatureEnabled: vi.fn(async () => gate.enabled) }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => gate.settings) }));
vi.mock('../services/dockerEngine.js', async (importOriginal) => ({
  ...await importOriginal(),
  resolveDockerEngine: vi.fn(async () => gate.resolveEngine()),
}));
vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal(), spawn: (...args) => gate.spawn(...args) }));

const { default: router } = await import('./dockerContainment.js');
const app = express();
app.use(express.json());
app.use('/api/docker-containment', router);
app.use(errorMiddleware);

const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'portos-contained-route-')));
afterAll(() => rmSync(worktree, { recursive: true, force: true }));

beforeEach(() => {
  gate.enabled = false;
  gate.settings = {};
  gate.resolveEngine = vi.fn(() => { throw new Error('Docker must not be consulted'); });
  gate.spawn = vi.fn(() => { throw new Error('nothing may be spawned'); });
});

describe('Docker containment routes', () => {
  it('answers status and refuses runs without a single Docker call while the feature is off', async () => {
    const status = await request(app).get('/api/docker-containment/status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ enabled: false, state: 'disabled', ready: false });
    const run = await request(app).post('/api/docker-containment/run').send({ worktree, phase: 'validate', command: 'npm test' });
    expect(run.status).toBe(409);
    expect(run.body).toMatchObject({ status: 'refused', code: 'CONTAINMENT_UNAVAILABLE', state: 'disabled', contained: false });
    expect(gate.resolveEngine).not.toHaveBeenCalled();
    expect(gate.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', () => evaluateDockerEngine({ installed: false })],
    ['stopped', () => evaluateDockerEngine({ installed: true, candidates: [{ name: 'default', current: true, endpoint: 'unix:///var/run/docker.sock' }],
      probes: [{ candidate: { name: 'default' }, docker: { running: false, error: 'Cannot connect to the Docker daemon' } }] })],
    ['remote', () => evaluateDockerEngine({ installed: true, candidates: [{ name: 'build-box', current: true, endpoint: 'ssh://builder@example.com' }], probes: [] })],
  ])('refuses a run with the resolver reason when Docker is %s, executing nothing', async (_label, engine) => {
    gate.enabled = true;
    gate.resolveEngine = vi.fn(engine);
    const res = await request(app).post('/api/docker-containment/run').send({ worktree, phase: 'install', command: 'npm ci' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ status: 'refused', code: 'CONTAINMENT_UNAVAILABLE', reason: engine().message, contained: false });
    expect(gate.spawn).not.toHaveBeenCalled();
  });

  it('validates the run body', async () => {
    gate.enabled = true;
    const res = await request(app).post('/api/docker-containment/run').send({ worktree: 'relative/path', phase: 'build', command: '' });
    expect(res.status).toBe(400);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const gate = vi.hoisted(() => ({ enabled: false, settings: {}, resolveEngine: null, spawn: null }));
vi.mock('../services/instanceFeatures.js', () => ({ isInstanceFeatureEnabled: vi.fn(async () => gate.enabled) }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => gate.settings) }));
vi.mock('../services/dockerEngine.js', async (importOriginal) => ({
  ...await importOriginal(),
  resolveDockerEngine: vi.fn(async () => gate.resolveEngine()),
}));
vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal(), spawn: (...args) => gate.spawn(...args) }));

const { default: router } = await import('./dockerContainment.js');
const { resolveDockerEngine } = await vi.importActual('../services/dockerEngine.js');

/** Real resolver verdicts for an absent, a stopped and a remote-only Docker. */
const dockerVerdict = (kind) => {
  if (kind === 'absent') return resolveDockerEngine({ bin: null });
  const endpoint = kind === 'remote' ? 'ssh://builder@example.com' : 'unix:///var/run/docker.sock';
  const createCli = () => ({
    capture: async (args) => (args[0] === 'context'
      ? { success: true, stdout: JSON.stringify({ Name: 'example', Current: true, DockerEndpoint: endpoint }) }
      : { success: false, stdout: '', stderr: 'Cannot connect to the Docker daemon' }),
  });
  return resolveDockerEngine({ bin: '/usr/bin/docker', createCli, env: {}, platform: 'linux' });
};

const app = express();
app.use(express.json());
app.use('/api/docker-containment', router);
app.use(errorMiddleware);

// A literal POSIX path, not a host temp dir: the run schema accepts only absolute POSIX paths,
// so a Windows temp path would fail validation (400) before the gate under test. Every run
// here is refused before the worktree is touched on disk.
const worktree = '/srv/example/worktree';

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

  it.each([['absent', 'docker-missing'], ['stopped', 'docker-stopped'], ['remote', 'docker-remote-refused']])('refuses a run with the resolver reason when Docker is %s, executing nothing', async (kind, state) => {
    gate.enabled = true;
    const verdict = await dockerVerdict(kind);
    expect(verdict.state).toBe(state);
    gate.resolveEngine = vi.fn(() => verdict);
    const res = await request(app).post('/api/docker-containment/run').send({ worktree, phase: 'install', command: 'npm ci' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ status: 'refused', code: 'CONTAINMENT_UNAVAILABLE', reason: verdict.message, contained: false });
    expect(gate.spawn).not.toHaveBeenCalled();
  });

  it('validates the run body', async () => {
    gate.enabled = true;
    const res = await request(app).post('/api/docker-containment/run').send({ worktree: 'relative/path', phase: 'build', command: '' });
    expect(res.status).toBe(400);
  });
});

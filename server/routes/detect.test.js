import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { realpathSync } from 'fs';
import { homedir } from 'os';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';
import detectRoutes from './detect.js';

vi.mock('../services/aiDetect.js', () => ({
  detectAppWithAi: vi.fn()
}));

import { detectAppWithAi } from '../services/aiDetect.js';

describe('Detect Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/detect', detectRoutes);
    app.use(errorMiddleware);
    vi.clearAllMocks();
  });

  it('keeps an expected AI detection refusal as a structured 200 outcome', async () => {
    detectAppWithAi.mockResolvedValue({ success: false, error: 'No AI provider configured' });

    const response = await request(app)
      .post('/api/detect/ai')
      .send({ path: '/example/project' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: false, error: 'No AI provider configured' });
  });

  it('returns the standard error envelope when AI detection throws', async () => {
    detectAppWithAi.mockRejectedValue(new Error('provider crashed'));

    const response = await request(app)
      .post('/api/detect/ai')
      .send({ path: '/example/project' });

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ error: 'provider crashed', code: 'INTERNAL_ERROR' });
    expect(response.body).not.toHaveProperty('success');
  });
});

// A directory that exists on the host but sits OUTSIDE DEFAULT_WORKSPACE_ROOTS,
// so the only thing that can admit it is PORTOS_WORKSPACE_ROOTS. Deliberately not
// a mkdtemp() directory: `tmpdir()` is itself a default root on Linux (/tmp) and
// Windows, so a temp dir is always allowed there and would make the refusal test
// pass only on macOS. realpathSync because macOS's /etc is a symlink to
// /private/etc and the route realpath()s before checking containment.
const OUTSIDE_DEFAULT_ROOTS = realpathSync(
  process.platform === 'win32' ? (process.env.SystemRoot || 'C:\\Windows') : '/etc'
);

// PORTOS_WORKSPACE_ROOTS is read once at module load, so these stub the env and
// re-import a fresh copy of the route graph. The module-registry reset drops the
// hoisted vi.mock above with it, so the AI service is re-mocked per load via
// vi.doMock (which applies to subsequent dynamic imports).
describe('POST /api/detect/ai workspace-root confinement', () => {
  const loadApp = async (workspaceRoots) => {
    vi.resetModules();
    vi.stubEnv('PORTOS_WORKSPACE_ROOTS', workspaceRoots);
    const detect = vi.fn();
    vi.doMock('../services/aiDetect.js', () => ({ detectAppWithAi: detect }));
    const routes = await import('./detect.js');
    const errors = await import('../lib/errorHandler.js');
    const scoped = express();
    scoped.use(express.json());
    scoped.use('/api/detect', routes.default);
    scoped.use(errors.errorMiddleware);
    return { app: scoped, detect };
  };

  afterEach(() => {
    vi.doUnmock('../services/aiDetect.js');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('refuses a path outside the configured roots without invoking the provider', async () => {
    const { app: scoped, detect } = await loadApp(homedir());

    const response = await request(scoped)
      .post('/api/detect/ai')
      .send({ path: OUTSIDE_DEFAULT_ROOTS });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE_ROOTS' });
    // The refusal must not echo the rejected filesystem path back to the caller.
    expect(JSON.stringify(response.body)).not.toContain(OUTSIDE_DEFAULT_ROOTS);
    // The regression this uniquely catches: no file was read and nothing was
    // shipped to a (possibly hosted) AI provider.
    expect(detect).not.toHaveBeenCalled();
  });

  it('allows a path the configured roots admit but the defaults would not', async () => {
    const { app: scoped, detect } = await loadApp(OUTSIDE_DEFAULT_ROOTS);
    detect.mockResolvedValue({ success: true, app: { name: 'example' } });

    const response = await request(scoped)
      .post('/api/detect/ai')
      .send({ path: OUTSIDE_DEFAULT_ROOTS });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, app: { name: 'example' } });
    expect(detect).toHaveBeenCalledWith(OUTSIDE_DEFAULT_ROOTS, undefined);
  });

  it('stays unrestricted when PORTOS_WORKSPACE_ROOTS is unset', async () => {
    const { app: scoped, detect } = await loadApp('');
    detect.mockResolvedValue({ success: true, app: { name: 'example' } });

    const response = await request(scoped)
      .post('/api/detect/ai')
      .send({ path: OUTSIDE_DEFAULT_ROOTS });

    expect(response.status).toBe(200);
    expect(detect).toHaveBeenCalledWith(OUTSIDE_DEFAULT_ROOTS, undefined);
  });
});

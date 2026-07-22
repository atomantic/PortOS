import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { EventEmitter } from 'events';
import { request } from '../lib/testHelper.js';

// --- Mock the filesystem + subprocess boundary so we can assert ZERO
// mutations happen when a request fails validation (issue #2390). ---
vi.mock('../lib/fileUtils.js', () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
  expandHome: (p) => p
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true })
}));

// Parent dir exists; target dir does not (so a valid request proceeds).
vi.mock('fs', () => ({
  existsSync: vi.fn((p) => p === '/tmp/workspace'),
  realpathSync: vi.fn((p) => p)
}));

vi.mock('child_process', () => ({
  exec: vi.fn((cmd, opts, cb) => cb(null, { stdout: '', stderr: '' })),
  spawn: vi.fn(() => {
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    // Resolve the spawn promise on the next tick with a success exit code.
    setImmediate(() => proc.emit('close', 0));
    return proc;
  })
}));

vi.mock('../services/apps.js', () => ({
  createApp: vi.fn().mockResolvedValue({ id: 'app-001', name: 'Test' }),
  getReservedPorts: vi.fn().mockResolvedValue([])
}));

vi.mock('../lib/workspaceRoots.js', () => ({
  isWithinAllowedRoots: vi.fn(() => true)
}));

vi.mock('./scaffoldVite.js', () => ({ scaffoldVite: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./scaffoldExpress.js', () => ({ scaffoldExpress: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./scaffoldIOS.js', () => ({ scaffoldIOS: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./scaffoldXcode.js', () => ({ scaffoldXcode: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./scaffoldPortOS.js', () => ({ scaffoldPortOS: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/xcodeScripts.js', () => ({ toTargetName: vi.fn(() => 'TestApp') }));

import scaffoldRoutes from './scaffold.js';
import { ensureDir } from '../lib/fileUtils.js';
import { writeFile } from 'fs/promises';
import { spawn, exec } from 'child_process';
import { createApp } from '../services/apps.js';
import { scaffoldVite } from './scaffoldVite.js';
import { scaffoldPortOS } from './scaffoldPortOS.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/scaffold', scaffoldRoutes);
  return app;
}

/** Assert that NO filesystem write or subprocess spawn happened. */
function expectZeroMutations() {
  expect(ensureDir).not.toHaveBeenCalled();
  expect(writeFile).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(exec).not.toHaveBeenCalled();
  expect(createApp).not.toHaveBeenCalled();
}

describe('POST /api/scaffold — request validation before filesystem mutation (#2390)', () => {
  let app;

  beforeEach(() => {
    vi.clearAllMocks();
    app = makeApp();
  });

  const validBody = {
    name: 'My App',
    template: 'ios-native',
    parentDir: '/tmp/workspace'
  };

  it('rejects an unknown template with a validation error and zero mutations', async () => {
    const res = await request(app)
      .post('/api/scaffold')
      .send({ ...validBody, template: 'malware-kit' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expectZeroMutations();
  });

  it('rejects an out-of-range uiPort with a validation error and zero mutations', async () => {
    const res = await request(app)
      .post('/api/scaffold')
      .send({ ...validBody, template: 'vite-react', uiPort: 70000 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expectZeroMutations();
  });

  it('rejects a non-integer apiPort with a validation error and zero mutations', async () => {
    const res = await request(app)
      .post('/api/scaffold')
      .send({ ...validBody, template: 'express-api', apiPort: 'not-a-port' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expectZeroMutations();
  });

  it('rejects a malformed name (no alphanumerics) with a validation error and zero mutations', async () => {
    const res = await request(app)
      .post('/api/scaffold')
      .send({ ...validBody, name: '!!!___' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expectZeroMutations();
  });

  it('rejects missing required fields with a validation error and zero mutations', async () => {
    const res = await request(app)
      .post('/api/scaffold')
      .send({ name: 'My App' }); // no template, no parentDir

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expectZeroMutations();
  });

  it('accepts a valid request and only then performs filesystem mutations', async () => {
    const res = await request(app)
      .post('/api/scaffold')
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Validation passed → the route reached the first filesystem mutation
    // (directory creation) and registered the app.
    expect(ensureDir).toHaveBeenCalledWith('/tmp/workspace/my-app');
    expect(createApp).toHaveBeenCalledTimes(1);
  });

  // The scaffolders take a single options object (#2841) — a positional call
  // would silently pass `dirName` as `repoPath` and scaffold into the wrong tree.
  it('dispatches to scaffoldVite with a named-options object', async () => {
    const res = await request(app)
      .post('/api/scaffold')
      .send({ ...validBody, template: 'vite-express', uiPort: 3100, apiPort: 3101 });

    expect(res.status).toBe(200);
    expect(scaffoldVite).toHaveBeenCalledTimes(1);
    expect(scaffoldVite).toHaveBeenCalledWith(expect.objectContaining({
      repoPath: '/tmp/workspace/my-app',
      dirName: 'my-app',
      parentDir: '/tmp/workspace',
      template: 'vite-express',
      uiPort: 3100,
      apiPort: 3101,
      addStep: expect.any(Function)
    }));
  });

  it('dispatches to scaffoldPortOS with a named-options object', async () => {
    const res = await request(app)
      .post('/api/scaffold')
      .send({ ...validBody, template: 'portos-stack', uiPort: 3100, apiPort: 3101 });

    expect(res.status).toBe(200);
    expect(scaffoldPortOS).toHaveBeenCalledWith(expect.objectContaining({
      repoPath: '/tmp/workspace/my-app',
      name: 'My App',
      dirName: 'my-app',
      uiPort: 3100,
      apiPort: 3101,
      addStep: expect.any(Function)
    }));
  });
});

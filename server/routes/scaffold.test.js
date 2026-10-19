import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import express from 'express';
import { request } from '../lib/testHelper.js';

// --- Mock the filesystem + subprocess boundary so we can assert ZERO
// mutations happen when a request fails validation (issue #2390). ---
// PATHS.data is required here too: scaffold.js pulls in lib/validation.js ->
// subscriptionSavings.js -> postStreak.js -> activeDays.js -> timezone.js ->
// services/settings.js, whose module-scope `join(PATHS.data, 'settings.json')`
// throws on load if this mock omits PATHS (#4211 added the activeDays.js edge).
vi.mock('../lib/fileUtils.js', () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
  expandHome: (p) => p,
  PATHS: { data: '/mock/data' }
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  rm: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true })
}));

// Parent dir exists; target dir does not (so a valid request proceeds).
vi.mock('fs', () => ({
  existsSync: vi.fn((p) => p === '/tmp/workspace'),
  realpathSync: vi.fn((p) => p)
}));

vi.mock('../lib/childProcess.js', () => ({
  exec: vi.fn((cmd, opts, cb) => cb(null, { stdout: '', stderr: '' })),
}));

vi.mock('../services/apps.js', () => ({
  createApp: vi.fn().mockResolvedValue({ id: 'app-001', name: 'Test' }),
  getReservedPorts: vi.fn().mockResolvedValue([]),
  notifyAppsChanged: vi.fn()
}));

vi.mock('../lib/workspaceRoots.js', () => ({
  isWithinAllowedRoots: vi.fn(() => true),
  outsideAllowedRootsMessage: vi.fn((realPath, { field = 'path' } = {}) => `${field} is outside allowed directories: ${realPath}`)
}));

vi.mock('./scaffoldVite.js', () => ({ scaffoldVite: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./scaffoldExpress.js', () => ({ scaffoldExpress: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/xcodeScaffold.js', () => ({ scaffoldXcode: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./scaffoldPortOS.js', () => ({ scaffoldPortOS: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/xcodeScripts.js', () => ({ toTargetName: vi.fn(() => 'TestApp') }));

vi.mock('../lib/runCliBounded.js', () => ({
  runCliBounded: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
}));

import scaffoldRoutes from './scaffold.js';
import { ensureDir } from '../lib/fileUtils.js';
import { writeFile, readdir, rm } from 'fs/promises';
import { exec } from '../lib/childProcess.js';
import { runCliBounded } from '../lib/runCliBounded.js';
import { createApp } from '../services/apps.js';
import { scaffoldVite } from './scaffoldVite.js';
import { scaffoldPortOS } from './scaffoldPortOS.js';
import { scaffoldXcode } from '../services/xcodeScaffold.js';

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
  expect(runCliBounded).not.toHaveBeenCalled();
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
    expect(ensureDir).toHaveBeenCalledWith(join('/tmp/workspace', 'my-app'));
    expect(createApp).toHaveBeenCalledTimes(1);
  });

  it('bounds every git stage without prompting or disabling hooks and signing', async () => {
    const res = await request(app).post('/api/scaffold').send(validBody);
    expect(res.status).toBe(200);
    expect(runCliBounded.mock.calls.map(([cmd, args]) => [cmd, args])).toEqual([
      ['git', ['init']], ['git', ['add', '-A']], ['git', ['commit', '-m', 'Initial commit']],
    ]);
    for (const [, , options] of runCliBounded.mock.calls) {
      expect(options).toMatchObject({
        cwd: join('/tmp/workspace', 'my-app'), timeoutMs: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'], env: { GIT_TERMINAL_PROMPT: '0' },
      });
    }
  });

  it.each([0, 2])('rolls back instead of registering an app when git stage %i times out', async (stage) => {
    for (let i = 0; i < stage; i++) runCliBounded.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
    runCliBounded.mockResolvedValueOnce({ code: -1, stdout: '', stderr: 'timed out' });
    const res = await request(app).post('/api/scaffold').send(validBody);
    expect(res.status).toBe(500);
    expect(rm).toHaveBeenCalledWith(join('/tmp/workspace', 'my-app'), { recursive: true, force: true });
    expect(createApp).not.toHaveBeenCalled();
  });

  it('accepts successful GitHub creation even when the CLI prints progress on stderr', async () => {
    runCliBounded.mockImplementation(async (command) => ({
      code: 0, stdout: '', stderr: command === 'gh' ? 'Pushing to remote' : '',
    }));
    const res = await request(app).post('/api/scaffold').send({ ...validBody, createGitHubRepo: true });
    expect(res.status).toBe(200);
    expect(res.body.steps).toContainEqual(expect.objectContaining({ name: 'Create GitHub repo', status: 'done' }));
    runCliBounded.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
  });

  it.each([
    [{ code: 1, stdout: 'Remote creation failed', stderr: '' }, 'Remote creation failed'],
    [{ code: 2, stdout: '', stderr: '' }, 'gh repo create exited with code 2'],
    [{ code: -1, stdout: '', stderr: 'timed out' }, 'timed out'],
    [{ code: 1, stdout: '', stderr: 'Created repository but push failed' }, 'Created repository but push failed'],
  ])('reports failed GitHub creation while preserving the registered local app (%j)', async (failure, detail) => {
    runCliBounded.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce(failure);
    const res = await request(app).post('/api/scaffold').send({ ...validBody, createGitHubRepo: true });
    expect(res.status).toBe(200);
    expect(res.body.steps).toContainEqual(expect.objectContaining({ name: 'Create GitHub repo', status: 'error', error: detail }));
    expect(createApp).toHaveBeenCalledTimes(1);
    expect(rm).not.toHaveBeenCalled();
    expect(runCliBounded).toHaveBeenLastCalledWith('gh',
      ['repo', 'create', 'my-app', '--source=.', '--push', '--private'],
      expect.objectContaining({ timeoutMs: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
        env: expect.objectContaining({ GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }) }));
  });

  // Regression (#9650): a failed scaffold left the directory behind, so a retry
  // with the same name was permanently blocked by DIR_EXISTS.
  it('removes the partial directory on failure so a retry with the same name succeeds', async () => {
    const repoPath = join('/tmp/workspace', 'my-app');
    const onDisk = new Set(['/tmp/workspace']);
    existsSync.mockImplementation((p) => onDisk.has(p));
    ensureDir.mockImplementation(async (p) => { onDisk.add(p); });
    rm.mockImplementation(async (p) => { onDisk.delete(p); });
    scaffoldVite.mockRejectedValueOnce(new Error('npm create failed'));

    const failed = await request(app)
      .post('/api/scaffold')
      .send({ ...validBody, template: 'vite-react', uiPort: 3100 });

    expect(failed.status).toBe(500);
    expect(rm).toHaveBeenCalledWith(repoPath, { recursive: true, force: true });
    expect(createApp).not.toHaveBeenCalled();
    expect(onDisk.has(repoPath)).toBe(false);

    const retry = await request(app)
      .post('/api/scaffold')
      .send({ ...validBody, template: 'vite-react', uiPort: 3100 });

    expect(retry.status).toBe(200);
    expect(createApp).toHaveBeenCalledTimes(1);

    existsSync.mockImplementation((p) => p === '/tmp/workspace');
    ensureDir.mockResolvedValue(undefined);
  });

  it('does not remove the directory when registration already succeeded', async () => {
    const res = await request(app).post('/api/scaffold').send(validBody);
    expect(res.status).toBe(200);
    expect(rm).not.toHaveBeenCalled();
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
      repoPath: join('/tmp/workspace', 'my-app'),
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
      repoPath: join('/tmp/workspace', 'my-app'),
      name: 'My App',
      dirName: 'my-app',
      uiPort: 3100,
      apiPort: 3101,
      addStep: expect.any(Function)
    }));
  });

  it('delegates Xcode project generation to the scaffold service', async () => {
    const res = await request(app)
      .post('/api/scaffold')
      .send({ ...validBody, template: 'xcode-multiplatform' });

    expect(res.status).toBe(200);
    expect(scaffoldXcode).toHaveBeenCalledWith(
      join('/tmp/workspace', 'my-app'),
      'My App',
      'my-app',
      expect.any(Function)
    );
  });

  it('routes the ios-native template to the same service, iOS-only', async () => {
    const res = await request(app)
      .post('/api/scaffold')
      .send({ ...validBody, template: 'ios-native' });

    expect(res.status).toBe(200);
    expect(scaffoldXcode).toHaveBeenCalledWith(
      join('/tmp/workspace', 'my-app'),
      'My App',
      'my-app',
      expect.any(Function),
      { platforms: ['ios'] }
    );
  });
});


describe('GET /api/scaffold/directories', () => {
  it('includes selectable files only when requested, preserving directory-only responses', async () => {
    existsSync.mockImplementation((p) => p === resolve('/tmp/workspace'));
    readdir.mockResolvedValue([
      { name: 'Chromium.app', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
      { name: 'chrome', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
      { name: '.hidden', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
    ]);
    const app = makeApp();
    const folders = await request(app).get('/api/scaffold/directories?path=/tmp/workspace');
    expect(folders.status).toBe(200);
    expect(folders.body).not.toHaveProperty('files');
    const files = await request(app).get('/api/scaffold/directories?path=/tmp/workspace&includeFiles=true');
    expect(files.status).toBe(200);
    expect(files.body.files).toEqual([{ name: 'chrome', path: join(resolve('/tmp/workspace'), 'chrome') }]);
    expect(files.body.directories).toEqual(folders.body.directories);
  });

  it('rejects an includeFiles value that is not a flag before reading the directory', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/scaffold/directories?path=/tmp/workspace&includeFiles=yes');
    expect(res.status).toBe(400);
    expect(readdir).not.toHaveBeenCalled();
  });
});

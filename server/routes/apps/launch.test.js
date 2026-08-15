import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { join } from 'path';
import { request } from '../../lib/testHelper.js';
import launchRoutes from './launch.js';

vi.mock('../../services/apps.js', () => ({
  getAppById: vi.fn(),
  PORTOS_APP_ID: 'portos-default'
}));

vi.mock('../../services/xcodeScripts.js', () => ({
  deriveProjectInfo: vi.fn()
}));

// `pathExists` (shared.js) is the only fs/promises consumer this router hits —
// stub `access` so the test controls which candidate paths "exist" on disk.
vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal()),
  access: vi.fn()
}));

vi.mock('../../lib/childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }))
}));

import * as appsService from '../../services/apps.js';
import { deriveProjectInfo } from '../../services/xcodeScripts.js';
import { access } from 'fs/promises';
import { spawn } from '../../lib/childProcess.js';

const REPO_PATH = '/example/repos/my-client';

/** Make only the listed paths resolve through `pathExists`. */
const existingPaths = (...paths) => {
  const set = new Set(paths);
  access.mockImplementation(async (p) => {
    if (!set.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
};

describe('Apps Launch Routes — POST /:id/open-xcode', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/apps', launchRoutes);
    vi.clearAllMocks();
    appsService.getAppById.mockResolvedValue({
      id: 'app-001',
      name: 'My Client',
      type: 'ios-native',
      repoPath: REPO_PATH
    });
  });

  it('opens the resolved project when the display name differs from the project filename', async () => {
    deriveProjectInfo.mockResolvedValue({ targetName: 'MyClient', bundleId: 'com.example.MyClient' });
    existingPaths(REPO_PATH, join(REPO_PATH, 'MyClient.xcodeproj'));

    const response = await request(app).post('/api/apps/app-001/open-xcode');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, path: join(REPO_PATH, 'MyClient.xcodeproj') });
    expect(deriveProjectInfo).toHaveBeenCalledWith(REPO_PATH, 'My Client');
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      [join(REPO_PATH, 'MyClient.xcodeproj')],
      expect.objectContaining({ detached: true })
    );
  });

  it('prefers an existing .xcworkspace over the .xcodeproj', async () => {
    deriveProjectInfo.mockResolvedValue({ targetName: 'MyClient', bundleId: 'com.example.MyClient' });
    existingPaths(
      REPO_PATH,
      join(REPO_PATH, 'MyClient.xcworkspace'),
      join(REPO_PATH, 'MyClient.xcodeproj')
    );

    const response = await request(app).post('/api/apps/app-001/open-xcode');

    expect(response.status).toBe(200);
    expect(response.body.path).toBe(join(REPO_PATH, 'MyClient.xcworkspace'));
  });

  it('falls back to the SPM manifest for a swift package with no .xcodeproj', async () => {
    deriveProjectInfo.mockResolvedValue({ targetName: 'MyClient', bundleId: 'com.example.MyClient' });
    existingPaths(REPO_PATH, join(REPO_PATH, 'Package.swift'));

    const response = await request(app).post('/api/apps/app-001/open-xcode');

    expect(response.status).toBe(200);
    expect(response.body.path).toBe(join(REPO_PATH, 'Package.swift'));
  });

  it('returns 404 naming every candidate when no project exists', async () => {
    deriveProjectInfo.mockResolvedValue({ targetName: 'MyClient', bundleId: 'com.example.MyClient' });
    existingPaths(REPO_PATH);

    const response = await request(app).post('/api/apps/app-001/open-xcode');

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('XCODE_PROJECT_NOT_FOUND');
    expect(response.body.error).toContain('MyClient.xcodeproj');
    expect(response.body.error).toContain('Package.swift');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns 400 when the repo path is missing', async () => {
    existingPaths();

    const response = await request(app).post('/api/apps/app-001/open-xcode');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('PATH_NOT_FOUND');
    expect(deriveProjectInfo).not.toHaveBeenCalled();
  });

  it('logs a launcher failure instead of letting the unlistened error event kill the process', async () => {
    deriveProjectInfo.mockResolvedValue({ targetName: 'MyClient', bundleId: 'com.example.MyClient' });
    existingPaths(REPO_PATH, join(REPO_PATH, 'MyClient.xcodeproj'));
    const handlers = {};
    spawn.mockReturnValue({ on: (event, fn) => { handlers[event] = fn; }, unref: vi.fn() });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await request(app).post('/api/apps/app-001/open-xcode');

    expect(response.status).toBe(200);
    expect(handlers.error).toBeTypeOf('function');
    handlers.error(new Error('spawn ENOENT'));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('spawn ENOENT'));
    consoleError.mockRestore();
  });

  it('returns 404 when the app does not exist', async () => {
    appsService.getAppById.mockResolvedValue(null);

    const response = await request(app).post('/api/apps/app-999/open-xcode');

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });
});

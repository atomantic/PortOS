import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import lifecycleRoutes from './lifecycle.js';

// Mock the services this router touches. appBuilder is intentionally NOT mocked
// so the build-command validation branch (INVALID_BUILD_COMMAND) runs for real.
vi.mock('../../services/apps.js', () => ({
  getAppById: vi.fn(),
  updateApp: vi.fn(),
  notifyAppsChanged: vi.fn(),
  PORTOS_APP_ID: 'portos-default'
}));

vi.mock('../../services/pm2.js', () => ({
  getAppStatus: vi.fn(),
  startFromEcosystem: vi.fn(),
  startWithCommand: vi.fn(),
  stopApp: vi.fn(),
  restartApp: vi.fn(),
  getLogs: vi.fn()
}));

vi.mock('../../services/history.js', () => ({
  logAction: vi.fn()
}));

vi.mock('../../services/streamingDetect.js', () => ({
  parseEcosystemFromPath: vi.fn(),
  usesPm2: vi.fn((type) => !new Set(['ios-native', 'macos-native', 'xcode', 'swift']).has(type)),
  NON_PM2_TYPES: new Set(['ios-native', 'macos-native', 'xcode', 'swift']),
  isDesktopType: vi.fn((type) => type === 'desktop')
}));

vi.mock('../../services/appUpdater.js', () => ({
  updateApp: vi.fn()
}));

vi.mock('../../services/appIconDetect.js', () => ({
  detectAppIcon: vi.fn(),
  isUsableSvg: vi.fn().mockResolvedValue(true)
}));

import * as appsService from '../../services/apps.js';
import * as pm2Service from '../../services/pm2.js';
import * as history from '../../services/history.js';

describe('Apps Lifecycle Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/apps', lifecycleRoutes);
    vi.clearAllMocks();
  });

  describe('POST /api/apps/:id/start', () => {
    it('should start an app', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        repoPath: '/path/to/repo',
        pm2ProcessNames: ['test-app'],
        startCommands: ['npm run dev']
      };
      appsService.getAppById.mockResolvedValue(mockApp);
      pm2Service.startWithCommand.mockResolvedValue({ success: true });
      history.logAction.mockResolvedValue();

      const response = await request(app).post('/api/apps/app-001/start');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(pm2Service.startWithCommand).toHaveBeenCalled();
      expect(history.logAction).toHaveBeenCalledWith('start', 'app-001', 'Test App', expect.any(Object), true);
    });

    it('should return 404 if app not found', async () => {
      appsService.getAppById.mockResolvedValue(null);

      const response = await request(app).post('/api/apps/app-999/start');

      expect(response.status).toBe(404);
    });

    it('launches a desktop app from its startCommands with autorestart OFF (#2991)', async () => {
      const mockApp = {
        id: 'game-001',
        name: 'The Game',
        type: 'desktop',
        repoPath: '/tmp', // real dir; no ecosystem config there, and desktop skips it anyway
        pm2ProcessNames: ['the-game'],
        startCommands: ['./scripts/game run']
      };
      appsService.getAppById.mockResolvedValue(mockApp);
      pm2Service.getAppStatus.mockResolvedValue({ status: 'stopped' }); // not running yet
      pm2Service.startWithCommand.mockResolvedValue({ success: true });
      history.logAction.mockResolvedValue();

      const response = await request(app).post('/api/apps/game-001/start');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      // Command-based launch, never the ecosystem web-server path.
      expect(pm2Service.startFromEcosystem).not.toHaveBeenCalled();
      expect(pm2Service.startWithCommand).toHaveBeenCalledWith(
        'the-game', '/tmp', './scripts/game run', { autorestart: false }
      );
    });

    it('does not spawn a second instance when the desktop app is already online (#2991)', async () => {
      const mockApp = {
        id: 'game-001',
        name: 'The Game',
        type: 'desktop',
        repoPath: '/tmp',
        pm2ProcessNames: ['the-game'],
        startCommands: ['./scripts/game run']
      };
      appsService.getAppById.mockResolvedValue(mockApp);
      pm2Service.getAppStatus.mockResolvedValue({ status: 'online' }); // already running
      history.logAction.mockResolvedValue();

      const response = await request(app).post('/api/apps/game-001/start');

      expect(response.status).toBe(200);
      expect(response.body.results['the-game']).toEqual({ success: true, alreadyRunning: true });
      // Single instance: no second launch.
      expect(pm2Service.startWithCommand).not.toHaveBeenCalled();
    });

    it('treats a transient launching state as already-running (no duplicate window, #2991)', async () => {
      const mockApp = {
        id: 'game-001',
        name: 'The Game',
        type: 'desktop',
        repoPath: '/tmp',
        pm2ProcessNames: ['the-game'],
        startCommands: ['./scripts/game run']
      };
      appsService.getAppById.mockResolvedValue(mockApp);
      // A slow launch is mid-flight — a second Start click must not spawn a duplicate.
      pm2Service.getAppStatus.mockResolvedValue({ status: 'launching' });
      history.logAction.mockResolvedValue();

      const response = await request(app).post('/api/apps/game-001/start');

      expect(response.status).toBe(200);
      expect(response.body.results['the-game']).toEqual({ success: true, alreadyRunning: true });
      expect(pm2Service.startWithCommand).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/apps/:id/stop', () => {
    it('should stop an app', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        pm2ProcessNames: ['test-app']
      };
      appsService.getAppById.mockResolvedValue(mockApp);
      pm2Service.stopApp.mockResolvedValue({ success: true });
      history.logAction.mockResolvedValue();

      const response = await request(app).post('/api/apps/app-001/stop');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(pm2Service.stopApp).toHaveBeenCalledWith('test-app', undefined);
    });

    it('should return 404 if app not found', async () => {
      appsService.getAppById.mockResolvedValue(null);

      const response = await request(app).post('/api/apps/app-999/stop');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/apps/:id/restart', () => {
    it('should restart an app', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        pm2ProcessNames: ['test-app']
      };
      appsService.getAppById.mockResolvedValue(mockApp);
      pm2Service.restartApp.mockResolvedValue({ success: true });
      history.logAction.mockResolvedValue();

      const response = await request(app).post('/api/apps/app-001/restart');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(pm2Service.restartApp).toHaveBeenCalledWith('test-app', undefined);
    });

    it('should return 404 if app not found', async () => {
      appsService.getAppById.mockResolvedValue(null);

      const response = await request(app).post('/api/apps/app-999/restart');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/apps/:id/build', () => {
    it('should return 404 if app not found', async () => {
      appsService.getAppById.mockResolvedValue(null);

      const response = await request(app).post('/api/apps/app-999/build');

      expect(response.status).toBe(404);
    });

    it.skipIf(process.platform !== 'win32')('should reject build command args containing shell-unsafe metacharacters', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        repoPath: process.cwd(), // real path so pathExists check passes
        buildCommand: 'npm run build&whoami',
        pm2ProcessNames: ['test-app']
      };
      appsService.getAppById.mockResolvedValue(mockApp);

      const response = await request(app).post('/api/apps/app-001/build');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_BUILD_COMMAND');
    });

    it('should reject build commands not starting with npm or npx', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        repoPath: '/tmp',
        buildCommand: 'rm -rf /',
        pm2ProcessNames: ['test-app']
      };
      appsService.getAppById.mockResolvedValue(mockApp);

      const response = await request(app).post('/api/apps/app-001/build');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_BUILD_COMMAND');
    });

    it('should return 400 if repo path does not exist', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        repoPath: '/nonexistent/path/that/does/not/exist',
        buildCommand: 'npm run build',
        pm2ProcessNames: ['test-app']
      };
      appsService.getAppById.mockResolvedValue(mockApp);

      const response = await request(app).post('/api/apps/app-001/build');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('PATH_NOT_FOUND');
    });
  });

  describe('GET /api/apps/:id/status', () => {
    it('should return PM2 status for app processes', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        pm2ProcessNames: ['test-api', 'test-worker']
      };
      appsService.getAppById.mockResolvedValue(mockApp);
      pm2Service.getAppStatus
        .mockResolvedValueOnce({ status: 'online', cpu: 2.5 })
        .mockResolvedValueOnce({ status: 'stopped' });

      const response = await request(app).get('/api/apps/app-001/status');

      expect(response.status).toBe(200);
      expect(response.body['test-api']).toEqual({ status: 'online', cpu: 2.5 });
      expect(response.body['test-worker']).toEqual({ status: 'stopped' });
    });

    it('should return 404 if app not found', async () => {
      appsService.getAppById.mockResolvedValue(null);

      const response = await request(app).get('/api/apps/app-999/status');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/apps/:id/logs', () => {
    it('should return logs for app process', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        pm2ProcessNames: ['test-app']
      };
      appsService.getAppById.mockResolvedValue(mockApp);
      pm2Service.getLogs.mockResolvedValue('Log line 1\nLog line 2');

      const response = await request(app).get('/api/apps/app-001/logs?lines=50');

      expect(response.status).toBe(200);
      expect(response.body.processName).toBe('test-app');
      expect(response.body.lines).toBe(50);
      expect(response.body.logs).toBe('Log line 1\nLog line 2');
    });

    it('should return 404 if app not found', async () => {
      appsService.getAppById.mockResolvedValue(null);

      const response = await request(app).get('/api/apps/app-999/logs');

      expect(response.status).toBe(404);
    });

    it('should return 400 if no process name available', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        pm2ProcessNames: []
      };
      appsService.getAppById.mockResolvedValue(mockApp);

      const response = await request(app).get('/api/apps/app-001/logs');

      expect(response.status).toBe(400);
    });
  });
});

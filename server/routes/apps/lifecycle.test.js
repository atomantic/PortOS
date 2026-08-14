import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { tmpdir } from 'os';
import { join } from 'path';

// The lifecycle route 400s when an app's repoPath does not exist, so these
// fixtures need a real directory. REAL_DIR is NOT one on Windows — it resolves to
// <cwd-drive>:\\tmp, present on some machines by accident and absent on the CI
// runner, which is why this suite passed locally and 400'd there.
const REAL_DIR = tmpdir();
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
  deleteApp: vi.fn(),
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

  describe('native launch target', () => {
    const mockApp = {
      id: 'app-001',
      name: 'Mixed App',
      type: 'express',
      repoPath: REAL_DIR,
      pm2ProcessNames: ['mixed-web'],
      nativeLaunch: {
        label: 'Godot',
        command: './scripts/game run',
        processName: 'mixed-game'
      }
    };

    it('launches the native target without replacing the web lifecycle', async () => {
      appsService.getAppById.mockResolvedValue(mockApp);
      pm2Service.getAppStatus.mockResolvedValue({ status: 'stopped' });
      pm2Service.deleteApp.mockResolvedValue({ success: true });
      pm2Service.startWithCommand.mockResolvedValue({ success: true });
      history.logAction.mockResolvedValue();

      const response = await request(app).post('/api/apps/app-001/native-launch');

      expect(response.status).toBe(200);
      expect(response.body.processName).toBe('mixed-game');
      expect(pm2Service.startWithCommand).toHaveBeenCalledWith(
        'mixed-game', REAL_DIR, './scripts/game run', { autorestart: false }
      );
      expect(pm2Service.deleteApp).toHaveBeenCalledWith('mixed-game', undefined);
      expect(pm2Service.deleteApp.mock.invocationCallOrder[0])
        .toBeLessThan(pm2Service.startWithCommand.mock.invocationCallOrder[0]);
      expect(pm2Service.startFromEcosystem).not.toHaveBeenCalled();
      expect(history.logAction).toHaveBeenCalledWith(
        'native-launch',
        'app-001',
        'Mixed App',
        { processName: 'mixed-game', label: 'Godot' },
        true
      );
    });

    it('starts the native target in the app\'s own PM2 home', async () => {
      appsService.getAppById.mockResolvedValue({ ...mockApp, pm2Home: join(REAL_DIR, 'example-pm2') });
      pm2Service.getAppStatus.mockResolvedValue({ status: 'stopped' });
      pm2Service.deleteApp.mockResolvedValue({ success: true });
      pm2Service.startWithCommand.mockResolvedValue({ success: true });
      history.logAction.mockResolvedValue();

      const response = await request(app).post('/api/apps/app-001/native-launch');

      expect(response.status).toBe(200);
      expect(pm2Service.startWithCommand).toHaveBeenCalledWith(
        'mixed-game', REAL_DIR, './scripts/game run', { autorestart: false, pm2Home: join(REAL_DIR, 'example-pm2') }
      );
    });

    it('does not open a second native window while one is launching', async () => {
      appsService.getAppById.mockResolvedValue(mockApp);
      pm2Service.getAppStatus.mockResolvedValue({ status: 'launching' });

      const response = await request(app).post('/api/apps/app-001/native-launch');

      expect(response.status).toBe(200);
      expect(response.body.result.alreadyRunning).toBe(true);
      expect(pm2Service.startWithCommand).not.toHaveBeenCalled();
      expect(pm2Service.deleteApp).not.toHaveBeenCalled();
    });

    it('does not launch a replacement when removing stale PM2 metadata fails', async () => {
      appsService.getAppById.mockResolvedValue(mockApp);
      pm2Service.getAppStatus.mockResolvedValue({ status: 'errored' });
      pm2Service.deleteApp.mockResolvedValue({ success: false, error: 'PM2 unavailable' });
      history.logAction.mockResolvedValue();

      const response = await request(app).post('/api/apps/app-001/native-launch');

      expect(response.status).toBe(500);
      expect(response.body.code).toBe('NATIVE_LAUNCH_FAILED');
      expect(pm2Service.startWithCommand).not.toHaveBeenCalled();
      expect(history.logAction).toHaveBeenCalledWith(
        'native-launch',
        'app-001',
        'Mixed App',
        { processName: 'mixed-game', label: 'Godot' },
        false
      );
    });

    it('reports the native process status independently of the web app', async () => {
      appsService.getAppById.mockResolvedValue(mockApp);
      pm2Service.getAppStatus.mockResolvedValue({ status: 'online' });

      const response = await request(app).get('/api/apps/app-001/native-launch/status');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ processName: 'mixed-game', status: 'online' });
    });

    it('rejects native launch when the app has no target', async () => {
      appsService.getAppById.mockResolvedValue({ ...mockApp, nativeLaunch: null });

      const response = await request(app).post('/api/apps/app-001/native-launch');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('NATIVE_LAUNCH_NOT_CONFIGURED');
    });
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

    it('starts a command-based app (no ecosystem config) in its own PM2 home', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        repoPath: '/path/to/repo',
        pm2ProcessNames: ['test-app'],
        startCommands: ['npm run dev'],
        pm2Home: join(REAL_DIR, 'example-pm2')
      };
      appsService.getAppById.mockResolvedValue(mockApp);
      pm2Service.startWithCommand.mockResolvedValue({ success: true });
      history.logAction.mockResolvedValue();

      const response = await request(app).post('/api/apps/app-001/start');

      expect(response.status).toBe(200);
      expect(pm2Service.startWithCommand).toHaveBeenCalledWith(
        'test-app', '/path/to/repo', 'npm run dev', { pm2Home: join(REAL_DIR, 'example-pm2') }
      );
    });

    it('launches a desktop app from its startCommands with autorestart OFF (#2991)', async () => {
      const mockApp = {
        id: 'game-001',
        name: 'The Game',
        type: 'desktop',
        repoPath: REAL_DIR, // real dir; no ecosystem config there, and desktop skips it anyway
        pm2ProcessNames: ['the-game'],
        startCommands: ['./scripts/game run']
      };
      appsService.getAppById.mockResolvedValue(mockApp);
      pm2Service.getAppStatus.mockResolvedValue({ status: 'stopped' }); // not running yet
      pm2Service.deleteApp.mockResolvedValue({ success: true });
      pm2Service.startWithCommand.mockResolvedValue({ success: true });
      history.logAction.mockResolvedValue();

      const response = await request(app).post('/api/apps/game-001/start');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      // Command-based launch, never the ecosystem web-server path.
      expect(pm2Service.startFromEcosystem).not.toHaveBeenCalled();
      expect(pm2Service.startWithCommand).toHaveBeenCalledWith(
        'the-game', REAL_DIR, './scripts/game run', { autorestart: false }
      );
      expect(pm2Service.deleteApp).toHaveBeenCalledWith('the-game', undefined);
    });

    it('does not spawn a second instance when the desktop app is already online (#2991)', async () => {
      const mockApp = {
        id: 'game-001',
        name: 'The Game',
        type: 'desktop',
        repoPath: REAL_DIR,
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
        repoPath: REAL_DIR,
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
        repoPath: REAL_DIR,
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

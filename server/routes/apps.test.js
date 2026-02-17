import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import appsRoutes from './apps.js';

// Mock the services
vi.mock('../services/apps.js', () => ({
  getAllApps: vi.fn(),
  getAppById: vi.fn(),
  createApp: vi.fn(),
  updateApp: vi.fn(),
  deleteApp: vi.fn(),
  notifyAppsChanged: vi.fn()
}));

vi.mock('../services/pm2.js', () => ({
  listProcesses: vi.fn(),
  getAppStatus: vi.fn(),
  startWithCommand: vi.fn(),
  stopApp: vi.fn(),
  restartApp: vi.fn(),
  getLogs: vi.fn()
}));

vi.mock('../services/history.js', () => ({
  logAction: vi.fn()
}));

vi.mock('../services/streamingDetect.js', () => ({
  parseEcosystemFromPath: vi.fn()
}));

// Import mocked modules
import * as appsService from '../services/apps.js';
import * as pm2Service from '../services/pm2.js';
import * as history from '../services/history.js';
import * as streamingDetect from '../services/streamingDetect.js';

describe('Apps Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/apps', appsRoutes);

    // Reset all mocks
    vi.clearAllMocks();
  });

  describe('GET /api/apps', () => {
    it('should return list of apps with PM2 status', async () => {
      const mockApps = [
        { id: 'app-001', name: 'Test App', pm2ProcessNames: ['test-app'], repoPath: '/tmp/test' }
      ];
      const mockPm2Processes = [
        { name: 'test-app', status: 'online' }
      ];

      appsService.getAllApps.mockResolvedValue(mockApps);
      pm2Service.listProcesses.mockResolvedValue(mockPm2Processes);
      streamingDetect.parseEcosystemFromPath.mockResolvedValue([]);

      const response = await request(app).get('/api/apps');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].overallStatus).toBe('online');
    });

    it('should handle apps with no PM2 processes', async () => {
      const mockApps = [
        { id: 'app-001', name: 'Test App', pm2ProcessNames: [], repoPath: '/tmp/test' }
      ];

      appsService.getAllApps.mockResolvedValue(mockApps);
      pm2Service.listProcesses.mockResolvedValue([]);
      streamingDetect.parseEcosystemFromPath.mockResolvedValue([]);

      const response = await request(app).get('/api/apps');

      expect(response.status).toBe(200);
      expect(response.body[0].overallStatus).toBe('not_started');
    });

    it('should return empty array when no apps exist', async () => {
      appsService.getAllApps.mockResolvedValue([]);
      pm2Service.listProcesses.mockResolvedValue([]);

      const response = await request(app).get('/api/apps');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(0);
    });
  });

  describe('GET /api/apps/:id', () => {
    it('should return app by ID', async () => {
      const mockApp = {
        id: 'app-001',
        name: 'Test App',
        pm2ProcessNames: ['test-app']
      };
      appsService.getAppById.mockResolvedValue(mockApp);
      pm2Service.getAppStatus.mockResolvedValue({ status: 'online' });

      const response = await request(app).get('/api/apps/app-001');

      expect(response.status).toBe(200);
      expect(response.body.id).toBe('app-001');
      expect(response.body.pm2Status).toBeDefined();
    });

    it('should return 404 if app not found', async () => {
      appsService.getAppById.mockResolvedValue(null);

      const response = await request(app).get('/api/apps/app-999');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/apps', () => {
    it('should create a new app', async () => {
      const newApp = {
        name: 'New App',
        repoPath: '/path/to/repo'
      };
      appsService.createApp.mockResolvedValue({ id: 'app-001', ...newApp });

      const response = await request(app)
        .post('/api/apps')
        .send(newApp);

      expect(response.status).toBe(201);
      expect(response.body.id).toBe('app-001');
      expect(appsService.createApp).toHaveBeenCalledWith(expect.objectContaining({ name: 'New App' }));
    });

    it('should return 400 if validation fails', async () => {
      // Missing required fields
      const response = await request(app)
        .post('/api/apps')
        .send({});

      expect(response.status).toBe(400);
    });
  });

  describe('PUT /api/apps/:id', () => {
    it('should update an app', async () => {
      const updates = { name: 'Updated Name' };
      appsService.updateApp.mockResolvedValue({ id: 'app-001', name: 'Updated Name' });

      const response = await request(app)
        .put('/api/apps/app-001')
        .send(updates);

      expect(response.status).toBe(200);
      expect(appsService.updateApp).toHaveBeenCalledWith('app-001', expect.objectContaining({ name: 'Updated Name' }));
    });

    it('should return 404 if app not found', async () => {
      appsService.updateApp.mockResolvedValue(null);

      const response = await request(app)
        .put('/api/apps/app-999')
        .send({ name: 'Test' });

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/apps/:id', () => {
    it('should delete an app', async () => {
      appsService.deleteApp.mockResolvedValue(true);

      const response = await request(app).delete('/api/apps/app-001');

      expect(response.status).toBe(204);
      expect(appsService.deleteApp).toHaveBeenCalledWith('app-001');
    });

    it('should return 404 if app not found', async () => {
      appsService.deleteApp.mockResolvedValue(false);

      const response = await request(app).delete('/api/apps/app-999');

      expect(response.status).toBe(404);
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

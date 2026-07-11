import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import xcodeRoutes from './xcode.js';

vi.mock('../../services/apps.js', () => ({
  getAppById: vi.fn(),
  PORTOS_APP_ID: 'portos-default'
}));

vi.mock('../../services/xcodeScripts.js', () => ({
  installScripts: vi.fn(),
  XCODE_SCRIPT_NAMES: ['deploy.sh', 'take_screenshots.sh', 'take_screenshots_macos.sh']
}));

import * as appsService from '../../services/apps.js';
import { installScripts } from '../../services/xcodeScripts.js';

describe('Apps Xcode Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/apps', xcodeRoutes);
    vi.clearAllMocks();
  });

  describe('POST /api/apps/:id/xcode-scripts/install', () => {
    it('should install requested scripts successfully', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'Test App', type: 'xcode', repoPath: '/tmp' });
      installScripts.mockResolvedValue({ installed: ['deploy.sh'], skipped: [], errors: [] });

      const response = await request(app)
        .post('/api/apps/app-001/xcode-scripts/install')
        .send({ scripts: ['deploy.sh'] });

      expect(response.status).toBe(200);
      expect(response.body.installed).toEqual(['deploy.sh']);
    });

    it('should return 400 when all scripts fail', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'Test App', type: 'xcode', repoPath: '/tmp' });
      installScripts.mockResolvedValue({ installed: [], skipped: [], errors: ['some failure'] });

      const response = await request(app)
        .post('/api/apps/app-001/xcode-scripts/install')
        .send({ scripts: ['deploy.sh'] });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INSTALL_FAILED');
    });

    it('should return 400 when scripts array contains an unknown name', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'Test App', type: 'xcode', repoPath: '/tmp' });

      const response = await request(app)
        .post('/api/apps/app-001/xcode-scripts/install')
        .send({ scripts: ['bad.sh'] });

      // Unknown script names are now rejected by the Zod enum validator
      expect(response.status).toBe(400);
    });

    it('should return 400 when scripts array is empty', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'Test App', type: 'xcode', repoPath: '/tmp' });

      const response = await request(app)
        .post('/api/apps/app-001/xcode-scripts/install')
        .send({ scripts: [] });

      expect(response.status).toBe(400);
    });

    it('should return 404 when app not found', async () => {
      appsService.getAppById.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/apps/app-999/xcode-scripts/install')
        .send({ scripts: ['deploy.sh'] });

      expect(response.status).toBe(404);
    });

    it('should return partial success with errors', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'Test App', type: 'xcode', repoPath: '/tmp' });
      installScripts.mockResolvedValue({
        installed: ['deploy.sh'],
        skipped: [],
        errors: ['Script take_screenshots_macos.sh does not apply to ios-native apps']
      });

      const response = await request(app)
        .post('/api/apps/app-001/xcode-scripts/install')
        .send({ scripts: ['deploy.sh', 'take_screenshots_macos.sh'] });

      expect(response.status).toBe(200);
      expect(response.body.installed).toEqual(['deploy.sh']);
      expect(response.body.errors).toHaveLength(1);
    });

    it('should return 400 when repoPath does not exist', async () => {
      appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'Test App', type: 'xcode', repoPath: '/nonexistent/path' });

      const response = await request(app)
        .post('/api/apps/app-001/xcode-scripts/install')
        .send({ scripts: ['deploy.sh'] });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('PATH_NOT_FOUND');
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import iconRoutes from './icons.js';

vi.mock('../../services/apps.js', () => ({
  getAllApps: vi.fn(),
  getAppById: vi.fn(),
  updateApp: vi.fn(),
  notifyAppsChanged: vi.fn(),
  PORTOS_APP_ID: 'portos-default'
}));

vi.mock('../../services/appIconDetect.js', () => ({
  detectAppIcon: vi.fn(),
  getIconContentType: vi.fn(),
  isUsableSvg: vi.fn().mockResolvedValue(true)
}));

import * as appsService from '../../services/apps.js';
import { detectAppIcon, getIconContentType, isUsableSvg } from '../../services/appIconDetect.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Apps Icon Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/apps', iconRoutes);
    vi.clearAllMocks();
  });

  describe('GET /api/apps/:id/icon', () => {
    const iconDir = join(tmpdir(), 'portos-test-icon');
    const iconPath = join(iconDir, 'icon.png');
    const mockApp = { id: 'app-001', name: 'Test App', appIconPath: iconPath, repoPath: '/tmp/test', pm2ProcessNames: [] };

    beforeEach(() => {
      mkdirSync(iconDir, { recursive: true });
      writeFileSync(iconPath, 'fake-png-data');
      appsService.getAppById.mockResolvedValue(mockApp);
      getIconContentType.mockReturnValue('image/png');
    });

    afterAll(() => {
      rmSync(iconDir, { recursive: true, force: true });
    });

    it('should return icon with ETag header', async () => {
      const response = await request(app).get('/api/apps/app-001/icon');

      expect(response.status).toBe(200);
      expect(response.headers['etag']).toBeDefined();
      expect(response.headers['etag']).toMatch(/^W\//);
      expect(response.headers['cache-control']).toBe('public, max-age=3600');
    });

    it('should return 304 when If-None-Match matches ETag', async () => {
      const first = await request(app).get('/api/apps/app-001/icon');
      const etag = first.headers['etag'];

      const second = await request(app)
        .get('/api/apps/app-001/icon')
        .set('If-None-Match', etag);

      expect(second.status).toBe(304);
    });

    it('should return 304 when If-None-Match contains multiple ETags including match', async () => {
      const first = await request(app).get('/api/apps/app-001/icon');
      const etag = first.headers['etag'];

      const second = await request(app)
        .get('/api/apps/app-001/icon')
        .set('If-None-Match', `W/"other-etag", ${etag}, W/"another"`);

      expect(second.status).toBe(304);
    });

    it('redetects when stored path is an unusable SVG (external <image href>) so PortOS-style icons recover', async () => {
      // Simulate the bad-state PortOS install: appIconPath stored as an SVG
      // that exists on disk but embeds <image href="/portos-logo.png"> — CSP
      // blocks the embed, so it renders blank. The route must re-detect.
      const badSvgPath = join(iconDir, 'favicon.svg');
      const goodPngPath = join(iconDir, 'redetected.png');
      writeFileSync(badSvgPath, '<svg><image href="/logo.png"/></svg>');
      writeFileSync(goodPngPath, 'fake-png-data');
      appsService.getAppById.mockResolvedValue({
        ...mockApp,
        appIconPath: badSvgPath,
      });
      isUsableSvg.mockResolvedValueOnce(false);
      detectAppIcon.mockResolvedValueOnce(goodPngPath);

      const response = await request(app).get('/api/apps/app-001/icon');

      expect(response.status).toBe(200);
      expect(detectAppIcon).toHaveBeenCalledWith('/tmp/test', undefined);
      expect(appsService.updateApp).toHaveBeenCalledWith('app-001', { appIconPath: goodPngPath });
    });
  });
});

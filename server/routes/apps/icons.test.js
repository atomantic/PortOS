import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { closeLoopbackServer, request, startLoopbackServer } from '../../lib/testHelper.js';
import iconRoutes from './icons.js';
import sharp from 'sharp';

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
import { writeFileSync, mkdirSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

async function requestBinary(app, path) {
  const server = await startLoopbackServer(app);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return {
      status: response.status,
      body: Buffer.from(await response.arrayBuffer()),
      headers: Object.fromEntries(response.headers.entries()),
    };
  } finally {
    await closeLoopbackServer(server);
  }
}

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

    beforeEach(async () => {
      mkdirSync(iconDir, { recursive: true });
      await sharp({ create: { width: 512, height: 512, channels: 3, background: '#ff0000' } }).png().toFile(iconPath);
      appsService.getAppById.mockResolvedValue(mockApp);
      getIconContentType.mockImplementation((path) => path.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
    });

    afterAll(() => {
      rmSync(iconDir, { recursive: true, force: true });
    });

    it('should return icon with ETag header', async () => {
      const response = await requestBinary(app, '/api/apps/app-001/icon');

      expect(response.status).toBe(200);
      expect(response.headers['etag']).toBeDefined();
      expect(response.headers['etag']).toMatch(/^W\//);
      expect(response.headers['cache-control']).toBe('public, max-age=3600');
      expect(response.headers['content-type']).toMatch(/^image\/png/);
      expect(await sharp(response.body).metadata()).toMatchObject({ width: 128, height: 128 });
    });

    it('serves requested raster sizes with distinct ETags', async () => {
      const defaultResponse = await requestBinary(app, '/api/apps/app-001/icon');
      const sizedResponse = await requestBinary(app, '/api/apps/app-001/icon?size=64');

      expect(sizedResponse.status).toBe(200);
      expect(sizedResponse.headers.etag).not.toBe(defaultResponse.headers.etag);
      expect(await sharp(sizedResponse.body).metadata()).toMatchObject({ width: 64, height: 64 });
    });

    it('rejects unsupported raster sizes', async () => {
      const response = await request(app).get('/api/apps/app-001/icon?size=999');

      expect(response.status).toBe(400);
    });

    it('refreshes a cached raster derivative when the source file changes', async () => {
      const first = await requestBinary(app, '/api/apps/app-001/icon');
      await sharp({ create: { width: 512, height: 512, channels: 3, background: '#0000ff' } }).png().toFile(iconPath);
      const future = new Date(Date.now() + 2_000);
      utimesSync(iconPath, future, future);
      const second = await requestBinary(app, '/api/apps/app-001/icon');

      expect(second.headers.etag).not.toBe(first.headers.etag);
      expect(second.body).not.toEqual(first.body);
    });

    it('passes SVG icons through unchanged with the restrictive CSP', async () => {
      const svgPath = join(iconDir, 'icon.svg');
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="4" cy="4" r="3"/></svg>';
      writeFileSync(svgPath, svg);
      appsService.getAppById.mockResolvedValue({ ...mockApp, appIconPath: svgPath });

      const response = await request(app).get('/api/apps/app-001/icon?size=64');

      expect(response.status).toBe(200);
      expect(response.text).toBe(svg);
      expect(response.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'");
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
      await sharp({ create: { width: 64, height: 64, channels: 3, background: '#00ff00' } }).png().toFile(goodPngPath);
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

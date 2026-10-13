import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

import * as appsService from '../../services/apps.js';
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, rmSync, utimesSync, symlinkSync, unlinkSync } from 'fs';
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
    let scratch;
    let iconDir;
    let iconPath;
    let mockApp;

    beforeEach(async () => {
      scratch = realpathSync(mkdtempSync(join(tmpdir(), 'portos-test-icon-')));
      iconDir = join(scratch, 'repo');
      iconPath = join(iconDir, 'icon.png');
      mkdirSync(iconDir, { recursive: true });
      await sharp({ create: { width: 512, height: 512, channels: 3, background: '#ff0000' } }).png().toFile(iconPath);
      mockApp = { id: 'app-001', name: 'Test App', appIconPath: iconPath, repoPath: iconDir, pm2ProcessNames: [] };
      appsService.getAppById.mockResolvedValue(mockApp);
    });

    afterEach(() => {
      rmSync(scratch, { recursive: true, force: true });
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
      mkdirSync(join(iconDir, 'public'));
      const badSvgPath = join(iconDir, 'public', 'favicon.svg');
      const goodPngPath = join(iconDir, 'public', 'apple-touch-icon.png');
      writeFileSync(badSvgPath, '<svg><image href="/logo.png"/></svg>');
      await sharp({ create: { width: 64, height: 64, channels: 3, background: '#00ff00' } }).png().toFile(goodPngPath);
      appsService.getAppById.mockResolvedValue({
        ...mockApp,
        appIconPath: badSvgPath,
      });
      const response = await request(app).get('/api/apps/app-001/icon');

      expect(response.status).toBe(200);
      expect(appsService.updateApp).toHaveBeenCalledWith('app-001', { appIconPath: goodPngPath });
    });

    it('replaces a cached outside path with a safe detected icon without serving outside bytes', async () => {
      const outside = join(scratch, 'outside.svg');
      writeFileSync(outside, 'synthetic-private-marker');
      mockApp.appIconPath = outside;

      const response = await requestBinary(app, '/api/apps/app-001/icon');

      expect(response.status).toBe(200);
      expect(response.body.toString()).not.toContain('synthetic-private-marker');
      expect(await sharp(response.body).metadata()).toMatchObject({ width: 128, height: 128 });
      expect(appsService.updateApp).toHaveBeenCalledWith('app-001', { appIconPath: iconPath });
    });

    it('does not expose a host file selected by a traversing Xcode icon manifest', async () => {
      unlinkSync(iconPath);
      const iconSet = join(iconDir, 'Assets.xcassets', 'AppIcon.appiconset');
      mkdirSync(iconSet, { recursive: true });
      writeFileSync(join(scratch, 'outside.txt'), 'synthetic-private-marker');
      writeFileSync(join(iconSet, 'Contents.json'), JSON.stringify({
        images: [{ filename: '../../../outside.txt', size: '1024x1024', scale: '1x' }],
      }));
      mockApp.appIconPath = null;
      mockApp.type = 'xcode';

      const response = await request(app).get('/api/apps/app-001/icon');

      expect(response.status).toBe(404);
      expect(response.text).not.toContain('synthetic-private-marker');
      expect(appsService.updateApp).not.toHaveBeenCalled();
    });

    it('revalidates a cached symlink before returning a matching conditional response', async () => {
      unlinkSync(iconPath);
      mkdirSync(join(iconDir, 'public'));
      mkdirSync(join(iconDir, 'assets'));
      const inside = join(iconDir, 'assets', 'safe.svg');
      const outside = join(scratch, 'outside.svg');
      const link = join(iconDir, 'public', 'favicon.svg');
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="3"/></svg>';
      writeFileSync(inside, svg);
      writeFileSync(outside, 'synthetic-private-marker'.padEnd(Buffer.byteLength(svg), ' '));
      const timestamp = new Date(Date.now() - 60_000);
      utimesSync(inside, timestamp, timestamp);
      utimesSync(outside, timestamp, timestamp);
      symlinkSync(inside, link, 'file');
      mockApp.appIconPath = link;

      const first = await request(app).get('/api/apps/app-001/icon');
      expect(first.status).toBe(200);
      expect(first.text).toBe(svg);
      unlinkSync(link);
      symlinkSync(outside, link, 'file');

      const second = await request(app).get('/api/apps/app-001/icon').set('If-None-Match', first.headers.etag);

      expect(second.status).toBe(404);
      expect(second.text).not.toContain('synthetic-private-marker');
    });

    it('refuses an icon beneath an escaping directory symlink', async () => {
      unlinkSync(iconPath);
      const outsideDir = join(scratch, 'outside');
      mkdirSync(outsideDir);
      writeFileSync(join(outsideDir, 'favicon.svg'), 'synthetic-private-marker');
      symlinkSync(outsideDir, join(iconDir, 'public'), process.platform === 'win32' ? 'junction' : 'dir');
      mockApp.appIconPath = join(iconDir, 'public', 'favicon.svg');

      const response = await request(app).get('/api/apps/app-001/icon');

      expect(response.status).toBe(404);
      expect(response.text).not.toContain('synthetic-private-marker');
    });

    it('does not serve an in-repository private file through an icon-shaped symlink', async () => {
      unlinkSync(iconPath);
      mkdirSync(join(iconDir, 'public'));
      const privateFile = join(iconDir, '.env');
      const link = join(iconDir, 'public', 'favicon.svg');
      writeFileSync(privateFile, 'synthetic-private-marker');
      symlinkSync(privateFile, link, 'file');
      mockApp.appIconPath = link;

      const response = await request(app).get('/api/apps/app-001/icon');

      expect(response.status).toBe(404);
      expect(response.text).not.toContain('synthetic-private-marker');
    });

    it('detects and serves an internal icon symlink when the repository root is also a symlink', async () => {
      unlinkSync(iconPath);
      mkdirSync(join(iconDir, 'assets'));
      mkdirSync(join(iconDir, 'public'));
      const realIcon = join(iconDir, 'assets', 'logo.svg');
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>';
      writeFileSync(realIcon, svg);
      symlinkSync(realIcon, join(iconDir, 'public', 'favicon.svg'), 'file');
      const linkedRepo = join(scratch, 'linked-repo');
      symlinkSync(iconDir, linkedRepo, process.platform === 'win32' ? 'junction' : 'dir');
      mockApp.repoPath = linkedRepo;
      mockApp.appIconPath = null;

      const response = await request(app).get('/api/apps/app-001/icon');

      expect(response.status).toBe(200);
      expect(response.text).toBe(svg);
      expect(response.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'");
    });
  });
});

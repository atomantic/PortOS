import { describe, it, expect, vi, afterAll } from 'vitest';
import express from 'express';
import { rmSync } from 'fs';
import { dirname } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Point the screenshots root at a throwaway temp dir but keep every real
// helper (sanitizeFilename, isPathInsideDir, ensureDir, ...). The temp dir is
// created inside the (hoisted) factory to avoid a TDZ on an outer const.
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const root = mkdtempSync(join(tmpdir(), 'portos-screenshots-'));
  return { ...actual, PATHS: { ...actual.PATHS, screenshots: join(root, 'screenshots') } };
});

import { PATHS } from '../lib/fileUtils.js';
import screenshotRoutes from './screenshots.js';

const buildApp = () => {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/screenshots', screenshotRoutes);
  app.use(errorMiddleware);
  return app;
};

// Minimal valid PNG: 89 50 4E 47 magic + padding to clear the 12-byte floor.
const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]).toString('base64');

describe('screenshots routes (#2518)', () => {
  afterAll(() => rmSync(dirname(PATHS.screenshots), { recursive: true, force: true }));

  it('returns an API-relative URL, never an absolute FS path', async () => {
    const res = await request(buildApp())
      .post('/api/screenshots')
      .send({ data: pngBase64, filename: 'shot.png' });

    expect(res.status).toBe(200);
    expect(res.body.path).toMatch(/^\/api\/screenshots\//);
    // The response must not leak the on-disk location.
    expect(res.body.path).not.toContain(PATHS.screenshots);
    expect(res.body.path).toBe(`/api/screenshots/${encodeURIComponent(res.body.filename)}`);
  });

  it('rejects non-image content (magic-byte guard)', async () => {
    const res = await request(buildApp())
      .post('/api/screenshots')
      .send({ data: Buffer.from('not an image at all here').toString('base64'), filename: 'x.png' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FILE_TYPE');
  });
});

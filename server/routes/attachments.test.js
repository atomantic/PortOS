import { describe, it, expect, vi, afterAll } from 'vitest';
import express from 'express';
import { rmSync } from 'fs';
import { dirname } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Point the attachments root at a throwaway temp dir but keep every real
// helper. Temp dir created inside the (hoisted) factory to avoid a TDZ.
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const root = mkdtempSync(join(tmpdir(), 'portos-attachments-'));
  return { ...actual, PATHS: { ...actual.PATHS, cosAttachments: join(root, 'attachments') } };
});

import { PATHS } from '../lib/fileUtils.js';
import attachmentRoutes from './attachments.js';

const buildApp = () => {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/attachments', attachmentRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('attachments routes (#2518)', () => {
  afterAll(() => rmSync(dirname(PATHS.cosAttachments), { recursive: true, force: true }));

  it('POST returns an API-relative URL, never an absolute FS path', async () => {
    const res = await request(buildApp())
      .post('/api/attachments')
      .send({ data: Buffer.from('hello doc').toString('base64'), filename: 'notes.txt' });

    expect(res.status).toBe(200);
    expect(res.body.path).toMatch(/^\/api\/attachments\//);
    expect(res.body.path).not.toContain(PATHS.cosAttachments);
    expect(res.body.path).toBe(`/api/attachments/${encodeURIComponent(res.body.filename)}`);
  });

  it('GET list returns API-relative URLs, never absolute FS paths', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/attachments')
      .send({ data: Buffer.from('another doc').toString('base64'), filename: 'more.txt' });

    const res = await request(app).get('/api/attachments');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.attachments)).toBe(true);
    expect(res.body.attachments.length).toBeGreaterThan(0);
    for (const att of res.body.attachments) {
      expect(att.path).toMatch(/^\/api\/attachments\//);
      expect(att.path).not.toContain(PATHS.cosAttachments);
    }
  });

  it('rejects a disallowed extension', async () => {
    const res = await request(buildApp())
      .post('/api/attachments')
      .send({ data: Buffer.from('x').toString('base64'), filename: 'evil.exe' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FILE_TYPE');
  });
});

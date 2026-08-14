import { describe, it, expect, vi, afterAll } from 'vitest';
import express from 'express';
import { rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Point the uploads root at a throwaway temp dir but keep every real helper —
// this suite is here to prove the shared saveBase64Upload / serveLocalFile
// pipeline still produces uploads.js's OWN response shape (#4101), so mocking
// those helpers out would defeat the point.
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join: joinPath } = await import('path');
  const root = mkdtempSync(joinPath(tmpdir(), 'portos-uploads-'));
  return { ...actual, PATHS: { ...actual.PATHS, uploads: joinPath(root, 'uploads') } };
});

import { PATHS, EXTENSION_MIME_MAP } from '../lib/fileUtils.js';
import uploadRoutes from './uploads.js';

const buildApp = () => {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/uploads', uploadRoutes);
  app.use(errorMiddleware);
  return app;
};

const post = (app, filename, body = 'hello uploads') =>
  request(app).post('/api/uploads').send({ data: Buffer.from(body).toString('base64'), filename });

describe('uploads routes (#4101)', () => {
  afterAll(() => rmSync(dirname(PATHS.uploads), { recursive: true, force: true }));

  it('POST returns the full uploads response shape, not the attachments one', async () => {
    const app = buildApp();
    const before = Date.now();
    const res = await post(app, 'my notes.txt', 'hello uploads');

    expect(res.status).toBe(200);
    // Exact key set — the Uploads page and the gallery picker read these.
    expect(Object.keys(res.body).sort()).toEqual([
      'createdAt', 'filename', 'id', 'mimeType', 'originalName', 'path', 'size', 'sizeFormatted',
    ]);
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    // `<uuid8>-<sanitized-name>`: the space in the original name is sanitized.
    expect(res.body.filename).toBe(`${res.body.id.slice(0, 8)}-my_notes.txt`);
    expect(res.body.originalName).toBe('my notes.txt');
    expect(res.body.path).toBe(`/api/uploads/${encodeURIComponent(res.body.filename)}`);
    expect(res.body.path).not.toContain(PATHS.uploads);
    expect(res.body.size).toBe(13);
    expect(res.body.sizeFormatted).toBe('13 B');
    expect(res.body.mimeType).toBe('text/plain');
    expect(Date.parse(res.body.createdAt)).toBeGreaterThanOrEqual(before);

    // The bytes actually landed under the uploads dir with that name.
    expect(readFileSync(join(PATHS.uploads, res.body.filename), 'utf8')).toBe('hello uploads');
  });

  it('formats KB with one decimal (formatBytes would say "1 KB")', async () => {
    const res = await post(buildApp(), 'padded.txt', 'x'.repeat(1536));
    expect(res.status).toBe(200);
    expect(res.body.size).toBe(1536);
    expect(res.body.sizeFormatted).toBe('1.5 KB');
  });

  it('accepts every extension in the shared MIME map, including audio/video/archives', async () => {
    const app = buildApp();
    for (const ext of ['.mp4', '.wav', '.mid', '.zip', '.ico', '.env']) {
      // These are exactly the families ATTACHMENT_ALLOWED_EXTENSIONS excludes,
      // so this fails the moment someone swaps in the narrow attachment set.
      const res = await post(app, `clip${ext}`);
      expect(res.status, `${ext} should be accepted`).toBe(200);
      expect(res.body.mimeType).toBe(EXTENSION_MIME_MAP[ext]);
    }
  });

  it('rejects an extension outside the MIME map with INVALID_FILE_TYPE', async () => {
    const res = await post(buildApp(), 'payload.exe');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FILE_TYPE');
  });

  it('rejects a filename with no extension at all', async () => {
    const res = await post(buildApp(), 'README');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FILE_TYPE');
  });

  it('rejects a missing data / filename with VALIDATION_ERROR', async () => {
    const app = buildApp();
    const noData = await request(app).post('/api/uploads').send({ filename: 'a.txt' });
    expect(noData.status).toBe(400);
    expect(noData.body.code).toBe('VALIDATION_ERROR');

    const noName = await request(app).post('/api/uploads').send({ data: 'aGk=' });
    expect(noName.status).toBe(400);
    expect(noName.body.code).toBe('VALIDATION_ERROR');
  });

  it('GET :filename serves the bytes with nosniff and no attachment disposition for safe types', async () => {
    const app = buildApp();
    const created = await post(app, 'served.txt', 'served body');

    const res = await request(app).get(`/api/uploads/${encodeURIComponent(created.body.filename)}`);
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('GET :filename forces an attachment disposition for risky types (HTML)', async () => {
    const app = buildApp();
    const created = await post(app, 'page.html', '<b>hi</b>');

    const res = await request(app).get(`/api/uploads/${encodeURIComponent(created.body.filename)}`);
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${created.body.filename}"`);
  });

  it('GET :filename 404s with this route\'s own message, not the attachment default', async () => {
    const res = await request(buildApp()).get('/api/uploads/nope.txt');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.error).toBe('File not found');
  });

  it('GET list returns API-relative paths plus the formatted totals', async () => {
    const app = buildApp();
    const created = await post(app, 'listed.txt', 'listed body');

    const res = await request(app).get('/api/uploads');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(res.body.uploads.length);
    expect(res.body.totalSize).toBe(res.body.uploads.reduce((sum, up) => sum + up.size, 0));

    const entry = res.body.uploads.find(up => up.filename === created.body.filename);
    expect(entry).toBeDefined();
    expect(Object.keys(entry).sort()).toEqual([
      'createdAt', 'filename', 'mimeType', 'modifiedAt', 'path', 'size', 'sizeFormatted',
    ]);
    expect(entry.size).toBe(11);
    expect(entry.sizeFormatted).toBe('11 B');
    expect(entry.mimeType).toBe('text/plain');
    for (const up of res.body.uploads) {
      expect(up.path).toBe(`/api/uploads/${encodeURIComponent(up.filename)}`);
      expect(up.path).not.toContain(PATHS.uploads);
    }
  });

  it('DELETE :filename returns the deleted size and 404s the second time', async () => {
    const app = buildApp();
    const created = await post(app, 'doomed.txt', 'doomed');

    const res = await request(app).delete(`/api/uploads/${encodeURIComponent(created.body.filename)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, filename: created.body.filename, size: 6 });

    const again = await request(app).delete(`/api/uploads/${encodeURIComponent(created.body.filename)}`);
    expect(again.status).toBe(404);
    expect(again.body.code).toBe('NOT_FOUND');
  });

  // Runs last on purpose: it empties the shared temp uploads dir.
  it('DELETE all requires ?confirm=true and reports freed space', async () => {
    const app = buildApp();

    const unconfirmed = await request(app).delete('/api/uploads');
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.code).toBe('CONFIRMATION_REQUIRED');
    // The 400 must not have deleted anything.
    expect((await request(app).get('/api/uploads')).body.count).toBeGreaterThan(0);

    // Clear whatever earlier cases left behind, then measure one known file.
    await request(app).delete('/api/uploads?confirm=true');
    await post(app, 'sweep.txt', 'sweep me');

    const res = await request(app).delete('/api/uploads?confirm=true');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      deleted: 1,
      freedSpace: 8,
      freedSpaceFormatted: '8 B',
    });

    const after = await request(app).get('/api/uploads');
    expect(after.body.uploads).toEqual([]);
    expect(after.body.totalSizeFormatted).toBe('0 B');
  });
});

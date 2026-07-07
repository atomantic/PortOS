import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// The importer service is exercised via its own unit suite; here we only assert
// the route wiring: multipart parse → validation → service call → temp cleanup.
vi.mock('../services/spotifyImport.js', () => ({
  importSpotifyHistory: vi.fn(async (file, opts) => ({
    dryRun: Boolean(opts?.dryRun),
    parsed: 3,
    mapped: 2,
    recorded: opts?.dryRun ? 0 : 2,
    skipped: opts?.dryRun ? 0 : 1,
    summary: { plays: 2, uniqueTracks: 2, totalMs: 1000, from: null, to: null, topArtists: [] },
  })),
}));

vi.mock('../services/humanActivity.js', () => ({
  getDaySummary: vi.fn(async () => ({ date: '2026-07-07', events: [] })),
  listEvents: vi.fn(async () => []),
}));

import { importSpotifyHistory } from '../services/spotifyImport.js';
import timelineRoutes from './timeline.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/timeline', timelineRoutes);
  app.use(errorMiddleware);
  return app;
}

// Build a minimal multipart/form-data body with one file part + optional fields.
function multipart(fields, file) {
  const boundary = '----portostest' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [name, value] of Object.entries(fields || {})) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  }
  if (file) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`,
    ));
    parts.push(Buffer.from(file.content));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

describe('timeline import routes', () => {
  let app;
  beforeEach(() => { app = makeApp(); vi.clearAllMocks(); });

  it('POST /import/spotify parses the upload and calls the importer (real import)', async () => {
    const { boundary, body } = multipart(
      { preview: 'false' },
      { filename: 'history.json', contentType: 'application/json', content: '[]' },
    );
    const r = await request(app).post('/api/timeline/import/spotify')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body.recorded).toBe(2);
    expect(importSpotifyHistory).toHaveBeenCalledWith(
      expect.objectContaining({ originalname: 'history.json' }),
      { dryRun: false },
    );
  });

  it('honors preview=true as a dry run', async () => {
    const { boundary, body } = multipart(
      { preview: 'true' },
      { filename: 'history.json', contentType: 'application/json', content: '[]' },
    );
    const r = await request(app).post('/api/timeline/import/spotify')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body.dryRun).toBe(true);
    expect(r.body.recorded).toBe(0);
    expect(importSpotifyHistory).toHaveBeenCalledWith(expect.anything(), { dryRun: true });
  });

  it('defaults preview to false when the field is absent', async () => {
    const { boundary, body } = multipart(
      {},
      { filename: 'export.zip', contentType: 'application/zip', content: 'PK...' },
    );
    const r = await request(app).post('/api/timeline/import/spotify')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(200);
    expect(importSpotifyHistory).toHaveBeenCalledWith(expect.anything(), { dryRun: false });
  });

  it('rejects a disallowed file type with 400', async () => {
    const { boundary, body } = multipart(
      {},
      { filename: 'notes.txt', contentType: 'text/plain', content: 'hi' },
    );
    const r = await request(app).post('/api/timeline/import/spotify')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(400);
    expect(importSpotifyHistory).not.toHaveBeenCalled();
  });

  it('400s when no file part is present', async () => {
    const { boundary, body } = multipart({ preview: 'false' }, null);
    const r = await request(app).post('/api/timeline/import/spotify')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(r.status).toBe(400);
    expect(importSpotifyHistory).not.toHaveBeenCalled();
  });
});

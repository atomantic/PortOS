import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/sprites/records.js', () => ({
  listRecords: vi.fn(async () => [{ id: 'pioneer', kind: 'character', name: 'Pioneer' }]),
  getRecordWithAssets: vi.fn(),
  createRecord: vi.fn(async (input, id) => ({ id, ...input })),
  updateRecord: vi.fn(async (id, patch) => ({ id, ...patch })),
  deleteRecord: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../services/sprites/importer.js', () => ({
  importFromSource: vi.fn(async () => ({ results: [], totals: { subjects: 0, files: 0, verified: 0, errors: 0 } })),
}));

vi.mock('../services/sprites/reference.js', () => ({
  getReferenceSet: vi.fn(async () => ({ manifest: null, candidates: [] })),
  startReferenceGeneration: vi.fn(async () => ({ jobId: 'j1', mode: 'codex', target: 'main', anchorId: 'walk-south' })),
  lockReference: vi.fn(async () => ({ manifest: { status: 'in-progress' }, candidates: [] })),
}));

import * as records from '../services/sprites/records.js';
import * as importer from '../services/sprites/importer.js';
import * as reference from '../services/sprites/reference.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import spriteRoutes from './sprites.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sprites', spriteRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('sprites routes', () => {
  let app;
  beforeEach(() => { app = makeApp(); vi.clearAllMocks(); });

  it('GET / returns the record list', async () => {
    const r = await request(app).get('/api/sprites');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ id: 'pioneer', kind: 'character', name: 'Pioneer' }]);
  });

  it('POST / creates a character, slugifying the name into an id', async () => {
    const r = await request(app).post('/api/sprites').send({ name: 'Trail Hand #2' });
    expect(r.status).toBe(201);
    expect(records.createRecord).toHaveBeenCalledWith(
      { kind: 'character', name: 'Trail Hand #2', spec: null },
      'trail-hand-2',
    );
  });

  it('POST / honors an explicit id and rejects an invalid one', async () => {
    await request(app).post('/api/sprites').send({ name: 'Hero', id: 'hero-alt' });
    expect(records.createRecord).toHaveBeenCalledWith(expect.anything(), 'hero-alt');

    const bad = await request(app).post('/api/sprites').send({ name: 'Hero', id: 'Not A Slug' });
    expect(bad.status).toBe(400);
  });

  it('POST / 400s a name that slugifies to nothing', async () => {
    const r = await request(app).post('/api/sprites').send({ name: '!!!' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/explicit id/);
  });

  it('GET /:id returns record + assets + reference set for characters', async () => {
    records.getRecordWithAssets.mockResolvedValueOnce({
      record: { id: 'pioneer', kind: 'character' },
      assets: [{ path: 'reference/main.png', size: 10, mtime: 1 }],
    });
    const r = await request(app).get('/api/sprites/pioneer');
    expect(r.status).toBe(200);
    expect(r.body.record.id).toBe('pioneer');
    expect(r.body.assets).toHaveLength(1);
    expect(r.body.reference).toEqual({ manifest: null, candidates: [] });
    expect(reference.getReferenceSet).toHaveBeenCalledWith('pioneer');
  });

  it('GET /:id skips the reference set for props records', async () => {
    records.getRecordWithAssets.mockResolvedValueOnce({
      record: { id: 'crates', kind: 'props' }, assets: [],
    });
    const r = await request(app).get('/api/sprites/crates');
    expect(r.status).toBe(200);
    expect(r.body.reference).toBeNull();
    expect(reference.getReferenceSet).not.toHaveBeenCalled();
  });

  it('GET /:id 404s on an unknown record', async () => {
    records.getRecordWithAssets.mockResolvedValueOnce(null);
    const r = await request(app).get('/api/sprites/ghost');
    expect(r.status).toBe(404);
  });

  it('POST /import validates and forwards the parsed input', async () => {
    const r = await request(app).post('/api/sprites/import')
      .send({ sourceRoot: '/tmp/src', includeProps: false });
    expect(r.status).toBe(200);
    expect(importer.importFromSource).toHaveBeenCalledWith({ sourceRoot: '/tmp/src', includeProps: false });
  });

  it('POST /import rejects a missing sourceRoot', async () => {
    const r = await request(app).post('/api/sprites/import').send({});
    expect(r.status).toBe(400);
    expect(importer.importFromSource).not.toHaveBeenCalled();
  });

  it('POST /:id/reference/generate validates and forwards (JSON, no upload)', async () => {
    const r = await request(app).post('/api/sprites/pioneer/reference/generate')
      .send({ target: 'main', designPrompt: 'a ranger', mode: 'codex' });
    expect(r.status).toBe(200);
    expect(r.body.jobId).toBe('j1');
    expect(reference.startReferenceGeneration).toHaveBeenCalledWith(
      'pioneer', { target: 'main', designPrompt: 'a ranger', mode: 'codex' }, null,
    );
  });

  it('POST /:id/reference/generate rejects south and unknown targets', async () => {
    for (const target of ['south', 'up', '']) {
      const r = await request(app).post('/api/sprites/pioneer/reference/generate').send({ target });
      expect(r.status, target).toBe(400);
    }
    expect(reference.startReferenceGeneration).not.toHaveBeenCalled();
  });

  it('POST /:id/reference/generate rejects a non-queueable mode', async () => {
    const r = await request(app).post('/api/sprites/pioneer/reference/generate')
      .send({ target: 'main', mode: 'external' });
    expect(r.status).toBe(400);
  });

  it('POST /:id/reference/lock validates and forwards', async () => {
    const r = await request(app).post('/api/sprites/pioneer/reference/lock')
      .send({ target: 'east', candidate: 'reference/candidates/walk-east-candidate-01.png' });
    expect(r.status).toBe(200);
    expect(reference.lockReference).toHaveBeenCalledWith(
      'pioneer', { target: 'east', candidate: 'reference/candidates/walk-east-candidate-01.png' },
    );
  });

  it('POST /:id/reference/lock rejects a missing candidate', async () => {
    const r = await request(app).post('/api/sprites/pioneer/reference/lock').send({ target: 'east' });
    expect(r.status).toBe(400);
  });

  it('PATCH /:id accepts the three standard chroma keys and null', async () => {
    for (const chromaKey of ['#FF00FF', '#00FF00', '#0000FF', null]) {
      const r = await request(app).patch('/api/sprites/pioneer').send({ chromaKey });
      expect(r.status, String(chromaKey)).toBe(200);
    }
  });

  it('PATCH /:id rejects hex colors outside the three-key set', async () => {
    for (const chromaKey of ['#123456', 'magenta', '#ff00ff']) {
      const r = await request(app).patch('/api/sprites/pioneer').send({ chromaKey });
      expect(r.status, chromaKey).toBe(400);
    }
    expect(records.updateRecord).not.toHaveBeenCalled();
  });

  it('DELETE /:id soft-deletes', async () => {
    const r = await request(app).delete('/api/sprites/pioneer');
    expect(r.status).toBe(200);
    expect(records.deleteRecord).toHaveBeenCalledWith('pioneer');
  });
});

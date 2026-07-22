import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/sprites/records.js', () => ({
  listRecords: vi.fn(async () => [{ id: 'pioneer', kind: 'character', name: 'Pioneer' }]),
  getRecord: vi.fn(),
  updateRecord: vi.fn(async (id, patch) => ({ id, ...patch })),
  deleteRecord: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../services/sprites/paths.js', () => ({
  listSpriteAssets: vi.fn(async () => [{ path: 'reference/main.png', size: 10, mtime: 1 }]),
}));

vi.mock('../services/sprites/importer.js', () => ({
  importFromSource: vi.fn(async () => ({ results: [], totals: { subjects: 0, files: 0, verified: 0, errors: 0 } })),
}));

import * as records from '../services/sprites/records.js';
import * as paths from '../services/sprites/paths.js';
import * as importer from '../services/sprites/importer.js';
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

  it('GET /:id returns record + asset listing', async () => {
    records.getRecord.mockResolvedValueOnce({ id: 'pioneer', kind: 'character' });
    const r = await request(app).get('/api/sprites/pioneer');
    expect(r.status).toBe(200);
    expect(r.body.record.id).toBe('pioneer');
    expect(r.body.assets).toHaveLength(1);
    expect(records.getRecord).toHaveBeenCalledWith('pioneer');
    expect(paths.listSpriteAssets).toHaveBeenCalledWith('pioneer');
  });

  it('GET /:id 404s on an unknown record', async () => {
    records.getRecord.mockResolvedValueOnce(null);
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

  it('PATCH /:id validates the whitelist patch', async () => {
    const r = await request(app).patch('/api/sprites/pioneer').send({ chromaKey: '#00FF00', notes: null });
    expect(r.status).toBe(200);
    expect(records.updateRecord).toHaveBeenCalledWith('pioneer', { chromaKey: '#00FF00', notes: null });
  });

  it('PATCH /:id rejects a malformed chroma key', async () => {
    const r = await request(app).patch('/api/sprites/pioneer').send({ chromaKey: 'magenta' });
    expect(r.status).toBe(400);
  });

  it('DELETE /:id soft-deletes', async () => {
    const r = await request(app).delete('/api/sprites/pioneer');
    expect(r.status).toBe(200);
    expect(records.deleteRecord).toHaveBeenCalledWith('pioneer');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/sprites/records.js', () => ({
  listRecords: vi.fn(async () => [{ id: 'pioneer', kind: 'character', name: 'Pioneer' }]),
  getRecordWithAssets: vi.fn(),
  createCharacter: vi.fn(async (input) => ({ id: input.id || 'derived', kind: 'character', ...input })),
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
  patchSpriteRecord: vi.fn(async (id, patch) => ({ id, ...patch })),
}));

vi.mock('../services/sprites/walk.js', () => ({
  getWalkState: vi.fn(async () => ({ runs: [], selection: null, walkSet: null })),
  startWalkGeneration: vi.fn(async () => ({ jobId: 'v1', runId: 'walk-east-0a1b2c3d', direction: 'east', duration: 6 })),
  approveWalkDirection: vi.fn(async () => ({ runs: [], selection: { status: 'in-progress' }, walkSet: null })),
  rerunWalkPostprocess: vi.fn(async () => ({ id: 'walk-east-0a1b2c3d', status: 'candidate' })),
}));

vi.mock('../services/sprites/walkTrims.js', () => ({
  saveLoopTrim: vi.fn(async () => ({ strip: 'walk/trims/t-v001-strip.png', loop: 'walk/trims/t-v001.gif', manifest: 'walk/trims/t-v001.json', frameCount: 3, disabledFrameCount: 1 })),
}));

import * as records from '../services/sprites/records.js';
import * as importer from '../services/sprites/importer.js';
import * as reference from '../services/sprites/reference.js';
import * as walk from '../services/sprites/walk.js';
import * as walkTrims from '../services/sprites/walkTrims.js';
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

  it('POST / validates and delegates to createCharacter', async () => {
    const r = await request(app).post('/api/sprites').send({ name: 'Trail Hand #2' });
    expect(r.status).toBe(201);
    expect(records.createCharacter).toHaveBeenCalledWith({ name: 'Trail Hand #2' });
  });

  it('POST / rejects an invalid explicit id at the schema', async () => {
    const bad = await request(app).post('/api/sprites').send({ name: 'Hero', id: 'Not A Slug' });
    expect(bad.status).toBe(400);
    expect(records.createCharacter).not.toHaveBeenCalled();
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

  // Build a multipart/form-data body with one file part + text fields —
  // exercises the real streamMultipart path (the fileFilter signature bug
  // class is invisible to JSON-only tests).
  const buildMultipart = (boundary, { fileBytes = Buffer.from('\x89PNGfake'), mime = 'image/png', fields = {} } = {}) => {
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="referenceImage"; filename="design.png"\r\nContent-Type: ${mime}\r\n\r\n`));
    parts.push(fileBytes);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    return Buffer.concat(parts);
  };

  it('POST /:id/reference/generate accepts a multipart design-image upload for main', async () => {
    const boundary = '----spritetest';
    const res = await request(app)
      .post('/api/sprites/pioneer/reference/generate')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(buildMultipart(boundary, { fields: { target: 'main', designPrompt: 'a ranger' } }));
    expect(res.status).toBe(200);
    expect(reference.startReferenceGeneration).toHaveBeenCalledWith(
      'pioneer',
      expect.objectContaining({ target: 'main', designPrompt: 'a ranger' }),
      expect.objectContaining({ originalname: 'design.png', tempPath: expect.any(String) }),
    );
  });

  it('POST /:id/reference/generate rejects an upload for a non-main target', async () => {
    const boundary = '----spritetest2';
    const res = await request(app)
      .post('/api/sprites/pioneer/reference/generate')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(buildMultipart(boundary, { fields: { target: 'east' } }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UPLOAD_MAIN_ONLY');
    expect(reference.startReferenceGeneration).not.toHaveBeenCalled();
  });

  it('POST /:id/reference/generate rejects a non-image mime upload', async () => {
    const boundary = '----spritetest3';
    const res = await request(app)
      .post('/api/sprites/pioneer/reference/generate')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(buildMultipart(boundary, { mime: 'application/zip', fields: { target: 'main' } }));
    expect(res.status).toBe(400);
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

  it('PATCH /:id accepts the three standard chroma keys and null, delegating to the lock-aware patch', async () => {
    for (const chromaKey of ['#FF00FF', '#00FF00', '#0000FF', null]) {
      const r = await request(app).patch('/api/sprites/pioneer').send({ chromaKey });
      expect(r.status, String(chromaKey)).toBe(200);
    }
    expect(reference.patchSpriteRecord).toHaveBeenCalledTimes(4);
    expect(reference.patchSpriteRecord).toHaveBeenLastCalledWith('pioneer', { chromaKey: null });
  });

  it('PATCH /:id surfaces the service 409 for a post-lock chroma-key change', async () => {
    const err = Object.assign(new Error('Chroma key is frozen with the locked reference set'), { status: 409, code: 'CHROMA_KEY_LOCKED' });
    reference.patchSpriteRecord.mockRejectedValueOnce(err);
    const r = await request(app).patch('/api/sprites/pioneer').send({ chromaKey: '#00FF00' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CHROMA_KEY_LOCKED');
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

  it('GET /:id includes the walk state for characters only', async () => {
    records.getRecordWithAssets.mockResolvedValueOnce({
      record: { id: 'pioneer', kind: 'character' }, assets: [],
    });
    const r = await request(app).get('/api/sprites/pioneer');
    expect(r.body.walk).toEqual({ runs: [], selection: null, walkSet: null });
    expect(walk.getWalkState).toHaveBeenCalledWith('pioneer');

    records.getRecordWithAssets.mockResolvedValueOnce({
      record: { id: 'crates', kind: 'props' }, assets: [],
    });
    const props = await request(app).get('/api/sprites/crates');
    expect(props.body.walk).toBeNull();
  });

  it('POST /:id/walk/generate validates direction and duration', async () => {
    const r = await request(app).post('/api/sprites/pioneer/walk/generate')
      .send({ direction: 'east', duration: 10 });
    expect(r.status).toBe(200);
    expect(walk.startWalkGeneration).toHaveBeenCalledWith('pioneer', { direction: 'east', duration: 10 });

    expect((await request(app).post('/api/sprites/pioneer/walk/generate')
      .send({ direction: 'up' })).status).toBe(400);
    expect((await request(app).post('/api/sprites/pioneer/walk/generate')
      .send({ direction: 'east', duration: 7 })).status).toBe(400);
    // south is animatable (its anchor is the frozen main).
    expect((await request(app).post('/api/sprites/pioneer/walk/generate')
      .send({ direction: 'south' })).status).toBe(200);
  });

  it('POST /:id/walk/approve validates the run id shape', async () => {
    const r = await request(app).post('/api/sprites/pioneer/walk/approve')
      .send({ direction: 'east', runId: 'walk-east-0a1b2c3d' });
    expect(r.status).toBe(200);
    expect(walk.approveWalkDirection).toHaveBeenCalledWith('pioneer', { direction: 'east', runId: 'walk-east-0a1b2c3d' });

    expect((await request(app).post('/api/sprites/pioneer/walk/approve')
      .send({ direction: 'east', runId: '../escape' })).status).toBe(400);
    expect(walk.approveWalkDirection).toHaveBeenCalledOnce();
  });

  it('POST /:id/walk/postprocess delegates the rerun', async () => {
    const r = await request(app).post('/api/sprites/pioneer/walk/postprocess')
      .send({ runId: 'walk-east-0a1b2c3d' });
    expect(r.status).toBe(200);
    expect(walk.rerunWalkPostprocess).toHaveBeenCalledWith('pioneer', { runId: 'walk-east-0a1b2c3d' });
  });

  it('POST /:id/walk/trim validates and 201s', async () => {
    const payload = { runId: 'walk-east-0a1b2c3d', enabledColumns: [0, 2] };
    const r = await request(app).post('/api/sprites/pioneer/walk/trim').send(payload);
    expect(r.status).toBe(201);
    expect(walkTrims.saveLoopTrim).toHaveBeenCalledWith('pioneer', payload);

    expect((await request(app).post('/api/sprites/pioneer/walk/trim')
      .send({ ...payload, slug: 'Bad Slug!' })).status).toBe(400);
    expect((await request(app).post('/api/sprites/pioneer/walk/trim')
      .send({ ...payload, enabledColumns: [0] })).status).toBe(400);
    expect((await request(app).post('/api/sprites/pioneer/walk/trim')
      .send({ ...payload, enabledColumns: [0, 0, 2] })).status).toBe(400);
    expect((await request(app).post('/api/sprites/pioneer/walk/trim')
      .send({ runId: '../escape', enabledColumns: [0, 2] })).status).toBe(400);
    expect(walkTrims.saveLoopTrim).toHaveBeenCalledOnce();
  });
});

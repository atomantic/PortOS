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
  listReferenceSources: vi.fn(async () => [{ id: 'pioneer', name: 'Pioneer', kind: 'character', path: 'reference/pioneer-walk-south-v1.png' }]),
  forkSprite: vi.fn(async (sourceId, body) => ({ record: { id: 'pioneer-fork', kind: 'character', name: body.name }, jobId: 'j1', mode: 'codex', target: 'main', anchorId: 'walk-south' })),
}));

vi.mock('../services/sprites/assetPrompt.js', () => ({
  resolveSpriteAssetPrompt: vi.fn(async () => ({ prompt: 'the built prompt', designPrompt: 'a knight', source: 'candidate' })),
}));

vi.mock('../services/sprites/walk.js', () => ({
  getWalkState: vi.fn(async () => ({ runs: [], selection: null, walkSet: null })),
  startWalkGeneration: vi.fn(async () => ({ jobId: 'v1', runId: 'walk-east-0a1b2c3d', direction: 'east', duration: 6 })),
  approveWalkDirection: vi.fn(async () => ({ runs: [], selection: { status: 'in-progress' }, walkSet: null })),
  rerunWalkPostprocess: vi.fn(async () => ({ id: 'walk-east-0a1b2c3d', status: 'candidate' })),
  unlockWalkSet: vi.fn(async () => ({ runs: [], selection: { status: 'in-progress' }, walkSet: null })),
  reopenWalkDirection: vi.fn(async () => ({ runs: [], selection: { status: 'in-progress' }, walkSet: null })),
}));

vi.mock('../services/sprites/walkTrims.js', () => ({
  saveLoopTrim: vi.fn(async () => ({ strip: 'walk/trims/t-v001-strip.png', loop: 'walk/trims/t-v001.gif', manifest: 'walk/trims/t-v001.json', frameCount: 3, disabledFrameCount: 1 })),
}));

vi.mock('../services/sprites/atlas.js', () => ({
  compileAtlas: vi.fn(async () => ({ created: true, version: 1, atlasPath: 'runtime/v1/pioneer-animation-atlas-v1.png' })),
  getAtlasState: vi.fn(async () => ({ current: null, publications: [] })),
}));

vi.mock('../services/sprites/publish.js', () => ({
  setPublishBinding: vi.fn(async (id, binding) => ({ id, publishBinding: binding })),
  publishAtlas: vi.fn(async () => ({ published: true, publication: { version: 1 } })),
}));

vi.mock('../services/sprites/assets.js', () => ({
  deleteSpriteAsset: vi.fn(async (id, path) => ({ deleted: true, removed: path })),
}));

import * as records from '../services/sprites/records.js';
import * as importer from '../services/sprites/importer.js';
import * as reference from '../services/sprites/reference.js';
import * as assetPrompt from '../services/sprites/assetPrompt.js';
import * as walk from '../services/sprites/walk.js';
import * as walkTrims from '../services/sprites/walkTrims.js';
import * as atlas from '../services/sprites/atlas.js';
import * as publish from '../services/sprites/publish.js';
import * as assets from '../services/sprites/assets.js';
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

  it('POST / threads the noun kind through to createCharacter (#2932)', async () => {
    const r = await request(app).post('/api/sprites').send({ name: 'Saloon', kind: 'place' });
    expect(r.status).toBe(201);
    expect(records.createCharacter).toHaveBeenCalledWith({ name: 'Saloon', kind: 'place' });
  });

  it('POST / rejects an unknown kind at the schema', async () => {
    const bad = await request(app).post('/api/sprites').send({ name: 'Hero', kind: 'weapon' });
    expect(bad.status).toBe(400);
    expect(records.createCharacter).not.toHaveBeenCalled();
  });

  it('GET /reference-sources lists lockable reference sprites (before /:id)', async () => {
    const r = await request(app).get('/api/sprites/reference-sources');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ id: 'pioneer', name: 'Pioneer', kind: 'character', path: 'reference/pioneer-walk-south-v1.png' }]);
    expect(reference.listReferenceSources).toHaveBeenCalled();
    // The literal path must not be swallowed by the /:id route.
    expect(records.getRecordWithAssets).not.toHaveBeenCalled();
  });

  it('GET /:id/asset-prompt resolves an asset prompt by record-relative path', async () => {
    const r = await request(app).get(`/api/sprites/pioneer/asset-prompt?path=${encodeURIComponent('reference/candidates/walk-south-candidate-01.png')}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ prompt: 'the built prompt', designPrompt: 'a knight', source: 'candidate' });
    expect(assetPrompt.resolveSpriteAssetPrompt).toHaveBeenCalledWith('pioneer', 'reference/candidates/walk-south-candidate-01.png');
    // Two segments — the single-segment /:id GET must not swallow it.
    expect(records.getRecordWithAssets).not.toHaveBeenCalled();
  });

  it('GET /:id/asset-prompt rejects a missing path at the schema', async () => {
    const bad = await request(app).get('/api/sprites/pioneer/asset-prompt');
    expect(bad.status).toBe(400);
    expect(assetPrompt.resolveSpriteAssetPrompt).not.toHaveBeenCalled();
  });

  it('POST /:id/fork validates and delegates to forkSprite', async () => {
    const r = await request(app).post('/api/sprites/pioneer/fork')
      .send({ name: 'Pioneer Fork', designPrompt: 'now with a red coat' });
    expect(r.status).toBe(201);
    expect(r.body.record.id).toBe('pioneer-fork');
    expect(reference.forkSprite).toHaveBeenCalledWith('pioneer', expect.objectContaining({ name: 'Pioneer Fork', designPrompt: 'now with a red coat' }));
  });

  it('POST /:id/fork rejects a missing design prompt at the schema', async () => {
    const bad = await request(app).post('/api/sprites/pioneer/fork').send({ name: 'Pioneer Fork' });
    expect(bad.status).toBe(400);
    expect(reference.forkSprite).not.toHaveBeenCalled();
  });

  it('POST /:id/reference/generate accepts a gallery/sprite seed source in JSON', async () => {
    const r = await request(app).post('/api/sprites/pioneer/reference/generate')
      .send({ target: 'main', designPrompt: 'x', initImageSpriteId: 'trailhand' });
    expect(r.status).toBe(200);
    expect(reference.startReferenceGeneration).toHaveBeenCalledWith(
      'pioneer', expect.objectContaining({ target: 'main', initImageSpriteId: 'trailhand' }), null,
    );
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

  it('POST /:id/reference/generate forwards an anchor correction prompt through the schema', async () => {
    const r = await request(app).post('/api/sprites/pioneer/reference/generate')
      .send({ target: 'north-east', correctionPrompt: 'no pocket on the right sleeve', mode: 'codex' });
    expect(r.status).toBe(200);
    // The field must survive validation — Zod strips unknown keys, so a dropped
    // schema field would silently break the feature at the wire.
    expect(reference.startReferenceGeneration).toHaveBeenCalledWith(
      'pioneer',
      expect.objectContaining({ target: 'north-east', correctionPrompt: 'no pocket on the right sleeve' }),
      null,
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

  it('POST /:id/reference/generate rejects an upload for main — the sheet is the only seedable target', async () => {
    // #2996: the main derives from the locked turnaround, so a seed sent with it
    // has nowhere to go. Accepting one silently discarded it.
    const boundary = '----spritetest';
    const res = await request(app)
      .post('/api/sprites/pioneer/reference/generate')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(buildMultipart(boundary, { fields: { target: 'main', designPrompt: 'a ranger' } }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UPLOAD_TURNAROUND_ONLY');
    expect(reference.startReferenceGeneration).not.toHaveBeenCalled();
  });

  it('POST /:id/reference/generate accepts a multipart design-image upload for the turnaround', async () => {
    const boundary = '----spritetest3';
    const res = await request(app)
      .post('/api/sprites/pioneer/reference/generate')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(buildMultipart(boundary, { fields: { target: 'turnaround', designPrompt: 'a ranger' } }));
    expect(res.status).toBe(200);
    expect(reference.startReferenceGeneration).toHaveBeenCalledWith(
      'pioneer',
      expect.objectContaining({ target: 'turnaround', designPrompt: 'a ranger' }),
      expect.objectContaining({ originalname: 'design.png', tempPath: expect.any(String) }),
    );
  });

  it('POST /:id/reference/generate rejects an upload for a directional-anchor target', async () => {
    const boundary = '----spritetest2';
    const res = await request(app)
      .post('/api/sprites/pioneer/reference/generate')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .send(buildMultipart(boundary, { fields: { target: 'east' } }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UPLOAD_TURNAROUND_ONLY');
    expect(reference.startReferenceGeneration).not.toHaveBeenCalled();
  });

  it('POST /:id/reference/generate + /lock accept the turnaround target', async () => {
    const gen = await request(app)
      .post('/api/sprites/pioneer/reference/generate')
      .send({ target: 'turnaround', designPrompt: 'a ranger' });
    expect(gen.status).toBe(200);
    expect(reference.startReferenceGeneration).toHaveBeenCalledWith(
      'pioneer', { target: 'turnaround', designPrompt: 'a ranger' }, null,
    );
    const lock = await request(app)
      .post('/api/sprites/pioneer/reference/lock')
      .send({ target: 'turnaround', candidate: 'reference/candidates/turnaround-candidate-01.png' });
    expect(lock.status).toBe(200);
    expect(reference.lockReference).toHaveBeenCalledWith(
      'pioneer', { target: 'turnaround', candidate: 'reference/candidates/turnaround-candidate-01.png' },
    );
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

  it('DELETE /:id/assets deletes an on-disk asset by record-relative path', async () => {
    const r = await request(app)
      .delete(`/api/sprites/pioneer/assets?path=${encodeURIComponent('runtime/v9/pioneer-animation-atlas-v9.png')}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ deleted: true, removed: 'runtime/v9/pioneer-animation-atlas-v9.png' });
    expect(assets.deleteSpriteAsset).toHaveBeenCalledWith('pioneer', 'runtime/v9/pioneer-animation-atlas-v9.png');
  });

  it('DELETE /:id/assets rejects a missing path at the schema', async () => {
    const r = await request(app).delete('/api/sprites/pioneer/assets');
    expect(r.status).toBe(400);
    expect(assets.deleteSpriteAsset).not.toHaveBeenCalled();
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

  it('POST /:id/walk/generate forwards frame count + fps and bounds them', async () => {
    walk.startWalkGeneration.mockClear();
    const r = await request(app).post('/api/sprites/pioneer/walk/generate')
      .send({ direction: 'east', frameCount: 14, fps: 8 });
    expect(r.status).toBe(200);
    expect(walk.startWalkGeneration).toHaveBeenCalledWith('pioneer', { direction: 'east', frameCount: 14, fps: 8 });
    // Out-of-range count / fps are rejected by the schema.
    expect((await request(app).post('/api/sprites/pioneer/walk/generate')
      .send({ direction: 'east', frameCount: 32 })).status).toBe(400);
    expect((await request(app).post('/api/sprites/pioneer/walk/generate')
      .send({ direction: 'east', fps: 99 })).status).toBe(400);
  });

  it('POST /:id/walk/reopen validates the direction and delegates', async () => {
    const r = await request(app).post('/api/sprites/pioneer/walk/reopen')
      .send({ direction: 'east' });
    expect(r.status).toBe(200);
    expect(walk.reopenWalkDirection).toHaveBeenCalledWith('pioneer', { direction: 'east' });
    expect((await request(app).post('/api/sprites/pioneer/walk/reopen')
      .send({ direction: 'up' })).status).toBe(400);
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

  it('POST /:id/walk/postprocess delegates the rerun (with optional reprocess count/fps)', async () => {
    const r = await request(app).post('/api/sprites/pioneer/walk/postprocess')
      .send({ runId: 'walk-east-0a1b2c3d' });
    expect(r.status).toBe(200);
    expect(walk.rerunWalkPostprocess).toHaveBeenCalledWith('pioneer', { runId: 'walk-east-0a1b2c3d' });

    walk.rerunWalkPostprocess.mockClear();
    const r2 = await request(app).post('/api/sprites/pioneer/walk/postprocess')
      .send({ runId: 'walk-east-0a1b2c3d', frameCount: 16, fps: 6 });
    expect(r2.status).toBe(200);
    expect(walk.rerunWalkPostprocess).toHaveBeenCalledWith('pioneer', { runId: 'walk-east-0a1b2c3d', frameCount: 16, fps: 6 });
    expect((await request(app).post('/api/sprites/pioneer/walk/postprocess')
      .send({ runId: 'walk-east-0a1b2c3d', frameCount: 3 })).status).toBe(400);
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

  it('POST /:id/atlas/compile validates and delegates (geometry optional)', async () => {
    const r = await request(app).post('/api/sprites/pioneer/atlas/compile').send({});
    expect(r.status).toBe(200);
    expect(atlas.compileAtlas).toHaveBeenCalledWith('pioneer', {});

    const withGeometry = { geometry: { cellSize: 64, pivot: [32, 56] } };
    await request(app).post('/api/sprites/pioneer/atlas/compile').send(withGeometry);
    expect(atlas.compileAtlas).toHaveBeenLastCalledWith('pioneer', withGeometry);

    expect((await request(app).post('/api/sprites/pioneer/atlas/compile')
      .send({ geometry: { cellSize: 4 } })).status).toBe(400);
  });

  it('PUT /:id/publish-binding validates the binding shape and delegates', async () => {
    const binding = { appId: 'game-app', atlasDestPath: 'assets/sprites/hero/atlas.png' };
    const r = await request(app).put('/api/sprites/pioneer/publish-binding').send({ binding });
    expect(r.status).toBe(200);
    expect(publish.setPublishBinding).toHaveBeenCalledWith('pioneer', binding);

    // null clears the binding
    await request(app).put('/api/sprites/pioneer/publish-binding').send({ binding: null });
    expect(publish.setPublishBinding).toHaveBeenLastCalledWith('pioneer', null);

    // traversal / absolute destinations die at the schema
    expect((await request(app).put('/api/sprites/pioneer/publish-binding')
      .send({ binding: { ...binding, atlasDestPath: '../escape.png' } })).status).toBe(400);
    expect((await request(app).put('/api/sprites/pioneer/publish-binding')
      .send({ binding: { ...binding, atlasDestPath: '/abs.png' } })).status).toBe(400);
    expect((await request(app).put('/api/sprites/pioneer/publish-binding')
      .send({ binding: { ...binding, codeBinding: { path: 'src/Hero.cs', resourcePath: '' } } })).status).toBe(400);
    expect((await request(app).put('/api/sprites/pioneer/publish-binding')
      .send({ binding: { ...binding, atlasDestPath: 'assets/atlas.jpg' } })).status).toBe(400);
    expect(publish.setPublishBinding).toHaveBeenCalledTimes(2);
  });

  it('POST /:id/atlas/publish delegates to publishAtlas with the acknowledge flag', async () => {
    const r = await request(app).post('/api/sprites/pioneer/atlas/publish').send({});
    expect(r.status).toBe(200);
    expect(publish.publishAtlas).toHaveBeenCalledWith('pioneer', {});
    expect(r.body.published).toBe(true);

    await request(app).post('/api/sprites/pioneer/atlas/publish').send({ acknowledgeOverwrite: true });
    expect(publish.publishAtlas).toHaveBeenLastCalledWith('pioneer', { acknowledgeOverwrite: true });
  });
});

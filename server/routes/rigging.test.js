/**
 * The rigging routes' public boundary.
 *
 * The gate arithmetic lives in `retargetReport.test.js` and the publication contract in
 * `retarget.test.js`; what this suite pins is what only the route decides:
 *
 *  - the clip roster answers with its CoS-state coverage attached, so a caller does not
 *    re-derive the vocabulary;
 *  - a retarget request with no `clip` is a 400, never a run against an unnamed file;
 *  - `mode` DEFAULTS to the diagnostic one — the head-zone cleanup edits skin weights, so
 *    a request that says nothing must measure rather than write;
 *  - a measured refusal reaches the client as its sentence and its reason code, because
 *    that sentence is the product (a generic 500 would bury it).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware, ServerError } from '../lib/errorHandler.js';

vi.mock('../services/rigging/readiness.js', async (importOriginal) => ({
  ...(await importOriginal()),
  // Host-independent: the readiness probe spawns a real Blender import otherwise.
  getRiggingReadiness: vi.fn(async () => ({ ready: true, reason: null, interpreter: '/opt/envs/rigging/bin/python' })),
}));
vi.mock('../services/rigging/clipLibrary.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listClipSources: vi.fn(async () => []),
}));
vi.mock('../services/rigging/autoSkin.js', () => ({ rigImageTo3dModel: vi.fn() }));
vi.mock('../services/rigging/retarget.js', () => ({ retargetImageTo3dModel: vi.fn() }));

const clipLibrary = await import('../services/rigging/clipLibrary.js');
const { retargetImageTo3dModel } = await import('../services/rigging/retarget.js');
const { RETARGET_DEFAULTS } = await import('../services/rigging/retargetReport.js');
const routes = (await import('./rigging.js')).default;

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/rigging', routes);
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => { vi.clearAllMocks(); });

describe('rigging routes', () => {
  it('GET /readiness carries the retarget defaults so the client labels its own overrides', async () => {
    const res = await request(makeApp()).get('/api/rigging/readiness');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ready: true, retargetDefaults: RETARGET_DEFAULTS });
  });

  it('GET /clips answers the local roster with its CoS-state coverage attached', async () => {
    clipLibrary.listClipSources.mockResolvedValueOnce([
      { filename: 'Idle.glb', label: 'Idle', path: '/clips/Idle.glb', sizeBytes: 12, updatedAt: '2026-01-02T00:00:00.000Z' },
    ]);
    const res = await request(makeApp()).get('/api/rigging/clips');
    expect(res.status).toBe(200);
    expect(res.body.clips).toHaveLength(1);
    expect(res.body.coverage).toMatchObject({
      complete: false,
      coverageByState: expect.objectContaining({ thinking: { covered: true, clip: 'Idle' } }),
    });
  });

  it('GET /clips reports an empty roster as empty rather than as a missing answer', async () => {
    const res = await request(makeApp()).get('/api/rigging/clips');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ clips: [], coverage: { complete: false } });
  });

  it('POST /models/:id/retarget defaults to diagnostic mode, so nothing is rewritten unasked', async () => {
    retargetImageTo3dModel.mockResolvedValueOnce({ id: 'image3d-example' });
    const res = await request(makeApp())
      .post('/api/rigging/models/image3d-example/retarget').send({ clip: 'Walk.glb' });
    expect(res.status).toBe(200);
    expect(retargetImageTo3dModel).toHaveBeenCalledWith('image3d-example', { clip: 'Walk.glb', mode: 'diagnostic' });
  });

  it('POST /models/:id/retarget passes an explicit write mode and cleanup cap through', async () => {
    retargetImageTo3dModel.mockResolvedValueOnce({ id: 'image3d-example' });
    await request(makeApp()).post('/api/rigging/models/image3d-example/retarget').send({
      clip: 'Walk.glb', clipName: 'Walk', mode: 'write', headCleanupFraction: 0.01,
    });
    expect(retargetImageTo3dModel).toHaveBeenCalledWith('image3d-example', {
      clip: 'Walk.glb', clipName: 'Walk', mode: 'write', headCleanupFraction: 0.01,
    });
  });

  it('POST /models/:id/retarget rejects a missing clip, an unknown mode, and an out-of-range cap', async () => {
    const bodies = [
      {},
      { clip: 'Walk.glb', mode: 'overwrite-everything' },
      { clip: 'Walk.glb', headCleanupFraction: 0.9 },
    ];
    for (const body of bodies) {
      const res = await request(makeApp()).post('/api/rigging/models/image3d-example/retarget').send(body);
      expect(res.status).toBe(400);
    }
    expect(retargetImageTo3dModel).not.toHaveBeenCalled();
  });

  it('POST /models/:id/retarget surfaces a measured refusal as its sentence and reason code', async () => {
    retargetImageTo3dModel.mockRejectedValueOnce(new ServerError(
      'The exported animation never moves: across 8 sampled frames no joint moved more than 0.00e+0 units.',
      { status: 422, code: 'RIGGING_RETARGET_GATE_FAILED', context: { reason: 'no-motion' } },
    ));
    const res = await request(makeApp())
      .post('/api/rigging/models/image3d-example/retarget').send({ clip: 'Walk.glb' });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('never moves');
    expect(res.body.code).toBe('RIGGING_RETARGET_GATE_FAILED');
  });
});

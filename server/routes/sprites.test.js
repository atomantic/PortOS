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
  setWalkTarget: vi.fn(async () => ({
    runs: [],
    selection: { status: 'in-progress' },
    walkSet: null,
    walkTarget: { track: 'walk', frameCount: 14, fps: 8, source: 'set' },
  })),
  unlockDirectionalAnchor: vi.fn(async () => ({
    manifest: { status: 'in-progress' },
    candidates: [],
    walkInvalidated: true,
  })),
  unlockMainReference: vi.fn(async () => ({
    manifest: { status: 'needs-main-reference' },
    candidates: [],
    walkInvalidated: true,
    scannerInvalidated: false,
  })),
  unlockTurnaroundReference: vi.fn(async () => ({
    manifest: { status: 'needs-turnaround' },
    candidates: [],
    walkInvalidatedDirections: ['south', 'east'],
  })),
  getWalkSourceFrames: vi.fn(async () => ({
    available: true,
    reason: null,
    frames: [{ index: 1, path: 'runs/walk-east-0a1b2c3d/generated/raw/source-0001.png' }],
    cycle: { windowStart: 2, windowLength: 12, windowStartFrame: 5, windowEndFrame: 17 },
    selectedSourceIndices: [5, 7],
    current: { frameCount: 8, fps: 12 },
    editable: true,
    lockReason: null,
  })),
}));

// One mock for every non-walk track (#3136) — the generic workflow the
// `/:id/tracks/:trackId/*` routes drive, echoing the track it was asked for so a
// test can assert the route resolved the right one.
vi.mock('../services/sprites/animationTrackWorkflow.js', () => ({
  // The service owns `definition` (the registry row it resolved), so the mock
  // supplies a stand-in rather than the route re-attaching it — that split is
  // what the GET assertion below is checking.
  getTrackState: vi.fn(async (track) => ({
    track, definition: { id: track, directional: track === 'scanner' }, runs: [], selection: null, set: null,
  })),
  startTrackGeneration: vi.fn(async (track) => ({ runId: `${track}-east-0a1b2c3d`, direction: 'east', duration: 6 })),
  approveTrackRun: vi.fn(async (track) => ({ track, runs: [], selection: { status: 'in-progress' }, set: null })),
}));

// Animation-type CRUD (#3153). The service owns every refusal (built-in, collision,
// in-use) and the derivation; these tests are about the ROUTES — ordering ahead of
// `/:id`, which schema gates which verb, and that the id/patch reach the service
// unchanged. The refusals themselves are asserted in animationTrackCrud.test.js.
vi.mock('../services/sprites/animationTrackCrud.js', () => ({
  listAnimationTracks: vi.fn(() => ({ tracks: [{ id: 'walk', builtin: true }], storePath: 'sprites/animation-tracks.json' })),
  createAnimationTrack: vi.fn(async (input) => ({ tracks: [{ id: input.id }], restartRequired: true })),
  updateAnimationTrack: vi.fn(async () => ({ tracks: [], restartRequired: true })),
  deleteAnimationTrack: vi.fn(async () => ({ tracks: [], restartRequired: true })),
  animationTrackStoreOrigin: vi.fn(async () => 'seed'),
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
import * as trackWorkflow from '../services/sprites/animationTrackWorkflow.js';
import * as trackCrud from '../services/sprites/animationTrackCrud.js';
import * as walkTrims from '../services/sprites/walkTrims.js';
import * as atlas from '../services/sprites/atlas.js';
import * as publish from '../services/sprites/publish.js';
import * as assets from '../services/sprites/assets.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cloudModelIdString } from '../lib/validation.js';
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

  it('GET / returns a bounded envelope when pagination is requested', async () => {
    records.listRecords.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, i) => ({ id: `sprite-${i}`, kind: 'character', name: `S${i}` }))
    );
    const r = await request(app).get('/api/sprites?limit=2&offset=1');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.items[0].id).toBe('sprite-1');
    expect(r.body.total).toBe(5);
    expect(r.body.limit).toBe(2);
    expect(r.body.offset).toBe(1);
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

  // Animation-type CRUD (#3153) — the authoring surface for the user-defined half
  // of the track registry.
  describe('animation-type CRUD', () => {
    it('GET /animation-tracks lists the registry and the store origin (before /:id)', async () => {
      const r = await request(app).get('/api/sprites/animation-tracks');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        tracks: [{ id: 'walk', builtin: true }],
        storePath: 'sprites/animation-tracks.json',
        origin: 'seed',
      });
      // The literal path must not be captured as a record id by the /:id GET.
      expect(records.getRecordWithAssets).not.toHaveBeenCalled();
    });

    it('POST /animation-tracks validates the authored subset and 201s', async () => {
      const body = {
        id: 'chest-opening',
        label: 'Chest opening',
        directional: false,
        kinds: ['object'],
        minFrameCount: 2,
        maxFrameCount: 8,
        defaultFrameCount: 4,
        minFps: 2,
        maxFps: 12,
        defaultFps: 6,
        promptTemplate: 'Animate the {{kind}} {{name}} opening once.',
      };
      const r = await request(app).post('/api/sprites/animation-tracks').send(body);
      expect(r.status).toBe(201);
      expect(r.body.restartRequired).toBe(true);
      expect(trackCrud.createAnimationTrack).toHaveBeenCalledWith(body);
      // The literal path must not be captured by POST / (create record).
      expect(records.createCharacter).not.toHaveBeenCalled();
    });

    const validBody = {
      id: 'chest-opening',
      label: 'Chest opening',
      directional: false,
      kinds: ['object'],
      minFrameCount: 2,
      maxFrameCount: 8,
      defaultFrameCount: 4,
      minFps: 2,
      maxFps: 12,
      defaultFps: 6,
      promptTemplate: 'Animate it.',
    };

    it('POST /animation-tracks rejects a DERIVED field supplied by the request', async () => {
      // These name files on disk and the publish-contract key, and the registry
      // requires them globally unique — accepting one from a request would let a typo
      // hand this track another's evidence chain, so `.strict()` refuses it by name
      // rather than silently stripping a field the user thinks they set.
      for (const extra of [
        { setKind: 'finalized-eight-direction-walk-set' },
        { selectionKind: 'reviewed-directional-walk-selection' },
        { contractFrameCountField: 'walkFrameCount' },
        { standaloneContract: true },
        { builtin: true },
      ]) {
        const bad = await request(app).post('/api/sprites/animation-tracks').send({ ...validBody, ...extra });
        expect(bad.status).toBe(400);
      }
      expect(trackCrud.createAnimationTrack).not.toHaveBeenCalled();
    });

    it('POST /animation-tracks rejects a malformed id, an unknown kind, and a missing prompt', async () => {
      const cases = [
        { ...validBody, id: 'Not A Slug' },
        { ...validBody, kinds: ['weapon'] },
        { ...validBody, kinds: [] },
        { ...validBody, promptTemplate: '' },
        { ...validBody, label: '' },
      ];
      for (const body of cases) {
        expect((await request(app).post('/api/sprites/animation-tracks').send(body)).status).toBe(400);
      }
      expect(trackCrud.createAnimationTrack).not.toHaveBeenCalled();
    });

    it('POST /animation-tracks rejects an out-of-order bounds triple at the schema', async () => {
      // Front-runs the registry's own cross-field rule so the form gets a per-field
      // 400 naming the default, instead of a whole-table 409.
      const bad = await request(app).post('/api/sprites/animation-tracks')
        .send({ ...validBody, minFrameCount: 6, defaultFrameCount: 4, maxFrameCount: 8 });
      expect(bad.status).toBe(400);
      expect(bad.body.context.details).toEqual([
        { path: 'defaultFrameCount', message: 'minFrameCount <= defaultFrameCount <= maxFrameCount is required' },
      ]);
      const badFps = await request(app).post('/api/sprites/animation-tracks')
        .send({ ...validBody, minFps: 2, defaultFps: 20, maxFps: 12 });
      expect(badFps.status).toBe(400);
      expect(badFps.body.context.details).toEqual([
        { path: 'defaultFps', message: 'minFps <= defaultFps <= maxFps is required' },
      ]);
      expect(trackCrud.createAnimationTrack).not.toHaveBeenCalled();
    });

    it('PUT /animation-tracks/:trackId takes a partial patch and threads the id through', async () => {
      const r = await request(app).put('/api/sprites/animation-tracks/chest-opening')
        .send({ label: 'Chest opens', maxFrameCount: 12 });
      expect(r.status).toBe(200);
      expect(trackCrud.updateAnimationTrack).toHaveBeenCalledWith('chest-opening', { label: 'Chest opens', maxFrameCount: 12 });
    });

    it('PUT /animation-tracks/:trackId refuses a rename and an empty patch', async () => {
      // Renaming would have to migrate the on-disk directories, every run record and
      // every manifest — so it is a delete-plus-create, and `id` in the patch is a
      // 400 naming the field rather than a silent no-op.
      expect((await request(app).put('/api/sprites/animation-tracks/chest-opening')
        .send({ id: 'chest-opens' })).status).toBe(400);
      expect((await request(app).put('/api/sprites/animation-tracks/chest-opening').send({})).status).toBe(400);
      expect(trackCrud.updateAnimationTrack).not.toHaveBeenCalled();
    });

    it('PUT /animation-tracks/:trackId rejects a malformed track id at the shape schema', async () => {
      expect((await request(app).put('/api/sprites/animation-tracks/Bad_Id').send({ label: 'x' })).status).toBe(400);
      expect(trackCrud.updateAnimationTrack).not.toHaveBeenCalled();
    });

    // The client's own suite mocks `apiSprites.js`, so it can never see a mismatch
    // between the body the drawer builds and the schema that has to accept it — which
    // is exactly how an `id` in the PUT patch (a hard 400 on every "Save changes")
    // shipped invisibly behind two green suites. These two assert the WIRE shapes the
    // drawer sends, against the real schemas.
    it('accepts the exact POST body the Animation types drawer builds', async () => {
      // Mirrors AnimationTypesDrawer's `form` — the authored subset plus `id`.
      const r = await request(app).post('/api/sprites/animation-tracks').send({
        id: 'jetpack-burst',
        label: 'Jetpack burst',
        directional: true,
        kinds: ['character'],
        minFrameCount: 2,
        maxFrameCount: 8,
        defaultFrameCount: 4,
        minFps: 2,
        maxFps: 12,
        defaultFps: 6,
        promptTemplate: 'Animate {{name}} firing a jetpack, facing {{direction}}.',
      });
      expect(r.status).toBe(201);
    });

    it('accepts the exact PUT body the drawer builds — the form MINUS the immutable id', async () => {
      // The drawer strips `id` before a PUT; if it ever stops, this fails here rather
      // than only in the browser.
      const r = await request(app).put('/api/sprites/animation-tracks/chest-opening').send({
        label: 'Chest opens',
        directional: false,
        kinds: ['object'],
        minFrameCount: 2,
        maxFrameCount: 12,
        defaultFrameCount: 4,
        minFps: 2,
        maxFps: 12,
        defaultFps: 6,
        promptTemplate: 'Animate the {{kind}} {{name}} opening once.',
      });
      expect(r.status).toBe(200);
    });

    it('DELETE /animation-tracks/:trackId delegates (and is not captured by DELETE /:id)', async () => {
      const r = await request(app).delete('/api/sprites/animation-tracks/chest-opening');
      expect(r.status).toBe(200);
      expect(trackCrud.deleteAnimationTrack).toHaveBeenCalledWith('chest-opening');
      expect(records.deleteRecord).not.toHaveBeenCalled();
    });
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

  // The two bodies ForkSpriteModal.jsx actually builds — full (an id typed and a
  // backend picked) and minimal (both omitted). The client suite mocks
  // apiSprites.js, so a schema that rejected or silently stripped one of these
  // keys would stay invisible behind two green suites; the case above only
  // proves a HAND-BUILT subset. Keep these in step with the client's
  // "ForkSpriteModal wire body" cases.
  it('POST /:id/fork accepts the exact body ForkSpriteModal sends', async () => {
    const modalBody = {
      name: 'Example Settler',
      id: 'example-settler',
      designPrompt: 'wearing a wide-brim hat',
      mode: 'grok',
      initImageStrength: 0.65,
    };
    const r = await request(app).post('/api/sprites/pioneer/fork').send(modalBody);
    expect(r.status).toBe(201);
    // Exact, not objectContaining: a stripped key must fail here.
    expect(reference.forkSprite).toHaveBeenCalledWith('pioneer', modalBody);
  });

  it('POST /:id/fork accepts the modal body with id and mode omitted', async () => {
    const modalBody = {
      name: 'Example Settler',
      designPrompt: 'wearing a wide-brim hat',
      initImageStrength: 0.65,
    };
    const r = await request(app).post('/api/sprites/pioneer/fork').send(modalBody);
    expect(r.status).toBe(201);
    expect(reference.forkSprite).toHaveBeenCalledWith('pioneer', modalBody);
  });

  it('POST /:id/fork rejects a missing design prompt at the schema', async () => {
    const bad = await request(app).post('/api/sprites/pioneer/fork').send({ name: 'Pioneer Fork' });
    expect(bad.status).toBe(400);
    expect(reference.forkSprite).not.toHaveBeenCalled();
  });

  it('fork, create, and update share the durable model-id validator', async () => {
    const invalidModelId = 'gpt image 1; rm';
    const validation = cloudModelIdString('model must be a valid model id').safeParse(invalidModelId);
    expect(validation.success).toBe(false);
    const expectedMessage = validation.error.issues[0].message;

    const attempts = [
      {
        response: await request(app).post('/api/sprites/pioneer/fork')
          .send({ name: 'Pioneer Fork', designPrompt: 'wearing a red coat', model: invalidModelId }),
        path: 'model',
      },
      {
        response: await request(app).post('/api/sprites')
          .send({ name: 'Pioneer Fork', imageModelId: invalidModelId }),
        path: 'imageModelId',
      },
      {
        response: await request(app).patch('/api/sprites/pioneer')
          .send({ imageModelId: invalidModelId }),
        path: 'imageModelId',
      },
    ];

    for (const { response, path } of attempts) {
      expect(response.status, path).toBe(400);
      expect(response.body.context.details).toContainEqual({ path, message: expectedMessage });
    }
    expect(reference.forkSprite).not.toHaveBeenCalled();
    expect(records.createCharacter).not.toHaveBeenCalled();
    expect(reference.patchSpriteRecord).not.toHaveBeenCalled();
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

  it('GET /:id returns the reference set for props records (ambient-loop identity root)', async () => {
    records.getRecordWithAssets.mockResolvedValueOnce({
      record: { id: 'crates', kind: 'props' }, assets: [],
    });
    const r = await request(app).get('/api/sprites/crates');
    expect(r.status).toBe(200);
    expect(r.body.reference).toEqual({ manifest: null, candidates: [] });
    expect(reference.getReferenceSet).toHaveBeenCalledWith('crates');
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
    // has nowhere to go — reject at the route rather than let it reach a service
    // that would have to discard it.
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

  it('POST /:id/reference/unlock accepts only turnaround-derived directions', async () => {
    const unlocked = await request(app).post('/api/sprites/pioneer/reference/unlock').send({ direction: 'east' });
    expect(unlocked.status).toBe(200);
    expect(unlocked.body.walkInvalidated).toBe(true);
    expect(walk.unlockDirectionalAnchor).toHaveBeenCalledWith('pioneer', { direction: 'east' });

    const south = await request(app).post('/api/sprites/pioneer/reference/unlock').send({ direction: 'south' });
    expect(south.status).toBe(400);
    expect(walk.unlockDirectionalAnchor).toHaveBeenCalledTimes(1);
  });

  it('POST /:id/reference/main/unlock reopens only the main reference chain', async () => {
    const unlocked = await request(app)
      .post('/api/sprites/pioneer/reference/main/unlock')
      .send();
    expect(unlocked.status).toBe(200);
    expect(unlocked.body.manifest.status).toBe('needs-main-reference');
    expect(walk.unlockMainReference).toHaveBeenCalledWith('pioneer');
  });

  it('POST /:id/reference/turnaround/unlock reopens the full dependent chain', async () => {
    const unlocked = await request(app)
      .post('/api/sprites/pioneer/reference/turnaround/unlock')
      .send();
    expect(unlocked.status).toBe(200);
    expect(unlocked.body.manifest.status).toBe('needs-turnaround');
    expect(unlocked.body.walkInvalidatedDirections).toEqual(['south', 'east']);
    expect(walk.unlockTurnaroundReference).toHaveBeenCalledWith('pioneer');
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

  it('GET /:id keys every non-walk track state by track id, per record kind (#3136)', async () => {
    records.getRecordWithAssets.mockResolvedValueOnce({
      record: { id: 'pioneer', kind: 'character' }, assets: [],
    });
    atlas.getAtlasState.mockResolvedValueOnce({
      current: {
        geometry: {
          columns: ['idle', 'walk-00', 'walk-01', 'walk-02', 'scanner'],
        },
      },
      publications: [],
    });
    const r = await request(app).get('/api/sprites/pioneer');
    expect(r.body.walk).toEqual({ runs: [], selection: null, walkSet: null });
    expect(walk.getWalkState).toHaveBeenCalledWith('pioneer');
    // This route resolves the LIVE registry, which since #3152 also holds
    // whatever tracks the operator authored — so assert the kind gate and the
    // keyed-by-id contract, not a snapshot of one install's track list. (Pinning
    // the exact array asserted that the developer running the suite had authored
    // no character tracks, and went red the day one did.)
    const characterTracks = r.body.trackDefinitions.map(({ id }) => id);
    expect(characterTracks).toEqual(expect.arrayContaining(['walk', 'scanner']));
    expect(characterTracks).not.toContain('ambient');
    expect(characterTracks[0]).toBe('walk');
    expect(r.body.trackDefinitions[0]).toMatchObject({
      id: 'walk',
      contractFrameCountField: 'walkFrameCount',
      standaloneContract: true,
    });
    expect(r.body.atlas.current.geometry.walkFrameCount).toBe(3);
    // A character carries scanner but NOT ambient, and `tracks` keys EVERY
    // non-walk track the kind carries by id — that equality is the contract, and
    // it holds whatever the registry contains. Each state passes through with the
    // `definition` (registry row) the service resolved, so the client renders the
    // track's label/bounds from data rather than mirroring them.
    expect(Object.keys(r.body.tracks)).toEqual(characterTracks.filter((id) => id !== 'walk'));
    expect(Object.keys(r.body.tracks)).toContain('scanner');
    expect(r.body.tracks.scanner).toMatchObject({
      track: 'scanner', runs: [], selection: null, set: null,
      definition: { id: 'scanner', directional: true },
    });
    expect(trackWorkflow.getTrackState).toHaveBeenCalledWith('scanner', 'pioneer');

    records.getRecordWithAssets.mockResolvedValueOnce({
      record: { id: 'crates', kind: 'props' }, assets: [],
    });
    const props = await request(app).get('/api/sprites/crates');
    // A props family has no gait, so no walk — and ambient, not scanner. The
    // whole point of keying by id: neither kind needs a route-level branch.
    expect(props.body.walk).toBeNull();
    const propsTracks = props.body.trackDefinitions.map(({ id }) => id);
    expect(propsTracks).toContain('ambient');
    expect(propsTracks).not.toContain('walk');
    expect(propsTracks).not.toContain('scanner');
    expect(Object.keys(props.body.tracks)).toEqual(propsTracks);
    expect(props.body.tracks.ambient).toMatchObject({
      track: 'ambient', definition: { id: 'ambient', directional: false },
    });
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

  it('POST /:id/tracks/:trackId/generate bounds each track against its OWN row (#3136)', async () => {
    trackWorkflow.startTrackGeneration.mockClear();
    const r = await request(app).post('/api/sprites/pioneer/tracks/scanner/generate')
      .send({ direction: 'east', frameCount: 4, fps: 6 });
    expect(r.status).toBe(200);
    expect(trackWorkflow.startTrackGeneration).toHaveBeenCalledWith('scanner', 'pioneer', { direction: 'east', frameCount: 4, fps: 6 });
    // Scanner's own 2–8 / 2–12, not walk's 6–16 / 4–24.
    expect((await request(app).post('/api/sprites/pioneer/tracks/scanner/generate')
      .send({ direction: 'east', frameCount: 9 })).status).toBe(400);
    expect((await request(app).post('/api/sprites/pioneer/tracks/scanner/generate')
      .send({ direction: 'east', fps: 13 })).status).toBe(400);
    // …and the SAME route bounds ambient against ITS 2–6, which is the property
    // that makes a user-defined track's schema come for free.
    expect((await request(app).post('/api/sprites/crates/tracks/ambient/generate')
      .send({ frameCount: 3 })).status).toBe(200);
    expect((await request(app).post('/api/sprites/crates/tracks/ambient/generate')
      .send({ frameCount: 7 })).status).toBe(400);
  });

  it('POST /:id/tracks/:trackId/generate requires a facing only for a directional track', async () => {
    // Without this the service would 409 "lock the undefined anchor", blaming
    // the reference set for a missing request field.
    expect((await request(app).post('/api/sprites/pioneer/tracks/scanner/generate').send({})).status).toBe(400);
    // A non-directional track derives row 0 server-side, so no facing is needed.
    expect((await request(app).post('/api/sprites/crates/tracks/ambient/generate').send({})).status).toBe(200);
  });

  it('POST /:id/tracks/:trackId/* refuses an unknown track and walk itself', async () => {
    trackWorkflow.startTrackGeneration.mockClear();
    // Well-formed but unregistered → 404 naming the known tracks, not a bare 400
    // that reads as "your request was malformed".
    const unknown = await request(app).post('/api/sprites/pioneer/tracks/jetpack/generate').send({ direction: 'east' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toMatch(/Unknown animation track 'jetpack'/);
    // Malformed id → 400 from the shape schema.
    expect((await request(app).post('/api/sprites/pioneer/tracks/Bad_Id/generate').send({ direction: 'east' })).status).toBe(400);
    // Walk keeps its own endpoints (reprocess/trims/targets live there), so the
    // generic route refuses it rather than writing walk state through a service
    // that doesn't implement any of that.
    const asWalk = await request(app).post('/api/sprites/pioneer/tracks/walk/generate').send({ direction: 'east' });
    expect(asWalk.status).toBe(400);
    expect(asWalk.body.error).toMatch(/walk cycle has its own endpoints/);
    expect(trackWorkflow.startTrackGeneration).not.toHaveBeenCalled();
  });

  it('POST /:id/tracks/:trackId/approve forwards a reviewed candidate', async () => {
    const r = await request(app).post('/api/sprites/pioneer/tracks/scanner/approve')
      .send({ direction: 'east', runId: 'scanner-east-0a1b2c3d' });
    expect(r.status).toBe(200);
    expect(trackWorkflow.approveTrackRun).toHaveBeenCalledWith('scanner', 'pioneer', {
      direction: 'east', runId: 'scanner-east-0a1b2c3d',
    });
  });

  it('PUT /:id/walk/target pins the set-level cycle target and bounds it', async () => {
    const r = await request(app).put('/api/sprites/pioneer/walk/target')
      .send({ frameCount: 14, fps: 8 });
    expect(r.status).toBe(200);
    expect(r.body.walkTarget).toMatchObject({ frameCount: 14, fps: 8, source: 'set' });
    expect(walk.setWalkTarget).toHaveBeenCalledWith('pioneer', { frameCount: 14, fps: 8 });
    // Both knobs are required — the target is one atomic set-level decision.
    expect((await request(app).put('/api/sprites/pioneer/walk/target')
      .send({ frameCount: 14 })).status).toBe(400);
    // …and both are range-checked against walkBounds.
    expect((await request(app).put('/api/sprites/pioneer/walk/target')
      .send({ frameCount: 32, fps: 8 })).status).toBe(400);
    expect((await request(app).put('/api/sprites/pioneer/walk/target')
      .send({ frameCount: 14, fps: 99 })).status).toBe(400);
  });

  it('POST /:id/walk/reopen validates the direction and delegates its acknowledgement', async () => {
    const r = await request(app).post('/api/sprites/pioneer/walk/reopen')
      .send({ direction: 'east' });
    expect(r.status).toBe(200);
    expect(walk.reopenWalkDirection).toHaveBeenCalledWith('pioneer', {
      direction: 'east', acknowledgeNoClips: false,
    });
    const acknowledged = await request(app).post('/api/sprites/pioneer/walk/reopen')
      .send({ direction: 'east', acknowledgeNoClips: true });
    expect(acknowledged.status).toBe(200);
    expect(walk.reopenWalkDirection).toHaveBeenLastCalledWith('pioneer', {
      direction: 'east', acknowledgeNoClips: true,
    });
    expect((await request(app).post('/api/sprites/pioneer/walk/reopen')
      .send({ direction: 'up' })).status).toBe(400);
  });

  it('POST /:id/walk/approve validates the run id shape', async () => {
    const r = await request(app).post('/api/sprites/pioneer/walk/approve')
      .send({ direction: 'east', runId: 'walk-east-0a1b2c3d' });
    expect(r.status).toBe(200);
    expect(walk.approveWalkDirection).toHaveBeenCalledWith('pioneer', { direction: 'east', runId: 'walk-east-0a1b2c3d' });

    // An imported run's id is its source-named directory — approve has been
    // layout-aware since #2993, so the reopen → re-derive → re-approve flow
    // must survive its last click.
    const imported = await request(app).post('/api/sprites/pioneer/walk/approve')
      .send({ direction: 'east', runId: 'run-3' });
    expect(imported.status).toBe(200);
    expect(walk.approveWalkDirection).toHaveBeenCalledWith('pioneer', { direction: 'east', runId: 'run-3' });

    expect((await request(app).post('/api/sprites/pioneer/walk/approve')
      .send({ direction: 'east', runId: '../escape' })).status).toBe(400);
    expect(walk.approveWalkDirection).toHaveBeenCalledTimes(2);
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

  it('GET /:id/walk/runs/:runId/source-frames delegates with the decoded run id', async () => {
    const r = await request(app).get('/api/sprites/pioneer/walk/runs/walk-east-0a1b2c3d/source-frames');
    expect(r.status).toBe(200);
    expect(r.body.frames).toHaveLength(1);
    expect(walk.getWalkSourceFrames).toHaveBeenCalledWith('pioneer', 'walk-east-0a1b2c3d');

    // An imported run's id is its source-named directory, not the native
    // `walk-<dir>-<hex>` shape — the whole population this endpoint exists for.
    walk.getWalkSourceFrames.mockClear();
    expect((await request(app).get('/api/sprites/pioneer/walk/runs/run-3/source-frames')).status).toBe(200);
    expect(walk.getWalkSourceFrames).toHaveBeenCalledWith('pioneer', 'run-3');

    // Traversal is refused before the service is reached (%2E%2E%2F = `../`).
    walk.getWalkSourceFrames.mockClear();
    expect((await request(app).get('/api/sprites/pioneer/walk/runs/%2E%2E%2Fescape/source-frames')).status).toBe(400);
    expect(walk.getWalkSourceFrames).not.toHaveBeenCalled();
  });

  // The GET must never extract — the importer leaves every imported run without
  // `raw/`, so a side-effecting read would spawn ffmpeg per direction on render.
  it('only asks the service to extract from the explicit extract endpoint', async () => {
    await request(app).get('/api/sprites/pioneer/walk/runs/walk-east-0a1b2c3d/source-frames');
    expect(walk.getWalkSourceFrames).toHaveBeenCalledWith('pioneer', 'walk-east-0a1b2c3d');

    walk.getWalkSourceFrames.mockClear();
    const r = await request(app).post('/api/sprites/pioneer/walk/runs/run-3/source-frames/extract');
    expect(r.status).toBe(200);
    expect(walk.getWalkSourceFrames).toHaveBeenCalledWith('pioneer', 'run-3', { extract: true });

    walk.getWalkSourceFrames.mockClear();
    expect((await request(app).post('/api/sprites/pioneer/walk/runs/%2E%2E%2Fescape/source-frames/extract')).status).toBe(400);
    expect(walk.getWalkSourceFrames).not.toHaveBeenCalled();
  });

  // Since #2993 the reprocess re-derives an IMPORTED run in place, so the route
  // has to accept an imported run id — the strict native shape made the one path
  // back onto the set's target unreachable for exactly those runs.
  it('POST /:id/walk/postprocess accepts an imported run id but still refuses traversal', async () => {
    walk.rerunWalkPostprocess.mockClear();
    const r = await request(app).post('/api/sprites/pioneer/walk/postprocess').send({ runId: 'run-3' });
    expect(r.status).toBe(200);
    expect(walk.rerunWalkPostprocess).toHaveBeenCalledWith('pioneer', { runId: 'run-3' });

    expect((await request(app).post('/api/sprites/pioneer/walk/postprocess')
      .send({ runId: '../escape' })).status).toBe(400);
    expect(walk.rerunWalkPostprocess).toHaveBeenCalledOnce();
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

vi.mock('../services/catalogDB/identityAccess.js', () => ({ assertCatalogIdentityWritable: vi.fn(async id => id) }));
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { basename } from 'node:path';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// The route runs the real sheet services; only the stores, settings and the
// media queue (the render's terminal effect) are doubled.
const mocks = vi.hoisted(() => ({
  getIngredient: vi.fn(),
  listLiveRefsForIngredient: vi.fn(),
  getUniverse: vi.fn(),
  updateUniverse: vi.fn(),
  updateIngredientPayloadKeys: vi.fn(),
  projectToCanon: vi.fn(),
  getSettings: vi.fn(),
  enqueueJob: vi.fn(),
  getImageModels: vi.fn(),
  getBoard: vi.fn(),
  listMediaForIngredient: vi.fn(),
  imageFiles: new Set(),
}));

vi.mock('../lib/imageCleanDefaults.js', () => ({
  resolveImageCleaners: vi.fn(() => ({ cleanC2PA: false, denoise: false })),
}));
vi.mock('../services/catalogDB.js', () => ({
  getIngredient: (...args) => mocks.getIngredient(...args),
  getIngredientIdentityIds: async id => [id],
  listLiveRefsForIngredient: (...args) => mocks.listLiveRefsForIngredient(...args),
  listMediaForIngredient: (...args) => mocks.listMediaForIngredient(...args),
  listRelationsForIngredient: async () => ({ outbound: [], inbound: [] }),
  updateIngredientPayloadKeys: (...args) => mocks.updateIngredientPayloadKeys(...args),
}));
vi.mock('../lib/pathSafety.js', async (importOriginal) => ({
  ...(await importOriginal()),
  // The real sheet service supplies native filesystem paths on every runner.
  resolveImageInputPath: (path) => mocks.imageFiles.has(basename(path)) ? path : null,
}));
vi.mock('../services/universeBuilder.js', () => ({
  getUniverse: (...args) => mocks.getUniverse(...args),
  updateUniverse: (...args) => mocks.updateUniverse(...args),
}));
vi.mock('../services/moodBoard/db.js', () => ({ getBoard: (...args) => mocks.getBoard(...args) }));
vi.mock('../services/settings.js', () => ({ getSettings: (...args) => mocks.getSettings(...args) }));
vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: (...args) => mocks.enqueueJob(...args),
  getJob: vi.fn(),
  mediaJobEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));
vi.mock('../services/universeRunTag.js', () => ({ buildUniverseRunTag: vi.fn(async () => null) }));
// Canon follows the catalog row through the normal projection (own suite).
vi.mock('../services/catalogCanonProjection.js', async (importOriginal) => ({
  ...(await importOriginal()),
  projectToCanon: (...args) => mocks.projectToCanon(...args),
}));
vi.mock('../services/universeCharacterSheetSlot.js', () => ({
  claimPendingSheetSlot: vi.fn(),
  getPendingSheetSlot: vi.fn(),
  releasePendingSheetSlot: vi.fn(),
}));
vi.mock('../lib/mediaModels.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getImageModels: (...args) => mocks.getImageModels(...args),
}));

const router = (await import('./catalogSheets.js')).default;

const app = express();
app.use(express.json());
app.use('/api/catalog', router);
app.use(errorMiddleware);

const character = {
  id: 'cat-chr-1', type: 'character', name: 'Example Hero',
  payload: { physicalDescription: 'tall, silver coat', role: 'courier' },
};
const place = {
  id: 'cat-plc-1', type: 'place', name: 'Example Harbor',
  payload: { description: 'fog over wooden piers', palette: 'slate, rust', intExt: 'EXT', timeOfDay: 'dawn' },
};
const object = {
  id: 'cat-obj-1', type: 'object', name: 'Example Lantern',
  payload: { description: 'brass storm lantern with a cracked lens', significance: 'a family heirloom' },
};

const queuedParams = (n = 0) => mocks.enqueueJob.mock.calls[n][0].params;

// Expected records come straight from the builders the render invokes.
async function expectBackendPreview(preview, params) {
  const { resolveInputImages } = await import('../services/imageGen/inputImages.js');
  const inputImages = resolveInputImages(params);
  let record;
  if (params.mode === 'local') {
    const { localSentPrompt } = await import('../services/imageGen/local.js');
    record = await localSentPrompt({ ...params, model: mocks.getImageModels().find(m => m.id === params.modelId) });
  } else {
    const backends = {
      codex: () => import('../services/imageGen/codex.js'),
      grok: () => import('../services/imageGen/grok.js'),
      agy: () => import('../services/imageGen/agy.js'),
      runway: () => import('../services/imageGen/runway.js'),
    };
    const { [params.mode === 'runway' ? 'runwayImageSentPrompt' : params.mode + 'SentPrompt']: builder } = await backends[params.mode]();
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    record = builder({ ...params, inputImages, modelId: params.model,
      stagingPath: join(tmpdir(), `portos-${params.mode}-<job>`, 'output.png') }).record;
  }
  expect(preview).toMatchObject(record);
  expect(preview.sentNegativePrompt).toBe(record.sentNegativePrompt);
  expect(preview.promptAdditions).toEqual(record.promptAdditions || []);
}


beforeEach(() => {
  vi.clearAllMocks();
  mocks.listLiveRefsForIngredient.mockResolvedValue([]);
  mocks.listMediaForIngredient.mockResolvedValue([]);
  mocks.imageFiles.clear();
  mocks.getSettings.mockResolvedValue({ imageGen: { mode: 'local', local: { pythonPath: '/python', modelId: 'dev' } } });
  mocks.getImageModels.mockReturnValue([{ id: 'dev', runner: 'flux2', hardwareCompatibility: { state: 'available' } }]);
  mocks.enqueueJob.mockReturnValue({ jobId: 'job-1', position: 1 });
  mocks.updateUniverse.mockResolvedValue({});
  mocks.getBoard.mockResolvedValue(null);
});

describe('catalog sheet routes', () => {
  // Pins backend wrappers for catalog sheets, looks and delegated universe sheets.
  it.each(['codex', 'local', 'grok'])('previews the %s backend record across sheet paths', async mode => {
    mocks.getSettings.mockResolvedValue({ imageGen: { mode, [mode]: { enabled: true, modelId: 'dev' } } });
    mocks.getIngredient.mockResolvedValue({ ...character, payload: { ...character.payload,
      wardrobes: [{ id: 'outfit-1', name: 'Travel', description: 'red coat' }] } });
    mocks.listMediaForIngredient.mockResolvedValue([{ kind: 'portrait', mediaKey: 'portrait.png' }]);
    mocks.imageFiles.add('portrait.png');
    const cases = [{}, { variant: 'look', wardrobeId: 'outfit-1', visualDirection: {
      style: 'Photography', camera: 'Full body', lighting: 'Soft light', environment: 'Harbor',
    } }, {}];
    for (const [index, body] of cases.entries()) {
      if (index === 2) {
        mocks.listLiveRefsForIngredient.mockResolvedValue([{ refKind: 'universe', refId: 'universe-1', role: 'owner' }]);
        mocks.getUniverse.mockResolvedValue({ id: 'universe-1', name: 'Example Universe',
          characters: [{ id: 'char-entry-1', name: character.name, ingredientId: character.id }] });
      }
      const preview = await request(app).post(`/api/catalog/ingredients/${character.id}/sheets/preview`).send(body);
      expect(preview.status).toBe(200);
      const render = await request(app).post(`/api/catalog/ingredients/${character.id}/sheets`).send(body);
      expect(render.status).toBe(200);
      const params = queuedParams(index);
      await expectBackendPreview(preview.body.preview, params);
      if (mode !== 'local') {
        expect(preview.body.preview.sentPrompt).not.toBe(params.prompt);
        expect(preview.body.preview.promptAdditions.map(a => a.id)).toContain('agent-instructions');
      }
    }
  });

  // Proves the images shown before Generate are the same ordered inputs queued,
  // and prevents derived sheets or a different form becoming identity fallback.
  it('previews and queues portrait and canon images once, excluding derived and alternate-form media', async () => {
    mocks.getIngredient.mockResolvedValue({ ...character, payload: {
      ...character.payload, primaryImageRef: 'canon.png', imageRefs: ['canon.png', 'profile.png'],
    } });
    mocks.listMediaForIngredient.mockResolvedValue([
      { kind: 'portrait', mediaKey: 'portrait.png' },
      { kind: 'reference', mediaKey: 'old-sheet.png', role: 'sheet:standard' },
      { kind: 'reference', mediaKey: 'archive.png', role: 'archive:portrait' },
      { kind: 'portrait', mediaKey: 'old-portrait.png', role: 'archive:portrait' },
      { kind: 'reference', mediaKey: 'child.png', library: { guide: true, variant: { formId: 'child' } } },
    ]);
    ['portrait.png', 'canon.png', 'profile.png'].forEach((name) => mocks.imageFiles.add(name));
    const res = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send({});
    expect(res.status).toBe(200);
    const preview = res.body.preview;
    expect(preview.referenceImages.map((ref) => [ref.filename, ref.status])).toEqual([
      ['portrait.png', 'included'], ['canon.png', 'included'], ['profile.png', 'included'],
    ]);
    expect(preview.referenceImages[1]).toMatchObject({ source: 'Primary canon image', url: '/data/images/canon.png' });
    expect(JSON.stringify(preview)).not.toContain(process.cwd());
    const queued = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send({});
    expect(queued.status).toBe(200);
    expect(queuedParams().referenceImagePaths.map((path) => basename(path))).toEqual(['portrait.png', 'canon.png', 'profile.png']);
    expect(queuedParams().prompt).toBe(preview.sentPrompt);
    expect(preview.promptAdditions.find((a) => a.id === 'character-identity').text).toContain('facial features');
  });

  it('honors guides and provider caps without rewriting an override equal to the template', async () => {
    mocks.getIngredient.mockResolvedValue({ ...character, payload: { primaryImageRef: 'unused.png' } });
    mocks.getSettings.mockResolvedValue({ imageGen: { mode: 'agy', agy: { enabled: true } } });
    mocks.listMediaForIngredient.mockResolvedValue(['one', 'two', 'three', 'four'].map((name) => ({
      kind: 'reference', mediaKey: `${name}.png`, library: { guide: true },
    })));
    ['one', 'two', 'three', 'four'].forEach((name) => mocks.imageFiles.add(`${name}.png`));
    const { buildCharacterReferenceSheetPrompt } = await import('../services/universeCharacterSheet.js');
    const built = buildCharacterReferenceSheetPrompt({}, { name: character.name });
    const body = { overridePrompt: built.prompt, overrideNegativePrompt: built.negativePrompt };
    const res = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send(body);
    expect(res.status).toBe(200);
    expect(res.body.preview.referenceImages.map((ref) => ref.status)).toEqual(['included', 'included', 'included', 'limit']);
    expect(res.body.preview.referenceImages.every((ref) => ref.source === 'Render guide')).toBe(true);
    expect(res.body.preview.sentPrompt).toContain(body.overridePrompt);
    expect(res.body.preview.promptAdditions.map(a => a.id)).toEqual(['agent-instructions']);
    await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send(body);
    expect(queuedParams().referenceImagePaths).toHaveLength(3);
    expect(queuedParams().prompt).toBe(body.overridePrompt);
    await expectBackendPreview(res.body.preview, queuedParams());
  });

  it('keeps same-age alternate costumes and rejected canon images out of canonical sheets', async () => {
    mocks.getIngredient.mockResolvedValue({ ...character, payload: { age: '27', primaryImageRef: 'rejected.png', imageRefs: ['costume.png'] } });
    mocks.listMediaForIngredient.mockResolvedValue([
      { kind: 'portrait', mediaKey: 'canonical.png', library: { variant: { age: 27, formId: 'adult' } } },
      { kind: 'reference', mediaKey: 'costume.png', library: { variant: { age: 27, formId: 'costume' }, guide: true } },
      { kind: 'reference', mediaKey: 'rejected.png', library: { review: { status: 'rejected' } } },
    ]);
    ['canonical.png', 'costume.png', 'rejected.png'].forEach(name => mocks.imageFiles.add(name));
    const preview = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send({});
    expect(preview.status).toBe(200);
    expect(preview.body.preview.referenceImages.map(ref => ref.filename)).toEqual(['canonical.png']);
  });

  // A collage left out of likeness is listed (so it can be put back) but never
  // sent, never takes a slot and never blocks the render when its file is gone.
  it('lists a left-out image without sending it or letting it fill a reference slot', async () => {
    mocks.getIngredient.mockResolvedValue({ ...character, payload: { ...character.payload, imageRefs: ['board.png'] } });
    mocks.listMediaForIngredient.mockResolvedValue([
      { kind: 'portrait', mediaKey: 'portrait.png' },
      { kind: 'reference', mediaKey: 'board.png', library: { likeness: false } },
      { kind: 'reference', mediaKey: 'gone-board.png', library: { likeness: false } },
      { kind: 'reference', mediaKey: 'still.png' },
    ]);
    ['portrait.png', 'board.png', 'still.png'].forEach(name => mocks.imageFiles.add(name));
    const res = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send({});
    expect(res.status).toBe(200);
    expect(res.body.preview.referenceImages.map(ref => [ref.filename, ref.status, ref.mediaKind])).toEqual([
      ['portrait.png', 'included', 'portrait'], ['still.png', 'included', 'reference'],
      ['board.png', 'left-out', 'reference'], ['gone-board.png', 'left-out', 'reference'],
    ]);
    const queued = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send({});
    expect(queued.status).toBe(200);
    expect(queuedParams().referenceImagePaths.map(path => basename(path))).toEqual(['portrait.png', 'still.png']);
  });

  it('includes shared facial identity on delegated canonical blueprints as well as alternate-form sheets', async () => {
    mocks.getIngredient.mockResolvedValue(character);
    mocks.listLiveRefsForIngredient.mockResolvedValue([{ refKind: 'universe', refId: 'universe-1', role: 'owner' }]);
    mocks.getUniverse.mockResolvedValue({ id: 'universe-1', name: 'Example World', characters: [
      { id: 'entry-1', ingredientId: character.id, name: character.name, visualIdentity: 'green eyes and a distinctive nose' },
    ] });
    const result = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send({ variant: 'blueprint' });
    expect(result.status).toBe(200);
    expect(result.body.preview.sentPrompt).toContain('green eyes and a distinctive nose');
    expect(result.body.preview.promptAdditions).toContainEqual(expect.objectContaining({ id: 'shared-character-identity' }));
  });

  it('shows a missing guide and refuses to silently render without it', async () => {
    mocks.getIngredient.mockResolvedValue(character);
    mocks.listMediaForIngredient.mockResolvedValue([{ kind: 'reference', mediaKey: 'missing.png', library: { guide: true } }]);
    const res = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send({});
    expect(res.body.preview.referenceImages).toEqual([{ filename: 'missing.png', source: 'Render guide', mediaKind: 'reference', status: 'missing' }]);
    const queued = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send({});
    expect(queued.status).toBe(400);
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });

  it('refuses a local model that would discard the reference images', async () => {
    mocks.getIngredient.mockResolvedValue({ ...character, payload: { primaryImageRef: 'canon.png' } });
    mocks.imageFiles.add('canon.png');
    mocks.getImageModels.mockReturnValue([{ id: 'dev', runner: 'mflux', hardwareCompatibility: { state: 'available' } }]);
    const res = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send({});
    expect(res.body.preview.referenceImages[0].status).toBe('unsupported');
    const queued = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send({});
    expect(queued.status).toBe(400);
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });

  it('refuses a foreign canonical target before rendering or looking up settings', async () => {
    const { assertCatalogIdentityWritable } = await import('../services/catalogDB/identityAccess.js');
    assertCatalogIdentityWritable.mockRejectedValueOnce(Object.assign(new Error('Canonical owner required'), { status: 409, code: 'CATALOG_IDENTITY_FOREIGN' }));
    const res = await request(app).post('/api/catalog/ingredients/foreign-canonical/sheets').send({});
    expect(res.status).toBe(409);
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
    expect(mocks.getSettings).not.toHaveBeenCalled();
  });
  it('lists the variants a type offers', async () => {
    mocks.getIngredient.mockResolvedValue(place);
    const res = await request(app).get('/api/catalog/ingredients/cat-plc-1/sheets/variants');
    expect(res.status).toBe(200);
    expect(res.body.variants.map((v) => v.id)).toEqual(['environment']);
  });

  // Catches a catalog-only render missing the attach tag/role (the image would
  // never reach the record, or would take its portrait) or claiming a universe style.
  it('queues a catalog-only character with the attach tag, the sheet role and the default-style chip', async () => {
    mocks.getIngredient.mockResolvedValue(character);
    const res = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send({ variant: 'blueprint' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ jobId: 'job-1', variant: 'blueprint', delegatedTo: null });
    const params = queuedParams();
    expect(params.catalogAttach).toEqual({ ingredientId: 'cat-chr-1', kind: 'reference', role: 'sheet:blueprint' });
    expect(params.characterSheet).toBeUndefined();
    const ids = params.promptAdditions.map((a) => a.id);
    expect(ids).toEqual(['sheet-default-style', 'sheet-negatives']);
    expect(params.prompt).toContain(params.promptAdditions[0].text);
    expect(params.prompt).toContain('Example Hero');
  });

  it('delegates a universe-linked character to the universe renderer', async () => {
    mocks.getIngredient.mockResolvedValue(character);
    mocks.listLiveRefsForIngredient.mockResolvedValue([{ refKind: 'universe', refId: 'universe-1', role: 'owner' }]);
    mocks.getUniverse.mockResolvedValue({
      id: 'universe-1', name: 'Example Universe', influences: { embrace: [] },
      characters: [{ id: 'char-entry-1', name: 'Example Hero', ingredientId: 'cat-chr-1', primaryImageRef: 'canonical.png' }],
    });
    mocks.imageFiles.add('canonical.png');
    const preview = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send({});
    expect(preview.body.preview.referenceImages).toMatchObject([{ filename: 'canonical.png', status: 'included' }]);
    const res = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ delegatedTo: 'universe', universeId: 'universe-1', entryId: 'char-entry-1', variant: 'standard' });
    const params = queuedParams();
    expect(params.characterSheet).toMatchObject({ universeId: 'universe-1', entryId: 'char-entry-1', variant: 'standard' });
    expect(params.catalogAttach).toBeUndefined();
    expect(params.referenceImagePaths[0]).toMatch(/canonical\.png$/);
    expect(params.prompt).toBe(preview.body.preview.sentPrompt);
  });

  it('refuses a variant the type does not offer, and a locked record', async () => {
    mocks.getIngredient.mockResolvedValue(place);
    const wrong = await request(app).post('/api/catalog/ingredients/cat-plc-1/sheets').send({ variant: 'blueprint' });
    expect(wrong.status).toBe(400);

    mocks.getIngredient.mockResolvedValue({ ...object, payload: { ...object.payload, locked: true } });
    const locked = await request(app).post('/api/catalog/ingredients/cat-obj-1/sheets').send({});
    expect(locked.status).toBe(409);

    mocks.getIngredient.mockResolvedValue(null);
    const missing = await request(app).post('/api/catalog/ingredients/cat-obj-9/sheets').send({});
    expect(missing.status).toBe(404);
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });

  // A preview writes nothing, so the lock never hides it; only the render is refused.
  it('previews a locked record but refuses to render it, for catalog-only and universe-delegated sheets', async () => {
    mocks.getIngredient.mockResolvedValue({ ...object, payload: { ...object.payload, locked: true } });
    const preview = await request(app).post('/api/catalog/ingredients/cat-obj-1/sheets/preview').send({});
    expect(preview.status).toBe(200);
    expect(preview.body.preview.sentPrompt).toContain('Example Lantern');
    const render = await request(app).post('/api/catalog/ingredients/cat-obj-1/sheets').send({});
    expect(render).toMatchObject({ status: 409, body: { code: 'CATALOG_INGREDIENT_LOCKED' } });

    mocks.getIngredient.mockResolvedValue({ ...character, payload: { ...character.payload, locked: true } });
    mocks.listLiveRefsForIngredient.mockResolvedValue([{ refKind: 'universe', refId: 'universe-1', role: 'owner' }]);
    mocks.getUniverse.mockResolvedValue({
      id: 'universe-1', name: 'Example Universe', influences: { embrace: [] },
      characters: [{ id: 'char-entry-1', name: 'Example Hero', ingredientId: 'cat-chr-1', locked: true }],
    });
    const delegatedPreview = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send({});
    expect(delegatedPreview.status).toBe(200);
    expect(delegatedPreview.body.preview.sentPrompt).toContain('Example Hero');
    const delegatedRender = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send({});
    expect(delegatedRender.status).toBe(409);

    // The universe renderer keeps its own canon lock when the record is unlocked.
    mocks.getIngredient.mockResolvedValue(character);
    const canonLocked = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send({});
    expect(canonLocked).toMatchObject({ status: 409, body: { code: 'UNIVERSE_CANON_LOCKED' } });
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
    expect(mocks.updateUniverse).not.toHaveBeenCalled();
  });

  // Catches the preview and the render drifting apart (#11317).
  it('previews exactly the prompt the render queues, for a place and an object', async () => {
    for (const [record, marker] of [[place, 'ENVIRONMENT REFERENCE SHEET'], [object, 'PRODUCT REFERENCE SHEET']]) {
      mocks.enqueueJob.mockClear();
      mocks.getIngredient.mockResolvedValue(record);
      const preview = await request(app).post(`/api/catalog/ingredients/${record.id}/sheets/preview`).send({});
      expect(preview.status).toBe(200);
      const sent = preview.body.preview;
      expect(sent.sentPrompt).toContain(marker);
      expect(sent.sentPrompt).toContain(record.name);

      await request(app).post(`/api/catalog/ingredients/${record.id}/sheets`).send({});
      const params = queuedParams();
      expect(sent.sentPrompt).toBe(params.prompt);
      expect(sent.sentNegativePrompt).toBe(params.negativePrompt);
      expect(sent.promptAdditions).toEqual(params.promptAdditions);
      expect(params.catalogAttach.role).toBe(`sheet:${record.type === 'place' ? 'environment' : 'product'}`);
    }
  });

  it('sends a typed override exactly as written, with no additions', async () => {
    mocks.getIngredient.mockResolvedValue(object);
    const typed = '  my own lantern sheet\n';
    const res = await request(app).post('/api/catalog/ingredients/cat-obj-1/sheets/preview')
      .send({ overridePrompt: typed, overrideNegativePrompt: 'blur ' });
    expect(res.body.preview.sentPrompt).toBe(typed);
    expect(res.body.preview.promptAdditions).toEqual([]);
  });

  // Catches an empty negative override being treated as absent (the template
  // negatives sent anyway, with their chip) and the preview drifting from it.
  it('sends an empty negative override as no negatives, with no negatives chip', async () => {
    mocks.getIngredient.mockResolvedValue(character);
    const body = { variant: 'standard', overrideNegativePrompt: '' };
    const preview = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send(body);
    expect(preview.status).toBe(200);
    expect(preview.body.preview.sentNegativePrompt).toBeUndefined();
    expect(preview.body.preview.promptAdditions.map((a) => a.id)).not.toContain('sheet-negatives');
    await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send(body);
    const params = queuedParams();
    expect(params.negativePrompt).toBe('');
    expect(params.prompt).toBe(preview.body.preview.sentPrompt);
    expect(params.promptAdditions).toEqual(preview.body.preview.promptAdditions);
  });

  it('renders the photographic turnaround with no negatives and no illustrated styling', async () => {
    mocks.getIngredient.mockResolvedValue({ ...character, name: 'Ada' });
    const body = { variant: 'photographic' };
    const preview = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send(body);
    expect(preview.status).toBe(200);
    const sent = preview.body.preview;
    expect(sent.sentPrompt).toContain('PHOTOGRAPHIC CHARACTER REFERENCE SHEET');
    expect(sent.sentPrompt).toContain('Ada');
    expect(sent.sentPrompt).not.toMatch(/illustrat/i);
    expect(sent.sentNegativePrompt).toBeUndefined();
    const style = sent.promptAdditions.find((a) => a.id === 'sheet-default-style');
    expect(style.text).toMatch(/photography/);
    expect(sent.promptAdditions.map((a) => a.id)).not.toContain('sheet-negatives');
    const res = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send(body);
    expect(res.body).toMatchObject({ variant: 'photographic', role: 'sheet:photographic' });
    const params = queuedParams();
    expect(params.negativePrompt).toBe('');
    expect(params.prompt).toBe(sent.sentPrompt);
    expect(params.promptAdditions).toEqual(sent.promptAdditions);
  });

  // Catches a photoreal universe starting its cast on the illustrated sheet.
  it('lists and defaults to the photographic sheet for a character in a photoreal universe', async () => {
    mocks.getIngredient.mockResolvedValue({ ...character, name: 'Ada' });
    mocks.listLiveRefsForIngredient.mockResolvedValue([{ refKind: 'universe', refId: 'universe-1', role: 'owner' }]);
    mocks.getUniverse.mockResolvedValue({
      id: 'universe-1', name: 'Example Universe', influences: { embrace: [] },
      visualProfile: { version: 1, generation: { enabled: true, lighting: 'Soft window light' } },
      characters: [{ id: 'char-entry-1', name: 'Ada', ingredientId: 'cat-chr-1' }],
    });
    const listed = await request(app).get('/api/catalog/ingredients/cat-chr-1/sheets/variants');
    expect(listed.body.variants.map((v) => v.id)).toEqual(['photographic', 'standard', 'face', 'blueprint']);
    const preview = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send({});
    expect(preview.body.preview.sentPrompt).toContain('PHOTOGRAPHIC CHARACTER REFERENCE SHEET');
    expect(preview.body.preview.sentPrompt).toContain('Soft window light');
    expect(preview.body.preview.sentPrompt).not.toMatch(/illustrat/i);
    const res = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send({});
    expect(res.body).toMatchObject({ delegatedTo: 'universe', variant: 'photographic' });
    expect(queuedParams().prompt).toBe(preview.body.preview.sentPrompt);

    mocks.getUniverse.mockResolvedValue({ id: 'universe-1', name: 'Example Universe', characters: [] });
    const plain = await request(app).get('/api/catalog/ingredients/cat-chr-1/sheets/variants');
    expect(plain.body.variants.map((v) => v.id)).toEqual(['standard', 'photographic', 'face', 'blueprint']);
  });

  describe('look renders', () => {
    const visualDirection = { camera: '  50mm film photography\n', lighting: 'Soft window light', environment: 'A weathered timber room' };
    const dressed = {
      ...character,
      payload: {
        ...character.payload,
        wardrobes: [{ id: 'wd-scarf', name: 'Red scarf', description: 'long red wool scarf over a grey travel coat' }],
      },
    };

    // Catches a look landing as a generic sheet (wrong role), delegating to the
    // universe renderer (it would never reach the Looks tab), or dropping the
    // wardrobe text; and the preview drifting from what is queued (#11317).
    it('previews and queues a look tagged look:<wardrobeId> through the catalog path, even when universe-linked', async () => {
      mocks.getIngredient.mockResolvedValue(dressed);
      mocks.listLiveRefsForIngredient.mockResolvedValue([{ refKind: 'universe', refId: 'universe-1', role: 'owner' }]);
      mocks.getUniverse.mockResolvedValue({
        id: 'universe-1', name: 'Example Universe', influences: { embrace: ['ink and watercolor'] },
        characters: [{ id: 'char-entry-1', name: 'Example Hero', ingredientId: 'cat-chr-1' }],
      });
      const body = { variant: 'look', wardrobeId: 'wd-scarf', visualDirection };
      const preview = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send(body);
      expect(preview.status).toBe(200);
      const sent = preview.body.preview;
      expect(sent.sentPrompt).toContain('long red wool scarf over a grey travel coat');
      expect(sent.sentPrompt).toContain('Example Hero');

      const res = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send(body);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ variant: 'look', role: 'look:wd-scarf', delegatedTo: null });
      const params = queuedParams();
      expect(params.catalogAttach).toEqual({ ingredientId: 'cat-chr-1', kind: 'reference', role: 'look:wd-scarf' });
      expect(params.characterSheet).toBeUndefined();
      expect(sent.sentPrompt).toBe(params.prompt);
      expect(sent.promptAdditions).toEqual(params.promptAdditions);
      // Style and negatives travel as labeled additions; the negatives never
      // ride in the positive prompt.
      const negatives = params.promptAdditions.find((a) => a.id === 'sheet-negatives');
      expect(negatives).toMatchObject({ label: 'Look negatives' });
      expect(params.negativePrompt).toBe(negatives.text);
      expect(params.prompt).not.toContain(negatives.text);
      expect(params.promptAdditions.map((a) => a.id)).toContain('universe-style');
      expect(sent.visualDirection).toMatchObject({ ready: true, missing: [], universe: { id: 'universe-1' } });
      expect(params.prompt).toContain(visualDirection.camera);
      expect(params.prompt).not.toContain('Even, soft studio lighting');
      expect(params.prompt).not.toContain('contemporary illustrated');
    });

    it('shows missing world and photography direction and refuses to spend a render on the default style', async () => {
      mocks.getIngredient.mockResolvedValue(dressed);
      const body = { variant: 'look', wardrobeId: 'wd-scarf' };
      const preview = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send(body);
      expect(preview.body.preview.visualDirection).toEqual({ ready: false,
        missing: ['Overall style / medium', 'Camera', 'Lighting', 'Environment'], universe: null, moodBoard: null });
      expect(preview.body.preview.promptAdditions.map((a) => a.id)).not.toContain('sheet-default-style');
      const res = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LOOK_VISUAL_DIRECTION_REQUIRED');
      expect(mocks.enqueueJob).not.toHaveBeenCalled();
    });

    it('uses a chosen universe’s notes and linked board style and avoids in both preview and queued input', async () => {
      mocks.getIngredient.mockResolvedValue(dressed);
      mocks.getUniverse.mockResolvedValue({ id: 'chosen', name: 'Example World', styleNotes: 'Tactile photographic grain',
        influences: { embrace: [], avoid: ['plastic skin'] }, moodBoardId: 'board-1' });
      mocks.getBoard.mockResolvedValue({ id: 'board-1', name: 'Example Board', style: { prompt: 'Naturalistic analog film', negativePrompt: '3D animation' } });
      const body = { variant: 'look', wardrobeId: 'wd-scarf', universeId: 'chosen', visualDirection };
      const preview = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send(body);
      expect(preview.body.preview.visualDirection).toMatchObject({ ready: true, moodBoard: { id: 'board-1', hasStyle: true } });
      const res = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send(body);
      expect(res.status).toBe(200);
      const params = queuedParams();
      expect(params.prompt).toBe(preview.body.preview.sentPrompt);
      expect(params.prompt).toContain('Tactile photographic grain');
      expect(params.prompt).toContain('Naturalistic analog film');
      expect(params.negativePrompt).toContain('plastic skin');
      expect(params.negativePrompt).toContain('3D animation');
      expect(params.prompt).not.toContain('3D animation');
    });

    it('supports an unlinked board or authored style, but a board without composed direction does not satisfy style', async () => {
      mocks.getIngredient.mockResolvedValue(dressed);
      mocks.getBoard.mockResolvedValue({ id: 'board-1', name: 'Example Board', items: [{ type: 'image', url: '/image.png' }] });
      const body = { variant: 'look', wardrobeId: 'wd-scarf', moodBoardId: 'board-1', visualDirection };
      const preview = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send(body);
      expect(preview.body.preview.visualDirection.missing).toEqual(['Overall style / medium']);
      const res = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send({ ...body,
        visualDirection: { ...visualDirection, style: 'Live-action photography' } });
      expect(res.status).toBe(200);
      expect(queuedParams().prompt).toContain('Live-action photography');
    });

    it('requires a source choice for multiple worlds and surfaces lookup failures without silently falling back', async () => {
      mocks.getIngredient.mockResolvedValue(dressed);
      mocks.listLiveRefsForIngredient.mockResolvedValue([{ refKind: 'universe', refId: 'u-1' }, { refKind: 'universe', refId: 'u-2' }]);
      const body = { variant: 'look', wardrobeId: 'wd-scarf', visualDirection };
      const post = (options) => request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send(options);
      expect((await post(body)).body.code).toBe('LOOK_UNIVERSE_REQUIRED');
      mocks.getUniverse.mockRejectedValueOnce(Object.assign(new Error('Universe unavailable'), { status: 503 }));
      expect((await post({ ...body, universeId: 'u-1' })).status).toBe(503);
      expect((await post({ ...body, universeId: '', moodBoardId: 'missing-board' })).status).toBe(404);
      expect((await post({ ...body, overridePrompt: 'bypass direction' })).status).toBe(400);
      expect((await post({ ...body, visualDirection: { lighting: 123 } })).status).toBe(400);
      expect(mocks.enqueueJob).not.toHaveBeenCalled();
    });

    describe('edit from the canonical portrait', () => {
      const codex = { imageGen: { mode: 'codex', codex: { enabled: true } } };
      const portraitMedia = [
        { kind: 'portrait', mediaKey: 'portrait.png' },
        { kind: 'reference', mediaKey: 'side.png' },
        { kind: 'reference', mediaKey: 'old-look.png', role: 'look:wd-scarf' },
      ];
      const body = { variant: 'look', wardrobeId: 'wd-scarf', visualDirection: { ...visualDirection, style: 'Live-action photography' } };
      beforeEach(() => {
        ['portrait.png', 'side.png', 'old-look.png'].forEach((name) => mocks.imageFiles.add(name));
      });

      // Catches the portrait riding as a loose reference again (the face drifts
      // to a different person), the preview hiding the edit base, the record's
      // everyday outfit text fighting the look, and a triptych shrinking the face.
      it('edits the portrait into one full-body figure, with other references as guides, exactly as previewed', async () => {
        mocks.getSettings.mockResolvedValue(codex);
        mocks.getIngredient.mockResolvedValue(dressed);
        mocks.listMediaForIngredient.mockResolvedValue(portraitMedia);
        const preview = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send(body);
        expect(preview.status).toBe(200);
        const sent = preview.body.preview;
        expect(sent.editBase).toMatchObject({ filename: 'portrait.png', source: 'Portrait', status: 'included', url: '/data/images/portrait.png' });
        expect(sent.referenceImages.map((ref) => [ref.filename, ref.status, ref.role])).toEqual([
          ['portrait.png', 'included', 'edit-base'], ['side.png', 'included', undefined],
        ]);
        expect(sent.promptAdditions.map((a) => a.id)).toContain('portrait-edit-base');
        expect(sent.promptAdditions.map((a) => a.id)).not.toContain('character-identity');
        expect(sent.sentPrompt).toContain('ONE full-body figure');
        expect(sent.sentPrompt).toContain('long red wool scarf over a grey travel coat');
        expect(sent.sentPrompt).not.toContain('silver coat');

        const res = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send(body);
        expect(res.status).toBe(200);
        expect(res.body.editBase).toMatchObject({ filename: 'portrait.png', status: 'included' });
        const params = queuedParams();
        expect(basename(params.initImagePath)).toBe('portrait.png');
        expect(params.referenceImagePaths.map((path) => basename(path))).toEqual(['side.png']);
        expect(params.initImageStrength).toBeGreaterThan(0.4);
        expect(params.height).toBeGreaterThan(params.width);
        expect(params.width).toBe(2048);
        await expectBackendPreview(sent, params);
      });

      it('keeps today’s three-view generate with no portrait to edit', async () => {
        mocks.getSettings.mockResolvedValue(codex);
        mocks.getIngredient.mockResolvedValue({ ...dressed, payload: { ...dressed.payload, primaryImageRef: 'side.png' } });
        const preview = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send(body);
        expect(preview.body.preview.editBase).toBeUndefined();
        expect(preview.body.preview.referenceImages.map((ref) => ref.role)).toEqual([undefined]);
        await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send(body);
        const params = queuedParams();
        expect(params.initImagePath).toBeUndefined();
        expect(params.referenceImagePaths.map((path) => basename(path))).toEqual(['side.png']);
        expect(params.prompt).toContain('three full-body views');
        expect(params.prompt).toContain('long red wool scarf over a grey travel coat');
        expect(params).toMatchObject({ width: 4096, height: 3072 });
      });

      // Catches a backend that cannot restage the portrait silently dropping it
      // or pretending to edit: the reason is shown and the portrait still guides.
      it('falls back to the portrait as a reference on the local backend and says why', async () => {
        mocks.getIngredient.mockResolvedValue(dressed);
        mocks.listMediaForIngredient.mockResolvedValue(portraitMedia);
        const preview = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send(body);
        expect(preview.body.preview.editBase).toMatchObject({ filename: 'portrait.png', status: 'fallback', reason: expect.stringMatching(/cloud image backend/) });
        expect(preview.body.preview.referenceImages.map((ref) => [ref.filename, ref.status])).toEqual([
          ['portrait.png', 'included'], ['side.png', 'included'],
        ]);
        const res = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send(body);
        expect(res.body.editBase).toMatchObject({ status: 'fallback' });
        const params = queuedParams();
        expect(params.initImagePath).toBeUndefined();
        expect(params.referenceImagePaths.map((path) => basename(path))).toEqual(['portrait.png', 'side.png']);
        expect(params.prompt).toContain('three full-body views');

        mocks.getImageModels.mockReturnValue([{ id: 'dev', runner: 'mflux', hardwareCompatibility: { state: 'available' } }]);
        const refused = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send(body);
        expect(refused.status).toBe(400);
        expect(refused.body.code).toBe('CHARACTER_SHEET_REFERENCES_UNSUPPORTED');
      });

      // Explicit guides supersede the portrait on the local backend; the
      // fallback explanation must not claim that the omitted portrait is sent.
      it('reports the local fallback accurately when explicit guides omit the portrait', async () => {
        mocks.getIngredient.mockResolvedValue(dressed);
        mocks.listMediaForIngredient.mockResolvedValue([
          portraitMedia[0], { ...portraitMedia[1], library: { guide: true } },
        ]);
        const preview = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send(body);
        expect(preview.status).toBe(200);
        expect(preview.body.preview.editBase).toMatchObject({ status: 'fallback', reason: expect.stringContaining('portrait is not edited') });
        expect(preview.body.preview.referenceImages.map((ref) => ref.filename)).toEqual(['side.png']);
        const res = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send(body);
        expect(res.status).toBe(200);
        expect(queuedParams().referenceImagePaths.map((path) => basename(path))).toEqual(['side.png']);
      });

      // FIBO Edit with only one reference retains the source crop, so it
      // cannot restage a portrait into a full-body look or a sheet.
      it('refuses a one-image FIBO Edit before queueing and accepts a second guide', async () => {
        mocks.getSettings.mockResolvedValue({ imageGen: { mode: 'runway', runway: { enabled: true, model: 'bria_fibo_edit_1_5' } } });
        mocks.getIngredient.mockResolvedValue(dressed);
        mocks.listMediaForIngredient.mockResolvedValue([portraitMedia[0]]);
        const preview = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send(body);
        expect(preview.status).toBe(400);
        expect(preview.body.code).toBe('CHARACTER_SHEET_PORTRAIT_FRAMING_UNSUPPORTED');
        expect(preview.body.error).toMatch(/Add another compatible reference image/);
        const refused = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send(body);
        expect(refused.status).toBe(400);
        expect(refused.body.code).toBe(preview.body.code);
        expect(mocks.enqueueJob).not.toHaveBeenCalled();

        mocks.listMediaForIngredient.mockResolvedValue(portraitMedia);
        const allowedPreview = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send(body);
        expect(allowedPreview.status).toBe(200);
        const allowed = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send(body);
        expect(allowed.status).toBe(200);
        expect(basename(queuedParams().initImagePath)).toBe('portrait.png');
        expect(queuedParams().referenceImagePaths.map((path) => basename(path))).toEqual(['side.png']);
        await expectBackendPreview(allowedPreview.body.preview, queuedParams());
        const { buildRunwayImageRequest } = await import('../lib/runwayImageModels.js');
        const { width, height, resolution } = queuedParams();
        const wire = buildRunwayImageRequest({ modelId: 'bria_fibo_edit_1_5', prompt: queuedParams().prompt, width, height, resolution,
          referenceImages: [{ uri: 'portrait' }, { uri: 'side' }] });
        expect(wire.body.ratio).toBe('768:1152');
      });

      it('starts a universe-delegated sheet from the linked record’s portrait too', async () => {
        mocks.getSettings.mockResolvedValue(codex);
        mocks.getIngredient.mockResolvedValue(character);
        mocks.listMediaForIngredient.mockResolvedValue(portraitMedia);
        mocks.listLiveRefsForIngredient.mockResolvedValue([{ refKind: 'universe', refId: 'universe-1', role: 'owner' }]);
        mocks.getUniverse.mockResolvedValue({ id: 'universe-1', name: 'Example Universe', influences: { embrace: [] },
          characters: [{ id: 'char-entry-1', name: 'Example Hero', ingredientId: 'cat-chr-1' }] });
        const preview = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send({});
        expect(preview.body.preview.editBase).toMatchObject({ filename: 'portrait.png', status: 'included' });
        const res = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send({});
        expect(res.body.delegatedTo).toBe('universe');
        const params = queuedParams();
        expect(basename(params.initImagePath)).toBe('portrait.png');
        expect(params).toMatchObject({ width: 4096, height: 3072 });
        await expectBackendPreview(preview.body.preview, params);
      });
    });

    it('is not offered among the sheet variants', async () => {
      mocks.getIngredient.mockResolvedValue(dressed);
      const res = await request(app).get('/api/catalog/ingredients/cat-chr-1/sheets/variants');
      expect(res.body.variants.map((v) => v.id)).not.toContain('look');
    });

    it('refuses an unknown wardrobe, a non-character, a missing wardrobeId and a stray one', async () => {
      mocks.getIngredient.mockResolvedValue(dressed);
      const wrong = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send({ variant: 'look', wardrobeId: 'wd-other' });
      expect(wrong.status).toBe(400);
      const missing = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send({ variant: 'look' });
      expect(missing.status).toBe(400);
      const stray = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send({ variant: 'blueprint', wardrobeId: 'wd-scarf' });
      expect(stray.status).toBe(400);

      mocks.getIngredient.mockResolvedValue({ ...place, payload: { ...place.payload, wardrobes: dressed.payload.wardrobes } });
      const notCharacter = await request(app).post('/api/catalog/ingredients/cat-plc-1/sheets/preview').send({ variant: 'look', wardrobeId: 'wd-scarf' });
      expect(notCharacter.status).toBe(400);
      expect(mocks.enqueueJob).not.toHaveBeenCalled();
    });
  });

  describe('alternate age/look sheets', () => {
    const aged = {
      ...character,
      payload: {
        ...character.payload, age: '34', visualIdentity: 'green eyes and a distinctive nose',
        wardrobes: [{ id: 'adult-coat', name: 'Adult outfit', description: 'adult silver coat and short bob' }],
        forms: [
          { id: 'form-kid', label: 'Age 7', age: '7', description: 'gap-toothed, long waves, oversized yellow raincoat' },
          { id: 'form-empty', label: 'Someday', age: '', description: '' },
        ],
      },
    };

    // Catches a form sheet overwriting the canonical universe pointer (delegated),
    // landing under the canonical role, or still describing the adult.
    it('renders a form through the catalog path with its age and look, tagged sheet:<variant>@<formId>', async () => {
      mocks.getIngredient.mockResolvedValue(aged);
      mocks.listLiveRefsForIngredient.mockResolvedValue([{ refKind: 'universe', refId: 'universe-1', role: 'owner' }]);
      mocks.getUniverse.mockResolvedValue({
        id: 'universe-1', name: 'Example Universe', influences: { embrace: [] },
        characters: [{ id: 'char-entry-1', name: 'Example Hero', ingredientId: 'cat-chr-1' }],
      });
      const body = { variant: 'blueprint', formId: 'form-kid' };
      const preview = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send(body);
      expect(preview.status).toBe(200);
      const res = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send(body);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ role: 'sheet:blueprint@form-kid', delegatedTo: null });
      const params = queuedParams();
      expect(params.catalogAttach).toEqual({ ingredientId: 'cat-chr-1', kind: 'reference', role: 'sheet:blueprint@form-kid' });
      expect(params.prompt).toContain('oversized yellow raincoat');
      expect(params.prompt).not.toContain('silver coat');
      expect(params.prompt).not.toContain('short bob');
      expect(params.prompt).toContain('long waves');
      expect(params.prompt).toContain('green eyes and a distinctive nose');
      expect(preview.body.preview.sentPrompt).toBe(params.prompt);
      expect(mocks.updateUniverse).not.toHaveBeenCalled();
    });

    // Catches a child's sheet drawn at the adult's height (the canonical Height stat).
    it('states an age\'s own height on its sheet, else the typical height for a child age', async () => {
      const tall = { ...aged, payload: { ...aged.payload, stats: [{ id: 'stat-h', label: 'Height', value: '5 ft 9 in' }] } };
      mocks.getIngredient.mockResolvedValue(tall);
      const sheet = async (forms, variant = 'standard') => {
        mocks.getIngredient.mockResolvedValue({ ...tall, payload: { ...tall.payload, forms } });
        return (await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send({ variant, formId: 'form-kid' })).body.preview.sentPrompt;
      };
      const typical = await sheet(aged.payload.forms);
      expect(typical).toContain('Height: about 4 ft (122 cm)');
      expect(typical).not.toContain('5 ft 9 in');
      expect(await sheet([{ ...aged.payload.forms[0], height: '3 ft 8 in' }])).toContain('Height: 3 ft 8 in');
      expect(await sheet(aged.payload.forms, 'photographic')).toContain('Height: about 4 ft (122 cm).');
    });

    // Catches an age or look editing the present-day portrait (a 7-year-old
    // drawn from the adult's face) and the preview hiding which images are sent.
    describe('edit base for an age or look', () => {
      const codex = { imageGen: { mode: 'codex', codex: { enabled: true } } };
      beforeEach(() => {
        mocks.getSettings.mockResolvedValue(codex);
        mocks.getIngredient.mockResolvedValue(aged);
        ['portrait.png', 'kid.png'].forEach((name) => mocks.imageFiles.add(name));
      });

      it('edits from the form’s own guide, not the canonical portrait, exactly as previewed', async () => {
        mocks.listMediaForIngredient.mockResolvedValue([
          { kind: 'portrait', mediaKey: 'portrait.png' },
          { kind: 'reference', mediaKey: 'kid.png', library: { guide: true, variant: { formId: 'form-kid' } } },
        ]);
        const body = { variant: 'blueprint', formId: 'form-kid' };
        const sent = (await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send(body)).body.preview;
        expect(sent.editBase).toMatchObject({ filename: 'kid.png', status: 'included', scope: 'form', source: 'Render guide · Age 7' });
        expect(sent.referenceImages.map((ref) => [ref.filename, ref.role])).toEqual([['kid.png', 'edit-base']]);
        expect(sent.promptAdditions.map((a) => a.id)).toContain('form-edit-base');
        expect(sent.promptAdditions.map((a) => a.id)).not.toContain('portrait-edit-base');
        await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send(body);
        const params = queuedParams();
        expect(basename(params.initImagePath)).toBe('kid.png');
        await expectBackendPreview(sent, params);
      });

      it('generates fresh with the canonical portrait as a likeness guide when the form has no image', async () => {
        mocks.listMediaForIngredient.mockResolvedValue([{ kind: 'portrait', mediaKey: 'portrait.png' }]);
        const body = { variant: 'blueprint', formId: 'form-kid' };
        const sent = (await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets/preview').send(body)).body.preview;
        expect(sent.editBase).toMatchObject({ status: 'none', reason: expect.stringContaining('generated fresh') });
        expect(sent.referenceImages.map((ref) => [ref.filename, ref.role, ref.source])).toEqual([
          ['portrait.png', undefined, 'Portrait · canonical · present story'],
        ]);
        const identity = sent.promptAdditions.find((a) => a.id === 'character-identity');
        expect(identity.text).toContain('another age or look than Age 7');
        await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send(body);
        const params = queuedParams();
        expect(params.initImagePath).toBeUndefined();
        expect(params.referenceImagePaths.map((path) => basename(path))).toEqual(['portrait.png']);
      });
    });

    it('refuses an unknown form, an undescribed form and a form on a look', async () => {
      mocks.getIngredient.mockResolvedValue(aged);
      const post = (body) => request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send(body);
      expect((await post({ formId: 'form-nope' })).status).toBe(400);
      expect((await post({ formId: 'form-empty' })).status).toBe(400);
      expect((await post({ variant: 'look', wardrobeId: 'wd-x', formId: 'form-kid' })).status).toBe(400);
      expect(mocks.enqueueJob).not.toHaveBeenCalled();
    });

    it('swaps a place form into its era and description', async () => {
      mocks.getIngredient.mockResolvedValue({ ...place, payload: { ...place.payload, era: '1985',
        forms: [{ id: 'form-ruin', label: 'Ruined', age: '2040', description: 'collapsed piers, rusted cranes' }] } });
      const res = await request(app).post('/api/catalog/ingredients/cat-plc-1/sheets').send({ formId: 'form-ruin' });
      expect(res.status).toBe(200);
      expect(queuedParams().prompt).toContain('collapsed piers, rusted cranes');
      expect(queuedParams().catalogAttach.role).toBe('sheet:environment@form-ruin');
    });
  });

  describe('removing a universe sheet pointer', () => {
    const sheetOwner = { ...character, updatedAt: '2026-01-01T00:00:00.000Z', payload: { ...character.payload,
      referenceSheetImageRef: 'example-sheet-standard.png', referenceSheets: { profile: 'example-sheet-profile.png', alt: 'example-sheet-standard.png' } } };
    const remove = (query = '') => request(app).delete(`/api/catalog/ingredients/${character.id}/sheets/pointer${query}`);
    // Runs the updater and guard against `locked` (the row under its lock).
    const lockedRow = (locked = sheetOwner) => mocks.updateIngredientPayloadKeys.mockImplementation(async (id, update, { guard }) => {
      guard({ ...locked, payload: locked.payload });
      const next = { ...locked.payload };
      for (const [key, value] of Object.entries(update(locked.payload))) {
        if (value === null) delete next[key]; else next[key] = value;
      }
      return { ingredient: { ...locked, updatedAt: '2026-01-03T00:00:00.000Z', payload: next }, priorUpdatedAt: locked.updatedAt };
    });

    beforeEach(() => {
      mocks.getIngredient.mockResolvedValue(sheetOwner);
      mocks.projectToCanon.mockResolvedValue({ universes: 1, written: 1, skipped: 0 });
    });

    it('clears every row slot naming the file in one locked write, then projects it to canon', async () => {
      // Another view edited the row after the snapshot; its clock is the prior one.
      lockedRow({ ...sheetOwner, updatedAt: '2026-01-02T00:00:00.000Z' });
      const res = await remove('?filename=example-sheet-standard.png');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ filename: 'example-sheet-standard.png', priorUpdatedAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z', pointers: { referenceSheetImageRef: null, referenceSheets: { profile: 'example-sheet-profile.png' } } });
      const [projectedId, projected] = mocks.projectToCanon.mock.calls[0];
      expect(projectedId).toBe(character.id);
      expect(projected.payload.referenceSheetImageRef).toBeUndefined();
      expect(mocks.updateUniverse).not.toHaveBeenCalled();
    });

    it('refuses whole, with nothing written or projected, when the slot moved on or the record is locked', async () => {
      lockedRow({ ...sheetOwner, payload: { ...sheetOwner.payload, referenceSheets: { profile: 'example-sheet-profile-newer.png' } } });
      const changed = await remove('?variant=profile&filename=example-sheet-profile.png');
      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe('REFERENCE_SHEET_CHANGED');
      lockedRow({ ...sheetOwner, payload: { ...sheetOwner.payload, locked: true } });
      expect((await remove()).status).toBe(409);
      expect(mocks.projectToCanon).not.toHaveBeenCalled();
    });

    it('answers 404 for a variant with no sheet', async () => {
      mocks.getIngredient.mockResolvedValue(character);
      expect((await remove('?variant=profile')).status).toBe(404);
      expect(mocks.updateIngredientPayloadKeys).not.toHaveBeenCalled();
    });
  });
});

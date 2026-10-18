vi.mock('../services/catalogDB/identityAccess.js', () => ({ assertCatalogIdentityWritable: vi.fn(async id => id) }));
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  getSettings: vi.fn(),
  enqueueJob: vi.fn(),
  getImageModels: vi.fn(),
}));

vi.mock('../lib/imageCleanDefaults.js', () => ({
  resolveImageCleaners: vi.fn(() => ({ cleanC2PA: false, denoise: false })),
}));
vi.mock('../services/catalogDB.js', () => ({
  getIngredient: (...args) => mocks.getIngredient(...args),
  getIngredientIdentityIds: async id => [id],
  listLiveRefsForIngredient: (...args) => mocks.listLiveRefsForIngredient(...args),
}));
vi.mock('../services/universeBuilder.js', () => ({
  getUniverse: (...args) => mocks.getUniverse(...args),
  updateUniverse: (...args) => mocks.updateUniverse(...args),
}));
vi.mock('../services/settings.js', () => ({ getSettings: (...args) => mocks.getSettings(...args) }));
vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: (...args) => mocks.enqueueJob(...args),
  getJob: vi.fn(),
  mediaJobEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));
vi.mock('../services/universeRunTag.js', () => ({ buildUniverseRunTag: vi.fn(async () => null) }));
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listLiveRefsForIngredient.mockResolvedValue([]);
  mocks.getSettings.mockResolvedValue({ imageGen: { mode: 'local', local: { pythonPath: '/python', modelId: 'dev' } } });
  mocks.getImageModels.mockReturnValue([{ id: 'dev', hardwareCompatibility: { state: 'available' } }]);
  mocks.enqueueJob.mockReturnValue({ jobId: 'job-1', position: 1 });
  mocks.updateUniverse.mockResolvedValue({});
});

describe('catalog sheet routes', () => {
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
    mocks.listLiveRefsForIngredient.mockResolvedValue([{ refKind: 'universe', refId: 'universe-1' }]);
    mocks.getUniverse.mockResolvedValue({
      id: 'universe-1', name: 'Example Universe', influences: { embrace: [] },
      characters: [{ id: 'char-entry-1', name: 'Example Hero', ingredientId: 'cat-chr-1' }],
    });
    const res = await request(app).post('/api/catalog/ingredients/cat-chr-1/sheets').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ delegatedTo: 'universe', universeId: 'universe-1', entryId: 'char-entry-1', variant: 'standard' });
    const params = queuedParams();
    expect(params.characterSheet).toMatchObject({ universeId: 'universe-1', entryId: 'char-entry-1', variant: 'standard' });
    expect(params.catalogAttach).toBeUndefined();
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

  describe('look renders', () => {
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
      mocks.listLiveRefsForIngredient.mockResolvedValue([{ refKind: 'universe', refId: 'universe-1' }]);
      mocks.getUniverse.mockResolvedValue({
        id: 'universe-1', name: 'Example Universe', influences: { embrace: ['ink and watercolor'] },
        characters: [{ id: 'char-entry-1', name: 'Example Hero', ingredientId: 'cat-chr-1' }],
      });
      const body = { variant: 'look', wardrobeId: 'wd-scarf' };
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
});

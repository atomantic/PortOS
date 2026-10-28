import { beforeEach, describe, expect, it, vi } from 'vitest';
import { basename } from 'node:path';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const state = vi.hoisted(() => ({ get: vi.fn(), media: vi.fn(), enqueue: vi.fn(), writable: vi.fn(), available: true,
  dimensions: { width: 1024, height: 1024 }, mode: 'codex' }));
vi.mock('../services/catalogDB/ingredients.js', () => ({ getIngredient: state.get }));
vi.mock('../services/catalogDB/media.js', () => ({ listMediaForIngredient: state.media }));
vi.mock('../services/catalogDB/identityAccess.js', () => ({ assertCatalogIdentityWritable: state.writable }));
vi.mock('../services/catalogPrimitives.js', () => ({
  getPrimitiveContext: async () => ({ owner: null }), setPrimitiveOwner: vi.fn(), forkPrimitive: vi.fn(),
}));
vi.mock('../services/settings.js', () => ({ getSettings: async () => ({ imageGen: {
  mode: state.mode, codex: { enabled: true }, local: { modelId: 'dev', pythonPath: '/example/python' },
} }) }));
vi.mock('../lib/mediaModels.js', async original => ({ ...await original(), getImageModels: () => [
  { id: 'dev', runner: 'mflux', hardwareCompatibility: { state: 'available' } },
] }));
vi.mock('../services/universeBuilder/crud.js', () => ({ getUniverse: vi.fn(), getUniverseRenderPin: vi.fn() }));
vi.mock('../services/imageGen/regen.js', () => ({ readImageDimensions: async () => state.dimensions }));
vi.mock('../services/mediaJobQueue/index.js', () => ({ enqueueJob: state.enqueue, assertMediaQueueRoom: vi.fn() }));
vi.mock('../lib/pathSafety.js', async original => ({
  ...await original(), resolveImageInputPath: path => state.available ? `/tmp/example-media/${basename(path)}` : null,
}));
vi.mock('../lib/fileUtils.js', async original => ({
  ...await original(), resolveGalleryImage: filename => state.available ? `/tmp/example-media/${filename}` : null,
}));
const { default: router } = await import('./catalogPrimitives.js');
const app = express(); app.use(express.json()); app.use('/ingredients/:id', router); app.use(errorMiddleware);
const source = { mediaKey: 'source.png', kind: 'reference', library: {
  variant: { age: 17 }, tags: ['period'], review: { status: 'bad', feedback: 'Wrong face' },
} };
const input = { mediaKey: 'source.png', kind: 'reference', feedback: '  Restore the same face.\nKeep her long waves.  ' };
beforeEach(() => {
  vi.clearAllMocks(); state.available = true; state.mode = 'codex';
  state.dimensions = { width: 1024, height: 1024 };
  state.writable.mockResolvedValue('cast');
  state.get.mockResolvedValue({ id: 'cast', name: 'Example performer', type: 'character', payload: {
    age: '27', physicalDescription: 'adult short bob and dark coat', visualIdentity: 'green eyes, freckles, distinctive nose',
    forms: [{ id: 'teen', label: 'Teen', age: '17', description: 'long waves and a period ringer shirt' }],
  } });
  state.media.mockResolvedValue([source,
    { mediaKey: 'adult.png', kind: 'reference', library: { guide: true, variant: { age: 27 } } },
    { mediaKey: 'rejected.png', kind: 'reference', library: { guide: true, variant: { age: 17 }, review: { status: 'rejected' } } },
    { mediaKey: 'teen-guide.png', kind: 'reference', library: { variant: { age: 17 }, review: { status: 'good' } } },
  ]);
  state.enqueue.mockResolvedValue({ jobId: 'refinement-job', position: 1 });
});
describe('reference image refinement boundary', () => {
  it('previews exact feedback and age-specific appearance without generating, then queues the same input with durable lineage', async () => {
    const preview = await request(app).post('/ingredients/cast/media/refine/compose').send(input);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(preview.body.sentPrompt).toContain(input.feedback);
    expect(preview.body.sentPrompt).toContain('long waves and a period ringer shirt');
    expect(preview.body.sentPrompt).toContain('green eyes, freckles, distinctive nose');
    expect(preview.body.sentPrompt).not.toContain('adult short bob');
    const render = await request(app).post('/ingredients/cast/media/refine').send(input);
    expect(render.status).toBe(200);
    const params = state.enqueue.mock.calls[0][0].params;
    expect(params.initImagePath).toContain('source.png');
    expect(params.referenceImagePaths.map(path => basename(path))).toEqual(['teen-guide.png']);
    expect(params).toMatchObject({ width: 1024, height: 1024, catalogAttach: {
      ingredientId: 'cast', kind: 'reference', role: 'refinement', library: {
        variant: { age: 17, formId: 'teen' }, tags: ['period'], guide: false,
        review: { status: 'unreviewed', feedback: input.feedback }, derivedFrom: { mediaKey: 'source.png', kind: 'reference' },
      },
    } });
    const { previewImagePrompt } = await import('../services/imageGen/promptPreview.js');
    // The provider wrapper and user feedback match the same native preview path.
    expect((await previewImagePrompt({ prompt: params.prompt, mode: 'codex', width: 1024, height: 1024,
      initImageFile: 'source.png', referenceImageFiles: ['teen-guide.png'], promptAdditions: params.promptAdditions })).sentPrompt)
      .toBe(preview.body.sentPrompt);
  });
  // Catches a form's free-text description (with its everyday outfit) being
  // sent beside a look's outfit, so the refine fights the requested clothes.
  it('refines a look image in the look’s outfit only, keeping the form’s age and shared identity', async () => {
    state.get.mockResolvedValue({ id: 'cast', name: 'Example performer', type: 'character', payload: {
      age: '27', physicalDescription: 'adult short bob and dark coat', visualIdentity: 'green eyes, freckles, distinctive nose',
      forms: [{ id: 'teen', label: 'Teen', age: '17', description: 'long waves and a period ringer shirt' }],
      wardrobes: [{ id: 'wd-gala', name: 'Gala', description: 'floor-length emerald gown' }],
    } });
    state.media.mockResolvedValue([{ mediaKey: 'look.png', kind: 'reference', role: 'look:wd-gala', library: { variant: { formId: 'teen' } } }]);
    const look = { mediaKey: 'look.png', kind: 'reference', feedback: 'Fix the face.' };
    const preview = await request(app).post('/ingredients/cast/media/refine/compose').send(look);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.sentPrompt).toContain('floor-length emerald gown');
    expect(preview.body.sentPrompt).toContain('Age: 17');
    expect(preview.body.sentPrompt).toContain('green eyes, freckles, distinctive nose');
    expect(preview.body.sentPrompt).not.toContain('period ringer shirt');
    expect(preview.body.sentPrompt).not.toContain('dark coat');
  });
  it('refuses invalid guidance, unattached assets and undescribed ages before enqueueing', async () => {
    for (const feedback of ['', '   ', 'x'.repeat(2001), 'bad\0input']) {
      expect((await request(app).post('/ingredients/cast/media/refine').send({ ...input, feedback })).status).toBe(400);
    }
    expect((await request(app).post('/ingredients/cast/media/refine').send({ ...input, mediaKey: 'other.png' })).status).toBe(404);
    state.media.mockResolvedValue([{ ...source, library: { variant: { age: 7 } } }]);
    expect((await request(app).post('/ingredients/cast/media/refine').send(input)).status).toBe(409);
    expect(state.enqueue).not.toHaveBeenCalled();
  });
  it('preserves shared-identity write fences and refuses missing source files', async () => {
    state.available = false;
    expect((await request(app).post('/ingredients/cast/media/refine').send(input)).status).toBe(422);
    state.writable.mockRejectedValue(Object.assign(new Error('Read-only identity'), { status: 409 }));
    expect((await request(app).post('/ingredients/cast/media/refine').send(input)).status).toBe(409);
    expect(state.enqueue).not.toHaveBeenCalled();
  });
  it('uses the selected form age rather than stale independently edited reference tags', async () => {
    state.media.mockResolvedValue([
      { ...source, library: { variant: { age: 27, era: 'adult', formId: 'teen' } } },
      { mediaKey: 'teen-guide.png', kind: 'reference', library: { variant: { age: 17 }, guide: true } },
      { mediaKey: 'adult-guide.png', kind: 'reference', library: { variant: { age: 27 }, guide: true } },
    ]);
    const result = await request(app).post('/ingredients/cast/media/refine').send(input);
    expect(result.status).toBe(200);
    const params = state.enqueue.mock.calls[0][0].params;
    expect(params.prompt).toContain('Age: 17');
    expect(params.prompt).not.toContain('Age: 27');
    expect(params.referenceImagePaths.map(path => basename(path))).toEqual(['teen-guide.png']);
    expect(params.catalogAttach.library.variant.age).toBe(17);
  });
  it('refuses oversized image inputs before queueing a render', async () => {
    state.dimensions = { width: 8000, height: 8000 };
    expect((await request(app).post('/ingredients/cast/media/refine/compose').send(input)).status).toBe(422);
    expect((await request(app).post('/ingredients/cast/media/refine').send(input)).status).toBe(422);
    expect(state.enqueue).not.toHaveBeenCalled();
  });
  it('keeps init-only local editing available without unsupported additional guides', async () => {
    state.mode = 'local';
    const result = await request(app).post('/ingredients/cast/media/refine').send(input);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const params = state.enqueue.mock.calls[0][0].params;
    expect(params).toMatchObject({ mode: 'local', modelId: 'dev', initImagePath: '/tmp/example-media/source.png' });
    expect(params.referenceImagePaths).toBeUndefined();
  });
  it('selects the editable canonical attachment when a retained duplicate sorts first', async () => {
    state.media.mockResolvedValue([
      { ...source, ingredientId: 'old-source', retained: true }, { ...source, ingredientId: 'cast' },
    ]);
    const result = await request(app).post('/ingredients/cast/media/refine').send(input);
    expect(result.status).toBe(200);
    expect(state.enqueue).toHaveBeenCalledOnce();
  });
  it('requires the canonical record to be unlocked before refining', async () => {
    state.get.mockResolvedValue({ id: 'cast', payload: { locked: true } });
    expect((await request(app).post('/ingredients/cast/media/refine').send(input)).status).toBe(409);
    expect(state.enqueue).not.toHaveBeenCalled();
  });
});

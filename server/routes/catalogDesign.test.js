import { beforeEach, describe, expect, it, vi } from 'vitest';
import { basename } from 'node:path';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const state = vi.hoisted(() => ({ get: vi.fn(), media: vi.fn(), enqueue: vi.fn(), writable: vi.fn(), run: vi.fn(), room: vi.fn(), mode: 'codex' }));
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
vi.mock('../services/imageGen/regen.js', () => ({ readImageDimensions: async () => ({ width: 832, height: 1216 }) }));
vi.mock('../services/mediaJobQueue/index.js', () => ({ enqueueJob: state.enqueue, assertMediaQueueRoom: state.room }));
vi.mock('../services/promptRunner.js', () => ({
  resolveProviderAndModel: async () => ({ provider: { id: 'example-api', enabled: true }, selectedModel: 'example-model' }),
  assertProvider: () => {}, runPromptThroughProvider: state.run,
}));
vi.mock('../lib/pathSafety.js', async original => ({
  ...await original(), resolveImageInputPath: path => `/tmp/example-media/${basename(path)}`,
}));
vi.mock('../lib/fileUtils.js', async original => ({
  ...await original(), resolveGalleryImage: filename => `/tmp/example-media/${filename}`,
}));
const { default: router } = await import('./catalogPrimitives.js');
const app = express(); app.use(express.json()); app.use('/ingredients/:id', router); app.use(errorMiddleware);
const post = (path, body) => request(app).post(`/ingredients/cast/design/${path}`).send(body);
const params = () => state.enqueue.mock.calls.map(([job]) => job.params);

beforeEach(() => {
  vi.clearAllMocks(); state.mode = 'codex';
  state.writable.mockResolvedValue('cast');
  state.get.mockResolvedValue({ id: 'cast', name: 'Example performer', type: 'character', payload: {
    age: '27', physicalDescription: 'shoulder-length brown hair, wool coat', visualIdentity: 'the old face',
    forms: [{ id: 'form-child01', label: 'Child', age: '7', description: 'pigtails and a yellow raincoat' }],
  } });
  state.media.mockResolvedValue([
    { mediaKey: 'old-guide.png', kind: 'reference', library: { guide: true } },
    { mediaKey: 'take.png', kind: 'reference', role: 'design:abcd1234:0', library: { likeness: false } },
  ]);
  let n = 0;
  state.enqueue.mockImplementation(async () => ({ jobId: `job-${++n}` }));
});

describe('Casting design rounds', () => {
  // The old references pulled every redesign back to the old face (Nora v2):
  // an open round is text only, and its takes stay out of likeness.
  it('renders an open round text only, one take per line, filed as left-out design takes', async () => {
    const body = { mode: 'open', note: 'Plain in flat light.', lines: ['A long face.', 'A round face.'] };
    const preview = await post('render/compose', body);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(preview.body.sentPrompt).toContain('Plain in flat light.');
    expect(preview.body.sentPrompt).toContain('eyes looking off camera');
    expect(preview.body.sentPrompt).not.toContain('the old face');
    const result = await post('render', body);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.jobs.map(j => j.line)).toEqual(body.lines);
    expect(params()).toHaveLength(2);
    for (const [index, p] of params().entries()) {
      expect(p.initImagePath).toBeUndefined();
      expect(p.referenceImagePaths).toBeUndefined();
      expect(p.catalogAttach).toMatchObject({ ingredientId: 'cast', kind: 'reference', role: `design:${result.body.roundId}:${index}`,
        library: { variant: { age: 27 }, guide: false, likeness: false, review: { status: 'unreviewed' } } });
    }
    expect(params()[1].prompt).toContain('A round face.');
  });

  it('keeps takes already queued when a later take is refused, reporting them on the error', async () => {
    const full = Object.assign(new Error('Media queue is full'), { status: 503, code: 'MEDIA_QUEUE_FULL' });
    state.enqueue.mockClear();
    state.enqueue.mockResolvedValueOnce({ jobId: 'job-a' }).mockRejectedValueOnce(full);
    const body = { mode: 'open', lines: ['A long face.', 'A round face.'] };
    const result = await post('render', body);
    expect(result.status).toBe(503);
    expect(result.body.error).toMatch(/^Queued 1 of 2 takes/);
    expect(result.body.context.jobs).toEqual([{ jobId: 'job-a', line: 'A long face.' }]);
    expect(result.body.context.roundId).toBeTruthy();
    state.enqueue.mockClear();
    state.enqueue.mockResolvedValueOnce({ jobId: 'job-b' }).mockRejectedValueOnce(new Error('disk exploded'));
    const other = await post('render', body);
    expect(other.body.error).toMatch(/^Queued 1 of 2 takes — disk exploded/);
    expect(other.body.context.jobs).toHaveLength(1);
    state.enqueue.mockClear();
    state.enqueue.mockRejectedValueOnce(full);
    expect((await post('render', body)).body.context?.jobs).toBeUndefined();
  });

  it('refuses a round that does not fit before queueing any take', async () => {
    state.room.mockImplementationOnce(() => { throw Object.assign(new Error('Too big'), { status: 503, code: 'MEDIA_BATCH_TOO_LARGE' }); });
    const result = await post('render', { mode: 'open', lines: ['A long face.', 'A round face.'] });
    expect(result.status).toBe(503);
    expect(state.enqueue).not.toHaveBeenCalled();
  });

  it('varies one feature of the picked take from its image alone, recording lineage', async () => {
    const result = await post('render', { mode: 'feature', baseImageFile: 'take.png', feature: 'noseSize' });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(params()).toHaveLength(8);
    expect(params()[0].prompt).toContain('Make the nose far smaller.');
    expect(params()[7].prompt).toContain('Make the nose far larger.');
    for (const p of params()) {
      expect(basename(p.initImagePath)).toBe('take.png');
      expect(p.referenceImagePaths).toBeUndefined();
      expect(p).toMatchObject({ width: 832, height: 1216 });
      expect(p.catalogAttach.library.derivedFrom).toEqual({ mediaKey: 'take.png', kind: 'reference' });
    }
  });

  it('blends toward a second face sent as the only reference, and refuses a backend that cannot take one', async () => {
    const result = await post('render', { mode: 'blend', baseImageFile: 'take.png', blendImageFile: 'other-face.png', features: ['noseShape'] });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(params()).toHaveLength(4);
    expect(params()[2].prompt).toContain('halfway toward the face in the second image. Change only the nose.');
    expect(params()[0].referenceImagePaths.map(p => basename(p))).toEqual(['other-face.png']);
    state.enqueue.mockClear(); state.mode = 'local';
    expect((await post('render', { mode: 'blend', baseImageFile: 'take.png', blendImageFile: 'other-face.png' })).status).toBe(400);
    expect(state.enqueue).not.toHaveBeenCalled();
  });

  it('redesigns from canon toward several faces at a chosen strength, with the note as written', async () => {
    const note = 'Keep the hair, but update the face structure toward these references.';
    const body = { mode: 'blend', baseImageFile: 'old-guide.png', blendImageFiles: ['face-a.png', 'face-b.png'], strength: 50, count: 3, note };
    const result = await post('render', body);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(params()).toHaveLength(3);
    for (const p of params()) {
      expect(basename(p.initImagePath)).toBe('old-guide.png');
      expect(p.referenceImagePaths.map(r => basename(r))).toEqual(['face-a.png', 'face-b.png']);
      expect(p.prompt).toContain(note);
      expect(p.prompt).toContain('about 50% of the way toward a blend of the faces in images 2 to 3.');
      expect(p.prompt).toContain('Every attached image after the first is a face reference only.');
      expect(p.catalogAttach.library.derivedFrom).toEqual({ mediaKey: 'old-guide.png', kind: 'reference' });
    }
    expect((await post('render', { ...body, blendImageFile: 'face-c.png' })).status).toBe(400);
  });

  it('carries a take to another age with that age’s hair and clothing', async () => {
    const result = await post('render', { mode: 'age', baseImageFile: 'take.png', formId: 'form-child01', count: 2 });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(params()).toHaveLength(2);
    expect(params()[0].prompt).toContain('pigtails and a yellow raincoat');
    expect(params()[0].catalogAttach.library.variant).toEqual({ age: 7, formId: 'form-child01' });
  });

  it('asks the provider for exactly the requested face lines and rejects a short answer', async () => {
    const body = { idea: 'Ordinary until the light hits her.', count: 2, providerId: 'example-api' };
    state.run.mockResolvedValue({ text: JSON.stringify({ lines: ['A long face.', 'A round face.'] }), runId: 'run-1' });
    const result = await post('spread', body);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.lines).toEqual(['A long face.', 'A round face.']);
    expect(state.run.mock.calls[0][0].prompt).toContain('Ordinary until the light hits her.');
    state.run.mockResolvedValue({ text: JSON.stringify({ lines: ['Only one.'] }) });
    expect((await post('spread', body)).status).toBe(502);
  });

  it('refuses locked records, unknown ages and malformed rounds before queueing', async () => {
    expect((await post('render', { mode: 'open', lines: [''] })).status).toBe(400);
    expect((await post('render', { mode: 'feature', baseImageFile: 'take.png', feature: 'ears' })).status).toBe(400);
    expect((await post('render', { mode: 'age', baseImageFile: 'take.png', formId: 'form-gone0001' })).status).toBe(409);
    state.get.mockResolvedValue({ id: 'cast', name: 'Example performer', type: 'character', payload: { locked: true } });
    expect((await post('render', { mode: 'open', lines: ['A long face.'] })).status).toBe(409);
    expect(state.enqueue).not.toHaveBeenCalled();
  });
});

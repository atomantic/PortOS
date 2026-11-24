/**
 * Blender model references (#17876) through the real router, services, prompt
 * builders, preview and completion hook. Doubled: the PostgreSQL row, settings,
 * the image catalog, the Casting store and the media queue (the render's
 * terminal effect; its event bus is real so the hook hears completions).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('blender-model-references-test-');
const ID = 'bmodel-00000000-0000-4000-8000-000000000000';
const mocks = vi.hoisted(() => ({ row: null, jobs: new Map(), enqueueJob: vi.fn(), settings: null, getIngredient: vi.fn(), listMediaForIngredient: vi.fn() }));

vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../lib/backupSnapshotBoundary.js', () => ({ withBackupAssetPublication: vi.fn((work) => work()) }));
vi.mock('../services/settings.js', () => ({ getSettings: async () => mocks.settings }));
vi.mock('../lib/mediaModels.js', async (importOriginal) => ({
  ...await importOriginal(),
  getImageModels: () => [{ id: 'dev', runner: 'flux2', hardwareCompatibility: { state: 'available' } }],
}));
vi.mock('../services/catalog/catalogDB.js', () => ({ getIngredient: (...args) => mocks.getIngredient(...args), listMediaForIngredient: (...args) => mocks.listMediaForIngredient(...args) }));
vi.mock('../services/codeAnimation/execution.js', () => ({
  getCodeAnimationExecution: async () => ({ executionMode: 'contained', lanes: { blender: { ready: false, reason: null } }, probe: null }),
}));
vi.mock('../services/mediaJobQueue/index.js', async () => {
  const { EventEmitter } = await import('node:events');
  return { mediaJobEvents: new EventEmitter(), enqueueJob: (...args) => mocks.enqueueJob(...args), getJob: (id) => mocks.jobs.get(id) ?? null, listJobs: () => [] };
});
vi.mock('../services/blenderModels/store.js', async (importOriginal) => ({
  ...await importOriginal(),
  announceBlenderModel: () => {},
  getModel: async (id) => (mocks.row?.id === id && !mocks.row.deleted ? structuredClone(mocks.row) : null),
  mutateModel: async (_id, mutate) => {
    const next = mutate(structuredClone(mocks.row));
    if (next) mocks.row = structuredClone(next);
    return structuredClone(mocks.row);
  },
}));

const { default: routes } = await import('./blenderModels.js');
const { mediaJobEvents } = await import('../services/mediaJobQueue/index.js');
const { createMediaJobHookLoader } = await import('../services/mediaJobQueue/hookRegistry.js');
const { registerMediaJobTerminalHooks } = await import('../services/bootHookRegistry.js');
const hook = await import('../services/blenderModels/referenceImageHook.js');
registerMediaJobTerminalHooks([
  [job => job.params?.blenderModelReference, () => hook.initBlenderModelReferenceHook()],
]);

const app = express();
app.use(express.json());
app.use('/api/blender-models', routes);
app.use(errorMiddleware);
afterAll(cleanupTempDataRoots);

const api = (suffix = '') => `/api/blender-models/${ID}${suffix}`;
const ref = (id, suffix = '') => api(`/references/${id}${suffix}`);
const slot = (id = 'overall') => mocks.row.references.find((entry) => entry.id === id);
const src = (path) => join(ROOT(), 'blender-models', ID, 'src', path);
const image = (filename, bytes = filename) => {
  mkdirSync(join(ROOT(), 'images'), { recursive: true });
  writeFileSync(join(ROOT(), 'images', filename), bytes);
  return filename;
};
const setSource = (patch) => request(app).patch(api('/reference-source')).send(patch);
const ok = (response, status = 200) => { expect(response.status, JSON.stringify(response.body)).toBe(status); return response.body; };

/** Finish a queued job the way the queue does after a restart: hooks load from the registry for the persisted job. */
async function finish(params, filename, event = 'completed', extra = {}) {
  const job = { id: filename.replace('.png', ''), kind: 'image', params: JSON.parse(JSON.stringify(params)), result: { filename: image(filename) }, ...extra };
  mocks.jobs.delete(job.id);
  await createMediaJobHookLoader()(job);
  mediaJobEvents.emit(event, job);
  await hook.__testing.settled();
}
async function render(id, jobId, words = '') {
  mocks.enqueueJob.mockImplementationOnce(async ({ params }) => { mocks.jobs.set(jobId, { id: jobId, status: 'running' }); return { jobId, params }; });
  ok(await request(app).post(ref(id, '/render')).send({ words }), 202);
  return mocks.enqueueJob.mock.lastCall[0].params;
}
const review = async (id, imageId, body) => ok(await request(app).post(ref(id, `/images/${imageId}/review`)).send(body));
async function approveOverall(jobId = 'sheet-1') {
  await finish(await render('overall', jobId), `${jobId}.png`);
  await review('overall', slot().images.at(-1).id, { decision: 'approve' });
}

beforeEach(() => {
  vi.clearAllMocks();
  hook.__testing.reset();
  mocks.jobs.clear();
  mocks.settings = { imageGen: { mode: 'local', local: { pythonPath: '/python', modelId: 'dev' } } };
  // A record written before references existed.
  mocks.row = { id: ID, name: 'Example lamp', description: 'A folding lamp', status: 'draft', publishedBuildId: null, builds: [] };
});

describe('Blender model references', () => {
  it('brings a Casting object\'s canonical image, product sheet and size in, and queues nothing', async () => {
    image('lamp.png'); image('lamp-sheet.png');
    mocks.getIngredient.mockResolvedValue({ id: 'cat-1', type: 'object', name: 'Example lantern', payload: { size: '30 cm tall' } });
    mocks.listMediaForIngredient.mockResolvedValue([
      { kind: 'portrait', mediaKey: 'lamp.png' }, { kind: 'reference', role: 'sheet:product', mediaKey: 'lamp-sheet.png' }, { kind: 'reference', mediaKey: 'other.png' },
    ]);
    const { referenceSource } = ok(await setSource({ ingredientId: 'cat-1' }));
    expect(referenceSource).toMatchObject({ name: 'Example lantern', size: '30 cm tall', images: [{ filename: 'lamp.png' }, { filename: 'lamp-sheet.png' }] });
    ok(await request(app).post(ref('overall', '/preview')).send({ words: 'x' }));
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
    mocks.getIngredient.mockResolvedValue({ id: 'cat-2', type: 'place', name: 'Example dock', payload: {} });
    expect((await setSource({ ingredientId: 'cat-2' })).status).toBe(400);
    expect((await setSource({ images: [{ filename: 'absent.png' }] })).status).toBe(400);
  });

  it('previews exactly what it sends, with the user\'s words verbatim and every addition listed', async () => {
    const words = '  Brass, not steel.\n\tKeep   the dents ';
    expect((await request(app).post(ref('overall', '/render')).send({ words })).body.code).toBe('BLENDER_MODEL_SIZE_REQUIRED');
    ok(await setSource({ size: '22 x 22 x 52 cm', images: [{ filename: image('photo.png') }] }));
    const overall = ok(await request(app).post(ref('overall', '/preview')).send({ words }));
    const params = await render('overall', 'sheet-1', words);
    const { localSentPrompt } = await import('../services/imageGen/local.js');
    const sent = async (p) => (await localSentPrompt({ ...p, model: { id: 'dev', runner: 'flux2' } }));
    expect(overall.sentPrompt).toBe((await sent(params)).sentPrompt);
    expect(overall.sentPrompt).toContain(words);
    expect(overall.sentPrompt).toContain('Real-world size: 22 x 22 x 52 cm.');
    for (const view of ['FRONT', 'BACK', 'LEFT', 'RIGHT', 'TOP', 'BOTTOM']) expect(overall.sentPrompt).toContain(view);
    // The words and the listed additions account for the whole prompt.
    expect([...params.promptAdditions.filter((a) => a.id.startsWith('model-')).map((a) => a.text), words].join('\n\n')).toBe(params.prompt);
    expect(overall.referenceImages).toMatchObject([{ filename: 'photo.png', status: 'included' }]);

    await finish(params, 'sheet-1.png');
    await review('overall', slot().images[0].id, { decision: 'approve' });
    ok(await request(app).post(api('/references')).send({ mechanism: 'Hinge' }), 201);
    const plateId = mocks.row.references[1].id;
    const plate = ok(await request(app).post(ref(plateId, '/preview')).send({ words }));
    const plateParams = await render(plateId, 'plate-1', words);
    expect(plate.sentPrompt).toBe((await sent(plateParams)).sentPrompt);
    expect(plate.referenceImages.map((entry) => entry.filename)).toEqual(['sheet-1.png', 'photo.png']);
    expect(plateParams.referenceImagePaths.map((path) => path.split(/[\\/]/).at(-1))).toEqual(['sheet-1.png', 'photo.png']);
  });

  it('refuses more references than the renderer takes instead of cutting them', async () => {
    const images = Array.from({ length: 6 }, (_, index) => ({ filename: image(`photo-${index}.png`) }));
    ok(await setSource({ size: '1 m', images }));
    expect(ok(await request(app).post(ref('overall', '/preview')).send({})).refusal).toBeNull();
    mocks.settings = { imageGen: { mode: 'codex', codex: { enabled: true } } };
    const { refusal } = ok(await request(app).post(ref('overall', '/preview')).send({}));
    expect(refusal).toMatch(/takes 5 reference images and this would send 6/);
    expect((await request(app).post(ref('overall', '/render')).send({})).body).toMatchObject({ code: 'BLENDER_MODEL_REFERENCE_INPUTS', error: refusal });
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
    expect((await setSource({ images: [...images, ...['a', 'b', 'c'].map((name) => ({ filename: image(`${name}.png`) }))] })).body.code).toBe('BLENDER_MODEL_TOO_MANY_SOURCES');
  });

  it('attaches a sheet that finished after a restart, even when the row never recorded the render', async () => {
    ok(await setSource({ size: '1 m' }));
    const params = await render('overall', 'sheet-1');
    expect((await request(app).post(ref('overall', '/render')).send({})).body.code).toBe('BLENDER_MODEL_REFERENCE_RENDERING');
    hook.__testing.reset();
    mocks.row.references[0].images = [];
    await finish(params, 'sheet-1.png');
    expect(slot().images).toMatchObject([{ filename: 'sheet-1.png', status: 'review' }]);
    await finish(params, 'sheet-1.png');
    expect(slot().images).toHaveLength(1);

    const failing = await render('overall', 'sheet-2');
    await finish(failing, 'sheet-2.png', 'failed', { error: 'example failure' });
    await vi.waitFor(() => expect(slot().images.at(-1)).toMatchObject({ status: 'failed', error: 'example failure' }));
    // A render whose job the queue no longer knows is shown as failed, so it can be rendered again.
    await render('overall', 'sheet-3');
    mocks.jobs.clear();
    expect(ok(await request(app).get(api())).references[0].images.at(-1)).toMatchObject({ status: 'failed' });
    mocks.row.deleted = true;
    await finish(failing, 'late.png');
    expect(slot().images.some((entry) => entry.filename === 'late.png')).toBe(false);
  });

  it('keeps redone images as superseded and an approved one until its replacement is approved', async () => {
    ok(await setSource({ size: '1 m' }));
    await finish(await render('overall', 'sheet-1', 'Brass'), 'sheet-1.png');
    const first = slot().images[0].id;
    await review('overall', first, { decision: 'redo', note: 'thinner base' });
    expect(slot()).toMatchObject({ words: 'Brass\nthinner base', images: [{ filename: 'sheet-1.png', status: 'superseded', note: 'thinner base' }] });
    expect(mocks.enqueueJob).toHaveBeenCalledTimes(1);

    await approveOverall('sheet-2');
    const second = slot().approvedImageId;
    expect(readFileSync(src('refs/overall.png'), 'utf8')).toBe('sheet-2.png');
    await review('overall', second, { decision: 'redo', note: 'taller' });
    await finish(await render('overall', 'sheet-3'), 'sheet-3.png');
    expect(slot().images.map((entry) => entry.status)).toEqual(['superseded', 'approved', 'review']);
    expect(readFileSync(src('refs/overall.png'), 'utf8')).toBe('sheet-2.png');
    await review('overall', slot().images[2].id, { decision: 'approve' });
    expect(slot().images.map((entry) => entry.status)).toEqual(['superseded', 'superseded', 'approved']);
    expect(readFileSync(src('refs/overall.png'), 'utf8')).toBe('sheet-3.png');
    expect(existsSync(join(ROOT(), 'images', 'sheet-2.png'))).toBe(true);
  });

  it('locks close-ups until the overall sheet is approved and marks plates out of date when it changes', async () => {
    ok(await setSource({ size: '1 m' }));
    ok(await request(app).post(api('/references')).send({ mechanism: 'Wheel hub' }), 201);
    expect((await request(app).post(api('/references')).send({ mechanism: 'wheel hub' })).status).toBe(409);
    const plateId = mocks.row.references[1].id;
    for (const [path, body] of [['/render', {}], ['/preview', {}], ['/images', { filename: image('own.png') }]]) {
      expect((await request(app).post(ref(plateId, path)).send(body)).body.code).toBe('BLENDER_MODEL_OVERALL_NOT_APPROVED');
    }
    await approveOverall('sheet-1');
    await finish(await render(plateId, 'plate-1'), 'plate-1.png');
    const state = await review(plateId, slot(plateId).images[0].id, { decision: 'approve' });
    expect(state.references[1]).toMatchObject({ locked: false, outOfDate: false });
    const { file } = slot(plateId);
    expect(file).toMatch(/^refs\/wheel-hub-[0-9a-f]{8}\.png$/);
    expect(existsSync(src(file))).toBe(true);

    ok(await request(app).post(ref('overall', '/images')).send({ filename: image('drawn.webp') }), 201);
    const changed = await review('overall', slot().images.at(-1).id, { decision: 'approve' });
    expect(changed.references[1].outOfDate).toBe(true);
    // The approved sheet's type changed, so its copy moved and the old name is gone.
    expect([existsSync(src('refs/overall.webp')), existsSync(src('refs/overall.png'))]).toEqual([true, false]);

    ok(await request(app).delete(ref(plateId)));
    expect([mocks.row.references.length, existsSync(src(file))]).toEqual([1, false]);
    expect((await request(app).delete(ref('overall'))).status).toBe(409);
  });

  it('creates the parts brief once, prefilled from the references', async () => {
    ok(await setSource({ size: '1 m' }));
    await approveOverall();
    ok(await request(app).post(api('/references')).send({ mechanism: 'Latch' }), 201);
    expect(ok(await request(app).post(api('/parts-brief')).send({}), 201).workspace.hasPartsBrief).toBe(true);
    const brief = readFileSync(src('PARTS.md'), 'utf8');
    for (const text of ['Real size: 1 m', '| Latch |', 'refs/overall.png', 'Which view wins']) expect(brief).toContain(text);
    expect((await request(app).post(api('/parts-brief')).send({})).status).toBe(409);
  });
});

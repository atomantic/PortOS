/**
 * The Blender Models routes through the real router and the real engine
 * (workspace, starter, build job, report, publish, pruning) over a temp data
 * root. Only Blender is doubled: a fake worker replays the driver events
 * recorded from a real build of the starter. The PostgreSQL row is an
 * in-memory double of store.js (its SQL has its own db.test.js).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { FAKE_GLB, createFakeModelBlender } from '../services/blenderModels/__modelFixture.js';

const ROOT = () => lazyTempDataRoot('blender-models-route-test-');
const blender = vi.hoisted(() => ({ fake: null, rows: new Map(), events: [] }));

vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../services/codeAnimation/execution.js', () => ({
  getCodeAnimationExecution: (...args) => blender.fake.getCodeAnimationExecution(...args),
  resolveBlenderTool: (...args) => blender.fake.resolveBlenderTool(...args),
}));
vi.mock('../lib/launchDetached.js', () => ({ launchDetached: vi.fn(async () => {}) }));
// Tiling needs ffmpeg; the sheets are optional.
vi.mock('../services/film/encode.js', () => ({ encodeBlenderSheet: vi.fn(async ({ output }) => { const { writeFileSync: write } = await import('node:fs'); write(output, 'sheet'); }) }));
vi.mock('../lib/backupSnapshotBoundary.js', () => ({ withBackupAssetPublication: vi.fn((work) => work()) }));
vi.mock('../services/blenderModels/store.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { ServerError } = await import('../lib/errorHandler.js');
  const copy = (value) => (value ? structuredClone(value) : null);
  const announce = (id) => blender.events.push(id);
  return {
    ...actual,
    announceBlenderModel: announce,
    listModels: async () => [...blender.rows.values()].filter((row) => !row.deleted).map(copy),
    getModel: async (id, { includeDeleted = false } = {}) => {
      const row = blender.rows.get(id);
      return row && (includeDeleted || !row.deleted) ? copy(row) : null;
    },
    createModel: async ({ name, description = '' }) => {
      const now = new Date().toISOString();
      const model = { id: `bmodel-${crypto.randomUUID()}`, schemaVersion: 1, name, description, status: 'draft', publishedBuildId: null, describe: null, builds: [], createdAt: now, updatedAt: now, deleted: false, deletedAt: null };
      blender.rows.set(model.id, copy(model));
      announce(model.id);
      return model;
    },
    mutateModel: async (id, mutate, { includeDeleted = false } = {}) => {
      const current = blender.rows.get(id);
      if (!current || (!includeDeleted && current.deleted)) throw new ServerError('Blender model not found', { status: 404, code: 'NOT_FOUND' });
      const next = mutate(copy(current));
      if (!next) return copy(current);
      next.status = actual.blenderModelStatus(next);
      blender.rows.set(id, copy(next));
      announce(id);
      return copy(next);
    },
    listBuildingModelIds: async () => [...blender.rows.values()].filter((row) => !row.deleted && row.status === 'building').map((row) => row.id),
  };
});

const { default: blenderModelsRoutes } = await import('./blenderModels.js');
const { __resetBlenderModelBuildsForTests, recoverInterruptedBlenderModelBuilds } = await import('../services/blenderModels/build.js');
const { launchDetached } = await import('../lib/launchDetached.js');
const { listActiveRenders } = await import('../services/renderActivity.js');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/blender-models', blenderModelsRoutes);
app.use(errorMiddleware);

afterAll(cleanupTempDataRoots);

const WAIT = { timeout: 20_000, interval: 20 };
const api = (id, suffix = '') => `/api/blender-models/${id}${suffix}`;
const workspace = (id) => join(ROOT(), 'blender-models', id);

async function newModel(name = 'Example lamp') {
  const created = await request(app).post('/api/blender-models').send({ name });
  expect(created.status).toBe(201);
  const scaffold = await request(app).post(api(created.body.id, '/workspace')).send({ template: 'starter' });
  expect(scaffold.status).toBe(201);
  return created.body.id;
}

/** Start a build and wait for its record entry to leave `running`. */
async function build(id, body = {}) {
  const started = await request(app).post(api(id, '/builds')).send(body);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const { build: { id: buildId } } = started.body;
  await vi.waitFor(() => expect(blender.rows.get(id).builds.find((entry) => entry.id === buildId).status).not.toBe('running'), WAIT);
  // The build prunes after it settles its row; wait for the job to be terminal too.
  await vi.waitFor(async () => expect((await request(app).get(api(id))).body.jobs.at(-1).status).not.toMatch(/queued|running/), WAIT);
  return { buildId, record: blender.rows.get(id).builds.find((entry) => entry.id === buildId) };
}

const report = async (id, buildId) => {
  const response = await request(app).get(api(id, `/builds/${buildId}/files/report.json`));
  expect(response.status).toBe(200);
  return JSON.parse(response.text);
};

beforeEach(() => {
  blender.fake = createFakeModelBlender();
  blender.rows.clear();
  blender.events.length = 0;
  __resetBlenderModelBuildsForTests();
  vi.mocked(launchDetached).mockClear();
});

describe('Blender Models: workspace, build, report, publish', () => {
  it('builds the starter to a published GLB through the API', async () => {
    const id = await newModel();
    expect(readFileSync(join(workspace(id), 'src', 'model.py'), 'utf8')).toContain('def describe(ctx)');
    const files = await request(app).get(api(id, '/files'));
    expect(files.body.files.map((file) => file.path)).toEqual(['model.py']);

    const { buildId, record } = await build(id);
    expect(record).toMatchObject({ status: 'complete', publishable: true, counts: { error: 0, warning: 0 }, quality: 'draft', title: 'Desk lamp' });
    expect(blender.fake.control.jobs[0]).toMatchObject({
      mode: 'build', quality: 'draft', src: join(workspace(id), 'src'), out: join(workspace(id), 'builds', buildId),
      staged: ['job.json', 'portos_model_driver.py'],
    });

    const built = await report(id, buildId);
    expect(built.findings.map((finding) => finding.code)).toEqual(['materials']);
    expect(built.checks).toMatchObject({
      parts: { declared: 3, built: 3, missing: [], undeclared: [] },
      triangles: { total: 180, budget: 2000 },
      bounds: { declared: { x: 0.22, y: 0.22, z: 0.52 }, actual: { x: 0.22, y: 0.22, z: 0.52 } },
      reimport: { objects: 3, triangles: 180, materials: 2, actions: 0 },
      glbBytes: FAKE_GLB.length,
    });
    const log = await request(app).get(api(id, `/builds/${buildId}/files/build.log`));
    expect(log.text).toContain('Built the lamp with 16 sides');

    // Nothing is published until asked.
    expect((await request(app).get(api(id, '/asset'))).body.code).toBe('BLENDER_MODEL_NOT_PUBLISHED');
    const published = await request(app).post(api(id, '/publish')).send({ buildId });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ publishedBuildId: buildId, status: 'published', describe: { title: 'Desk lamp' } });
    expect(published.body.workspace).toMatchObject({ hasModel: true, srcChanged: false });

    const asset = await request(app).get(api(id, '/asset'));
    expect(asset.status).toBe(200);
    expect(asset.headers['content-type']).toBe('model/gltf-binary');
    expect(asset.text).toBe(FAKE_GLB.toString());
    expect(blender.events).toContain(id);

    const opened = await request(app).post(api(id, `/builds/${buildId}/open`)).send({});
    expect(opened.body).toEqual({ opened: true, blenderVersion: '5.3.0' });
    expect(launchDetached).toHaveBeenCalledWith('/opt/example/Blender', ['--disable-autoexec', join(workspace(id), 'builds', buildId, 'model.blend')]);
  });

  it.each([
    ['a missing part', (events) => events.filter((event) => !(event.event === 'mesh' && event.name === 'shade')), 'part-missing', ['shade']],
    ['oversized bounds', (events) => events.map((event) => (event.event === 'scene' ? { ...event, max: [0.11, 0.11, 0.8] } : event)), 'bounds-oversized', ['z']],
    ['a triangle overrun', (events) => events.map((event) => (event.event === 'described' ? { ...event, triangleBudget: 100 } : event)), 'triangles-over-budget', undefined],
  ])('names %s as an error and refuses to publish that build', async (_label, edit, code, subjects) => {
    const id = await newModel();
    blender.fake.control.edit = edit;
    const { buildId, record } = await build(id);
    expect(record).toMatchObject({ status: 'complete', publishable: false });
    expect(record.counts.error).toBeGreaterThan(0);
    const finding = (await report(id, buildId)).findings.find((candidate) => candidate.code === code);
    expect(finding).toMatchObject({ severity: 'error', ...(subjects ? { subjects } : {}) });
    const refused = await request(app).post(api(id, '/publish')).send({ buildId });
    expect([refused.status, refused.body.code]).toEqual([409, 'BLENDER_MODEL_BUILD_NOT_PUBLISHABLE']);
  });

  it('leaves the published build unchanged when a later build is canceled or crashes', async () => {
    const id = await newModel();
    const { buildId: good } = await build(id);
    expect((await request(app).post(api(id, '/publish')).send({ buildId: good })).status).toBe(200);

    let release;
    blender.fake.control.hold = new Promise((resolve) => { release = resolve; });
    const started = await request(app).post(api(id, '/builds')).send({ quality: 'full' });
    expect(started.status).toBe(202);
    const running = started.body.build.id;
    await vi.waitFor(() => expect(blender.fake.control.jobs).toHaveLength(2), WAIT);
    // A running build keeps the system busy, so the unattended updater waits for it.
    expect(listActiveRenders().map((render) => render.kind)).toContain('blender-model');
    const again = await request(app).post(api(id, '/builds')).send({});
    expect([again.status, again.body.code]).toEqual([409, 'BLENDER_MODEL_BUILD_RUNNING']);
    expect((await request(app).post(api(id, `/builds/${running}/cancel`)).send({})).body).toEqual({ ok: true });
    await vi.waitFor(() => expect(blender.rows.get(id).builds.find((entry) => entry.id === running).status).toBe('canceled'), WAIT);
    release();
    expect(blender.rows.get(id).publishedBuildId).toBe(good);
    await vi.waitFor(() => expect(listActiveRenders().map((render) => render.kind)).not.toContain('blender-model'), WAIT);

    blender.fake.control.hold = null;
    blender.fake.control.crash = { message: 'RuntimeError: example failure' };
    const { record: crashed } = await build(id);
    expect(crashed).toMatchObject({ status: 'failed', error: 'RuntimeError: example failure' });
    expect(blender.rows.get(id)).toMatchObject({ publishedBuildId: good, status: 'published' });
    const asset = await request(app).get(api(id, '/asset'));
    expect(asset.status).toBe(200);
  });

  it('keeps the published build and the newest five, and prunes the rest', async () => {
    const id = await newModel();
    const { buildId: first } = await build(id);
    expect((await request(app).post(api(id, '/publish')).send({ buildId: first })).status).toBe(200);
    // A folder a crash left behind, which no record names.
    mkdirSync(join(workspace(id), 'builds', 'build-20200101T000000Z-0000abcd'), { recursive: true });
    const later = [];
    for (let index = 0; index < 6; index += 1) later.push((await build(id)).buildId);
    const kept = blender.rows.get(id).builds.map((entry) => entry.id);
    expect(kept.sort()).toEqual([first, ...later.slice(1)].sort());
    expect(readdirSync(join(workspace(id), 'builds')).sort()).toEqual(kept.sort());

    // A failed build ages the oldest kept build out too.
    blender.fake.control.crash = { message: 'RuntimeError: example failure' };
    const { buildId: crashed } = await build(id);
    expect(blender.rows.get(id).builds.map((entry) => entry.id).sort()).toEqual([first, ...later.slice(2), crashed].sort());
    expect(readdirSync(join(workspace(id), 'builds'))).not.toContain(later[1]);
  });

  it('refuses a build in contained mode with the same 409 as films', async () => {
    const id = await newModel();
    blender.fake.control.executionMode = 'contained';
    const refused = await request(app).post(api(id, '/builds')).send({});
    expect([refused.status, refused.body.code]).toEqual([409, 'MUSIC_VIDEO_BLENDER_NEEDS_TRUSTED_LOCAL']);
    expect(blender.fake.control.jobs).toHaveLength(0);
    expect((await request(app).get(api(id))).body.tool).toMatchObject({ ready: false, executionMode: 'contained' });
  });

  it('refuses a build with no model.py, a source path outside src/ and an unknown build file', async () => {
    const created = await request(app).post('/api/blender-models').send({ name: 'Empty' });
    const id = created.body.id;
    const refused = await request(app).post(api(id, '/builds')).send({});
    expect([refused.status, refused.body.code]).toEqual([409, 'BLENDER_MODEL_NO_SOURCE']);
    expect((await request(app).put(api(id, '/file')).send({ path: '../escape.py', content: 'x' })).status).toBe(400);
    expect((await request(app).get(api(id, '/builds/build-20200101T000000Z-0000abcd/files/secret.txt'))).status).toBe(404);
    expect((await request(app).get('/api/blender-models/not-an-id')).status).toBe(404);
  });

  it('writes, reads and deletes source files, and a second scaffold is refused', async () => {
    const id = await newModel();
    const written = await request(app).put(api(id, '/file')).send({ path: 'parts/lamp.py', content: 'SIDES = 16\n' });
    expect(written.body).toEqual({ path: 'parts/lamp.py', bytes: 11 });
    expect((await request(app).get(api(id, '/file?path=parts/lamp.py'))).body.content).toBe('SIDES = 16\n');
    expect((await request(app).delete(api(id, '/file?path=parts/lamp.py'))).status).toBe(200);
    expect(existsSync(join(workspace(id), 'src', 'parts', 'lamp.py'))).toBe(false);
    const again = await request(app).post(api(id, '/workspace')).send({});
    expect([again.status, again.body.code]).toEqual([409, 'BLENDER_MODEL_WORKSPACE_EXISTS']);
  });

  it('keeps a one-line description, changes only the fields a patch names, and lists models with readiness', async () => {
    const created = await request(app).post('/api/blender-models').send({ name: 'Lamp', description: 'A folding desk lamp' });
    expect(created.body).toMatchObject({ name: 'Lamp', description: 'A folding desk lamp' });
    const id = created.body.id;
    expect((await request(app).patch(api(id)).send({ name: 'Desk lamp' })).body).toMatchObject({ name: 'Desk lamp', description: 'A folding desk lamp' });
    expect((await request(app).patch(api(id)).send({ description: '' })).body).toMatchObject({ name: 'Desk lamp', description: '' });
    expect((await request(app).patch(api(id)).send({})).status).toBe(400);
    expect((await request(app).post('/api/blender-models').send({ name: 'Lamp', description: 'two\nlines' })).status).toBe(400);
    const list = await request(app).get('/api/blender-models');
    expect(list.body).toMatchObject({ models: [{ id, name: 'Desk lamp' }], tool: { ready: true, executionMode: 'trusted-local' } });
  });

  it('marks a build a restart interrupted as failed, and delete keeps src/ but removes builds', async () => {
    const id = await newModel();
    const { buildId } = await build(id);
    const row = blender.rows.get(id);
    blender.rows.set(id, { ...row, status: 'building', builds: [...row.builds, { id: 'build-20300101T000000Z-0000beef', status: 'running', startedAt: '2030-01-01T00:00:00.000Z' }] });
    expect(await recoverInterruptedBlenderModelBuilds()).toEqual({ recovered: 1 });
    expect(blender.rows.get(id).builds.at(-1)).toMatchObject({ status: 'failed', error: expect.stringContaining('restart') });
    expect(blender.rows.get(id).status).toBe('draft');

    mkdirSync(join(workspace(id), 'renders'), { recursive: true });
    writeFileSync(join(workspace(id), 'renders', 'preview.png'), 'x');
    expect((await request(app).delete(api(id))).body).toEqual({ ok: true });
    expect(blender.rows.get(id).deleted).toBe(true);
    expect(existsSync(join(workspace(id), 'builds', buildId))).toBe(false);
    expect(existsSync(join(workspace(id), 'renders'))).toBe(false);
    expect(existsSync(join(workspace(id), 'src', 'model.py'))).toBe(true);
    expect((await request(app).get(api(id))).status).toBe(404);
  });
});

describe('Blender Models: comparing builds with references', () => {
  const state = async (id) => (await request(app).get(api(id))).body;
  const camera = { label: 'Shade', referenceId: 'overall', crop: { x: 0, y: 0, width: 0.5, height: 0.5 }, orbit: { azimuth: 40, elevation: 20, distance: 0.6, lens: 85, partId: 'shade' } };
  const idle = (id) => vi.waitFor(async () => expect((await state(id)).jobs.some((job) => /queued|running/.test(job.status))).toBe(false), WAIT);

  it('renders every view after a build, marks it out of date by a newer one, and frames both alike', async () => {
    const id = await newModel();
    const { buildId: first } = await build(id);
    blender.fake.control.edit = (events) => events.map((event) => (event.event === 'scene' ? { ...event, max: [0.1, 0.1, 0.51] } : event));
    const { buildId: second } = await build(id);
    const [a, b] = blender.fake.control.reviews;
    // Different bounds, one declared size: the same cameras.
    expect(b.views).toEqual(a.views);
    expect(a.blend).toBe(join(workspace(id), 'builds', first, 'model.blend'));
    expect((await state(id)).reviews).toMatchObject([
      { buildId: second, outOfDate: false, sheets: ['sheet-textured.jpg', 'sheet-clay.jpg'] }, { buildId: first, outOfDate: true },
    ]);
    const image = await request(app).get(api(id, `/builds/${second}/review/three-quarter-clay.png`));
    expect([image.status, image.headers['content-type']]).toEqual([200, 'image/png']);
    expect((await request(app).get(api(id, `/builds/${second}/review/..%2Fmodel.blend`))).status).toBe(404);
    expect((await request(app).get(api(id, '/builds/not-a-build/review/front-clay.png'))).status).toBe(404);
    // Nothing is written into the build's own folder.
    expect(readdirSync(join(workspace(id), 'builds', second)).sort()).toEqual(['build.log', 'model.blend', 'model.glb', 'report.json']);
  });

  it('keeps the build when its review fails, and renders again on request without losing the last set', async () => {
    const id = await newModel();
    const { buildId } = await build(id);
    let release;
    blender.fake.control.reviewHold = new Promise((resolve) => { release = resolve; });
    expect((await request(app).post(api(id, `/builds/${buildId}/review`)).send({})).status).toBe(202);
    const again = await request(app).post(api(id, `/builds/${buildId}/review`)).send({});
    expect([again.status, again.body.code]).toEqual([409, 'BLENDER_MODEL_REVIEW_RUNNING']);
    // A running review keeps the system busy, and stops neither the record nor a build.
    expect(listActiveRenders().map((render) => render.kind)).toContain('blender-model');
    expect((await state(id)).status).toBe('draft');
    expect((await request(app).post(api(id, `/builds/${buildId}/review/cancel`)).send({})).body).toEqual({ ok: true });
    await idle(id);
    release();
    blender.fake.control.reviewHold = null;
    expect((await state(id)).jobs.at(-1)).toMatchObject({ kind: 'review', status: 'canceled' });
    expect((await state(id)).reviews).toHaveLength(1);
    expect(readdirSync(join(workspace(id), 'renders', 'reviews')).sort()).toEqual([buildId, `${buildId}.log`]);

    // A build without a declared size completes and is simply not rendered.
    blender.fake.control.edit = (events) => events.map((event) => (event.event === 'described' ? { ...event, sizeMeters: null } : event));
    const { buildId: unsized, record } = await build(id);
    expect(record.status).toBe('complete');
    const refused = await request(app).post(api(id, `/builds/${unsized}/review`)).send({});
    expect([refused.status, refused.body.code]).toEqual([409, 'BLENDER_MODEL_REVIEW_NOT_READY']);
    blender.fake.control.executionMode = 'contained';
    expect((await request(app).post(api(id, `/builds/${buildId}/review`)).send({})).body.code).toBe('MUSIC_VIDEO_BLENDER_NEEDS_TRUSTED_LOCAL');
  });

  it('cancels a running review when the model is deleted, and prunes reviews with their builds', async () => {
    const id = await newModel();
    const { buildId: first } = await build(id);
    for (let index = 0; index < 5; index += 1) await build(id);
    expect(readdirSync(join(workspace(id), 'renders', 'reviews')).some((name) => name.startsWith(first))).toBe(false);
    blender.fake.control.reviewHold = new Promise(() => {});
    const newest = blender.rows.get(id).builds.at(-1).id;
    expect((await request(app).post(api(id, `/builds/${newest}/review`)).send({})).status).toBe(202);
    expect((await request(app).delete(api(id))).body).toEqual({ ok: true });
    expect(existsSync(join(workspace(id), 'renders'))).toBe(false);
    expect(listActiveRenders().map((render) => render.kind)).not.toContain('blender-model');
  });

  it('aims a saved orbit at its part once, and says when its render is older than the camera', async () => {
    const id = await newModel();
    expect((await request(app).post(api(id, '/cameras')).send(camera)).body.code).toBe('BLENDER_MODEL_PART_NOT_MEASURED');
    await build(id);
    const added = await request(app).post(api(id, '/cameras')).send(camera);
    expect(added.status).toBe(201);
    const [saved] = added.body.cameras;
    expect(saved).toMatchObject({ label: 'Shade', view: null, orbit: { partId: 'shade', target: [0, 0, 0.45] } });
    expect(added.body.reviews[0].outdatedCameraIds).toEqual([saved.id]);

    // The shade moves; the saved camera's frame does not.
    blender.fake.control.edit = (events) => events.map((event) => (event.name === 'shade' ? { ...event, max: [0.11, 0.11, 0.9] } : event));
    const { buildId } = await build(id);
    expect((await state(id)).cameras[0].orbit.target).toEqual([0, 0, 0.45]);
    expect((await state(id)).reviews[0]).toMatchObject({ buildId, outdatedCameraIds: [], views: expect.arrayContaining(['front', saved.id]) });

    const moved = await request(app).patch(api(id, `/cameras/${saved.id}`)).send({ orbit: { ...saved.orbit, azimuth: 60 } });
    expect(moved.body.reviews[0].outdatedCameraIds).toEqual([saved.id]);
    // On a fixed view it shows that view's render, which is current.
    const fixed = await request(app).patch(api(id, `/cameras/${saved.id}`)).send({ view: 'front' });
    expect(fixed.body.cameras[0]).toMatchObject({ view: 'front', orbit: null, crop: camera.crop });
    expect(fixed.body.reviews[0].outdatedCameraIds).toEqual([]);

    for (const bad of [{ ...camera, view: 'front' }, { ...camera, orbit: undefined }, { ...camera, crop: { x: 0.8, y: 0, width: 0.5, height: 1 } }]) {
      expect((await request(app).post(api(id, '/cameras')).send(bad)).status).toBe(400);
    }
    expect((await request(app).post(api(id, '/cameras')).send({ ...camera, referenceId: 'closeup-none' })).status).toBe(404);
    expect((await request(app).delete(api(id, `/cameras/${saved.id}`))).body.cameras).toEqual([]);
    expect((await request(app).delete(api(id, `/cameras/${saved.id}`))).status).toBe(404);
  });

  it('keeps differences across rebuilds and records the build each was closed on', async () => {
    const id = await newModel();
    const opened = await request(app).post(api(id, '/differences')).send({ text: 'No bolts on the base', partId: 'base', referenceId: 'overall' });
    const [{ id: differenceId }] = opened.body.differences;
    const patch = (body) => request(app).patch(api(id, `/differences/${differenceId}`)).send(body);
    expect((await patch({ status: 'fixed' })).body.code).toBe('BLENDER_MODEL_NO_BUILD');
    const { buildId: first } = await build(id);
    const { buildId: second } = await build(id);
    expect((await state(id)).differences).toMatchObject([{ id: differenceId, status: 'open', closedBuildId: null }]);
    expect((await patch({ status: 'fixed' })).body.differences).toMatchObject([{ status: 'fixed', closedBuildId: second, closedAt: expect.any(String) }]);
    expect((await patch({ status: 'open' })).body.differences).toMatchObject([{ status: 'open', closedBuildId: null, closedAt: null }]);
    expect((await patch({ status: 'accepted' })).status).toBe(400);
    expect((await patch({ status: 'accepted', reason: 'Glued', buildId: first })).body.differences).toMatchObject([{ status: 'accepted', reason: 'Glued', closedBuildId: first }]);
    expect((await patch({ text: 'No base bolts' })).body.differences).toMatchObject([{ text: 'No base bolts', status: 'accepted', closedBuildId: first }]);
    expect((await patch({ status: 'open', buildId: 'build-20200101T000000Z-0000abcd' })).body.differences[0].reason).toBe('');
    expect((await patch({ status: 'fixed', buildId: 'build-20200101T000000Z-0000abcd' })).status).toBe(404);
    expect((await request(app).delete(api(id, `/differences/${differenceId}`))).body.differences).toEqual([]);
  });

  it('drops a removed plate\'s cameras and unlinks its differences', async () => {
    const id = await newModel();
    const plate = (await request(app).post(api(id, '/references')).send({ mechanism: 'Hinge' })).body.references.at(-1).id;
    expect((await request(app).post(api(id, '/cameras')).send({ label: 'Hinge', referenceId: plate, view: 'left' })).status).toBe(201);
    await request(app).post(api(id, '/differences')).send({ text: 'No pin', referenceId: plate });
    const { body } = await request(app).delete(api(id, `/references/${plate}`));
    expect(body).toMatchObject({ cameras: [], differences: [{ text: 'No pin', referenceId: null }] });
  });

  it('warns when the model stands outside what its review views frame', async () => {
    const id = await newModel();
    blender.fake.control.edit = (events) => events.map((event) => (event.event === 'scene' ? { ...event, min: [-0.11, -0.11, -0.26], max: [0.11, 0.11, 0.26] } : event));
    const { buildId } = await build(id);
    expect((await report(id, buildId)).findings).toContainEqual(expect.objectContaining({ code: 'review-out-of-frame', severity: 'warning', subjects: ['z'] }));
  });
});

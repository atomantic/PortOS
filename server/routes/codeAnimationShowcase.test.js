/** POST /showcase through the real film engine: what a showcase film holds, and that it starts no job. */
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { errorMiddleware, ServerError } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';

function ROOT() { return lazyTempDataRoot('code-showcase-route-'); }
const library = vi.hoisted(() => ({ projects: new Map(), models: {}, reports: {}, sheet: null, glb: null }));
vi.mock('../lib/paths.js', async load => makePathsProxy(await load(), { dataRoot: ROOT }));
vi.mock('../services/codeAnimation/projectStore.js', () => ({
  getProjectRecord: vi.fn(async id => structuredClone(library.projects.get(id) || null)),
  createProjectRecord: vi.fn(async (id, data) => { const project = { id, ...data }; library.projects.set(id, project); return structuredClone(project); }),
  deleteProjectRecord: vi.fn(async id => { library.projects.delete(id); }),
}));
vi.mock('../services/codeAnimation/events.js', () => ({ emitCodeAnimationChanged: vi.fn(), emitCodeAnimationFilm: vi.fn() }));
vi.mock('../services/blenderModels/models.js', () => ({
  requireBlenderModel: async id => {
    if (!library.models[id]) throw new ServerError('Blender model not found', { status: 404, code: 'NOT_FOUND' });
    return library.models[id];
  },
  getBlenderModelAsset: async id => {
    if (!library.models[id].publishedBuildId) throw new ServerError('This model has no published build yet', { status: 409, code: 'BLENDER_MODEL_NOT_PUBLISHED' });
    return { absolute: library.glb, filename: 'lamp.glb' };
  },
}));
vi.mock('../services/blenderModels/review.js', () => ({ readBuildReport: async (id) => library.reports[id] }));
vi.mock('../services/blenderModels/references.js', () => ({ approvedOverallSheetPath: () => library.sheet }));

import routes from './codeAnimationFilms.js';
import { listBlenderJobs } from '../services/film/jobs.js';
import { deleteProjectRecord } from '../services/codeAnimation/projectStore.js';
import { createShowcaseFilm, showcaseDurationSec } from '../services/codeAnimation/showcase.js';

const app = express();
app.use(express.json());
app.use('/api/code-animation/films', routes);
app.use(errorMiddleware);

const report = (extra = {}) => ({
  describe: { sizeMeters: { x: 0.22, y: 0.22, z: 0.52 }, parts: [{ id: 'base', label: 'Base' }, { id: 'shade', label: 'Shade', parent: 'base' }] },
  checks: { parts: { centers: { base: [0, 0, 0.01], shade: [0, 0, 0.45] } }, motion: null },
  ...extra,
});
const src = (id, ...parts) => join(ROOT(), 'code-animation', 'films', id, 'src', ...parts);

beforeEach(() => {
  for (const entry of readdirSync(ROOT())) rmSync(join(ROOT(), entry), { recursive: true, force: true });
  library.projects.clear();
  mkdirSync(ROOT(), { recursive: true });
  library.glb = join(ROOT(), 'lamp.glb');
  writeFileSync(library.glb, 'glb-bytes');
  library.sheet = null;
  library.models = { m1: { id: 'm1', name: 'Desk lamp', publishedBuildId: 'b1', cameras: [] } };
  library.reports = { m1: report() };
});
afterAll(() => cleanupTempDataRoots());

it('makes a valid film from a model with no controls and no references, and starts no job', async () => {
  const response = await request(app).post('/api/code-animation/films/showcase').send({ modelId: 'm1' });
  expect(response.status).toBe(201);
  const { id } = response.body;
  expect(response.body).toMatchObject({ kind: 'film', title: 'Desk lamp showcase', film: { timeline: { fps: 24 } } });
  const data = JSON.parse(readFileSync(src(id, 'showcase.json'), 'utf8'));
  expect(data).toMatchObject({ size: { z: 0.52 }, controls: [], actions: [], cameras: [], sheet: null });
  expect(data.parts.map(part => part.id)).toEqual(['base', 'shade']);
  // Turntable and assembly only: the timeline is exactly their natural length.
  expect(response.body.film.timeline.durationSec).toBe(14);
  expect(showcaseDurationSec(data)).toBe(14);
  expect(readFileSync(src(id, 'models', 'model.glb'), 'utf8')).toBe('glb-bytes');
  expect(JSON.parse(readFileSync(src(id, 'models', 'model.json'), 'utf8'))).toMatchObject({ kind: 'blender-model', sourceId: 'm1', slug: 'model' });
  expect(existsSync(src(id, 'film.py')) && existsSync(src(id, 'kit', 'plan.py'))).toBe(true);
  expect(existsSync(src(id, 'showcase'))).toBe(false);
  expect(listBlenderJobs({ kind: 'code-animation', id })).toEqual([]);
});

it('carries controls, actions, saved cameras and the approved sheet', async () => {
  library.sheet = join(ROOT(), 'sheet.png');
  writeFileSync(library.sheet, 'png-bytes');
  library.models.m1.cameras = Array.from({ length: 8 }, (_, index) => ({ id: `c${index}`, label: `Cam ${index}`, view: 'front', orbit: null }));
  library.reports.m1 = report({ checks: { parts: { centers: {} }, motion: {
    controls: [{ id: 'tilt', label: 'Tilt', partId: 'shade', default01: 0.5, dependsOn: [] }],
    actions: [{ id: 'wave', label: 'Wave', seconds: 2, error: null }, { id: 'bad', seconds: 1, error: 'failed' }],
  } } });
  const response = await request(app).post('/api/code-animation/films/showcase').send({ modelId: 'm1', title: 'Lamp reel' });
  expect(response.body.title).toBe('Lamp reel');
  const data = JSON.parse(readFileSync(src(response.body.id, 'showcase.json'), 'utf8'));
  expect(data.cameras).toHaveLength(6);
  expect(data.actions.map(action => action.id)).toEqual(['wave']);
  expect(data.controls).toEqual([{ id: 'tilt', label: 'Tilt', partId: 'shade', default01: 0.5, dependsOn: [] }]);
  expect(data.sheet).toBe('showcase/sheet.png');
  expect(readFileSync(src(response.body.id, 'showcase', 'sheet.png'), 'utf8')).toBe('png-bytes');
  // 8 turn + 6 assembly + (2.5 control + 2 action) + 6 close-ups x 3 + 4 reference
  expect(response.body.film.timeline.durationSec).toBe(40.5);
});

it('refuses an unpublished or missing model before creating anything', async () => {
  library.models.m1.publishedBuildId = null;
  expect((await request(app).post('/api/code-animation/films/showcase').send({ modelId: 'm1' })).status).toBe(409);
  expect((await request(app).post('/api/code-animation/films/showcase').send({ modelId: 'nope' })).status).toBe(404);
  expect((await request(app).post('/api/code-animation/films/showcase').send({})).status).toBe(400);
  expect(library.projects.size).toBe(0);
});

it('rolls back the created project record and workspace directory when a post-insert step fails', async () => {
  library.sheet = join(ROOT(), 'missing-sheet.png');
  await expect(createShowcaseFilm('m1')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(library.projects.size).toBe(0);
  const filmsDir = join(ROOT(), 'code-animation', 'films');
  expect(existsSync(filmsDir) ? readdirSync(filmsDir) : []).toEqual([]);
});

it('preserves the original error even if rollback cleanup fails', async () => {
  library.sheet = join(ROOT(), 'missing-sheet.png');
  deleteProjectRecord.mockRejectedValueOnce(new Error('db cleanup error'));
  await expect(createShowcaseFilm('m1')).rejects.toMatchObject({ code: 'ENOENT' });
  const filmsDir = join(ROOT(), 'code-animation', 'films');
  expect(existsSync(filmsDir) ? readdirSync(filmsDir) : []).toEqual([]);
});

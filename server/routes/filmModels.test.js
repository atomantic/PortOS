/**
 * Adding a library 3D model to a film (POST /blender/models, .../models/:slug/update)
 * through the shared film router over a temp workspace. The library services are
 * doubled; the copy, containment, naming and staleness code is real.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware, ServerError } from '../lib/errorHandler.js';

const library = vi.hoisted(() => ({ glb: null, records: {}, sources: {} }));
vi.mock('../services/imageTo3d/db.js', () => ({ getModel: async (id) => library.records[id] ?? null }));
vi.mock('../services/imageTo3d/models.js', () => ({
  getModelAsset: async (id) => {
    if (library.records[id]?.status !== 'ready') throw new ServerError('This model has no generated mesh yet', { status: 409, code: 'MODEL_NOT_READY' });
    return { path: library.glb, filename: 'x.glb' };
  },
}));
vi.mock('../services/threejsModels/db.js', () => ({ getModel: async (id) => library.sources[id]?.record ?? null }));
vi.mock('../services/threejsModels/index.js', () => ({
  getModelSource: async (id) => ({ filename: 'x.js', source: library.sources[id].source }),
}));

const { createFilmRoutes } = await import('./filmRoutes.js');
const { hashBlenderSources, blenderImportHashes, blenderImportsChanged } = await import('../services/film/hashing.js');
const { copyBlenderFilm } = await import('../services/film/fork.js');
const { parseBlenderDriverLine } = await import('../services/film/protocol.js');

const dirs = [];
const makeOwner = () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'film-models-'));
  dirs.push(workspaceDir);
  mkdirSync(join(workspaceDir, 'src'), { recursive: true });
  return { kind: 'test', id: 'film', workspaceDir, emit: vi.fn(), readRecord: async () => ({}) };
};
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

let owner;
let app;
const src = (...parts) => join(owner.workspaceDir, 'src', ...parts);
const post = (path, body) => request(app).post(`/film/x/blender${path}`).send(body);
const sha = (value) => createHash('sha256').update(value).digest('hex');

beforeEach(() => {
  owner = makeOwner();
  app = express();
  app.use(express.json());
  app.use('/film', createFilmRoutes({ resolveOwner: async () => owner, readState: async () => ({}) }));
  app.use(errorMiddleware);
  library.glb = join(owner.workspaceDir, 'library.glb');
  writeFileSync(library.glb, 'glb-v1');
  library.records = { a: { id: 'a', name: 'Robot Dog', status: 'ready', updatedAt: '2026-01-01T00:00:00.000Z' } };
  library.sources = { t: { record: { id: 't', name: 'Lamp', updatedAt: '2026-01-02T00:00:00.000Z' }, source: 'export const build = () => 1;\n' } };
});

describe('add a model', () => {
  it('copies the GLB with a sidecar naming its source and hash', async () => {
    const res = await post('/models', { kind: 'image-to-3d', id: 'a' });
    expect(res.status).toBe(201);
    expect(res.body.model).toMatchObject({ slug: 'robot-dog', kind: 'image-to-3d', sourceId: 'a', variant: 'mesh', sha256: sha('glb-v1'), bytes: 6 });
    expect(res.body.snippet).toContain('models.load(ctx, "robot-dog"');
    expect(readFileSync(src('models', 'robot-dog.glb'), 'utf8')).toBe('glb-v1');
    expect(JSON.parse(readFileSync(src('models', 'robot-dog.json'), 'utf8')).sourceId).toBe('a');
    expect(readdirSync(src('models')).filter((name) => name.startsWith('.'))).toEqual([]);
    expect(owner.emit).toHaveBeenCalled();
  });

  it('writes a Three.js model as its factory module', async () => {
    const res = await post('/models', { kind: 'threejs', id: 't' });
    expect(res.status).toBe(201);
    expect(readFileSync(src('models', 'lamp.js'), 'utf8')).toContain('export const build');
  });

  it('adding the same model twice gives a second slug, and an explicit taken slug is a 409 unless replacing', async () => {
    await post('/models', { kind: 'image-to-3d', id: 'a' });
    expect((await post('/models', { kind: 'image-to-3d', id: 'a' })).body.model.slug).toBe('robot-dog-2');
    const clash = await post('/models', { kind: 'image-to-3d', id: 'a', slug: 'robot-dog' });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('MUSIC_VIDEO_BLENDER_MODEL_EXISTS');
    writeFileSync(library.glb, 'glb-v2');
    expect((await post('/models', { kind: 'image-to-3d', id: 'a', slug: 'robot-dog', replace: true })).status).toBe(201);
    expect(readFileSync(src('models', 'robot-dog.glb'), 'utf8')).toBe('glb-v2');
  });

  it('answers 409 for a model with no mesh and 404 for an unknown one', async () => {
    library.records.a.status = 'draft';
    expect((await post('/models', { kind: 'image-to-3d', id: 'a' })).status).toBe(409);
    expect((await post('/models', { kind: 'image-to-3d', id: 'nope' })).status).toBe(404);
  });

  it('refuses a symlinked src/models and a traversal slug', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'film-models-out-'));
    dirs.push(outside);
    symlinkSync(outside, src('models'));
    const res = await post('/models', { kind: 'image-to-3d', id: 'a' });
    expect(res.status).toBe(400);
    expect(readdirSync(outside)).toEqual([]);
    expect((await post('/models', { kind: 'image-to-3d', id: 'a', slug: '../x' })).status).toBe(400);
    expect((await post('/models/..%2Fx/update', {})).status).toBe(400);
  });
});

describe('update a copy', () => {
  it('reports updateAvailable only after the source changes, and updates only on request', async () => {
    await post('/models', { kind: 'image-to-3d', id: 'a' });
    const list = () => request(app).get('/film/x/blender/models').then((res) => res.body.models[0]);
    expect(await list()).toMatchObject({ updateAvailable: false, sourceMissing: false });
    writeFileSync(library.glb, 'glb-v2');
    expect(await list()).toMatchObject({ updateAvailable: true });
    expect(readFileSync(src('models', 'robot-dog.glb'), 'utf8')).toBe('glb-v1');
    const res = await post('/models/robot-dog/update', {});
    expect(res.status).toBe(200);
    expect(readFileSync(src('models', 'robot-dog.glb'), 'utf8')).toBe('glb-v2');
    expect(await list()).toMatchObject({ updateAvailable: false });
  });

  it('keeps the copy when its source is deleted, and update answers 404', async () => {
    await post('/models', { kind: 'image-to-3d', id: 'a' });
    library.records = {};
    expect((await request(app).get('/film/x/blender/models')).body.models[0]).toMatchObject({ sourceMissing: true, updateAvailable: false });
    expect((await post('/models/robot-dog/update', {})).status).toBe(404);
    expect(existsSync(src('models', 'robot-dog.glb'))).toBe(true);
  });
});

describe('staleness', () => {
  it('a shot that reported a model import goes stale only when that file changes', async () => {
    writeFileSync(src('film.py'), '# film');
    await post('/models', { kind: 'image-to-3d', id: 'a' });
    const done = parseBlenderDriverLine('PORTOS_BLENDER {"event":"done","shot":"s1","sec":1,"imports":["film.py","models/robot-dog.glb","models/../x.glb","models/a/b.glb"]}');
    expect(done.imports).toEqual(['film.py', 'models/robot-dog.glb']);
    const before = (await hashBlenderSources(owner)).files;
    const imports = blenderImportHashes(done.imports, before);
    writeFileSync(src('models', 'other.glb'), 'unrelated');
    expect(blenderImportsChanged(imports, (await hashBlenderSources(owner)).files)).toBe(false);
    writeFileSync(src('models', 'robot-dog.glb'), 'changed');
    expect(blenderImportsChanged(imports, (await hashBlenderSources(owner)).files)).toBe(true);
    expect(blenderImportsChanged(undefined, before)).toBe(false);
  });
});

describe('fork', () => {
  it('carries src/models into a forked film', async () => {
    await post('/models', { kind: 'image-to-3d', id: 'a' });
    const target = makeOwner();
    await copyBlenderFilm(owner, target);
    expect(readFileSync(join(target.workspaceDir, 'src', 'models', 'robot-dog.glb'), 'utf8')).toBe('glb-v1');
    expect(existsSync(join(target.workspaceDir, 'src', 'models', 'robot-dog.json'))).toBe(true);
  });
});

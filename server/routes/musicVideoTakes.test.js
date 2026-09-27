/**
 * Music Video scene takes + external-asset handoff routes (#8965), exercised
 * through the real router and the real file-backed project store. Covers the
 * explicit-selection contract (select / reject / note survive a re-read), the
 * existence check that keeps a take from pointing at an arbitrary file, and a
 * synthetic Midjourney-style handoff round trip: export → files named with the
 * scene tags → import → exact scene association + provider provenance.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-takes-route-test-');
vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const { default: musicVideoRoutes } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');

const app = express();
app.use(express.json());
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);

function seedImage(name) {
  mkdirSync(join(ROOT(), 'images'), { recursive: true });
  writeFileSync(join(ROOT(), 'images', name), 'png-bytes');
}
function seedVideoHistory(rows) {
  writeFileSync(join(ROOT(), 'video-history.json'), JSON.stringify(rows));
}

let project;
let sceneA;
let sceneB;
beforeEach(async () => {
  rmSync(join(ROOT(), 'music-video-projects.json'), { force: true });
  rmSync(join(ROOT(), 'images'), { recursive: true, force: true });
  seedVideoHistory([]);
  project = await projects.createProject({ name: 'Example Video' });
  sceneA = await projects.addProjectScene(project.id, { prompt: 'a lighthouse at dusk', framePrompt: 'lighthouse still' });
  sceneB = await projects.addProjectScene(project.id, { prompt: 'waves crash' });
});
afterAll(cleanupTempDataRoots);

const base = () => `/api/music-video/${project.id}`;
const addTake = (sceneId, body) => request(app).post(`${base()}/scenes/${sceneId}/takes`).send(body);
const reload = async () => projects.getProject(project.id);

describe('scene takes routes', () => {
  it('adds takes, keeps the first as the selection, and persists an explicit select + reject across reloads', async () => {
    seedImage('take-1.png');
    seedImage('take-2.png');
    const first = await addTake(sceneA.sceneId, { kind: 'image', assetId: 'take-1.png', source: 'generated' });
    expect(first.status).toBe(201);
    expect(first.body.scene.referenceImageId).toBe('take-1.png');
    expect(first.body.take).toMatchObject({ source: 'generated', provider: 'portos', status: 'candidate' });

    const second = await addTake(sceneA.sceneId, { kind: 'image', assetId: 'take-2.png' });
    expect(second.body.scene.referenceImageId).toBe('take-1.png');

    const sel = await request(app).post(`${base()}/scenes/${sceneA.sceneId}/takes/${second.body.take.takeId}/select`);
    expect(sel.status).toBe(200);
    expect(sel.body.referenceImageId).toBe('take-2.png');

    const rej = await request(app).patch(`${base()}/scenes/${sceneA.sceneId}/takes/${first.body.take.takeId}`)
      .send({ status: 'rejected', note: 'wrong wardrobe' });
    expect(rej.status).toBe(200);

    const stored = (await reload()).scenes.find((s) => s.sceneId === sceneA.sceneId);
    expect(stored.referenceImageId).toBe('take-2.png');
    expect(stored.takes.map((t) => [t.assetId, t.status, t.note])).toEqual([
      ['take-1.png', 'rejected', 'wrong wardrobe'],
      ['take-2.png', 'candidate', null],
    ]);
  });

  it('rejecting the selected take clears the slot so the next take fills it', async () => {
    seedImage('a.png');
    seedImage('b.png');
    const a = await addTake(sceneA.sceneId, { kind: 'image', assetId: 'a.png' });
    await request(app).patch(`${base()}/scenes/${sceneA.sceneId}/takes/${a.body.take.takeId}`).send({ status: 'rejected' });
    expect((await reload()).scenes[0].referenceImageId).toBeNull();
    const b = await addTake(sceneA.sceneId, { kind: 'image', assetId: 'b.png' });
    expect(b.body.scene.referenceImageId).toBe('b.png');
  });

  it('refuses a take whose asset is not in the media library, or that names a path', async () => {
    const missing = await addTake(sceneA.sceneId, { kind: 'image', assetId: 'nope.png' });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('TAKE_ASSET_NOT_FOUND');
    const traversal = await addTake(sceneA.sceneId, { kind: 'image', assetId: '../settings.png' });
    expect(traversal.status).toBe(400);
    const clip = await addTake(sceneA.sceneId, { kind: 'video', assetId: 'clip-9' });
    expect(clip.status).toBe(400);
    seedVideoHistory([{ id: 'clip-9', filename: 'clip-9.mp4' }]);
    const ok = await addTake(sceneA.sceneId, { kind: 'video', assetId: 'clip-9' });
    expect(ok.status).toBe(201);
    expect(ok.body.scene.videoHistoryId).toBe('clip-9');
    expect((await reload()).scenes[0].takes.map((t) => t.kind)).toEqual(['video']);
  });

  it('materializes a pre-takes selection as a legacy take instead of losing it', async () => {
    // A pre-#8965 scene: a selected frame with no takes list at all.
    await projects.updateScene(project.id, sceneB.sceneId, { referenceImageId: 'legacy.png' });
    const raw = await reload();
    // updateScene records the slot as a take; strip it to model an old record.
    const { mergeProjectsFromSync } = projects;
    await mergeProjectsFromSync([{
      ...raw,
      updatedAt: new Date(Date.now() + 1000).toISOString(),
      scenes: raw.scenes.map((s) => (s.sceneId === sceneB.sceneId ? { ...s, takes: undefined } : s)),
    }]);
    seedImage('fresh.png');
    const added = await addTake(sceneB.sceneId, { kind: 'image', assetId: 'fresh.png' });
    expect(added.body.scene.referenceImageId).toBe('legacy.png');
    expect(added.body.scene.takes.map((t) => [t.assetId, t.source])).toEqual([
      ['legacy.png', 'legacy'],
      ['fresh.png', 'imported'],
    ]);
  });
});

describe('external-asset handoff', () => {
  it('exports per-scene prompts + tags without machine-local settings, and imports tagged files back onto their exact scenes', async () => {
    seedImage('ref-mood.png');
    const patched = await request(app).patch(base()).send({
      concept: { style: 'grainy 16mm' },
      visualSpec: {
        palette: ['#112233', '#AABBCC'],
        cameraRules: 'locked-off wide shots',
        references: [{ imageId: 'ref-mood.png', role: 'mood', label: 'Harbor mood', condition: true }],
      },
      imageMode: 'local',
      imageModelId: 'example-model',
    });
    expect(patched.status).toBe(200);

    const exported = await request(app).get(`${base()}/handoff`);
    expect(exported.status).toBe(200);
    const manifest = exported.body;
    expect(manifest).toMatchObject({ format: 'portos.music-video.handoff', version: 1 });
    expect(JSON.stringify(manifest)).not.toMatch(/imageModelId|example-model|videoSettings|\/Users\//);
    expect(manifest.visualSpec.references[0]).toMatchObject({ filename: 'ref-mood.png', condition: true });
    const [tagA, tagB] = manifest.scenes.map((s) => s.fileTag);
    expect(manifest.scenes[0].framePrompt).toBe('lighthouse still, grainy 16mm, color palette #112233 #aabbcc; camera: locked-off wide shots');
    expect(manifest.scenes[0].referenceFiles).toEqual(['ref-mood.png']);

    // Reorder between export and import: the tag's order prefix is cosmetic.
    const reordered = await request(app).post(`${base()}/scenes/reorder`).send({ sceneIds: [sceneB.sceneId, sceneA.sceneId] });
    expect(reordered.status).toBe(200);

    // The files come back through the gallery upload route (seeded here) under
    // new basenames; only the ORIGINAL names carry the tags.
    seedImage('upload-0001.png');
    seedImage('upload-0002.png');
    seedImage('upload-0003.png');
    const imported = await request(app).post(`${base()}/handoff/import`).send({
      provider: 'midjourney',
      items: [
        { kind: 'image', assetId: 'upload-0001.png', originalName: `user_${tagA}_harbor_v1.png` },
        { kind: 'image', assetId: 'upload-0002.png', originalName: `${tagB.toLowerCase()}-waves.png` },
        { kind: 'image', assetId: 'upload-0003.png', originalName: 'untagged.png' },
        { kind: 'image', assetId: 'upload-9999.png', originalName: `${tagA}-missing.png` },
      ],
    });
    expect(imported.status).toBe(200);
    expect(imported.body.imported.map((i) => [i.sceneId, i.assetId])).toEqual([
      [sceneA.sceneId, 'upload-0001.png'],
      [sceneB.sceneId, 'upload-0002.png'],
    ]);
    expect(imported.body.skipped.map((s) => [s.assetId, s.reason])).toEqual([
      ['upload-0003.png', 'no-matching-scene'],
      ['upload-9999.png', 'asset-not-found'],
    ]);

    const stored = await reload();
    const a = stored.scenes.find((s) => s.sceneId === sceneA.sceneId);
    expect(a.takes[0]).toMatchObject({
      assetId: 'upload-0001.png', source: 'imported', provider: 'midjourney', originalName: `user_${tagA}_harbor_v1.png`,
    });
    expect(a.referenceImageId).toBe('upload-0001.png');
  });
});

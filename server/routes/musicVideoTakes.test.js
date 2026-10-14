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

  it('serves a downloadable ZIP bundle carrying the manifest plus its reference images', async () => {
    seedImage('ref-mood.png');
    const patched = await request(app).patch(base()).send({
      visualSpec: { references: [{ imageId: 'ref-mood.png', role: 'mood', condition: false }] },
    });
    expect(patched.status).toBe(200);

    const res = await request(app).get(`${base()}/handoff/bundle`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename=".*\.zip"/);
    // The fetch-based test harness reads the body as text — real ZIP-content
    // assertions (missing-file reporting, per-entry bytes) live in the real
    // file-store service test (handoff.test.js `buildHandoffBundle`); this
    // route test only proves the wiring returns a non-empty ZIP-signed body.
    expect(res.text.slice(0, 2)).toBe('PK');
    expect(res.text.length).toBeGreaterThan(0);
  });

  it('round-trips a short hand-authored scene id through its file tag', async () => {
    const raw = await reload();
    await projects.mergeProjectsFromSync([{
      ...raw,
      updatedAt: new Date(Date.now() + 1000).toISOString(),
      scenes: [{ ...raw.scenes[0], sceneId: 'intro' }],
    }]);
    const { body: manifest } = await request(app).get(`${base()}/handoff`);
    expect(manifest.scenes[0].fileTag).toBe('S01-intro');
    seedImage('upload-short.png');
    const imported = await request(app).post(`${base()}/handoff/import`).send({
      provider: 'external',
      items: [{ kind: 'image', assetId: 'upload-short.png', originalName: 'S01-intro final.png' }],
    });
    expect(imported.body.imported.map((i) => i.sceneId)).toEqual(['intro']);
  });
});

describe('swapping a shot from unused takes', () => {
  // Uniquely catches a cut shot's takes vanishing from the picker, a clip losing its still, and a used take offered as unused.
  it('lists every unused still and clip, keeps a cut shot\'s takes on the floor, and puts a still with its clip on a shot', async () => {
    for (const name of ['a-1.png', 'a-2.png', 'b-1.png', 'b-2.png']) seedImage(name);
    seedVideoHistory([{ id: 'clip-b2', prompt: 'waves in slow motion' }, { id: 'clip-a1' }, { id: 'clip-a1-trim' }]);
    await addTake(sceneA.sceneId, { kind: 'image', assetId: 'a-1.png', source: 'generated' });
    await addTake(sceneA.sceneId, { kind: 'image', assetId: 'a-2.png', source: 'generated' });
    await addTake(sceneA.sceneId, { kind: 'video', assetId: 'clip-a1', source: 'generated', sourceImageId: 'a-1.png' });
    await addTake(sceneB.sceneId, { kind: 'image', assetId: 'b-1.png', source: 'generated' });
    await addTake(sceneB.sceneId, { kind: 'image', assetId: 'b-2.png', source: 'generated' });
    await addTake(sceneB.sceneId, { kind: 'video', assetId: 'clip-b2', source: 'generated', sourceImageId: 'b-2.png' });
    const pool = async () => (await request(app).get(`${base()}/media-pool`)).body.items;

    // Selected stills and clips are in use; the rest are offered, each naming the shot that holds it.
    expect((await pool()).map((item) => [item.kind, item.assetId, item.sceneId]).sort()).toEqual([
      ['image', 'a-2.png', sceneA.sceneId], ['image', 'b-2.png', sceneB.sceneId], ['video', 'clip-b2', sceneB.sceneId],
    ]);

    // Cutting shot B leaves its takes on the floor, the clip still paired with the still it was rendered from.
    await request(app).delete(`${base()}/scenes/${sceneB.sceneId}`);
    const floor = await pool();
    expect(floor.filter((item) => !item.sceneId).map((item) => item.assetId).sort()).toEqual(['b-1.png', 'b-2.png', 'clip-b2']);
    expect(floor.find((item) => item.assetId === 'b-2.png').clipIds).toEqual(['clip-b2']);
    const { getCollection, musicVideoCollectionId } = await import('../services/mediaCollections.js');
    expect((await getCollection(musicVideoCollectionId(project.id))).items).toHaveLength(6);

    const used = await request(app).post(`${base()}/scenes/${sceneA.sceneId}/takes/use`).send({ kind: 'image', assetId: 'b-2.png', withAssetId: 'clip-b2' });
    expect(used.status).toBe(200);
    expect(used.body.scene).toMatchObject({ referenceImageId: 'b-2.png', videoHistoryId: 'clip-b2' });
    expect(used.body.scene.takes.find((take) => take.assetId === 'clip-b2')).toMatchObject({ source: 'reused', sourceImageId: 'b-2.png' });
    expect((await pool()).map((item) => item.assetId).sort()).toEqual(['a-1.png', 'a-2.png', 'b-1.png', 'clip-a1']);

    // A clip cut from a later start frame ("Start clip here") lands as a trimmed take.
    const trimmed = await addTake(sceneA.sceneId, { kind: 'video', assetId: 'clip-a1-trim', source: 'trimmed' });
    expect(trimmed.status).toBe(201);
    expect(trimmed.body.take).toMatchObject({ kind: 'video', assetId: 'clip-a1-trim', source: 'trimmed' });

    // Any unused still can become the shot's end frame, and leaves the pool.
    const end = await request(app).post(`${base()}/scenes/${sceneA.sceneId}/takes/use`).send({ kind: 'endImage', assetId: 'b-1.png' });
    expect(end.status).toBe(200);
    expect(end.body.scene).toMatchObject({ referenceImageId: 'b-2.png', endImageId: 'b-1.png' });
    expect((await pool()).map((item) => item.assetId).sort()).toEqual(['a-1.png', 'a-2.png', 'clip-a1', 'clip-a1-trim']);

    expect((await request(app).post(`${base()}/scenes/${sceneA.sceneId}/takes/use`).send({ kind: 'image', assetId: 'missing.png' })).status).toBe(400);
    expect((await request(app).post(`${base()}/scenes/${sceneA.sceneId}/takes/use`).send({ kind: 'endImage', assetId: 'a-1.png', withAssetId: 'clip-a1' })).status).toBe(400);

    // A shot whose video is locked takes nothing new until it is unlocked.
    const { setShotLocks } = await import('../services/musicVideo/productionReview.js');
    await projects.mutateProjectRecord(project.id, (current) => ({ project: setShotLocks(
      setShotLocks(current, { sceneIds: [sceneA.sceneId], locked: true, stage: 'still' }),
      { sceneIds: [sceneA.sceneId], locked: true, stage: 'video' },
    ) }));
    const refused = await request(app).post(`${base()}/scenes/${sceneA.sceneId}/takes/use`).send({ kind: 'image', assetId: 'a-1.png' });
    expect(refused.status).toBe(409);
    expect((await reload()).scenes.find((scene) => scene.sceneId === sceneA.sceneId).referenceImageId).toBe('b-2.png');
  });
});

describe('a swapped still brings its frame prompt', () => {
  // Uniquely catches a still placed from another shot or the floor leaving the start or end prompt describing the old picture, or carrying the look twice.
  it('sets the start or end frame prompt to the one the placed still was made from, without the project look', async () => {
    const prompts = {
      'diner.png': 'A neon diner at night, grainy 16mm\nShe enters from the left.',
      'smile.png': 'She smiles. Keep the reference image\'s composition, subject and framing; change only what this prompt describes.',
      'edit.png': 'Edit the reference image: remove the hand. Keep everything else exactly as it is.',
      'booth.png': 'An empty red booth, grainy 16mm',
    };
    for (const [name, prompt] of Object.entries(prompts)) {
      seedImage(name);
      writeFileSync(join(ROOT(), 'images', name.replace('.png', '.metadata.json')), JSON.stringify({ prompt }));
    }
    await projects.mutateProjectRecord(project.id, (current) => ({ project: { ...current, concept: { ...current.concept, style: 'grainy 16mm' } } }));
    await addTake(sceneB.sceneId, { kind: 'image', assetId: 'booth.png', source: 'generated' });
    for (const name of ['diner.png', 'edit.png']) await addTake(sceneB.sceneId, { kind: 'image', assetId: name, source: 'generated' });
    await addTake(sceneB.sceneId, { kind: 'endImage', assetId: 'smile.png', source: 'generated' });
    // Cut shot B: its stills land on the floor, where only their image records still name a prompt.
    await request(app).delete(`${base()}/scenes/${sceneB.sceneId}`);
    const use = (body) => request(app).post(`${base()}/scenes/${sceneA.sceneId}/takes/use`).send(body);

    expect((await use({ kind: 'image', assetId: 'diner.png' })).body.scene.framePrompt).toBe('A neon diner at night');
    expect((await use({ kind: 'endImage', assetId: 'smile.png' })).body.scene).toMatchObject({ framePrompt: 'A neon diner at night', endFramePrompt: 'She smiles' });
    // A refined still's prompt is an edit instruction, not a frame: the shot keeps its prompt.
    expect((await use({ kind: 'image', assetId: 'edit.png' })).body.scene.framePrompt).toBe('A neon diner at night');
    const booth = await use({ kind: 'image', assetId: 'booth.png' });
    expect(booth.body.scene.framePrompt).toBe('An empty red booth');
    expect(booth.body.scene.takes.find((take) => take.assetId === 'booth.png').prompt).toBe(prompts['booth.png']);
  });
});

describe('a director\'s still change keeps the shot locked', () => {
  // Uniquely catches a swapped still or edited prompt leaving the shot "changed since you locked it", so its clip can't render.
  it('re-binds the still lock on Use, take select and a prompt edit, and drops a clip lock made from the old still', async () => {
    for (const name of ['a-1.png', 'a-2.png', 'floor.png']) seedImage(name);
    seedVideoHistory([{ id: 'clip-a1' }]);
    await addTake(sceneA.sceneId, { kind: 'image', assetId: 'a-1.png', source: 'generated' });
    const second = await addTake(sceneA.sceneId, { kind: 'image', assetId: 'a-2.png', source: 'generated' });
    await addTake(sceneA.sceneId, { kind: 'video', assetId: 'clip-a1', source: 'generated', sourceImageId: 'a-1.png' });
    await addTake(sceneB.sceneId, { kind: 'image', assetId: 'floor.png', source: 'generated' });
    await request(app).delete(`${base()}/scenes/${sceneB.sceneId}`);
    const { setShotLocks, shotLocks, clipLocks } = await import('../services/musicVideo/productionReview.js');
    const lockA = async (stage) => projects.mutateProjectRecord(project.id, (current) => ({ project: setShotLocks(current, { sceneIds: [sceneA.sceneId], locked: true, stage }) }));
    await lockA('still');
    const stillLock = async () => shotLocks(await reload())[sceneA.sceneId];

    expect((await request(app).post(`${base()}/scenes/${sceneA.sceneId}/takes/use`).send({ kind: 'image', assetId: 'floor.png' })).status).toBe(200);
    expect(await stillLock()).toBe('locked');
    expect((await request(app).post(`${base()}/scenes/${sceneA.sceneId}/takes/${second.body.take.takeId}/select`)).status).toBe(200);
    expect(await stillLock()).toBe('locked');
    expect((await request(app).patch(`${base()}/scenes/${sceneA.sceneId}`).send({ prompt: 'Slow push toward the reel' })).status).toBe(200);
    expect(await stillLock()).toBe('locked');

    // A clip lock made from the old still goes stale with it; a director edit then re-locks the still and drops the clip lock.
    await lockA('video');
    await projects.mutateProjectRecord(project.id, (current) => ({ project: { ...current,
      scenes: current.scenes.map((scene) => scene.sceneId === sceneA.sceneId ? { ...scene, endImageId: 'a-1.png' } : scene) } }));
    expect(await stillLock()).toBe('changed');
    expect((await request(app).patch(`${base()}/scenes/${sceneA.sceneId}`).send({ referenceImageId: 'floor.png' })).status).toBe(200);
    expect(await stillLock()).toBe('locked');
    expect(clipLocks(await reload())[sceneA.sceneId]).toBe('open');
  });
});

describe('renders made for a video with no shot', () => {
  // Uniquely catches a sheet, test or Video Gen render for the video (no shot keeps it) missing from its collection and the picker.
  it('files completed renders naming the video, and clips stamped with it, into its collection', async () => {
    const { mediaJobEvents } = await import('../services/mediaJobQueue/index.js');
    const hook = await import('../services/musicVideoCollectionHook.js');
    hook.__testing.reset();
    hook.initMusicVideoCollectionHook();
    seedImage('sheet.png');
    seedImage('frame.png');
    seedVideoHistory([{ id: 'test-clip' }, { id: 'trimmed-copy', musicVideo: { projectId: project.id, sceneId: null } }, { id: 'other-clip' }]);
    mediaJobEvents.emit('completed', { kind: 'image', id: 'job-sheet', params: { musicVideo: { projectId: project.id, castAndSets: { key: 'cast:lead' } } }, result: { filename: 'sheet.png' } });
    mediaJobEvents.emit('completed', { kind: 'video', id: 'test-clip', params: { musicVideoProjectId: project.id, sourceImagePath: '/abs/images/frame.png' }, result: { generationId: 'test-clip' } });
    mediaJobEvents.emit('completed', { kind: 'video', id: 'other-clip', params: {}, result: { generationId: 'other-clip' } });
    mediaJobEvents.emit('completed', { kind: 'image', id: 'job-gone', params: { musicVideoProjectId: 'mv-missing' }, result: { filename: 'frame.png' } });
    await hook.__testing.drain();
    hook.__testing.reset();

    const { getCollection, musicVideoCollectionId } = await import('../services/mediaCollections.js');
    const filed = async () => (await getCollection(musicVideoCollectionId(project.id))).items.map((item) => `${item.kind}:${item.ref}`).sort();
    expect(await filed()).toEqual(['image:sheet.png', 'video:test-clip']);

    const pool = (await request(app).get(`${base()}/media-pool`)).body.items;
    expect(await filed()).toEqual(['image:sheet.png', 'video:test-clip', 'video:trimmed-copy']);
    expect(pool.find((item) => item.assetId === 'test-clip')).toMatchObject({ kind: 'video', sceneId: null, sourceImageId: 'frame.png' });
  });
});

describe('the shot asset manager', () => {
  // Uniquely catches a take rejected from one shot reading as bad in Swap, where another shot may want it.
  it('lists a take rejected from its shot as not bad until the director marks it', async () => {
    for (const name of ['first.png', 'second.png']) seedImage(name);
    await addTake(sceneA.sceneId, { kind: 'image', assetId: 'first.png', source: 'generated' });
    const second = await addTake(sceneA.sceneId, { kind: 'image', assetId: 'second.png', source: 'generated' });
    await request(app).patch(`${base()}/scenes/${sceneA.sceneId}/takes/${second.body.take.takeId}`).send({ status: 'rejected' });
    const listed = async () => (await request(app).get(`${base()}/media-pool`)).body.items.find((item) => item.assetId === 'second.png');
    expect(await listed()).toMatchObject({ takeStatus: 'rejected', mark: null });
    await request(app).patch(`${base()}/media-pool/marks`).send({ items: [{ kind: 'image', assetId: 'second.png' }], mark: 'bad' });
    expect((await listed()).mark).toBe('bad');
  });

  // Uniquely catches a deleted still or clip leaving a take, mark or collection row pointing at a file that is gone, and a shot's own still being deletable.
  it('marks unused assets, refuses a shot\'s own, and forgets deleted ones everywhere', async () => {
    for (const name of ['keep.png', 'bad.png', 'used.png', 'b-used.png']) seedImage(name);
    seedVideoHistory([{ id: 'b-clip', filename: 'b-clip.mp4' }, { id: 'bad-clip', filename: 'bad-clip.mp4' }]);
    await addTake(sceneA.sceneId, { kind: 'image', assetId: 'used.png', source: 'generated' });
    await addTake(sceneA.sceneId, { kind: 'image', assetId: 'keep.png', source: 'generated' });
    await addTake(sceneB.sceneId, { kind: 'image', assetId: 'b-used.png', source: 'generated' });
    await addTake(sceneB.sceneId, { kind: 'image', assetId: 'bad.png', source: 'generated' });
    await addTake(sceneB.sceneId, { kind: 'video', assetId: 'b-clip', source: 'generated' });
    await addTake(sceneB.sceneId, { kind: 'video', assetId: 'bad-clip', source: 'generated' });
    const marks = (items, mark) => request(app).patch(`${base()}/media-pool/marks`).send({ items, mark });

    expect((await marks([{ kind: 'image', assetId: 'keep.png' }], 'ingredient')).body.assetMarks).toEqual({ 'image:keep.png': 'ingredient' });
    await marks([{ kind: 'image', assetId: 'bad.png' }], 'bad');
    const pool = (await request(app).get(`${base()}/media-pool`)).body.items;
    expect(pool.find((item) => item.assetId === 'keep.png').mark).toBe('ingredient');

    const refused = await request(app).post(`${base()}/media-pool/delete`).send({ items: [{ kind: 'image', assetId: 'used.png' }] });
    expect(refused.status).toBe(409);
    // Nor a still another video's shot uses, though it sits in this video's collection.
    seedImage('shared.png');
    const other = await projects.createProject({ name: 'Second Video' });
    const otherScene = await projects.addProjectScene(other.id, { prompt: 'an empty stage' });
    await request(app).post(`/api/music-video/${other.id}/scenes/${otherScene.sceneId}/takes`).send({ kind: 'image', assetId: 'shared.png', source: 'generated' });
    const { fileMusicVideoMedia } = await import('../services/musicVideo/mediaPool.js');
    await fileMusicVideoMedia(await reload(), [{ kind: 'image', ref: 'shared.png' }]);
    expect((await request(app).post(`${base()}/media-pool/delete`).send({ items: [{ kind: 'image', assetId: 'shared.png' }] })).status).toBe(409);
    // A mark can be cleared again.
    await marks([{ kind: 'image', assetId: 'shared.png' }], 'bad');
    expect((await marks([{ kind: 'image', assetId: 'shared.png' }], null)).body.assetMarks).toEqual({ 'image:keep.png': 'ingredient', 'image:bad.png': 'bad' });

    const deleted = await request(app).post(`${base()}/media-pool/delete`).send({ items: [{ kind: 'image', assetId: 'bad.png' }] });
    expect(deleted.status).toBe(200);
    // A clip deleted from Media history is forgotten the same way.
    const { deleteHistoryItem } = await import('../services/videoGen/historyOps.js');
    await deleteHistoryItem('bad-clip');

    const stored = await reload();
    const takeIds = stored.scenes.flatMap((scene) => (scene.takes || []).map((take) => take.assetId));
    expect(takeIds).not.toContain('bad.png');
    expect(takeIds).not.toContain('bad-clip');
    expect(stored.assetMarks).toEqual({ 'image:keep.png': 'ingredient' });
    const { getCollection, musicVideoCollectionId } = await import('../services/mediaCollections.js');
    expect((await getCollection(musicVideoCollectionId(project.id))).items.map((item) => item.ref).sort()).toEqual(['b-clip', 'b-used.png', 'keep.png', 'shared.png', 'used.png']);
  });
});

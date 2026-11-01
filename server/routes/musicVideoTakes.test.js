// Keep the filesystem half real without touching the host's Trash.
vi.mock('../lib/nativeTrash.js', () => ({ moveToNativeTrash: async paths => {
  const { unlink } = await import('node:fs/promises');
  for (const path of paths) await unlink(path);
} }));
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
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const race = vi.hoisted(() => ({ beforeDelete: null, beforeSave: null, onRequest: null, ownerAnswer: null }));
// `ownerAnswer(kind, key)` stands in for a peer-owned asset: the real flow dials the owner and is covered in mediaRemoteDelete.test.js.
vi.mock('../services/mediaRemoteDelete.js', async (original) => {
  const actual = await original();
  return { ...actual, deleteMediaAnywhere: async (kind, key, opts) => (race.ownerAnswer?.(kind, key) ?? actual.deleteMediaAnywhere(kind, key, opts)) };
});
vi.mock('../services/galleryImageDeletion.js', async (original) => {
  const actual = await original();
  return { ...actual, deleteGalleryImage: async (...args) => {
    await race.beforeDelete?.(...args);
    return actual.deleteGalleryImage(...args);
  } };
});
vi.mock('../services/videoGen/historyOps.js', async (original) => {
  const actual = await original();
  return { ...actual, deleteHistoryItem: async (...args) => {
    await race.beforeDelete?.(...args);
    return actual.deleteHistoryItem(...args);
  } };
});
vi.mock('../lib/fileUtils.js', async (original) => {
  const actual = await original();
  return { ...actual, atomicWrite: async (...args) => {
    if (args[0].endsWith('music-video-projects.json')) await race.beforeSave?.(args[1]);
    return actual.atomicWrite(...args);
  } };
});

const ROOT = () => lazyTempDataRoot('mv-takes-route-test-');
vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const { default: musicVideoRoutes } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const { productionReviewBasis } = await import('../services/musicVideo/productionReview.js');

// The approvals a project saved before lock removal still carries (a covering board approval and a
// clip approval); nothing writes them now.
const withLegacyLocks = (current, sceneId, videoHistoryId) => ({ ...current, productionReview: { ...current.productionReview,
  approvals: { storyboard: { basis: productionReviewBasis(current).storyboard } }, clipApprovals: { [sceneId]: { videoHistoryId } } } });

const app = express();
app.use(express.json());
app.use((req, res, next) => { race.onRequest?.(req); next(); });
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
  race.beforeDelete = race.beforeSave = race.onRequest = race.ownerAnswer = null;
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
    seedImage('legacy.png');
    await projects.updateScene(project.id, sceneB.sceneId, { referenceImageId: 'legacy.png' });
    rmSync(join(ROOT(), 'images', 'legacy.png')); // legacy records may outlive their bytes
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
  // Uniquely catches a cut shot's takes vanishing from the picker, a clip losing its still, and a frame placed on a shot dropping out of every other shot's picker.
  it('lists every still and clip with the shots using it, keeps a cut shot\'s takes on the floor, and puts a still with its clip on a shot', async () => {
    for (const name of ['a-1.png', 'a-2.png', 'b-1.png', 'b-2.png']) seedImage(name);
    seedVideoHistory([{ id: 'clip-b2', prompt: 'waves in slow motion' }, { id: 'clip-a1' }, { id: 'clip-a1-trim' }]);
    await addTake(sceneA.sceneId, { kind: 'image', assetId: 'a-1.png', source: 'generated' });
    await addTake(sceneA.sceneId, { kind: 'image', assetId: 'a-2.png', source: 'generated' });
    await addTake(sceneA.sceneId, { kind: 'video', assetId: 'clip-a1', source: 'generated', sourceImageId: 'a-1.png' });
    await addTake(sceneB.sceneId, { kind: 'image', assetId: 'b-1.png', source: 'generated' });
    await addTake(sceneB.sceneId, { kind: 'image', assetId: 'b-2.png', source: 'generated' });
    await addTake(sceneB.sceneId, { kind: 'video', assetId: 'clip-b2', source: 'generated', sourceImageId: 'b-2.png' });
    const pool = async () => (await request(app).get(`${base()}/media-pool`)).body.items;
    const inUse = async () => (await pool()).filter((item) => item.inUseBy.length).map((item) => item.assetId).sort();

    // Everything is offered, each naming the shot that holds it; selected stills and clips name the shots using them.
    expect((await pool()).map((item) => [item.kind, item.assetId, item.sceneId, item.inUseBy]).sort()).toEqual([
      ['image', 'a-1.png', sceneA.sceneId, [sceneA.sceneId]], ['image', 'a-2.png', sceneA.sceneId, []],
      ['image', 'b-1.png', sceneB.sceneId, [sceneB.sceneId]], ['image', 'b-2.png', sceneB.sceneId, []],
      ['video', 'clip-a1', sceneA.sceneId, [sceneA.sceneId]], ['video', 'clip-b2', sceneB.sceneId, []],
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
    expect(await inUse()).toEqual(['b-2.png', 'clip-b2']);

    // A clip cut from a later start frame ("Start clip here") lands as a trimmed take.
    const trimmed = await addTake(sceneA.sceneId, { kind: 'video', assetId: 'clip-a1-trim', source: 'trimmed' });
    expect(trimmed.status).toBe(201);
    expect(trimmed.body.take).toMatchObject({ kind: 'video', assetId: 'clip-a1-trim', source: 'trimmed' });

    // Any still can become the shot's end frame, and stays listed as in use.
    const end = await request(app).post(`${base()}/scenes/${sceneA.sceneId}/takes/use`).send({ kind: 'endImage', assetId: 'b-1.png' });
    expect(end.status).toBe(200);
    expect(end.body.scene).toMatchObject({ referenceImageId: 'b-2.png', endImageId: 'b-1.png' });
    expect(await inUse()).toEqual(['b-1.png', 'b-2.png', 'clip-b2']);

    expect((await request(app).post(`${base()}/scenes/${sceneA.sceneId}/takes/use`).send({ kind: 'image', assetId: 'missing.png' })).status).toBe(400);
    expect((await request(app).post(`${base()}/scenes/${sceneA.sceneId}/takes/use`).send({ kind: 'endImage', assetId: 'a-1.png', withAssetId: 'clip-a1' })).status).toBe(400);

    // Legacy video locks do not prevent changing the reference or discard its clip.
    await projects.mutateProjectRecord(project.id, (current) => ({ project: withLegacyLocks(current, sceneA.sceneId, 'clip-b2') }));
    const changed = await request(app).post(`${base()}/scenes/${sceneA.sceneId}/takes/use`).send({ kind: 'image', assetId: 'a-1.png' });
    expect(changed.status).toBe(200);
    expect((await reload()).scenes.find((scene) => scene.sceneId === sceneA.sceneId)).toMatchObject({ referenceImageId: 'a-1.png', videoHistoryId: 'clip-b2' });
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

describe('a director can change legacy locked shots', () => {
  it('selects a new still and edits its prompt without losing the selected clip or prior takes', async () => {
    for (const name of ['a-1.png', 'a-2.png', 'floor.png']) seedImage(name);
    seedVideoHistory([{ id: 'clip-a1' }]);
    await addTake(sceneA.sceneId, { kind: 'image', assetId: 'a-1.png', source: 'generated' });
    const second = await addTake(sceneA.sceneId, { kind: 'image', assetId: 'a-2.png', source: 'generated' });
    await addTake(sceneA.sceneId, { kind: 'video', assetId: 'clip-a1', source: 'generated', sourceImageId: 'a-1.png' });
    await addTake(sceneB.sceneId, { kind: 'image', assetId: 'floor.png', source: 'generated' });
    await request(app).delete(`${base()}/scenes/${sceneB.sceneId}`);
    await projects.mutateProjectRecord(project.id, (current) => ({ project: withLegacyLocks(current, sceneA.sceneId, 'clip-a1') }));
    expect((await request(app).post(`${base()}/scenes/${sceneA.sceneId}/takes/use`).send({ kind: 'image', assetId: 'floor.png' })).status).toBe(200);
    expect((await request(app).post(`${base()}/scenes/${sceneA.sceneId}/takes/${second.body.take.takeId}/select`)).status).toBe(200);
    expect((await request(app).patch(`${base()}/scenes/${sceneA.sceneId}`).send({ prompt: 'Slow push toward the reel' })).status).toBe(200);
    const updated = (await reload()).scenes.find(scene => scene.sceneId === sceneA.sceneId);
    expect(updated).toMatchObject({ referenceImageId: 'a-2.png', videoHistoryId: 'clip-a1', prompt: 'Slow push toward the reel' });
    expect(updated.takes.map(take => take.assetId)).toEqual(expect.arrayContaining(['a-1.png', 'a-2.png', 'floor.png', 'clip-a1']));
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

describe('Swap\'s prompt search', () => {
  // Uniquely catches a still on the floor (no take left to carry its prompt) or a clip missing from a search for words in its prompt.
  it('matches every word against each file\'s own prompt, ignoring case', async () => {
    for (const name of ['falcon.png', 'street.png']) seedImage(name);
    writeFileSync(join(ROOT(), 'images', 'falcon.metadata.json'), JSON.stringify({ prompt: 'A Falcon tattoo on her forearm, grainy 16mm' }));
    writeFileSync(join(ROOT(), 'images', 'street.metadata.json'), JSON.stringify({ prompt: 'A wet street at night' }));
    seedVideoHistory([{ id: 'falcon-clip', filename: 'falcon-clip.mp4', prompt: 'The falcon tattoo flexes as she grips the wheel' }]);
    await addTake(sceneB.sceneId, { kind: 'image', assetId: 'falcon.png', source: 'generated' });
    await addTake(sceneB.sceneId, { kind: 'image', assetId: 'street.png', source: 'generated' });
    await addTake(sceneB.sceneId, { kind: 'video', assetId: 'falcon-clip', source: 'generated' });
    // Cut shot B: its files land on the floor, where only the files themselves still name a prompt.
    await request(app).delete(`${base()}/scenes/${sceneB.sceneId}`);
    const search = (q) => request(app).get(`${base()}/media-pool/search?q=${encodeURIComponent(q)}`);
    expect((await search('FALCON tattoo')).body.items).toEqual(expect.arrayContaining([{ kind: 'image', assetId: 'falcon.png' }, { kind: 'video', assetId: 'falcon-clip' }]));
    expect((await search('falcon street')).body.items).toEqual([]);
    expect((await search('')).status).toBe(400);
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

  // Uniquely catches a Bad mark leaving the file offered as a candidate on shots, or clearing a shot's selection.
  it('rejects a bad file on every shot not using it, and keeps it where it is in use', async () => {
    for (const name of ['a-pick.png', 'spare.png']) seedImage(name);
    await addTake(sceneA.sceneId, { kind: 'image', assetId: 'a-pick.png', source: 'generated' });
    await addTake(sceneA.sceneId, { kind: 'image', assetId: 'spare.png', source: 'generated' });
    await addTake(sceneB.sceneId, { kind: 'image', assetId: 'spare.png', source: 'generated' });
    await addTake(sceneB.sceneId, { kind: 'endImage', assetId: 'a-pick.png', source: 'generated' });
    const marked = await request(app).patch(`${base()}/media-pool/marks`).send({ items: [{ kind: 'image', assetId: 'spare.png' }, { kind: 'image', assetId: 'a-pick.png' }], mark: 'bad' });
    expect(marked.status).toBe(200);
    // Shot A uses a-pick and shot B uses spare (its first take), so only A's spare changes.
    expect(marked.body.scenes.map((scene) => scene.sceneId)).toEqual([sceneA.sceneId]);
    const statuses = (scene) => Object.fromEntries(scene.takes.map((take) => [`${take.kind}:${take.assetId}`, take.status]));
    expect(statuses(marked.body.scenes[0])).toEqual({ 'image:a-pick.png': 'candidate', 'image:spare.png': 'rejected' });
    const saved = (await reload()).scenes;
    expect(statuses(saved.find((scene) => scene.sceneId === sceneB.sceneId))).toEqual({ 'image:spare.png': 'candidate', 'endImage:a-pick.png': 'candidate' });
    expect(saved.find((scene) => scene.sceneId === sceneA.sceneId).referenceImageId).toBe('a-pick.png');
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
    expect(deleted.body).toMatchObject({ deleted: 1, items: [{ kind: 'image', assetId: 'bad.png', status: 'deleted' }] });
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

describe('deleting a peer-owned pool asset', () => {
  // Uniquely catches a pool delete removing or forgetting an asset here before its owner has deleted it.
  it('keeps a pending asset and its takes, and forgets one the owner deleted', async () => {
    for (const name of ['theirs.png', 'gone.png', 'first.png']) seedImage(name);
    // The shot's first take is its own; the later ones sit unused in the pool.
    for (const name of ['first.png', 'theirs.png', 'gone.png']) await addTake(sceneA.sceneId, { kind: 'image', assetId: name, source: 'generated' });
    await projects.mutateProjectRecord(project.id, (current) => ({ project: { ...current, assetMarks: { 'image:theirs.png': 'bad', 'image:gone.png': 'bad' } } }));
    const remove = (items) => request(app).post(`/api/music-video/${project.id}/media-pool/delete`).send({ items });
    race.ownerAnswer = async (kind, key) => (key === 'theirs.png'
      ? { status: 'pending', pendingDelete: { peerId: 'peer-1', queuedAt: '2026-05-01T00:00:00.000Z' }, peerName: 'Example Peer' }
      : { status: 'deleted-remote', hiddenHere: true, peerName: 'Example Peer' });
    const res = await remove([{ kind: 'image', assetId: 'theirs.png' }, { kind: 'image', assetId: 'gone.png' }]);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
    expect(res.body.items.map((item) => [item.assetId, item.status])).toEqual([['theirs.png', 'pending'], ['gone.png', 'deleted-remote']]);
    // Nothing was deleted or tombstoned here: the bytes stay, and only the hidden asset is forgotten.
    expect(existsSync(join(ROOT(), 'images', 'theirs.png'))).toBe(true);
    expect((await projects.getProject(project.id)).assetMarks).toEqual({ 'image:theirs.png': 'bad' });
  });
});

describe('a shot\'s frame references', () => {
  // Uniquely catches the shot card's References pick failing to save, or a frame render ignoring it.
  it('saves the director\'s pick on the shot, and frame renders send it instead of the automatic set', async () => {
    const { musicVideoConditioningReferences } = await import('../lib/musicVideoConditioning.js');
    await projects.mutateProjectRecord(project.id, (current) => ({ project: { ...current, visualSpec: { ...(current.visualSpec || {}), references: [
      { id: 'lead', imageId: 'lead.png', role: 'character', label: 'Lead', condition: true },
      { id: 'tattooist', imageId: 'tattooist.png', role: 'character', label: 'Tattoo artist', condition: false },
      { id: 'mvr-board-1', imageId: 'board.png', role: 'style', label: 'Board pin', condition: false },
    ] } } }));
    const sceneOf = async () => (await reload()).scenes.find((scene) => scene.sceneId === sceneA.sceneId);
    expect(musicVideoConditioningReferences(await reload(), await sceneOf()).map((ref) => ref.id)).toEqual(['lead']);

    const saved = await request(app).patch(`${base()}/scenes/${sceneA.sceneId}`).send({ frameReferenceIds: ['tattooist', 'mvr-board-1'] });
    expect(saved.status).toBe(200);
    // Outside inspiration is never sent as an image, even when named.
    expect(musicVideoConditioningReferences(await reload(), await sceneOf()).map((ref) => ref.id)).toEqual(['tattooist']);
    expect((await request(app).patch(`${base()}/scenes/${sceneA.sceneId}`).send({ frameReferenceIds: ['a', 'b', 'c', 'd', 'e'] })).status).toBe(400);
    // Back to auto.
    await request(app).patch(`${base()}/scenes/${sceneA.sceneId}`).send({ frameReferenceIds: null });
    expect(musicVideoConditioningReferences(await reload(), await sceneOf()).map((ref) => ref.id)).toEqual(['lead']);
  });

  // Uniquely catches a shot's Casting variant failing to save, or the server-side load not feeding conditioning.
  it('saves a shot\'s cast variant and conditions its frames only on age-compatible Casting guides', async () => {
    const { musicVideoConditioningReferences } = await import('../lib/musicVideoConditioning.js');
    const { loadSceneCastMedia } = await import('../services/musicVideo/castGuideMedia.js');
    await projects.mutateProjectRecord(project.id, (current) => ({ project: { ...current, visualSpec: { ...(current.visualSpec || {}), references: [
      { id: 'lead', imageId: 'lead.png', role: 'character', label: 'Lead', condition: true },
    ] } } }));
    const sceneOf = async () => (await reload()).scenes.find((scene) => scene.sceneId === sceneA.sceneId);
    expect((await request(app).patch(`${base()}/scenes/${sceneA.sceneId}`).send({ characterVariant: { ingredientId: 'cat-chr-x', era: 'nope' } })).status).toBe(400);
    const saved = await request(app).patch(`${base()}/scenes/${sceneA.sceneId}`).send({ characterVariant: { ingredientId: 'cat-chr-x', age: 7 } });
    expect(saved.status).toBe(200);
    const scene = await sceneOf();
    expect(scene.characterVariant).toEqual({ ingredientId: 'cat-chr-x', age: 7 });
    const listMedia = async (id) => (id === 'cat-chr-x' ? [
      { mediaKey: 'adult.png', kind: 'reference', library: { variant: { age: 30 }, guide: true } },
      { mediaKey: 'child.png', kind: 'reference', library: { variant: { age: 7 }, guide: true } },
    ] : []);
    const castMedia = await loadSceneCastMedia(scene, { listMedia });
    expect(musicVideoConditioningReferences(await reload(), scene, castMedia).map((ref) => ref.imageId)).toEqual(['child.png', 'lead.png']);
    // A failed catalog read conditions on the project's references, as before.
    expect(await loadSceneCastMedia(scene, { listMedia: async () => { throw new Error('db down'); } })).toBeNull();
    await request(app).patch(`${base()}/scenes/${sceneA.sceneId}`).send({ characterVariant: null });
    expect(await loadSceneCastMedia(await sceneOf(), { listMedia })).toBeNull();
  });
});


function barrier() {
  let entered;
  let release;
  const reached = new Promise(resolve => { entered = resolve; });
  const resumed = new Promise(resolve => { release = resolve; });
  return { reached, release, wait: async () => { entered(); await resumed; } };
}

// Each combination catches a different deletion lane or all-project scan.
describe('pool deletion and selection admission', () => {
  async function seedRace(kind, anotherProject) {
    const assetId = kind === 'image' ? 'race.png' : 'race-clip';
    const keep = kind === 'image' ? 'keep.png' : 'keep-clip';
    const field = kind === 'image' ? 'referenceImageId' : 'videoHistoryId';
    if (kind === 'image') {
      seedImage(assetId);
      seedImage(keep);
    } else {
      mkdirSync(join(ROOT(), 'videos'), { recursive: true });
      for (const id of [assetId, keep]) writeFileSync(join(ROOT(), 'videos', `${id}.mp4`), 'synthetic clip');
      seedVideoHistory([assetId, keep].map(id => ({ id, filename: `${id}.mp4` })));
    }
    await addTake(sceneA.sceneId, { kind, assetId: keep });
    const candidate = await addTake(sceneA.sceneId, { kind, assetId });
    let owner = project;
    let shot = sceneA;
    let take = candidate.body.take;
    if (anotherProject) {
      owner = await projects.createProject({ name: 'Other synthetic project' });
      shot = await projects.addProjectScene(owner.id, { prompt: 'Another shot' });
      await projects.appendSceneTakes(owner.id, shot.sceneId, [{ kind, assetId: keep }]);
      take = (await projects.appendSceneTakes(owner.id, shot.sceneId, [{ kind, assetId }])).appended[0];
    }
    const path = `/api/music-video/${owner.id}/scenes/${shot.sceneId}`;
    const select = () => request(app).post(`${path}/takes/${take.takeId}/select`).then(value => value);
    const remove = () => request(app).post(`${base()}/media-pool/delete`).send({ items: [{ kind, assetId }] }).then(value => value);
    const bytes = () => existsSync(join(ROOT(), kind === 'image' ? 'images' : 'videos', kind === 'image' ? assetId : `${assetId}.mp4`));
    const selected = async () => (await projects.getProject(owner.id)).scenes.find(scene => scene.sceneId === shot.sceneId)[field];
    return { assetId, keep, field, owner, shot, path, select, remove, bytes, selected };
  }

  it.each([['image', false], ['video', false], ['image', true], ['video', true]])(
    'keeps a %s selected before deletion (other project: %s)', async (kind, anotherProject) => {
      const fixture = await seedRace(kind, anotherProject);
      const gate = barrier();
      race.beforeSave = async rows => {
        if (rows.some(row => row.id === fixture.owner.id && row.scenes.some(scene => scene[fixture.field] === fixture.assetId))) {
          race.beforeSave = null;
          await gate.wait();
        }
      };
      const selection = fixture.select();
      await gate.reached;
      const arrived = barrier();
      race.onRequest = req => { if (req.path.endsWith('/media-pool/delete')) arrived.release(); };
      const deletion = fixture.remove();
      // Wait until HTTP deletion has arrived while selection owns the store tail.
      await arrived.wait();
      gate.release();
      expect((await selection).status).toBe(200);
      const refused = await deletion;
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('POOL_ASSET_IN_USE');
      expect(await fixture.selected()).toBe(fixture.assetId);
      expect(fixture.bytes()).toBe(true);
    },
  );

  it.each([['image', false], ['video', false], ['image', true], ['video', true]])(
    'refuses selection after admitted %s deletion (other project: %s)', async (kind, anotherProject) => {
      const fixture = await seedRace(kind, anotherProject);
      const gate = barrier();
      race.beforeDelete = gate.wait;
      const deletion = fixture.remove();
      await gate.reached;
      const arrived = barrier();
      race.onRequest = req => { if (req.path.endsWith('/select')) arrived.release(); };
      const selection = fixture.select();
      // An unrelated project edit must survive the file-wide cleanup too.
      const edit = projects.updateProject(fixture.owner.id, { name: 'Concurrent title' });
      await arrived.wait();
      gate.release();
      expect((await deletion).status).toBe(200);
      expect((await selection).status).toBe(404); // cleanup removed the now-missing take
      await edit;
      expect(await fixture.selected()).toBe(fixture.keep);
      expect(fixture.bytes()).toBe(false);
      expect((await projects.getProject(fixture.owner.id)).name).toBe('Concurrent title');
      // Direct slot writes and reused/generated/imported completions also see
      // the missing local asset inside admission, even after route preflight.
      const direct = await request(app).patch(fixture.path).send({ [fixture.field]: fixture.assetId });
      expect(direct.status).toBe(400);
      expect(direct.body.code).toBe('TAKE_ASSET_NOT_FOUND');
      await expect(projects.placeMediaPoolItem(fixture.owner.id, fixture.shot.sceneId, { kind, assetId: fixture.assetId }))
        .rejects.toMatchObject({ code: 'TAKE_ASSET_NOT_FOUND' });
      await projects.updateScene(fixture.owner.id, fixture.shot.sceneId, { [fixture.field]: null });
      for (const source of ['generated', 'imported']) {
        await expect(projects.appendSceneTakes(fixture.owner.id, fixture.shot.sceneId, [{ kind, assetId: fixture.assetId, source }]))
          .rejects.toMatchObject({ code: 'TAKE_ASSET_NOT_FOUND' });
      }
      await expect(projects.appendTakesAcrossScenes(fixture.owner.id, [{ sceneId: fixture.shot.sceneId, kind, assetId: fixture.assetId }]))
        .rejects.toMatchObject({ code: 'TAKE_ASSET_NOT_FOUND' });
      expect(await fixture.selected()).toBeNull();
    },
  );

  it('cleans a completed batch prefix after failure and keeps the failed asset and evidence', async () => {
    seedImage('keep.png');
    seedImage('deleted.png');
    seedImage('failed.png');
    await addTake(sceneA.sceneId, { kind: 'image', assetId: 'keep.png' });
    await addTake(sceneA.sceneId, { kind: 'image', assetId: 'deleted.png' });
    await addTake(sceneA.sceneId, { kind: 'image', assetId: 'failed.png' });
    const items = ['deleted.png', 'failed.png'].map(assetId => ({ kind: 'image', assetId }));
    await request(app).patch(`${base()}/media-pool/marks`).send({ items, mark: 'bad' });
    seedImage('outside.png');
    for (const assetId of ['keep.png', 'outside.png']) {
      const refused = await request(app).post(`${base()}/media-pool/delete`).send({ items: [items[0], { kind: 'image', assetId }] });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('POOL_ASSET_IN_USE');
      expect(existsSync(join(ROOT(), 'images', 'deleted.png'))).toBe(true);
    }
    race.beforeDelete = async id => { if (id === 'failed.png') throw new Error('Synthetic deletion failure'); };
    const result = await request(app).post(`${base()}/media-pool/delete`).send({ items });
    expect(result.status).toBe(500);
    expect(existsSync(join(ROOT(), 'images', 'deleted.png'))).toBe(false);
    expect(existsSync(join(ROOT(), 'images', 'failed.png'))).toBe(true);
    const stored = await reload();
    expect(stored.scenes[0].takes.map(take => take.assetId)).toEqual(['keep.png', 'failed.png']);
    expect(stored.assetMarks).toEqual({ 'image:failed.png': 'bad' });
    await projects.updateProject(project.id, { name: 'Queue recovered' });
    expect((await reload()).name).toBe('Queue recovered');
  });
});

describe('media from an earlier draft', () => {
  // Uniquely catches an import that copies nothing the draft's shots hold, skips the stats tally, or restamps the draft's clips.
  it('files the draft\'s stills and clips into this video\'s assets and stats, leaving the draft as it was', async () => {
    for (const name of ['draft-still.png', 'draft-floor.png', 'mine.png']) seedImage(name);
    seedVideoHistory([{ id: 'draft-clip', filename: 'draft-clip.mp4', prompt: 'draft motion' }]);
    await addTake(sceneA.sceneId, { kind: 'image', assetId: 'mine.png', source: 'generated' });
    const draft = await projects.createProject({ name: 'Example Draft' });
    const draftShot = await projects.addProjectScene(draft.id, { prompt: 'an early idea' });
    const draftTake = (body) => request(app).post(`/api/music-video/${draft.id}/scenes/${draftShot.sceneId}/takes`).send(body);
    await draftTake({ kind: 'image', assetId: 'draft-still.png', source: 'generated' });
    await draftTake({ kind: 'image', assetId: 'draft-floor.png', source: 'generated' });
    await draftTake({ kind: 'video', assetId: 'draft-clip', source: 'generated' });
    await draftTake({ kind: 'image', assetId: 'mine.png', source: 'generated' });

    const imported = await request(app).post(`${base()}/media-pool/import`).send({ fromProjectId: draft.id });
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({ added: 3, total: 4 });
    const fromDraft = imported.body.items.filter((item) => item.assetId.startsWith('draft-'));
    expect(fromDraft.map((item) => `${item.kind}:${item.assetId}`).sort()).toEqual(['image:draft-floor.png', 'image:draft-still.png', 'video:draft-clip']);
    expect(fromDraft.every((item) => item.sceneId === null && item.inUseBy.length === 0)).toBe(true);
    // Again is a no-op.
    expect((await request(app).post(`${base()}/media-pool/import`).send({ fromProjectId: draft.id })).body).toMatchObject({ added: 0 });

    const stats = (await request(app).get(`${base()}/stats-outro`)).body.stats;
    expect(stats.stills.made).toBe(3);
    expect(stats.clips.made).toBe(1);
    const { loadHistory } = await import('../services/videoGen/history.js');
    expect((await loadHistory()).find((entry) => entry.id === 'draft-clip').musicVideo.projectId).toBe(draft.id);
    expect((await request(app).post(`${base()}/media-pool/import`).send({ fromProjectId: project.id })).status).toBe(400);
    expect((await request(app).post(`${base()}/media-pool/import`).send({ fromProjectId: 'mv-missing' })).status).toBe(404);
  });
});

describe('media from the library', () => {
  // Uniquely catches a library search offering files already in the video, missing a clip, or an add that files nothing.
  it('finds unfiled stills and clips by prompt and adds the picks to this video\'s assets', async () => {
    for (const name of ['sheet.png', 'filed.png', 'other.png']) seedImage(name);
    writeFileSync(join(ROOT(), 'images', 'sheet.metadata.json'), JSON.stringify({ prompt: 'Character reference sheet for The Director', createdAt: '2026-01-02T00:00:00Z' }));
    writeFileSync(join(ROOT(), 'images', 'filed.metadata.json'), JSON.stringify({ prompt: 'The Director at her desk' }));
    writeFileSync(join(ROOT(), 'images', 'other.metadata.json'), JSON.stringify({ prompt: 'A mountain lake' }));
    seedVideoHistory([{ id: 'director-clip', filename: 'director-clip.mp4', prompt: 'The director turns', createdAt: '2026-01-03T00:00:00Z' }]);
    await addTake(sceneA.sceneId, { kind: 'image', assetId: 'filed.png', source: 'generated' });

    const found = await request(app).get(`${base()}/media-pool/library?q=${encodeURIComponent('director')}`);
    expect(found.body.items.map((item) => `${item.kind}:${item.assetId}`)).toEqual(['video:director-clip', 'image:sheet.png']);
    expect((await request(app).get(`${base()}/media-pool/library?q=`)).status).toBe(400);

    const added = await request(app).post(`${base()}/media-pool/add`).send({ items: found.body.items.map(({ kind, assetId }) => ({ kind, assetId })) });
    expect(added.body.added).toBe(2);
    expect(added.body.items.map((item) => item.assetId).sort()).toEqual(['director-clip', 'filed.png', 'sheet.png']);
    expect((await request(app).get(`${base()}/media-pool/library?q=director`)).body.items).toEqual([]);
    expect((await request(app).post(`${base()}/media-pool/add`).send({ items: [{ kind: 'image', assetId: 'missing.png' }] })).status).toBe(400);
  });
});

import { afterAll, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { imageTreatmentDefaults } from '../lib/musicVideo/musicVideoImageTreatments.js';
import { captureMusicVideoEvidence, captureTakeDependencies, musicVideoDependencyChanges } from '../lib/musicVideo/musicVideoDependencies.js';

vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-image-treatments-'),
}));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
const { PATHS } = await import('../lib/paths.js');
const { default: sceneRoutes } = await import('./musicVideoScenes.js');
const { createProject, getStoredProjectRecord } = await import('../services/musicVideo/projects.js');
const { resolveSceneClips } = await import('../services/musicVideo/renderPlan.js');
const { resolveSceneMedia } = await import('../services/musicVideo/documentRender.js');
const { applyMusicVideoSubmissionGuards } = await import('../services/musicVideo/submissionGuards.js');
const app = express();
app.use(express.json());
app.use('/api/music-video', sceneRoutes);
app.use(errorMiddleware);
afterAll(cleanupTempDataRoots);

const photo = (background) => sharp({ create: { width: 640, height: 360, channels: 3, background } }).png().toBuffer();
const preview = (url, t) => `${url}/image-treatment?${new URLSearchParams({ treatment: JSON.stringify(t) })}`;

it('uses the same treated pixels in live previews, still/sequence render inputs and video conditioning without touching the originals', async () => {
  const dark = await photo('#191919');
  const other = await photo('#224466');
  await mkdir(PATHS.images, { recursive: true });
  await writeFile(join(PATHS.images, 'a.png'), dark);
  await writeFile(join(PATHS.images, 'b.png'), other);
  const project = await createProject({ name: 'Image Treatments synthetic fixture' });
  const root = `/api/music-video/${project.id}/scenes`;
  const scene = (await request(app).post(root).send({
    label: 'Snapshots', visualLayer: 'still', startSec: 0, endSec: 2,
    photoSequence: { imageIds: ['a.png', 'b.png'], intervalFrames: 8 },
  })).body;
  const url = `${root}/${scene.sceneId}`;
  await request(app).patch(url).send({ referenceImageId: 'a.png', endImageId: 'b.png' });
  const before = await getStoredProjectRecord(project.id);
  const first = { ...imageTreatmentDefaults('quartz', 'a.png'), date: '1985-11-02' };
  const second = { ...imageTreatmentDefaults('print', 'b.png'), date: '1985-11-04' };
  const draft = await request(app).get(preview(url, first));
  expect(draft.status).toBe(200);
  expect(draft.headers['content-type']).toContain('image/png');
  expect((await getStoredProjectRecord(project.id)).scenes[0].imageTreatments).toBeUndefined();
  expect((await request(app).patch(url).send({ imageTreatments: [first, second] })).status).toBe(200);
  const saved = await getStoredProjectRecord(project.id);
  const shot = saved.scenes[0];
  expect(shot.imageTreatments).toEqual([first, second]);
  expect(musicVideoDependencyChanges(saved, captureMusicVideoEvidence(before)).length).toBeGreaterThan(0);
  expect(musicVideoDependencyChanges(saved, captureTakeDependencies(before.scenes[0], 'a.png', 'b.png')).map(r => r.role)).toEqual(['plate', 'endPlate']);

  const [clip] = await resolveSceneClips(saved, { layered: true });
  const media = (await resolveSceneMedia(saved, { strictLayers: true })).get(scene.sceneId);
  expect(clip.photoPaths).toEqual(media.photos.map(item => item.path));
  expect(clip.photoPaths.every(path => path.startsWith(PATHS.imageRefs))).toBe(true);
  expect((await readFile(clip.photoPaths[0])).equals(dark)).toBe(false);
  expect((await readFile(clip.photoPaths[1])).equals(other)).toBe(false);
  expect(await sharp(clip.photoPaths[1]).metadata()).toMatchObject({ width: 640, height: 360 });
  const originalA = join(PATHS.images, 'a.png');
  const originalB = join(PATHS.images, 'b.png');
  const inputs = { prompt: 'Hold still', sourceImagePath: originalA, lastImagePath: originalB, icReferencePaths: [originalB],
    remoteMedia: { inputAssets: [{ role: 'sourceImage', path: 'a.png' }, { role: 'lastImage', path: 'b.png' }] } };
  await applyMusicVideoSubmissionGuards({
    body: { musicVideo: { projectId: project.id, sceneId: scene.sceneId }, lastImageFile: 'b.png' },
    params: inputs, prepared: { sourceImagePath: originalA }, backend: 'remote',
  });
  expect(inputs.musicVideoDependencies.references.map(ref => ref.assetId)).toEqual(['a.png', 'b.png']);
  expect(inputs.sourceImagePath).toBe(clip.photoPaths[0]);
  expect(inputs.lastImagePath).toBe(clip.photoPaths[1]);
  expect(inputs.icReferencePaths).toEqual([clip.photoPaths[1]]);
  expect(inputs.remoteMedia.inputAssets.map(asset => asset.path)).toEqual(clip.photoPaths);

  expect((await request(app).get(preview(url, { ...first, imageId: 'out-of-shot.png' }))).status).toBe(404);
  expect((await request(app).get(preview(url, { ...first, imageId: '../a.png' }))).status).toBe(400);
  expect((await request(app).patch(url).send({ imageTreatments: [{ ...first, date: '1985-02-29' }] })).status).toBe(400);
  expect((await request(app).patch(url).send({ imageTreatments: [first, first] })).status).toBe(400);

  expect((await request(app).patch(url).send({ imageTreatments: [] })).status).toBe(200);
  const [restored] = await resolveSceneClips(await getStoredProjectRecord(project.id), { layered: true });
  expect(restored.photoPaths).toEqual([originalA, originalB]);
  expect(await readFile(originalA)).toEqual(dark);
  expect(await readFile(originalB)).toEqual(other);
});

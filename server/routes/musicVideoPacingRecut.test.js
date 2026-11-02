/** Public-boundary regression: a previewed board-wide re-cut persists once,
 * keeps original first-piece media and refuses stale or impossible plans. */
import { it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-pacing-recut-');
vi.mock('../lib/paths.js', async (load) => makePathsProxy(await load(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
const { default: routes } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const app = express();
app.use(express.json());
app.use('/api/music-video', routes);
app.use(errorMiddleware);
let project;
beforeEach(async () => {
  rmSync(join(ROOT(), 'music-video-projects.json'), { force: true });
  mkdirSync(join(ROOT(), 'images'), { recursive: true });
  writeFileSync(join(ROOT(), 'images', 'person.png'), 'png');
  writeFileSync(join(ROOT(), 'video-history.json'), JSON.stringify([{ id: 'clip-parent', filename: 'parent.mp4' }]));
  project = await projects.createProject({ name: 'Example video', pacing: { minShotSec: 1, maxShotSec: 3 } });
  await projects.setProjectAnalysis(project.id, { bpm: 120, durationSec: 13, beats: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], downbeats: [3, 5, 10], sections: [] });
  await projects.updateProject(project.id, { lyricCues: [{ text: 'A new line', startSec: 2.5, endSec: 4 }] });
});
afterAll(cleanupTempDataRoots);
const endpoint = () => `/api/music-video/${project.id}/pacing-recut`;
const preview = () => request(app).get(endpoint());
const apply = (revision) => request(app).post(endpoint()).send({ revision });

it('previews and re-cuts every long shot, preferring a lyric start to a downbeat and preserving first-piece media', async () => {
  const first = await projects.addProjectScene(project.id, { label: 'Verse', prompt: 'Walk through the room', framePrompt: 'The room', startSec: 0, endSec: 8 });
  const second = await projects.addProjectScene(project.id, { label: 'Chorus', prompt: 'Sing', startSec: 8, endSec: 13, shotMode: 'performance' });
  const untimed = await projects.addProjectScene(project.id, { label: 'Untimed', prompt: 'Unchanged' });
  for (const scene of [first, second]) await projects.updateScene(project.id, scene.sceneId, { referenceImageId: 'person.png', videoHistoryId: 'clip-parent' });
  const before = await projects.getProject(project.id);
  const proposal = await preview();
  expect(proposal.status).toBe(200);
  expect(proposal.body).toMatchObject({ minSec: 1, maxSec: 3, total: 3, added: 3, skipped: [{ sceneId: untimed.sceneId }] });
  expect(proposal.body.changes[0].pieces).toEqual([
    { startSec: 0, endSec: 2.5, cut: 'lyric' }, { startSec: 2.5, endSec: 5, cut: 'downbeat' }, { startSec: 5, endSec: 8, cut: null },
  ]);
  expect(await projects.getProject(project.id)).toEqual(before);
  const saved = await apply(proposal.body.revision);
  expect(saved.status).toBe(200);
  expect(saved.body.added).toBe(3);
  const scenes = (await projects.getProject(project.id)).scenes;
  expect(scenes).toHaveLength(6);
  expect(scenes[0]).toMatchObject({ sceneId: first.sceneId, referenceImageId: 'person.png', videoHistoryId: 'clip-parent', prompt: first.prompt });
  expect(scenes[3]).toMatchObject({ sceneId: second.sceneId, referenceImageId: 'person.png', videoHistoryId: 'clip-parent' });
  expect(scenes[5]).toEqual({ ...before.scenes[2], order: 5 });
  for (const [i, scene] of scenes.slice(0, 5).entries()) {
    expect(scene.beatAligned).toBe(true);
    expect(scene.endSec - scene.startSec).toBeGreaterThanOrEqual(1);
    expect(scene.endSec - scene.startSec).toBeLessThanOrEqual(3);
    if (i) expect(scene.startSec).toBe(scenes[i - 1].endSec);
  }
  for (const scene of [scenes[1], scenes[2], scenes[4]]) {
    expect(scene).toMatchObject({ beatNeedsReview: true, referenceImageId: 'person.png', videoHistoryId: null });
    expect(scene.prompt).toBe(scene.order < 3 ? first.prompt : second.prompt);
    expect(scene.takes.some((take) => take.kind === 'video')).toBe(false);
  }
  const cleared = await request(app).patch(`/api/music-video/${project.id}/scenes/${scenes[1].sceneId}`).send({ beatNeedsReview: false });
  expect(cleared.status).toBe(200);
  expect((await projects.getProject(project.id)).scenes[1].beatNeedsReview).toBe(false);
  expect((await apply(proposal.body.revision)).status).toBe(409);
});

it('rejects a stale preview and malformed input without changing the edited project', async () => {
  await projects.addProjectScene(project.id, { label: 'Verse', startSec: 0, endSec: 8 });
  const proposal = await preview();
  await projects.updateProject(project.id, { name: 'Edited after preview' });
  const before = await projects.getProject(project.id);
  expect((await apply(proposal.body.revision)).body.code).toBe('MUSIC_VIDEO_PACING_CHANGED');
  expect((await apply('not-a-revision')).status).toBe(400);
  expect(await projects.getProject(project.id)).toEqual(before);
});

it('refuses impossible minimums, requires a pacing ceiling and leaves cold-open shots untouched', async () => {
  await projects.addProjectScene(project.id, { label: 'Song shot', startSec: 0, endSec: 3.5 });
  await projects.addProjectScene(project.id, { label: 'Cold open', preMusic: { durationSec: 10 } });
  await projects.updateProject(project.id, { pacing: { minShotSec: 2, maxShotSec: 3 } });
  const before = await projects.getProject(project.id);
  expect((await preview()).body.code).toBe('MUSIC_VIDEO_PACING_IMPOSSIBLE');
  expect(await projects.getProject(project.id)).toEqual(before);
  await projects.updateProject(project.id, { pacing: null });
  expect((await preview()).body.code).toBe('MUSIC_VIDEO_PACING_REQUIRED');
  await projects.updateProject(project.id, { pacing: { minShotSec: 1, maxShotSec: 4 } });
  expect((await preview()).body).toMatchObject({ changes: [], added: 0 });
});

it('reserves the minimum for every remaining piece even when a later lyric cut is tempting', async () => {
  await projects.updateProject(project.id, { pacing: { minShotSec: 1, maxShotSec: 1.5 }, lyricCues: [{ text: 'Tempting cut', startSec: 1.5, endSec: 2 }] });
  await projects.addProjectScene(project.id, { label: 'Short verse', startSec: 0, endSec: 3.1 });
  const proposal = await preview();
  expect(proposal.status).toBe(200);
  const pieces = proposal.body.changes[0].pieces;
  expect(pieces).toHaveLength(3);
  expect(pieces[0].endSec).toBe(1);
  for (const piece of pieces) {
    expect(piece.endSec - piece.startSec).toBeGreaterThanOrEqual(1 - 1e-6);
    expect(piece.endSec - piece.startSec).toBeLessThanOrEqual(1.5 + 1e-6);
  }
  expect((await apply(proposal.body.revision)).status).toBe(200);
});

it('refuses composition-source projects whose actual rendered cuts are not board records', async () => {
  await projects.addProjectScene(project.id, { startSec: 0, endSec: 8 });
  await projects.updateProject(project.id, { composition: { mode: 'document' } });
  const before = await projects.getProject(project.id);
  expect((await preview()).body.code).toBe('MUSIC_VIDEO_PACING_COMPOSITION');
  expect(await projects.getProject(project.id)).toEqual(before);
});

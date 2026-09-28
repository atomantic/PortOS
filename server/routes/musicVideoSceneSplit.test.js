/**
 * Music Video scene split route (#8977), through the real router and the real
 * file-backed project store: an over-long performance shot (fal lip-sync) and
 * an over-long Grok cutaway become contiguous scenes cut on lyric boundaries,
 * the original keeps its id and takes, new pieces carry the direction and the
 * selected frame but no clip, and a shot that fits one take is refused.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-split-route-test-');
vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const { default: musicVideoRoutes } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');

const app = express();
app.use(express.json());
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);

const LYRICS = [
  { text: 'first line', startSec: 30, endSec: 37 },
  { text: 'second line', startSec: 39, endSec: 46 },
  { text: 'third line', startSec: 47.5, endSec: 55 },
];

let project;
beforeEach(async () => {
  rmSync(join(ROOT(), 'music-video-projects.json'), { force: true });
  mkdirSync(join(ROOT(), 'images'), { recursive: true });
  writeFileSync(join(ROOT(), 'images', 'singer.png'), 'png-bytes');
  writeFileSync(join(ROOT(), 'video-history.json'), JSON.stringify([]));
  project = await projects.createProject({ name: 'Example Video' });
  await projects.updateProject(project.id, { lyricCues: LYRICS, videoSettings: { backend: 'fal' } });
});
afterAll(cleanupTempDataRoots);

const split = (sceneId, body = {}) => request(app).post(`/api/music-video/${project.id}/scenes/${sceneId}/split`).send(body);

describe('POST /:id/scenes/:sceneId/split', () => {
  it('splits an over-long performance shot at the lyric pauses, keeping the original id, takes and neighbours', async () => {
    const before = await projects.addProjectScene(project.id, { label: 'Intro', startSec: 0, endSec: 30 });
    const shot = await projects.addProjectScene(project.id, {
      label: 'Verse', prompt: 'singer at the mic', startSec: 30, endSec: 56, shotMode: 'performance', loop: false,
    });
    const after = await projects.addProjectScene(project.id, { label: 'Outro', startSec: 56, endSec: 70 });
    await projects.updateScene(project.id, shot.sceneId, { referenceImageId: 'singer.png', videoHistoryId: 'clip-whole-verse' });

    // No backend in the body: the project's pinned fal lane bounds the take.
    const res = await split(shot.sceneId);
    expect(res.status).toBe(200);
    const pieces = res.body.scenes;
    // 26s over a ~14.75s lip-sync window fits two takes, but any two-way cut
    // lands inside "second line" — so it takes a third and cuts in both pauses.
    expect(pieces.map((p) => [p.startSec, p.endSec])).toEqual([[30, 38], [38, 46.75], [46.75, 56]]);
    expect(pieces[0].sceneId).toBe(shot.sceneId);
    expect(pieces.map((p) => p.label)).toEqual(['Verse · 1/3', 'Verse · 2/3', 'Verse · 3/3']);
    expect(pieces.map((p) => p.lyricText)).toEqual(['first line', 'second line', 'third line']);
    expect(pieces[1]).toMatchObject({ shotMode: 'performance', prompt: 'singer at the mic', loop: false, referenceImageId: 'singer.png', videoHistoryId: null });
    expect(pieces[1].takes.map((t) => [t.kind, t.assetId])).toEqual([['image', 'singer.png']]);

    const stored = await projects.getProject(project.id);
    expect(stored.scenes.map((s) => [s.sceneId, s.order])).toEqual([
      [before.sceneId, 0], [shot.sceneId, 1], [pieces[1].sceneId, 2], [pieces[2].sceneId, 3], [after.sceneId, 4],
    ]);
    // The lip-synced clip was generated for 30–56s: it stays a candidate take
    // but is no longer selected, so the render never re-cuts it.
    expect(stored.scenes[1].videoHistoryId).toBeNull();
    expect(stored.scenes[1].takes.map((t) => t.assetId)).toEqual(['singer.png', 'clip-whole-verse']);
  });

  it('splits a Grok cutaway at its 10-second clip limit when the director renders on Grok', async () => {
    const shot = await projects.addProjectScene(project.id, { label: 'Bridge', startSec: 30, endSec: 55 });
    await projects.updateScene(project.id, shot.sceneId, { videoHistoryId: 'clip-bridge' });
    const res = await split(shot.sceneId, { backend: 'grok' });
    expect(res.status).toBe(200);
    const pieces = res.body.scenes;
    // A cutaway clip still starts where the first piece does: it stays selected.
    expect(pieces.map((p) => p.videoHistoryId)).toEqual(['clip-bridge', null, null]);
    expect(pieces).toHaveLength(3);
    for (const p of pieces) expect(p.endSec - p.startSec).toBeLessThanOrEqual(10);
    expect(pieces[0].startSec).toBe(30);
    expect(pieces.at(-1).endSec).toBe(55);
  });

  it('refuses a shot that fits one take, a lane with no per-take limit, a bad backend and an unknown scene', async () => {
    const fits = await projects.addProjectScene(project.id, { startSec: 30, endSec: 40, shotMode: 'performance' });
    expect((await split(fits.sceneId)).body.code).toBe('MUSIC_VIDEO_SPLIT_NOT_NEEDED');
    const cutaway = await projects.addProjectScene(project.id, { startSec: 0, endSec: 60 });
    const unbounded = await split(cutaway.sceneId);
    expect(unbounded.status).toBe(400);
    expect(unbounded.body.code).toBe('MUSIC_VIDEO_SPLIT_NOT_NEEDED');
    expect((await split(cutaway.sceneId, { backend: 'sora' })).status).toBe(400);
    expect((await split('mvs-missing')).status).toBe(404);
    expect((await projects.getProject(project.id)).scenes).toHaveLength(2);
  });
});

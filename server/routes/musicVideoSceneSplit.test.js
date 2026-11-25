/**
 * Music Video scene split route (#8977), through the real router and the real
 * file-backed project store: an over-long performance shot (fal lip-sync) and
 * an over-long Grok cutaway become contiguous scenes cut on lyric boundaries,
 * the original keeps its id and takes, new pieces carry the direction and the
 * selected frame but no clip, and a shot that fits one take is refused.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
  { text: 'first line', startSec: 30, endSec: 45 },
  { text: 'second line', startSec: 47, endSec: 68 },
  { text: 'third line', startSec: 70, endSec: 85 },
];

let project;
beforeEach(async () => {
  rmSync(join(ROOT(), 'music-video-projects.json'), { force: true });
  mkdirSync(join(ROOT(), 'images'), { recursive: true });
  writeFileSync(join(ROOT(), 'images', 'singer.png'), 'png-bytes');
  writeFileSync(join(ROOT(), 'video-history.json'), JSON.stringify(['clip-whole-verse', 'clip-bridge'].map(id => ({ id, filename: `${id}.mp4` }))));
  project = await projects.createProject({ name: 'Example Video' });
  await projects.updateProject(project.id, { lyricCues: LYRICS, videoSettings: { backend: 'fal' } });
});
afterAll(cleanupTempDataRoots);

const split = (sceneId, body = {}) => request(app).post(`/api/music-video/${project.id}/scenes/${sceneId}/split`).send(body);
const readiness = async () => {
  const res = await request(app).get(`/api/music-video/${project.id}/production-review/readiness`);
  expect(res.status).toBe(200);
  return res.body.readiness;
};

const approver = { approvedAt: '2026-01-01T00:00:00.000Z', approvedBy: 'director', reviewer: { model: 'example' } };
async function approveBoardFixture() {
  const { productionReviewBasis } = await import('../services/musicVideo/productionReview.js');
  await projects.mutateProjectRecord(project.id, (current) => {
    const basis = productionReviewBasis(current);
    return { project: { ...current, productionReview: { ...current.productionReview, approvals: { storyboard: {
      ...approver, stage: 'storyboard', basis: basis.storyboard, shotsBasis: basis.storyboardShots,
      values: Object.fromEntries(current.scenes.map((_, i) => [`scene ${i + 1} still direction`, 'Example storyboard direction. '.repeat(80)])),
    } } } } };
  });
}

describe('POST /:id/scenes/:sceneId/split', () => {
  it('splits an over-long performance shot at the lyric pauses, keeping the original id, takes and neighbours', async () => {
    const before = await projects.addProjectScene(project.id, { label: 'Intro', startSec: 0, endSec: 30 });
    const shot = await projects.addProjectScene(project.id, {
      label: 'Verse', prompt: 'singer at the mic', startSec: 30, endSec: 86, shotMode: 'performance', performanceSpeaker: 'Example Singer', loop: false,
    });
    const after = await projects.addProjectScene(project.id, { label: 'Outro', startSec: 86, endSec: 100 });
    await projects.updateScene(project.id, shot.sceneId, { referenceImageId: 'singer.png', videoHistoryId: 'clip-whole-verse' });

    // No backend in the body: the project's pinned fal lane bounds the take.
    const res = await split(shot.sceneId);
    expect(res.status).toBe(200);
    const pieces = res.body.scenes;
    // 56s over the ~29.95s lip-sync take fits two takes, but any two-way cut
    // lands inside "second line" — so it takes a third and cuts in both pauses.
    expect(pieces.map((p) => [p.startSec, p.endSec])).toEqual([[30, 46], [46, 69], [69, 86]]);
    expect(pieces[0].sceneId).toBe(shot.sceneId);
    expect(pieces.map((p) => p.label)).toEqual(['Verse · 1/3', 'Verse · 2/3', 'Verse · 3/3']);
    expect(pieces.map((p) => p.lyricText)).toEqual(['first line', 'second line', 'third line']);
    expect(pieces[1]).toMatchObject({ shotMode: 'performance', performanceSpeaker: 'Example Singer', prompt: 'singer at the mic', loop: false, referenceImageId: 'singer.png', videoHistoryId: null });
    expect(pieces[1].takes.map((t) => [t.kind, t.assetId])).toEqual([['image', 'singer.png']]);

    const stored = await projects.getProject(project.id);
    expect(stored.scenes.map((s) => [s.sceneId, s.order])).toEqual([
      [before.sceneId, 0], [shot.sceneId, 1], [pieces[1].sceneId, 2], [pieces[2].sceneId, 3], [after.sceneId, 4],
    ]);
    // The lip-synced clip was generated for 30–86s: it stays a candidate take
    // but is no longer selected, so the render never re-cuts it.
    expect(stored.scenes[1].videoHistoryId).toBeNull();
    expect(stored.scenes[1].takes.map((t) => t.assetId)).toEqual(['singer.png', 'clip-whole-verse']);
  });

  it('splits a Grok cutaway at its 15-second clip limit when the director renders on Grok', async () => {
    const shot = await projects.addProjectScene(project.id, { label: 'Bridge', startSec: 30, endSec: 70 });
    await projects.updateScene(project.id, shot.sceneId, { videoHistoryId: 'clip-bridge' });
    const res = await split(shot.sceneId, { backend: 'grok' });
    expect(res.status).toBe(200);
    const pieces = res.body.scenes;
    // A cutaway clip still starts where the first piece does: it stays selected.
    expect(pieces.map((p) => p.videoHistoryId)).toEqual(['clip-bridge', null, null]);
    expect(pieces).toHaveLength(3);
    for (const p of pieces) expect(p.endSec - p.startSec).toBeLessThanOrEqual(15);
    expect(pieces[0].startSec).toBe(30);
    expect(pieces.at(-1).endSec).toBe(70);
  });

  it('gives a sung line held across an unavoidable cut to both pieces', async () => {
    await projects.updateProject(project.id, { lyricCues: [{ text: 'held note', startSec: 30, endSec: 50 }] });
    const shot = await projects.addProjectScene(project.id, { startSec: 30, endSec: 50 });
    const res = await split(shot.sceneId, { backend: 'grok' });
    expect(res.body.scenes.map((p) => [p.startSec, p.endSec, p.lyricText])).toEqual([[30, 40, 'held note'], [40, 50, 'held note']]);
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

  // Uniquely catches a cut at a chosen time losing the director's still locks, or a new mid-song shot landing at the end of the board.
  it('cuts a shot in two at a chosen time, keeping its still locked on both pieces and the board in song order', async () => {
    const { shotLocks } = await import('../services/musicVideo/productionReview.js');
    const intro = await projects.addProjectScene(project.id, { label: 'Intro', startSec: 0, endSec: 10, prompt: 'Wide room' });
    const outro = await projects.addProjectScene(project.id, { label: 'Outro', startSec: 20, endSec: 30, prompt: 'Door' });
    // Added after the outro but timed between the two: it goes in between.
    const middle = await projects.addProjectScene(project.id, { label: 'Middle', startSec: 10, endSec: 20, prompt: 'Close-up' });
    expect((await projects.getProject(project.id)).scenes.map((s) => [s.sceneId, s.order])).toEqual([[intro.sceneId, 0], [middle.sceneId, 1], [outro.sceneId, 2]]);
    await projects.updateScene(project.id, middle.sceneId, { referenceImageId: 'singer.png' });
    // A board approved before lock removal reads every shot it covers as locked.
    await approveBoardFixture();
    expect((await readiness()).storyboard.shotLocks).toEqual(Object.fromEntries([intro, middle, outro].map(s => [s.sceneId, 'locked'])));
    const before = (await projects.getProject(project.id)).productionReview;
    expect(before.shotApprovals).toBeUndefined();

    expect((await split(middle.sceneId, { atSec: 25 })).body.code).toBe('MUSIC_VIDEO_SPLIT_OUT_OF_RANGE');
    const res = await split(middle.sceneId, { atSec: 13.5 });
    expect(res.status).toBe(200);
    const [first, second] = res.body.scenes;
    expect([first.sceneId, first.startSec, first.endSec, second.startSec, second.endSec]).toEqual([middle.sceneId, 10, 13.5, 13.5, 20]);
    expect(second).toMatchObject({ prompt: 'Close-up', referenceImageId: 'singer.png', videoHistoryId: null });
    const review = (await projects.getProject(project.id)).productionReview;
    expect(Buffer.byteLength(JSON.stringify(review)) - Buffer.byteLength(JSON.stringify(before))).toBeLessThan(1024 * res.body.edit.sceneIds.length);
    expect(Object.keys(review.shotApprovals)).toHaveLength(4);
    for (const approval of Object.values(review.shotApprovals)) {
      expect(approval).toMatchObject({ ...approver, fromBoardApproval: true, basis: expect.any(String), v: 2 });
      expect(approval).not.toHaveProperty('shotsBasis');
      expect(approval).not.toHaveProperty('values');
    }

    // A shot added after the split, mid-song, keeps every lock in place.
    const insert = await projects.addProjectScene(project.id, { label: 'Insert', startSec: 5, endSec: 6 });
    const stored = await projects.getProject(project.id);
    expect(stored.scenes.map((s) => s.sceneId)).toEqual([intro.sceneId, insert.sceneId, middle.sceneId, second.sceneId, outro.sceneId]);
    expect(stored.scenes.map((s) => s.order)).toEqual([0, 1, 2, 3, 4]);
    const locks = shotLocks(stored);
    expect([locks[intro.sceneId], locks[middle.sceneId], locks[second.sceneId], locks[outro.sceneId], locks[insert.sceneId]])
      .toEqual(['locked', 'locked', 'locked', 'locked', 'open']);
  });

  it('opens the new piece when its borrowed still is replaced, while an original shot reads changed', async () => {
    const shot = await projects.addProjectScene(project.id, { startSec: 0, endSec: 10 });
    await projects.updateScene(project.id, shot.sceneId, { referenceImageId: 'singer.png' });
    await approveBoardFixture();
    const cut = await split(shot.sceneId, { atSec: 5 });
    expect(cut.status).toBe(200);
    const [, piece] = cut.body.scenes;
    expect((await readiness()).storyboard.shotLocks).toEqual({ [shot.sceneId]: 'locked', [piece.sceneId]: 'locked' });

    writeFileSync(join(ROOT(), 'images', 'replacement.png'), 'png-bytes');
    for (const sceneId of [piece.sceneId, shot.sceneId]) {
      const edit = await request(app).patch(`/api/music-video/${project.id}/scenes/${sceneId}`).send({ referenceImageId: 'replacement.png' });
      expect(edit.status).toBe(200);
    }
    expect((await readiness()).storyboard.shotLocks).toEqual({ [shot.sceneId]: 'changed', [piece.sceneId]: 'open' });
  });

  it('compacts persisted legacy board-derived locks on the next write while retaining their lock states', async () => {
    const shot = await projects.addProjectScene(project.id, { startSec: 0, endSec: 10, prompt: 'Original direction' });
    await approveBoardFixture();
    const cut = await split(shot.sceneId, { atSec: 5 });
    expect(cut.status).toBe(200);
    const [, piece] = cut.body.scenes;
    const file = join(ROOT(), 'music-video-projects.json');
    const records = JSON.parse(readFileSync(file, 'utf8'));
    const review = records.find(record => record.id === project.id).productionReview;
    const board = review.approvals.storyboard;
    const compact = { ...approver, fromBoardApproval: true, v: 2 };
    for (const [id, approval] of Object.entries(review.shotApprovals)) {
      // Older splits copied the board approval and knew nothing about borrowed stills.
      review.shotApprovals[id] = { ...board, ...compact, basis: id === piece.sceneId ? 'stale-basis' : approval.basis };
    }
    writeFileSync(file, JSON.stringify(records));

    const states = { [shot.sceneId]: 'locked', [piece.sceneId]: 'changed' };
    expect((await readiness()).storyboard.shotLocks).toEqual(states);
    const edit = await request(app).patch(`/api/music-video/${project.id}/scenes/${shot.sceneId}`).send({ label: 'Renamed shot' });
    expect(edit.status).toBe(200);
    expect((await readiness()).storyboard.shotLocks).toEqual(states);
    const saved = JSON.parse(readFileSync(file, 'utf8')).find(record => record.id === project.id).productionReview;
    expect(saved.shotApprovals).toEqual({
      [shot.sceneId]: { ...compact, basis: review.shotApprovals[shot.sceneId].basis },
      [piece.sceneId]: { ...compact, basis: 'stale-basis' },
    });
    expect(saved.approvals.storyboard.values).toEqual(board.values);
  });
});

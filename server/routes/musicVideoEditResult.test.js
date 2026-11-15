/**
 * Board edit replies (#16247), through the real router and the real file-backed store: every edit
 * route answers with an edit result instead of the whole project, and that result folded into the
 * record `GET /:id` returned before the edit (by the client's own reducer) equals what `GET /:id`
 * returns after it, take staleness and readiness included. The change broadcast names the asking tab.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
import { applyMusicVideoEdit } from '../lib/musicVideoEditResult.js';

const ROOT = () => lazyTempDataRoot('mv-edit-result-');
vi.mock('../lib/paths.js', async (original) => makePathsProxy(await original(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
const { default: router } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const { recordEvents } = await import('../services/sharing/recordEvents.js');
const { productionReviewBasis } = await import('../services/musicVideo/productionReview.js');

const app = express();
app.use(express.json());
app.use('/api/music-video', router);
app.use(errorMiddleware);

let project;
const base = () => `/api/music-video/${project.id}`;
const read = async () => (await request(app).get(base())).body;

beforeEach(async () => {
  mkdirSync(join(ROOT(), 'images'), { recursive: true });
  for (const image of ['a.png', 'b.png', 'c.png', 'spare.png']) writeFileSync(join(ROOT(), 'images', image), 'synthetic-image');
  writeFileSync(join(ROOT(), 'video-history.json'), JSON.stringify(['clip-a', 'clip-b', 'clip-c'].map((id) => ({ id, filename: `${id}.mp4` }))));
  project = await projects.createProject({ name: 'Example edit project' });
  await projects.updateProject(project.id, {
    audioAnalysis: { durationSec: 15, bpm: 120, beats: [], sections: [] },
    scenes: ['a', 'b', 'c'].map((id, i) => ({ sceneId: id, label: `Shot ${i + 1}`, startSec: i * 5, endSec: i * 5 + 5, framePrompt: `Frame ${id}`, visualLayer: 'footage', takes: [] })),
  });
  for (const id of ['a', 'b', 'c']) {
    await request(app).post(`${base()}/scenes/${id}/takes`).send({ kind: 'image', assetId: `${id}.png`, source: 'generated' });
    await request(app).post(`${base()}/scenes/${id}/takes`).send({ kind: 'video', assetId: `clip-${id}`, sourceImageId: `${id}.png`, source: 'generated' });
  }
  // An unused still in the project's pool, for "Swap from unused".
  await request(app).post(`${base()}/scenes/b/takes`).send({ kind: 'image', assetId: 'spare.png', source: 'imported' });
});
afterAll(cleanupTempDataRoots);

// The edit's reply, folded into the read before it, is the read after it.
async function expectReloadParity(send) {
  const before = await read();
  const reply = await send();
  expect(reply.status).toBe(200);
  expect(reply.body).not.toHaveProperty('project');
  expect(reply.body.edit).toMatchObject({ sceneIds: expect.any(Array), scenes: expect.any(Array), project: expect.any(Object), removed: expect.any(Array) });
  const after = await read();
  expect(applyMusicVideoEdit(before, reply.body.edit)).toEqual(after);
  return { before, after, reply: reply.body };
}

describe('board edit replies carry what a reload would show', () => {
  it('a prompt edit sends only that shot, with its frame take now stale', async () => {
    const { reply, after } = await expectReloadParity(() => request(app).patch(`${base()}/scenes/a`).send({ framePrompt: 'Frame a, rewritten' }));
    expect(reply.framePrompt).toBe('Frame a, rewritten');
    expect(reply.edit.scenes.map((scene) => scene.sceneId)).toEqual(['a']);
    const frame = reply.edit.scenes[0].takes.find((take) => take.assetId === 'a.png');
    expect(frame.dependencyState).toMatchObject({ status: 'stale', reasons: expect.arrayContaining(['Frame prompt changed']) });
    expect(reply.edit.updatedAt).toBe(after.updatedAt);
  });

  // Uniquely catches a reply that leaves the board showing an approval the edit invalidated.
  it('reports the storyboard approval an edit carried over or staled', async () => {
    await projects.mutateProjectRecord(project.id, (current) => ({ project: { ...current, productionReview: { ...current.productionReview,
      approvals: { ...current.productionReview?.approvals, storyboard: { basis: productionReviewBasis(current).storyboard, approvedAt: '2026-01-01T00:00:00.000Z' } } } } }));
    expect((await read()).productionReadiness.storyboard.stale).toBeNull();
    // Rewording a shot keeps the board the director approved: the approval moves to the new revision.
    const reworded = await expectReloadParity(() => request(app).patch(`${base()}/scenes/b`).send({ prompt: 'A different action' }));
    expect(reworded.reply.edit.project.productionReview.approvals.storyboard).toMatchObject({ carriedOver: { reason: 'Edited a shot' } });
    expect(reworded.reply.edit.project.productionReadiness.basis.storyboard).toBe(reworded.after.productionReadiness.basis.storyboard);
    // Re-timing the lyric a shot covers is a new board: the reply carries the stale approval.
    const relyric = await expectReloadParity(() => request(app).patch(`${base()}/scenes/b`).send({ lyricText: 'A new sung line' }));
    expect(relyric.after.productionReadiness.storyboard.stale).not.toBeNull();
    expect(relyric.reply.edit.project.productionReadiness.storyboard.stale).toEqual(relyric.after.productionReadiness.storyboard.stale);
  });

  it('moving a shot end moves the next shot start and sends both, not the project', async () => {
    const { reply } = await expectReloadParity(() => request(app).post(`${base()}/scenes/a/end`).send({ endSec: 6 }));
    expect(reply.scene).toMatchObject({ sceneId: 'a', endSec: 6 });
    expect(reply.next).toMatchObject({ sceneId: 'b', startSec: 6 });
    expect(reply.edit.scenes.map((scene) => scene.sceneId).sort()).toEqual(['a', 'b']);
  });

  it('moving a shot start ends the shot before it there', async () => {
    const { reply } = await expectReloadParity(() => request(app).post(`${base()}/scenes/c/start`).send({ startSec: 9 }));
    expect(reply.previous).toMatchObject({ sceneId: 'b', endSec: 9 });
  });

  it('split, merge, delete and reorder each fold into the reloaded board', async () => {
    const split = await expectReloadParity(() => request(app).post(`${base()}/scenes/a/split`).send({ atSec: 2.5 }));
    expect(split.reply.scenes).toHaveLength(2);
    expect(split.after.scenes).toHaveLength(4);
    const added = split.reply.scenes[1].sceneId;
    await expectReloadParity(() => request(app).post(`${base()}/scenes/a/merge-next`).send({}));
    await expectReloadParity(() => request(app).post(`${base()}/scenes/c/merge-previous`).send({}));
    const remaining = (await read()).scenes.map((scene) => scene.sceneId);
    expect(remaining).not.toContain(added);
    await expectReloadParity(() => request(app).post(`${base()}/scenes/reorder`).send({ sceneIds: [...remaining].reverse() }));
    const removed = await expectReloadParity(() => request(app).delete(`${base()}/scenes/${remaining[0]}`));
    expect(removed.reply.edit.sceneIds).not.toContain(remaining[0]);
  });

  it('vary wipes, swap from unused and the final approval tick fold in too', async () => {
    await expectReloadParity(() => request(app).post(`${base()}/scenes/vary-wipes`).send({ fromSceneId: 'a', count: 2, seed: 3 }));
    const swapped = await expectReloadParity(() => request(app).post(`${base()}/scenes/a/takes/use`).send({ kind: 'image', assetId: 'spare.png' }));
    expect(swapped.reply.scene.referenceImageId).toBe('spare.png');
    // The clip made from the old still is stale now, and the reply says so.
    const clip = swapped.reply.edit.scenes.find((scene) => scene.sceneId === 'a').takes.find((take) => take.assetId === 'clip-a');
    expect(clip.dependencyState.status).toBe('stale');
    const approved = await expectReloadParity(() => request(app).post(`${base()}/scenes/approve-final`).send({ sceneIds: ['b'], approved: true }));
    expect(approved.reply.counts).toMatchObject({ approved: 1 });
  });

  it('the change broadcast names the tab that asked, and only that one', async () => {
    const seen = [];
    const listen = (event) => { if (event.recordId === project.id) seen.push(event.origin ?? null); };
    recordEvents.on('updated', listen);
    await request(app).post(`${base()}/scenes/a/end`).set('X-PortOS-Origin', 'socket-example').send({ endSec: 6 });
    await request(app).patch(`${base()}/scenes/b`).send({ prompt: 'From somewhere else' });
    recordEvents.off('updated', listen);
    expect(seen).toEqual(['socket-example', null]);
  });
});

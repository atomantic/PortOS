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
import { applyMusicVideoEdit } from '../lib/musicVideo/musicVideoEditResult.js';

const ROOT = () => lazyTempDataRoot('mv-edit-result-');
vi.mock('../lib/paths.js', async (original) => makePathsProxy(await original(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
const { default: router } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const boardEdits = await import('../services/musicVideo/projectBoardEdits.js');
const { clearBoardUndo } = await import('../services/musicVideo/boardUndo.js');
const { recordEvents } = await import('../services/sharing/recordEvents.js');
const { productionReviewBasis } = await import('../services/musicVideo/productionReview.js');

const app = express();
app.use(express.json());
// A frame confirmation names its reviewer; with no instance password that is the local operator.
app.use((req, _res, next) => { req.portosAuthContext = { enabled: false }; next(); });
app.use('/api/music-video', router);
app.use(errorMiddleware);

let project;
const base = () => `/api/music-video/${project.id}`;
const read = async () => (await request(app).get(base())).body;

beforeEach(async () => {
  clearBoardUndo();
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
async function expectReloadParity(send, status = 200) {
  const before = await read();
  const reply = await send();
  expect(reply.status).toBe(status);
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

  // Uniquely catches an added shot whose reply is the bare scene, which forces the board to reload.
  it('adding a shot answers with the new shot and an edit that folds into the reloaded board', async () => {
    const before = await read();
    const reply = await request(app).post(`${base()}/scenes`).send({ prompt: 'A new shot' });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ prompt: 'A new shot', sceneId: expect.any(String) });
    expect(reply.body).not.toHaveProperty('project');
    expect(reply.body.edit.scenes.map((scene) => scene.sceneId)).toContain(reply.body.sceneId);
    expect(applyMusicVideoEdit(before, reply.body.edit)).toEqual(await read());
  });

  // Uniquely catches a project-level save that answers with the whole project when the tab asked for the edit result.
  it('a project field save asking for the edit result folds into the reloaded board; without asking it answers the project', async () => {
    const before = await read();
    const reply = await request(app).patch(`${base()}?edit=1`).send({ name: 'Renamed example', lyricOverlayEnabled: true });
    expect(reply.status).toBe(200);
    expect(reply.body).not.toHaveProperty('scenes');
    expect(reply.body.edit.project).toMatchObject({ name: 'Renamed example', lyricOverlayEnabled: true });
    expect(applyMusicVideoEdit(before, reply.body.edit)).toEqual(await read());
    const plain = await request(app).patch(base()).send({ name: 'Renamed again' });
    expect(plain.body).toMatchObject({ id: project.id, name: 'Renamed again' });
    expect(plain.body).not.toHaveProperty('edit');
  });

  // A cast change is a project save like any other: it answers the edit result too, folded in like a reload.
  it('a project save that changes the cast answers the edit result when it was asked for', async () => {
    const { after } = await expectReloadParity(() => request(app).patch(`${base()}?edit=1`).send({ concept: { subjects: [{ id: 'subject-a', kind: 'character', name: 'Alice', description: 'Example' }] } }));
    expect(after.concept.subjects).toHaveLength(1);
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

  // Uniquely catches a take decision whose reply leaves readiness or neighbour staleness as it was.
  it('each take decision folds into the reloaded board', async () => {
    const takes = (await read()).scenes.find((scene) => scene.sceneId === 'b').takes;
    const spare = takes.find((take) => take.assetId === 'spare.png');
    const selected = await expectReloadParity(() => request(app).post(`${base()}/scenes/b/takes/${spare.takeId}/select`).send({}));
    expect(selected.reply.referenceImageId).toBe('spare.png');
    const reviewed = await expectReloadParity(() => request(app).patch(`${base()}/scenes/b/takes/${spare.takeId}`).send({ note: 'Example note' }));
    expect(reviewed.reply.edit.sceneIds).toEqual(['a', 'b', 'c']);
    await request(app).patch(`${base()}/scenes/b`).send({ endImageId: 'c.png' });
    await expectReloadParity(() => request(app).post(`${base()}/scenes/b/swap-frames`).send({}));
    await expectReloadParity(() => request(app).post(`${base()}/scenes/b/takes/reject-unused`).send({}));
    const marked = await expectReloadParity(() => request(app).patch(`${base()}/media-pool/marks`).send({ items: [{ kind: 'image', assetId: 'c.png' }], mark: 'bad' }));
    expect(marked.reply.assetMarks).toBeTruthy();
  });

  // Uniquely catches a take import whose reply is the bare scene, which forces the board to reload after the import.
  it('importing a still or a clip answers with an edit that folds into the reloaded board', async () => {
    const still = await expectReloadParity(() => request(app).post(`${base()}/scenes/c/takes`).send({ kind: 'endImage', assetId: 'spare.png', source: 'imported' }), 201);
    expect(still.reply.take).toMatchObject({ kind: 'endImage', assetId: 'spare.png' });
    expect(still.reply.scene).toMatchObject({ sceneId: 'c', endImageId: 'spare.png' });
    const clip = await expectReloadParity(() => request(app).post(`${base()}/scenes/a/takes`).send({ kind: 'video', assetId: 'clip-b', source: 'imported' }), 201);
    expect(clip.reply.take).toMatchObject({ kind: 'video', assetId: 'clip-b' });
    // A take the shot already has changes nothing, and the board is already right.
    await expectReloadParity(() => request(app).post(`${base()}/scenes/a/takes`).send({ kind: 'video', assetId: 'clip-b', source: 'imported' }), 201);
  });

  // Uniquely catches a continuing shot that writes the frame, the start selection and the end selection as three
  // revisions, which no single edit result can describe.
  it('starting a shot from a frame is one write whose edit folds into the reloaded board', async () => {
    const before = await read();
    const { scene, edit } = await boardEdits.startSceneFromFrame(project.id, 'b', { imageId: 'spare.png', prompt: 'Out-frame of the previous shot', keepStillAsEnd: true });
    expect(scene).toMatchObject({ sceneId: 'b', referenceImageId: 'spare.png', endImageId: 'b.png' });
    expect(edit.baseUpdatedAt).toBe(before.updatedAt);
    expect(applyMusicVideoEdit(before, edit)).toEqual(await read());
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

// #16270 / #16275: take decisions answer with the same edit result, so the board takes their
// read-time effects from the reply and the next shot edit's diff applies on the revision it shows.
describe('take decision replies carry what a reload would show', () => {
  const takeOf = (body, sceneId, assetId) => body.scenes.find((scene) => scene.sceneId === sceneId).takes.find((take) => take.assetId === assetId);

  it('select, reject, restore, note, reject unused, swap frames and a bad mark each fold into the reloaded board', async () => {
    const spare = takeOf(await read(), 'b', 'spare.png');
    const selected = await expectReloadParity(() => request(app).post(`${base()}/scenes/b/takes/${spare.takeId}/select`).send({}));
    expect(selected.reply.referenceImageId).toBe('spare.png');
    // The clip made from the old still went stale with the new selection, and the reply says so.
    expect(selected.reply.edit.scenes.find((scene) => scene.sceneId === 'b').takes.find((take) => take.assetId === 'clip-b').dependencyState.status).toBe('stale');
    const old = takeOf(selected.after, 'b', 'b.png');
    await expectReloadParity(() => request(app).patch(`${base()}/scenes/b/takes/${old.takeId}`).send({ status: 'rejected' }));
    await expectReloadParity(() => request(app).patch(`${base()}/scenes/b/takes/${old.takeId}`).send({ status: 'candidate', note: 'Keep for later' }));
    const unused = await expectReloadParity(() => request(app).post(`${base()}/scenes/b/takes/reject-unused`).send());
    expect(unused.reply).toMatchObject({ rejected: 1, scene: { sceneId: 'b' } });
    expect(takeOf(unused.after, 'b', 'b.png').status).toBe('rejected');
    await request(app).post(`${base()}/scenes/c/takes`).send({ kind: 'endImage', assetId: 'spare.png', source: 'imported' });
    const swapped = await expectReloadParity(() => request(app).post(`${base()}/scenes/c/swap-frames`).send());
    expect(swapped.reply).toMatchObject({ referenceImageId: 'spare.png', endImageId: 'c.png' });
    const marked = await expectReloadParity(() => request(app).patch(`${base()}/media-pool/marks`).send({ items: [{ kind: 'video', assetId: 'clip-a' }], mark: 'bad' }));
    expect(marked.reply.assetMarks).toMatchObject({ 'video:clip-a': expect.anything() });
  });

  // Uniquely catches a shot edit after a take decision whose reply cannot apply on the board the
  // decision's reply left (a stale `takes` array or a base revision the board never saw).
  it('reject unused then Done: the Done reply applies on the board the rejection left, with the takes still rejected', async () => {
    const board = await read();
    const rejected = await request(app).post(`${base()}/scenes/b/takes/reject-unused`).send();
    const afterReject = applyMusicVideoEdit(board, rejected.body.edit);
    expect(takeOf(afterReject, 'b', 'spare.png').status).toBe('rejected');
    const done = await request(app).patch(`${base()}/scenes/b`).send({ shotSheet: { checked: true } });
    expect(done.body.edit.baseUpdatedAt).toBe(afterReject.updatedAt);
    const afterDone = applyMusicVideoEdit(afterReject, done.body.edit);
    expect(afterDone).toEqual(await read());
    expect(takeOf(afterDone, 'b', 'spare.png').status).toBe('rejected');
  });

  it('Still matches then Done: the confirmed frame stays current through the Done reply', async () => {
    await request(app).patch(`${base()}/scenes/a`).send({ framePrompt: 'Frame a, described as drawn' });
    const board = await read();
    const still = takeOf(board, 'a', 'a.png');
    expect(still.dependencyState.status).toBe('stale');
    const confirmed = await request(app).patch(`${base()}/scenes/a/takes/${still.takeId}`).send({ confirmFrame: true });
    expect(confirmed.status).toBe(200);
    const afterConfirm = applyMusicVideoEdit(board, confirmed.body.edit);
    expect(afterConfirm).toEqual(await read());
    expect(takeOf(afterConfirm, 'a', 'a.png').dependencyState.status).toBe('current');
    const done = await request(app).patch(`${base()}/scenes/a`).send({ shotSheet: { checked: true } });
    const afterDone = applyMusicVideoEdit(afterConfirm, done.body.edit);
    expect(afterDone).toEqual(await read());
    expect(takeOf(afterDone, 'a', 'a.png').dependencyState.status).toBe('current');
  });
});

describe('board edit undo restores prior shots and keeps reload parity', () => {
  it('undoes merge-next, merge-previous, split and delete in stack order and refuses when empty', async () => {
    const initial = await read();
    expect(initial.boardUndo).toBeUndefined();

    // Empty stack returns 400 NOTHING_TO_UNDO.
    const empty = await request(app).post(`${base()}/scenes/undo`).send();
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('NOTHING_TO_UNDO');

    // Accidental merge-next of Shot 1 over Shot 2, then undo restores Shot 2 with its takes and timing.
    const mergedNext = await expectReloadParity(() => request(app).post(`${base()}/scenes/a/merge-next`).send({}));
    expect(mergedNext.after.scenes.map((s) => s.sceneId)).toEqual(['a', 'c']);
    expect(mergedNext.after.boardUndo).toEqual({ count: 1, label: 'merge with next' });

    const undoneMerge = await expectReloadParity(() => request(app).post(`${base()}/scenes/undo`).send());
    expect(undoneMerge.reply.undone).toBe('merge with next');
    expect(undoneMerge.after.scenes.map((s) => s.sceneId)).toEqual(['a', 'b', 'c']);
    expect(undoneMerge.after.scenes[0]).toMatchObject({ sceneId: 'a', startSec: 0, endSec: 5 });
    expect(undoneMerge.after.scenes[1]).toMatchObject({ sceneId: 'b', startSec: 5, endSec: 10, referenceImageId: 'b.png', videoHistoryId: 'clip-b' });
    expect(undoneMerge.after.boardUndo).toBeUndefined();

    // Multi-step undo: merge-previous then delete, then undo twice.
    const mergedPrev = await expectReloadParity(() => request(app).post(`${base()}/scenes/b/merge-previous`).send({}));
    expect(mergedPrev.after.scenes.map((s) => s.sceneId)).toEqual(['b', 'c']);
    expect(mergedPrev.after.boardUndo).toEqual({ count: 1, label: 'merge over previous' });

    const deleted = await expectReloadParity(() => request(app).delete(`${base()}/scenes/c`));
    expect(deleted.after.scenes.map((s) => s.sceneId)).toEqual(['b']);
    expect(deleted.after.boardUndo).toEqual({ count: 2, label: 'delete shot' });

    const undoDelete = await expectReloadParity(() => request(app).post(`${base()}/scenes/undo`).send());
    expect(undoDelete.reply.undone).toBe('delete shot');
    expect(undoDelete.after.scenes.map((s) => s.sceneId)).toEqual(['b', 'c']);
    expect(undoDelete.after.boardUndo).toEqual({ count: 1, label: 'merge over previous' });

    const undoMergePrev = await expectReloadParity(() => request(app).post(`${base()}/scenes/undo`).send());
    expect(undoMergePrev.reply.undone).toBe('merge over previous');
    expect(undoMergePrev.after.scenes.map((s) => s.sceneId)).toEqual(['a', 'b', 'c']);
    expect(undoMergePrev.after.scenes[0]).toMatchObject({ sceneId: 'a', startSec: 0, endSec: 5, referenceImageId: 'a.png' });
    expect(undoMergePrev.after.boardUndo).toBeUndefined();
  });
});

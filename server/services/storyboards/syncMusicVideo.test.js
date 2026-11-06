/**
 * Sync shots through the real routers and file-backed stores: one shot per
 * panel at the panel's own time, kept 1:1 after each board edit, with each
 * shot's own work kept.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('storyboard-sync-mv-');
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const { default: storyboardRoutes } = await import('../../routes/storyboards.js');
const projects = await import('../musicVideo/projects.js');

const app = express();
app.use(express.json());
app.use('/api/storyboards', storyboardRoutes);
app.use(errorMiddleware);
afterAll(cleanupTempDataRoots);

const analysis = { bpm: 120, beats: [], downbeats: [], durationSec: 20, sections: [{ label: 'Verse', startSec: 0, endSec: 20 }] };

async function linkedProject(scenes = []) {
  const created = await request(app).post('/api/storyboards').send({ name: 'Example board' });
  const boardId = created.body.id;
  await request(app).post(`/api/storyboards/${boardId}/beats/add`).send({ beats: [
    { title: 'Arrival', panels: [{ action: 'She steps off the bus', seconds: 5 }, { action: 'The town square', seconds: 5 }] },
    { title: 'Lift off', panels: [{ action: 'Crowd lifts her up', seconds: 10 }] },
  ] });
  const project = await projects.createProject({ name: 'Example Song' });
  await projects.mutateProjectRecord(project.id, (record) => ({
    project: { ...record, storyboardId: boardId, audioAnalysis: analysis, scenes,
      lyricCues: [{ id: 'c1', text: 'Here we go', startSec: 11, endSec: 13 }] },
  }));
  const board = (await request(app).get(`/api/storyboards/${boardId}`)).body;
  return { project: await projects.getProject(project.id), board };
}
const spans = (scenes) => scenes.map((s) => [s.startSec, s.endSec, s.visualIntent]);

describe('sync a music video\'s shots to its storyboard', () => {
  it('makes one shot per panel at its own time, then keeps them in sync after each edit', async () => {
    const { project, board } = await linkedProject();
    const res = await request(app).post(`/api/storyboards/sync-music-video/${project.id}`).send({ boardUpdatedAt: board.updatedAt });
    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({ added: 3 });
    expect(res.body.project.storyboardSync).toBe(true);
    expect(spans(res.body.project.scenes)).toEqual([[0, 5, 'She steps off the bus'], [5, 10, 'The town square'], [10, 20, 'Crowd lifts her up']]);
    expect(res.body.project.scenes[2].lyricText).toBe('Here we go');

    // A transition added on Shots survives the panel growing; the next shot moves.
    const [first, second] = res.body.project.scenes;
    await projects.updateScene(project.id, second.sceneId, { transitionIn: 'film-burn' });
    const firstPanel = board.beats[0].panels[0];
    expect((await request(app).patch(`/api/storyboards/${board.id}/panels/${firstPanel.id}`).send({ seconds: 6 })).status).toBe(200);
    let scenes = (await projects.getProject(project.id)).scenes;
    expect(scenes.map((s) => [s.sceneId, s.startSec, s.endSec])).toEqual([[first.sceneId, 0, 6], [second.sceneId, 6, 11], [scenes[2].sceneId, 11, 20]]);
    expect(scenes[1].transitionIn).toBe('film-burn');

    // A panel added makes a shot in its place; a panel deleted takes its shot away. A board
    // running past the song leaves the shots as they are until it fits again.
    const tooLong = await request(app).post(`/api/storyboards/${board.id}/beats/${board.beats[0].id}/panels`).send({ action: 'Too long', seconds: 9 });
    expect(spans((await projects.getProject(project.id)).scenes)).toEqual(spans(scenes));
    await request(app).delete(`/api/storyboards/${board.id}/panels/${tooLong.body.panelId}`);
    await request(app).patch(`/api/storyboards/${board.id}/panels/${board.beats[1].panels[0].id}`).send({ seconds: 7 });
    const added = await request(app).post(`/api/storyboards/${board.id}/beats/${board.beats[0].id}/panels`).send({ action: 'A dog barks', seconds: 2 });
    expect(added.status).toBe(201);
    scenes = (await projects.getProject(project.id)).scenes;
    expect(spans(scenes)).toEqual([[0, 6, 'She steps off the bus'], [6, 11, 'The town square'], [11, 13, 'A dog barks'], [13, 20, 'Crowd lifts her up']]);
    await request(app).delete(`/api/storyboards/${board.id}/panels/${firstPanel.id}`);
    scenes = (await projects.getProject(project.id)).scenes;
    expect(scenes.map((s) => s.visualIntent)).toEqual(['The town square', 'A dog barks', 'Crowd lifts her up']);
    expect(scenes[0]).toMatchObject({ sceneId: second.sceneId, startSec: 0, endSec: 5 });

    // Turned off, an edit leaves the shots alone.
    await request(app).put(`/api/storyboards/sync-music-video/${project.id}/auto`).send({ on: false });
    await request(app).patch(`/api/storyboards/${board.id}/panels/${board.beats[0].panels[1].id}`).send({ seconds: 4 });
    expect(spans((await projects.getProject(project.id)).scenes)).toEqual(spans(scenes));
  });

  // Uniquely catches a shot edit that the next board edit would undo: the panels have to take it too.
  it('writes merges, splits and moved cuts back to the panels so a later board edit keeps them', async () => {
    const { project, board } = await linkedProject();
    const synced = await request(app).post(`/api/storyboards/sync-music-video/${project.id}`).send({ boardUpdatedAt: board.updatedAt });
    const [first, second, third] = synced.body.project.scenes;
    const panelSeconds = async () => (await request(app).get(`/api/storyboards/${board.id}`)).body.beats.flatMap((beat) => beat.panels.map((panel) => [panel.action, panel.seconds]));
    const times = async () => (await projects.getProject(project.id)).scenes.map((s) => [s.sceneId, s.startSec, s.endSec]);

    // A longer shot: the next one starts later, its end stays, and what it owns is kept.
    await projects.updateScene(project.id, second.sceneId, { transitionIn: 'film-burn' });
    const moved = await projects.moveProjectSceneEnd(project.id, first.sceneId, { endSec: 7.5 });
    expect([moved.scene.endSec, moved.next.startSec, moved.next.endSec]).toEqual([7.5, 7.5, 10]);
    expect(moved.next.transitionIn).toBe('film-burn');
    expect(await panelSeconds()).toEqual([['She steps off the bus', 7.5], ['The town square', 2.5], ['Crowd lifts her up', 10]]);

    // Too far for the next shot, or too short for this one, is refused. The last shot stops at the song's end.
    await expect(projects.moveProjectSceneEnd(project.id, first.sceneId, { endSec: 9.95 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(projects.moveProjectSceneEnd(project.id, first.sceneId, { endSec: 0.05 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(projects.moveProjectSceneEnd(project.id, third.sceneId, { endSec: 21 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // Cuts the board can't hold are refused and change nothing: its first panel starts with the song,
    // and its last one snaps to the song's end from within a second.
    const held = await times();
    await expect(projects.moveProjectSceneStart(project.id, first.sceneId, { startSec: 1 })).rejects.toMatchObject({ code: 'STORYBOARD_FIRST_START' });
    await expect(projects.moveProjectSceneEnd(project.id, third.sceneId, { endSec: 19.5 })).rejects.toMatchObject({ code: 'STORYBOARD_LAST_END' });
    expect(await times()).toEqual(held);
    // Stopping further before the song's end holds, and so does running back to it.
    const shorter = await projects.moveProjectSceneEnd(project.id, third.sceneId, { endSec: 18 });
    expect(shorter.scene.endSec).toBe(18);
    expect((await projects.moveProjectSceneEnd(project.id, third.sceneId, { endSec: 20 })).scene.endSec).toBe(20);

    // A moved start reaches the panels too.
    await projects.moveProjectSceneStart(project.id, second.sceneId, { startSec: 6 });
    expect(await panelSeconds()).toEqual([['She steps off the bus', 6], ['The town square', 4], ['Crowd lifts her up', 10]]);

    // A split gives the later piece a panel of its own, right after the first.
    const split = await projects.splitProjectScene(project.id, second.sceneId, { atSec: 8 });
    expect(split.scenes.map((s) => [s.startSec, s.endSec])).toEqual([[6, 8], [8, 10]]);
    expect(split.scenes[1].panelId).not.toBe(split.scenes[0].panelId);
    expect(await panelSeconds()).toEqual([['She steps off the bus', 6], ['The town square', 2], ['The town square', 2], ['Crowd lifts her up', 10]]);

    // A merge keeps the first shot over both and takes the removed shot's panel away.
    const merged = await projects.mergeProjectNextScene(project.id, second.sceneId, {});
    expect(merged.scene).toMatchObject({ sceneId: second.sceneId, startSec: 6, endSec: 10, transitionIn: 'film-burn' });
    expect(await panelSeconds()).toEqual([['She steps off the bus', 6], ['The town square', 4], ['Crowd lifts her up', 10]]);
    const afterEdits = await times();
    expect(afterEdits).toEqual([[first.sceneId, 0, 6], [second.sceneId, 6, 10], [third.sceneId, 10, 20]]);

    // The next board edit leaves all of it in place.
    await request(app).patch(`/api/storyboards/${board.id}/panels/${board.beats[0].panels[0].id}`).send({ action: 'She steps off the bus again' });
    expect(await times()).toEqual(afterEdits);

    // With the sync off the board keeps its own lengths.
    await request(app).put(`/api/storyboards/sync-music-video/${project.id}/auto`).send({ on: false });
    await projects.moveProjectSceneEnd(project.id, first.sceneId, { endSec: 5 });
    expect((await panelSeconds())[0][1]).toBe(6);
  });

  it('links existing shots in place on the first sync, keeping their words and media', async () => {
    const shot = (id, startSec, endSec) => ({ sceneId: `mvs-${id}`, order: 0, label: id, startSec, endSec, visualIntent: `shot ${id}`, prompt: `prompt ${id}`,
      referenceImageId: null, videoHistoryId: null, takes: [], loop: false });
    const { project, board } = await linkedProject([shot('a', 0, 5), shot('b', 5, 9.8), shot('c', 9.8, 14), shot('d', 14, 20)]);
    const res = await request(app).post(`/api/storyboards/sync-music-video/${project.id}`).send({ boardUpdatedAt: board.updatedAt });
    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({ linked: 2, added: 1, removed: 2 });
    const [a, b, c] = res.body.project.scenes;
    expect(a).toMatchObject({ sceneId: 'mvs-a', visualIntent: 'shot a', prompt: 'prompt a', panelId: board.beats[0].panels[0].id });
    expect(b).toMatchObject({ sceneId: 'mvs-b', startSec: 5, endSec: 10, visualIntent: 'shot b' });
    expect(c).toMatchObject({ startSec: 10, endSec: 20, visualIntent: 'Crowd lifts her up' });
  });

  it('preserves a legacy shot and its selected frame when its panel is deleted until removal is explicitly confirmed', async () => {
    const { project, board } = await linkedProject();
    const initial = await request(app).post(`/api/storyboards/sync-music-video/${project.id}`).send({ boardUpdatedAt: board.updatedAt });
    const first = initial.body.project.scenes[0];
    const { PATHS } = await import('../../lib/paths.js');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(PATHS.images, { recursive: true });
    await writeFile(`${PATHS.images}/preserved.png`, 'synthetic image');
    await projects.appendSceneTakes(project.id, first.sceneId, [{ kind: 'image', assetId: 'preserved.png', source: 'generated' }]);

    await request(app).delete(`/api/storyboards/${board.id}/panels/${board.beats[0].panels[0].id}`);
    const retained = await projects.getProject(project.id);
    expect(retained.scenes.find(scene => scene.sceneId === first.sceneId)).toMatchObject({ referenceImageId: 'preserved.png' });
    const updatedBoard = (await request(app).get(`/api/storyboards/${board.id}`)).body;
    const removed = await request(app).post(`/api/storyboards/sync-music-video/${project.id}`)
      .send({ boardUpdatedAt: updatedBoard.updatedAt, projectUpdatedAt: retained.updatedAt, removeWithMedia: true });
    expect(removed.status).toBe(200);
    expect(removed.body.project.scenes.some(scene => scene.sceneId === first.sceneId)).toBe(false);
    const { getCollection, musicVideoCollectionId } = await import('../mediaCollections.js');
    expect((await getCollection(musicVideoCollectionId(project.id))).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'image', ref: 'preserved.png' }),
    ]));
  });

  // An older edit's sync can finish after a newer edit's; it must not apply its stale board.
  it('syncs from the board as it is now, not from a late edit\'s older snapshot', async () => {
    const { project, board } = await linkedProject();
    await request(app).post(`/api/storyboards/sync-music-video/${project.id}`).send({ boardUpdatedAt: board.updatedAt });
    const stale = (await request(app).get(`/api/storyboards/${board.id}`)).body;
    await request(app).patch(`/api/storyboards/${board.id}/panels/${board.beats[0].panels[0].id}`).send({ seconds: 3 });
    const { syncShotsAfterBoardEdit } = await import('./syncMusicVideo.js');
    await syncShotsAfterBoardEdit(stale);
    expect(spans((await projects.getProject(project.id)).scenes).map(([start, end]) => [start, end]))
      .toEqual([[0, 3], [3, 8], [8, 18]]);
  });

  it('refuses a stale preview', async () => {
    const { project } = await linkedProject();
    const res = await request(app).post(`/api/storyboards/sync-music-video/${project.id}`).send({ boardUpdatedAt: '2000-01-01T00:00:00.000Z' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STORYBOARD_CHANGED');
  });
});

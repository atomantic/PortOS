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

  it('refuses a stale preview', async () => {
    const { project } = await linkedProject();
    const res = await request(app).post(`/api/storyboards/sync-music-video/${project.id}`).send({ boardUpdatedAt: '2000-01-01T00:00:00.000Z' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STORYBOARD_CHANGED');
  });
});

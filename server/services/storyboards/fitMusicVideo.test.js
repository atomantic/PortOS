/**
 * Fit to song through the real routers and file-backed stores: the linked
 * board's panels become shots on the analyzed song, each keeping its panel.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { fitStoryboardToSong, storyboardFitSong } from '../../lib/storyboardFit.js';

const ROOT = () => lazyTempDataRoot('storyboard-fit-mv-');
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const { default: storyboardRoutes } = await import('../../routes/storyboards.js');
const { default: musicVideoRoutes } = await import('../../routes/musicVideo.js');
const projects = await import('../musicVideo/projects.js');
const { PATHS } = await import('../../lib/paths.js');
const { mkdir, writeFile } = await import('node:fs/promises');

const app = express();
app.use(express.json());
app.use('/api/storyboards', storyboardRoutes);
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);
afterAll(cleanupTempDataRoots);

const analysis = {
  bpm: 120, beats: [], downbeats: [], durationSec: 40,
  sections: [{ label: 'Verse', startSec: 0, endSec: 20 }, { label: 'Chorus', startSec: 20, endSec: 40 }],
};

async function linkedProject(extra = {}) {
  const created = await request(app).post('/api/storyboards').send({ name: 'Example board' });
  const boardId = created.body.id;
  await request(app).post(`/api/storyboards/${boardId}/beats/add`).send({ beats: [
    { title: 'Arrival', musicalRole: 'verse', panels: [{ action: 'She steps off the bus', seconds: 4 }, { action: 'The town square', seconds: 4 }] },
    { title: 'Lift off', musicalRole: 'chorus', panels: [{ action: 'Crowd lifts her up', seconds: 8 }] },
  ] });
  const project = await projects.createProject({ name: 'Example Song' });
  await projects.mutateProjectRecord(project.id, (record) => ({
    project: { ...record, storyboardId: boardId, audioAnalysis: analysis, lyricCues: [{ id: 'c1', text: 'Here we go', startSec: 21, endSec: 23 }], ...extra },
  }));
  const board = (await request(app).get(`/api/storyboards/${boardId}`)).body;
  return { project, board };
}

describe('fit a music video to its storyboard', () => {
  it('writes the previewed short shots when three beats share a three-second song', async () => {
    const { project, board } = await linkedProject({ audioAnalysis: { ...analysis, durationSec: 3, sections: [] }, lyricCues: [] });
    await request(app).post(`/api/storyboards/${board.id}/beats/add`).send({ beats: [
      { title: 'Farewell', panels: [{ action: 'The bus leaves', seconds: 3 }] },
    ] });
    const updatedBoard = (await request(app).get(`/api/storyboards/${board.id}`)).body;
    const preview = fitStoryboardToSong(updatedBoard, storyboardFitSong(await projects.getProject(project.id)));
    expect(preview.beats).toHaveLength(3);
    expect(preview.beats.reduce((sum, beat) => sum + beat.short, 0)).toBe(4);

    const res = await request(app).post(`/api/storyboards/fit-music-video/${project.id}`).send({ boardUpdatedAt: updatedBoard.updatedAt });
    expect(res.status).toBe(200);
    const spans = (shots) => shots.map(({ startSec, endSec, panelId }) => ({ startSec, endSec, panelId }));
    expect(spans(res.body.project.scenes)).toEqual(spans(preview.shots));
    expect(spans((await projects.getProject(project.id)).scenes)).toEqual(spans(preview.shots));
    expect(res.body.project.scenes.every((shot) => shot.endSec > shot.startSec && shot.endSec <= 3)).toBe(true);
  });

  it('writes one shot per panel on the song, tied to its panel', async () => {
    const { project, board } = await linkedProject();
    const res = await request(app).post(`/api/storyboards/fit-music-video/${project.id}`).send({ boardUpdatedAt: board.updatedAt });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ shots: 3, replaced: 0 });
    const panelIds = board.beats.flatMap((beat) => beat.panels.map((panel) => panel.id));
    expect(res.body.project.scenes.map((s) => [s.label, s.startSec, s.endSec, s.sectionLabel, s.visualIntent, s.panelId])).toEqual([
      ['Arrival · 1/2', 0, 10, 'Verse', 'She steps off the bus', panelIds[0]],
      ['Arrival · 2/2', 10, 20, 'Verse', 'The town square', panelIds[1]],
      ['Lift off', 20, 40, 'Chorus', 'Crowd lifts her up', panelIds[2]],
    ]);
    expect(res.body.project.scenes[2]).toMatchObject({ lyricText: 'Here we go', loop: false, panelRev: expect.any(String) });

    // A board edited after the preview is refused, so what was shown is what gets written.
    expect((await request(app).post(`/api/storyboards/fit-music-video/${project.id}`).send({ boardUpdatedAt: '2000-01-01T00:00:00.000Z' })).status).toBe(409);
  });

  it('never replaces locked shots and needs an analyzed song', async () => {
    const { project, board } = await linkedProject({
      scenes: [{ sceneId: 'mvs-kept', order: 0, startSec: 0, endSec: 40, prompt: '', takes: [] }],
      productionReview: { shotApprovals: { 'mvs-kept': { basis: 'example' } } },
    });
    const locked = await request(app).post(`/api/storyboards/fit-music-video/${project.id}`).send({ boardUpdatedAt: board.updatedAt });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('SHOTS_LOCKED');
    expect((await projects.getProject(project.id)).scenes.map((s) => s.sceneId)).toEqual(['mvs-kept']);

    const bare = await linkedProject({ audioAnalysis: null });
    const unanalyzed = await request(app).post(`/api/storyboards/fit-music-video/${bare.project.id}`).send({ boardUpdatedAt: bare.board.updatedAt });
    expect(unanalyzed.body.code).toBe('SONG_NOT_ANALYZED');
  });

  it('flags an edited panel on its shot until Update, sends the still back as panel art, and names a deleted panel', async () => {
    const { project, board } = await linkedProject();
    const fitted = await request(app).post(`/api/storyboards/fit-music-video/${project.id}`).send({ boardUpdatedAt: board.updatedAt });
    const [first, second] = fitted.body.project.scenes;
    const panelId = first.panelId;

    await request(app).patch(`/api/storyboards/${board.id}/panels/${panelId}`).send({ action: 'She steps off the night bus' });
    const updated = await request(app).post(`/api/storyboards/music-video/${project.id}/shots/${first.sceneId}/update-from-panel`);
    expect(updated.status).toBe(200);
    expect(updated.body.scene).toMatchObject({ visualIntent: 'She steps off the night bus', startSec: 0, endSec: 10 });
    expect(updated.body.scene.panelRev).not.toBe(first.panelRev);

    await mkdir(PATHS.images, { recursive: true });
    await writeFile(`${PATHS.images}/still-a.png`, Buffer.from('89504e470d0a1a0a', 'hex'));
    await projects.mutateProjectRecord(project.id, (record) => ({
      project: { ...record, scenes: record.scenes.map((s) => (s.sceneId === first.sceneId ? { ...s, referenceImageId: 'still-a.png' } : s)) },
    }));
    const art = await request(app).post(`/api/storyboards/music-video/${project.id}/shots/${first.sceneId}/panel-art`);
    expect(art.status).toBe(200);
    const panel = art.body.board.beats[0].panels.find((p) => p.id === panelId);
    expect(panel.takes.find((take) => take.id === panel.selectedTakeId)).toMatchObject({ source: 'gallery', image: 'still-a.png' });
    // The panel's art is now the shot's own still, so the shot keeps it as its frame reference and reads as current.
    expect(art.body.scene.panelArt).toBe('still-a.png');
    // Sending it again reselects the same take rather than adding another.
    const again = await request(app).post(`/api/storyboards/music-video/${project.id}/shots/${first.sceneId}/panel-art`);
    expect(again.body.board.beats[0].panels.find((p) => p.id === panelId).takes).toHaveLength(1);

    await request(app).delete(`/api/storyboards/${board.id}/panels/${second.panelId}`);
    const gone = await request(app).post(`/api/storyboards/music-video/${project.id}/shots/${second.sceneId}/update-from-panel`);
    expect(gone.status).toBe(409);
    expect(gone.body.code).toBe('PANEL_MISSING');
  });
});

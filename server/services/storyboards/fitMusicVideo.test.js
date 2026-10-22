/**
 * Fit to song through the real routers and file-backed stores: the linked
 * board's panels become shots on the analyzed song, each keeping its panel.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('storyboard-fit-mv-');
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const { default: storyboardRoutes } = await import('../../routes/storyboards.js');
const { default: musicVideoRoutes } = await import('../../routes/musicVideo.js');
const projects = await import('../musicVideo/projects.js');

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
});

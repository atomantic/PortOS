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

  it('puts beats marked before the song in front as shots before it, and keeps their sound on a refit', async () => {
    const { project, board } = await linkedProject();
    const opening = await request(app).post(`/api/storyboards/${board.id}/beats`).send({ title: 'Booth', beforeSong: true, index: 0 });
    expect(opening.status).toBe(201);
    const beatId = opening.body.beatId;
    await request(app).post(`/api/storyboards/${board.id}/beats/${beatId}/panels`).send({ action: 'He presses play on the deck', seconds: 2.5 });
    // Only the opening run can be before the song: a flag on a later beat does not stick.
    const later = board.beats[1].id;
    await request(app).patch(`/api/storyboards/${board.id}/beats/${later}`).send({ beforeSong: true });
    const marked = (await request(app).get(`/api/storyboards/${board.id}`)).body;
    expect(marked.beats.map((beat) => beat.beforeSong === true)).toEqual([true, false, false]);

    const fit = async (current) => request(app).post(`/api/storyboards/fit-music-video/${project.id}`).send({ boardUpdatedAt: current.updatedAt });
    const res = await fit(marked);
    expect(res.status).toBe(200);
    expect(res.body.shots).toBe(4);
    const rows = (scenes) => scenes.map((s) => [s.label, s.preMusic?.durationSec ?? null, s.startSec ?? null, s.endSec ?? null, s.lyricText ?? null]);
    // The song beats still fill the whole song from its first note.
    expect(rows(res.body.project.scenes)).toEqual([
      ['Booth', 2.5, null, null, null],
      ['Arrival · 1/2', null, 0, 10, null],
      ['Arrival · 2/2', null, 10, 20, null],
      ['Lift off', null, 20, 40, 'Here we go'],
    ]);

    const [cold] = res.body.project.scenes;
    await projects.updateScene(project.id, cold.sceneId, { preMusic: { durationSec: 2.5, layers: [{ effect: 'tape-hiss', atSec: 0, volume: 0.5 }] } });
    const refit = await fit((await request(app).get(`/api/storyboards/${board.id}`)).body);
    expect(refit.body.project.scenes[0]).toMatchObject({ sceneId: cold.sceneId, preMusic: { durationSec: 2.5, layers: [{ effect: 'tape-hiss' }] } });
    expect(refit.body.project.scenes).toHaveLength(4);
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

  it('groups the board by song sections, placing each panel where its shot starts', async () => {
    const sections = [
      { label: 'Intro', startSec: 0, endSec: 8 }, { label: 'Verse 1', startSec: 8, endSec: 20 },
      { label: 'Verse 1', startSec: 20, endSec: 24 }, { label: 'Chorus', startSec: 24, endSec: 40 },
    ];
    const { project, board } = await linkedProject({ audioAnalysis: { ...analysis, sections } });
    const [p1, p2] = board.beats[0].panels;
    const [p3] = board.beats[1].panels;
    // The first panel's shot starts in the verse, the third's in the chorus; the second has no shot and follows the first.
    await projects.mutateProjectRecord(project.id, (record) => ({ project: { ...record, scenes: [
      { sceneId: 'mvs-1', order: 0, startSec: 9, endSec: 14, panelId: p1.id, takes: [] },
      { sceneId: 'mvs-3', order: 1, startSec: 26, endSec: 34, panelId: p3.id, takes: [] },
    ] } }));
    const res = await request(app).post(`/api/storyboards/group-by-song/${project.id}`);
    expect(res.status).toBe(200);
    expect(res.body.beats.map((beat) => [beat.title, beat.musicalRole, beat.panels.map((p) => p.id)])).toEqual([
      ['Verse 1', 'verse', [p1.id, p2.id]],
      ['Chorus', 'chorus', [p3.id]],
    ]);
    // The verse keeps the old beat that held its panels.
    expect(res.body.beats[0].id).toBe(board.beats[0].id);

    const bare = await projects.createProject({ name: 'Unlinked' });
    expect((await request(app).post(`/api/storyboards/group-by-song/${bare.id}`)).status).toBe(409);
  });
});

/**
 * Make storyboard from this video, through the real routers and file-backed
 * stores: the board mirrors the shots and the project links it.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('storyboard-from-mv-');
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

const scene = (order, extra) => ({
  sceneId: `mvs-${order}`, order, startSec: order * 4, endSec: order * 4 + 4, prompt: '', framePrompt: '', visualIntent: '', lyricText: '', takes: [], ...extra,
});

describe('make storyboard from a music video', () => {
  it('builds beats from song sections and panels from shots, then links the project', async () => {
    const project = await projects.createProject({ name: 'Example Song' });
    await mkdir(PATHS.images, { recursive: true });
    await writeFile(`${PATHS.images}/frame-a.png`, Buffer.from('89504e470d0a1a0a', 'hex'));
    await projects.mutateProjectRecord(project.id, (record) => ({
      project: {
        ...record,
        scenes: [
          scene(0, { sectionIndex: 0, sectionLabel: 'Section 1 · 1/2', visualIntent: 'She opens the gym doors', referenceImageId: 'frame-a.png', camera: { move: 'push-in' } }),
          scene(1, { sectionIndex: 0, sectionLabel: 'Section 1 · 2/2', framePrompt: 'Wide of the empty floor', characterVariant: { ingredientId: 'cat-example-1' } }),
          scene(2, { sectionIndex: 1, sectionLabel: 'Section 2 · 1/1', prompt: 'She dances', lyricText: 'Here I am' }),
        ],
      },
    }));

    const made = await request(app).post(`/api/storyboards/from-music-video/${project.id}`);
    expect(made.status).toBe(201);
    const { board } = made.body;
    expect(made.body.project.storyboardId).toBe(board.id);
    expect(board.name).toBe('Example Song');
    expect(board.artStyle).toBe('production-sketch');
    expect(board.beats.map((beat) => [beat.title, beat.panels.length])).toEqual([['Section 1', 2], ['Section 2', 1]]);
    expect(board.beats[0].panels[0]).toMatchObject({ action: 'She opens the gym doors', camera: 'push-in', seconds: 4, takes: [expect.objectContaining({ source: 'gallery', image: 'frame-a.png' })] });
    expect(board.beats[0].panels[1]).toMatchObject({ action: 'Wide of the empty floor', castIds: ['cat-example-1'], takes: [] });
    expect(board.beats[1].panels[0]).toMatchObject({ action: 'She dances', dialogue: 'Here I am' });

    // A second board is refused while the first stays linked; unlinking frees it.
    expect((await request(app).post(`/api/storyboards/from-music-video/${project.id}`)).status).toBe(409);
    const unlinked = await request(app).patch(`/api/music-video/${project.id}`).send({ storyboardId: null });
    expect(unlinked.body.storyboardId).toBeNull();
    const relinked = await request(app).patch(`/api/music-video/${project.id}`).send({ storyboardId: board.id });
    expect(relinked.body.storyboardId).toBe(board.id);
    expect((await request(app).patch(`/api/music-video/${project.id}`).send({ storyboardId: 'not-a-board' })).status).toBe(400);
  });

  it('refuses a video with no shots', async () => {
    const project = await projects.createProject({ name: 'Empty' });
    expect((await request(app).post(`/api/storyboards/from-music-video/${project.id}`)).status).toBe(400);
    expect((await request(app).post('/api/storyboards/from-music-video/mv-missing')).status).toBe(404);
  });
});

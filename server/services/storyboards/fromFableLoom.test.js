/**
 * Make storyboard from a FableLoom path and Use as scene art, through the real
 * storyboard router and file-backed stores: the board mirrors the picked path,
 * and only the tap on a panel changes its scene's image.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('storyboard-from-loom-');
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const { default: storyboardRoutes } = await import('../../routes/storyboards.js');
const looms = await import('../fableLoom/records.js');

const app = express();
app.use(express.json());
app.use('/api/storyboards', storyboardRoutes);
app.use(errorMiddleware);
afterAll(cleanupTempDataRoots);

const node = (id, extra) => ({ id, title: id.toUpperCase(), prose: '', transitions: [], ...extra });

describe('storyboard from a FableLoom path', () => {
  it('builds the picked path as panels and sends a panel image back to its scene', async () => {
    const loom = await looms.createLoom({ name: 'Example Story' });
    const { episodes: [{ id: episodeId }] } = await looms.addEpisode(loom.id, { title: 'Pilot' });
    await looms.mutateLoom(loom.id, (draft) => {
      draft.episodes[0].startNodeId = 'node-a';
      draft.episodes[0].nodes = [
        node('node-a', {
          imagePrompt: 'Wide of the harbor at dawn', image: 'harbor.png', cameraMovement: 'slow push-in',
          shot: { dramaticSceneId: 'ds-1', dramaticSceneTitle: 'Arrival', durationSeconds: 6, framing: 'Wide, low angle' },
          transitions: [{ id: 'tr-left', targetNodeId: 'node-b', intent: 'Board the ship' }, { id: 'tr-right', targetNodeId: 'node-c', intent: 'Stay ashore' }],
        }),
        node('node-b', { prose: 'The deck heaves.', isEnding: true }),
        node('node-c', { prose: 'The market wakes.', isEnding: true }),
      ];
      return draft;
    });

    const made = await request(app).post(`/api/storyboards/from-fableloom/${loom.id}/${episodeId}`).send({ via: ['tr-right'] });
    expect(made.status).toBe(201);
    const board = made.body;
    expect(board).toMatchObject({ name: 'Example Story · Pilot', source: { kind: 'fableloom', loomId: loom.id, episodeId } });
    expect(board.beats.map((beat) => [beat.title, beat.panels.map((p) => p.sourceSceneId)])).toEqual([['Arrival', ['node-a']], ['NODE-C', ['node-c']]]);
    expect(board.beats[0].panels[0]).toMatchObject({
      action: 'Wide of the harbor at dawn', camera: 'slow push-in', seconds: 6, notes: 'Wide, low angle',
      takes: [expect.objectContaining({ source: 'gallery', image: 'harbor.png' })],
    });

    // A panel with no image refuses; a new selected image goes to the scene.
    const panelId = board.beats[1].panels[0].id;
    expect((await request(app).post(`/api/storyboards/${board.id}/panels/${panelId}/scene-art`)).body.code).toBe('NO_IMAGE');
    expect((await request(app).post(`/api/storyboards/${board.id}/panels/${panelId}/takes`).send({ source: 'generated', image: 'market.png' })).status).toBe(201);
    const sent = await request(app).post(`/api/storyboards/${board.id}/panels/${panelId}/scene-art`);
    expect(sent.status).toBe(200);
    expect(sent.body.node).toMatchObject({ id: 'node-c', image: 'market.png' });
    const after = await looms.getLoom(loom.id);
    expect(after.episodes[0].nodes.map((n) => n.image)).toEqual(['harbor.png', null, 'market.png']);
  });

  it('refuses a missing episode', async () => {
    const loom = await looms.createLoom({ name: 'Empty Story' });
    const res = await request(app).post(`/api/storyboards/from-fableloom/${loom.id}/ep-missing`).send({});
    expect(res.status).toBe(404);
  });
});

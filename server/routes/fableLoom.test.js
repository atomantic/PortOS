import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';

vi.mock('../services/fableLoom/index.js', () => ({
  addEpisode: vi.fn(),
  addNode: vi.fn(),
  branchNode: vi.fn(),
  createLoom: vi.fn(),
  deleteEpisode: vi.fn(),
  deleteLoom: vi.fn(),
  deleteNode: vi.fn(),
  getLoom: vi.fn(),
  listLoomSummaries: vi.fn(async () => []),
  playTurn: vi.fn(),
  reformatLoom: vi.fn(),
  reviewEpisode: vi.fn(),
  updateEpisode: vi.fn(),
  updateLoom: vi.fn(),
  updateNode: vi.fn(),
  weaveEpisode: vi.fn(),
}));

import * as fableLoom from '../services/fableLoom/index.js';
import routes from './fableLoom.js';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/fableloom', routes);
  app.use(errorMiddleware);
  return app;
};

describe('FableLoom routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET / lists loom summaries', async () => {
    fableLoom.listLoomSummaries.mockResolvedValueOnce([{ id: 'loom-1', name: 'X', sceneCount: 3 }]);
    const response = await request(makeApp()).get('/api/fableloom');
    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ id: 'loom-1', name: 'X', sceneCount: 3 }]);
  });

  it('POST / forwards the validated create payload (refs are checked in the service)', async () => {
    fableLoom.createLoom.mockResolvedValueOnce({ id: 'loom-1', name: 'X' });
    const created = await request(makeApp())
      .post('/api/fableloom')
      .send({ name: 'X', universeId: 'uni-1', seriesId: 'ser-1' });
    expect(created.status).toBe(201);
    expect(fableLoom.createLoom).toHaveBeenCalledWith({ name: 'X', universeId: 'uni-1', seriesId: 'ser-1' });
  });

  it('POST / rejects a missing name', async () => {
    const response = await request(makeApp()).post('/api/fableloom').send({});
    expect(response.status).toBe(400);
    expect(fableLoom.createLoom).not.toHaveBeenCalled();
  });

  it('GET /:id 404s on a missing loom', async () => {
    fableLoom.getLoom.mockResolvedValueOnce(null);
    const response = await request(makeApp()).get('/api/fableloom/loom-gone');
    expect(response.status).toBe(404);
  });

  it('PATCH /:id forwards only provided fields', async () => {
    fableLoom.updateLoom.mockResolvedValueOnce({ id: 'loom-1', name: 'Y' });
    const response = await request(makeApp())
      .patch('/api/fableloom/loom-1')
      .send({ name: 'Y' });
    expect(response.status).toBe(200);
    expect(fableLoom.updateLoom).toHaveBeenCalledWith('loom-1', { name: 'Y' });
  });

  it('episode + node CRUD dispatches with route params', async () => {
    fableLoom.addEpisode.mockResolvedValueOnce({ id: 'loom-1' });
    await request(makeApp()).post('/api/fableloom/loom-1/episodes').send({ title: 'Pilot' });
    expect(fableLoom.addEpisode).toHaveBeenCalledWith('loom-1', { title: 'Pilot' });

    fableLoom.updateNode.mockResolvedValueOnce({ id: 'loom-1' });
    await request(makeApp())
      .patch('/api/fableloom/loom-1/episodes/ep-1/nodes/node-1')
      .send({ prose: 'New prose' });
    expect(fableLoom.updateNode).toHaveBeenCalledWith('loom-1', 'ep-1', 'node-1', { prose: 'New prose' });

    fableLoom.deleteNode.mockResolvedValueOnce({ id: 'loom-1' });
    await request(makeApp()).delete('/api/fableloom/loom-1/episodes/ep-1/nodes/node-1');
    expect(fableLoom.deleteNode).toHaveBeenCalledWith('loom-1', 'ep-1', 'node-1');
  });

  it('GET validate runs the deterministic analysis on the episode', async () => {
    fableLoom.getLoom.mockResolvedValueOnce({
      id: 'loom-1',
      episodes: [{ id: 'ep-1', startNodeId: 'n1', nodes: [{ id: 'n1', isEnding: true, transitions: [] }] }],
    });
    const response = await request(makeApp()).get('/api/fableloom/loom-1/episodes/ep-1/validate');
    expect(response.status).toBe(200);
    expect(response.body.stats.nodeCount).toBe(1);
    expect(response.body.issues).toEqual([]);
  });

  it('POST weave validates bounds and forwards options', async () => {
    const invalid = await request(makeApp())
      .post('/api/fableloom/loom-1/episodes/ep-1/weave')
      .send({ nodeTarget: 999 });
    expect(invalid.status).toBe(400);
    expect(fableLoom.weaveEpisode).not.toHaveBeenCalled();

    fableLoom.weaveEpisode.mockResolvedValueOnce({ loom: { id: 'loom-1' }, runId: 'r' });
    const ok = await request(makeApp())
      .post('/api/fableloom/loom-1/episodes/ep-1/weave')
      .send({ guidance: 'darker', replace: true });
    expect(ok.status).toBe(200);
    expect(fableLoom.weaveEpisode).toHaveBeenCalledWith('loom-1', 'ep-1', { guidance: 'darker', replace: true });
  });

  it('POST play accepts a tapped path instead of a message', async () => {
    const neither = await request(makeApp())
      .post('/api/fableloom/loom-1/episodes/ep-1/play')
      .send({ nodeId: 'node-1' });
    expect(neither.status).toBe(400);
    expect(fableLoom.playTurn).not.toHaveBeenCalled();

    fableLoom.playTurn.mockResolvedValueOnce({ action: 'move', resolvedBy: 'choice' });
    const tapped = await request(makeApp())
      .post('/api/fableloom/loom-1/episodes/ep-1/play')
      .send({ nodeId: 'node-1', transitionId: 'tr-1' });
    expect(tapped.status).toBe(200);
    expect(fableLoom.playTurn).toHaveBeenCalledWith('loom-1', 'ep-1', { nodeId: 'node-1', transitionId: 'tr-1' });
  });

  it('POST reformat validates the target format and forwards it', async () => {
    const invalid = await request(makeApp())
      .post('/api/fableloom/loom-1/reformat')
      .send({ format: 'haiku' });
    expect(invalid.status).toBe(400);
    expect(fableLoom.reformatLoom).not.toHaveBeenCalled();

    fableLoom.reformatLoom.mockResolvedValueOnce({ loom: { id: 'loom-1' }, rewritten: 3 });
    const ok = await request(makeApp())
      .post('/api/fableloom/loom-1/reformat')
      .send({ format: 'teleplay', providerId: 'claude' });
    expect(ok.status).toBe(200);
    expect(fableLoom.reformatLoom).toHaveBeenCalledWith('loom-1', { format: 'teleplay', providerId: 'claude' });
  });

  it('POST play requires a nodeId and message', async () => {
    const invalid = await request(makeApp())
      .post('/api/fableloom/loom-1/episodes/ep-1/play')
      .send({ message: 'hello' });
    expect(invalid.status).toBe(400);
    expect(fableLoom.playTurn).not.toHaveBeenCalled();

    fableLoom.playTurn.mockResolvedValueOnce({ action: 'stay' });
    const ok = await request(makeApp())
      .post('/api/fableloom/loom-1/episodes/ep-1/play')
      .send({ nodeId: 'node-1', message: 'open the gate', transcript: [{ role: 'reader', text: 'hi' }] });
    expect(ok.status).toBe(200);
    expect(fableLoom.playTurn).toHaveBeenCalledWith('loom-1', 'ep-1', {
      nodeId: 'node-1', message: 'open the gate', transcript: [{ role: 'reader', text: 'hi' }],
    });
  });
});

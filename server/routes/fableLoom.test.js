import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';

vi.mock('../services/fableLoom/index.js', () => ({
  addEpisode: vi.fn(),
  addNode: vi.fn(),
  addNodeTransition: vi.fn(),
  branchNode: vi.fn(),
  createLoom: vi.fn(),
  deleteEpisode: vi.fn(),
  deleteLoom: vi.fn(),
  deleteNode: vi.fn(),
  deleteNodeTransition: vi.fn(),
  feedbackEpisode: vi.fn(),
  feedbackSeriesPlan: vi.fn(),
  generateSeriesPlan: vi.fn(),
  getLoom: vi.fn(),
  listLoomSummaries: vi.fn(async () => []),
  playTurn: vi.fn(),
  reformatEpisodeScenes: vi.fn(),
  reviewEpisode: vi.fn(),
  reviewSeriesPlan: vi.fn(),
  updateEpisode: vi.fn(),
  updateLoom: vi.fn(),
  updateNode: vi.fn(),
  updateNodeTransition: vi.fn(),
  weaveEpisode: vi.fn(),
  checkHostedSessionReadiness: vi.fn(),
  createHostedSession: vi.fn(),
  getHostedSession: vi.fn(),
  updateHostedSession: vi.fn(),
  endHostedSession: vi.fn(),
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
    expect(fableLoom.listLoomSummaries).toHaveBeenCalledWith({ seriesId: undefined });
  });

  it('GET /?seriesId= scopes the list to one series', async () => {
    fableLoom.listLoomSummaries.mockResolvedValueOnce([{ id: 'loom-1', seriesId: 'ser-1' }]);
    const response = await request(makeApp()).get('/api/fableloom?seriesId=ser-1');
    expect(response.status).toBe(200);
    expect(fableLoom.listLoomSummaries).toHaveBeenCalledWith({ seriesId: 'ser-1' });
  });

  it('GET / treats a blank seriesId as no filter and rejects an over-long one', async () => {
    const blank = await request(makeApp()).get('/api/fableloom?seriesId=');
    expect(blank.status).toBe(200);
    expect(fableLoom.listLoomSummaries).toHaveBeenCalledWith({ seriesId: undefined });

    const tooLong = await request(makeApp()).get(`/api/fableloom?seriesId=${'s'.repeat(65)}`);
    expect(tooLong.status).toBe(400);
    expect(fableLoom.listLoomSummaries).toHaveBeenCalledTimes(1);
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

  it('generates, reviews, and conversationally edits the series plan', async () => {
    fableLoom.generateSeriesPlan.mockResolvedValueOnce({ loom: { id: 'loom-1' }, runId: 'run-draft' });
    const generated = await request(makeApp())
      .post('/api/fableloom/loom-1/plan/generate')
      .send({ providerId: 'writer', model: 'large', effort: 'high' });
    expect(generated.status).toBe(200);
    expect(fableLoom.generateSeriesPlan).toHaveBeenCalledWith('loom-1', {
      providerId: 'writer', model: 'large', effort: 'high',
    });

    fableLoom.reviewSeriesPlan.mockResolvedValueOnce({ analysis: { summary: 'Coherent.' } });
    const reviewed = await request(makeApp())
      .post('/api/fableloom/loom-1/plan/review')
      .send({ providerId: 'writer', model: 'large' });
    expect(reviewed.status).toBe(200);
    expect(fableLoom.reviewSeriesPlan).toHaveBeenCalledWith('loom-1', { providerId: 'writer', model: 'large' });

    fableLoom.feedbackSeriesPlan.mockResolvedValueOnce({ loom: { id: 'loom-1' }, changes: ['Moved midpoint'] });
    const edited = await request(makeApp())
      .post('/api/fableloom/loom-1/plan/feedback')
      .send({ feedback: 'Move the midpoint earlier.' });
    expect(edited.status).toBe(200);
    expect(fableLoom.feedbackSeriesPlan).toHaveBeenCalledWith('loom-1', { feedback: 'Move the midpoint earlier.' });

    const invalid = await request(makeApp()).post('/api/fableloom/loom-1/plan/feedback').send({ feedback: '   ' });
    expect(invalid.status).toBe(400);
    expect(fableLoom.feedbackSeriesPlan).toHaveBeenCalledTimes(1);
  });

  it('validates and forwards structured series-plan patches', async () => {
    const seriesPlan = {
      storyArc: 'A courier becomes a leader.',
      plotPoints: [{ id: 'plot-1', title: 'The choice', description: 'She stays.', episodeId: 'ep-1' }],
      sideQuests: [{ id: 'quest-1', title: 'Lost map', description: 'Recover it.', status: 'active', startEpisodeId: 'ep-1', endEpisodeId: null }],
    };
    fableLoom.updateLoom.mockResolvedValueOnce({ id: 'loom-1', seriesPlan });
    const response = await request(makeApp()).patch('/api/fableloom/loom-1').send({ seriesPlan });
    expect(response.status).toBe(200);
    expect(fableLoom.updateLoom).toHaveBeenCalledWith('loom-1', { seriesPlan });
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

  it('POST transitions mints one path and answers with the loom plus the row', async () => {
    fableLoom.addNodeTransition.mockResolvedValueOnce({
      loom: { id: 'loom-1' }, transition: { id: 'tr-1', targetNodeId: 'node-2', intent: 'press on' },
    });
    const created = await request(makeApp())
      .post('/api/fableloom/loom-1/episodes/ep-1/nodes/node-1/transitions')
      .send({ targetNodeId: 'node-2', intent: 'press on', triggers: ['keep going'] });
    expect(created.status).toBe(201);
    expect(created.body.transition.id).toBe('tr-1');
    expect(fableLoom.addNodeTransition).toHaveBeenCalledWith('loom-1', 'ep-1', 'node-1', {
      targetNodeId: 'node-2', intent: 'press on', triggers: ['keep going'],
    });
  });

  it('POST transitions rejects a body with no target and never mints an id client-side', async () => {
    const noTarget = await request(makeApp())
      .post('/api/fableloom/loom-1/episodes/ep-1/nodes/node-1/transitions')
      .send({ intent: 'press on' });
    expect(noTarget.status).toBe(400);
    expect(fableLoom.addNodeTransition).not.toHaveBeenCalled();

    fableLoom.addNodeTransition.mockResolvedValueOnce({ loom: { id: 'loom-1' }, transition: { id: 'tr-2' } });
    await request(makeApp())
      .post('/api/fableloom/loom-1/episodes/ep-1/nodes/node-1/transitions')
      .send({ targetNodeId: 'node-2', intent: 'press on', id: 'tr-mine' });
    expect(fableLoom.addNodeTransition).toHaveBeenCalledWith('loom-1', 'ep-1', 'node-1', {
      targetNodeId: 'node-2', intent: 'press on',
    });
  });

  it('PATCH/DELETE transitions dispatch with the transition id', async () => {
    fableLoom.updateNodeTransition.mockResolvedValueOnce({ id: 'loom-1' });
    const patched = await request(makeApp())
      .patch('/api/fableloom/loom-1/episodes/ep-1/nodes/node-1/transitions/tr-1')
      .send({ intent: '' });
    expect(patched.status).toBe(200);
    expect(fableLoom.updateNodeTransition).toHaveBeenCalledWith('loom-1', 'ep-1', 'node-1', 'tr-1', { intent: '' });

    fableLoom.deleteNodeTransition.mockResolvedValueOnce({ id: 'loom-1' });
    const removed = await request(makeApp())
      .delete('/api/fableloom/loom-1/episodes/ep-1/nodes/node-1/transitions/tr-1');
    expect(removed.status).toBe(200);
    expect(fableLoom.deleteNodeTransition).toHaveBeenCalledWith('loom-1', 'ep-1', 'node-1', 'tr-1');
  });

  it('PATCH nodes still accepts the whole transitions array (back-compat)', async () => {
    fableLoom.updateNode.mockResolvedValueOnce({ id: 'loom-1' });
    const rows = [{ id: 'tr-1', targetNodeId: 'node-2', intent: 'press on' }];
    const response = await request(makeApp())
      .patch('/api/fableloom/loom-1/episodes/ep-1/nodes/node-1')
      .send({ transitions: rows });
    expect(response.status).toBe(200);
    expect(fableLoom.updateNode).toHaveBeenCalledWith('loom-1', 'ep-1', 'node-1', { transitions: rows });
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

  it('POST weave ignores legacy count hints and forwards current options', async () => {
    fableLoom.weaveEpisode.mockResolvedValueOnce({ loom: { id: 'loom-1' }, runId: 'r' });
    const ok = await request(makeApp())
      .post('/api/fableloom/loom-1/episodes/ep-1/weave')
      .send({ guidance: 'darker', replace: true, nodeTarget: 999, endingTarget: 999 });
    expect(ok.status).toBe(200);
    expect(fableLoom.weaveEpisode).toHaveBeenCalledWith('loom-1', 'ep-1', { guidance: 'darker', replace: true });
  });

  it('POST feedback requires an instruction and forwards the route selection', async () => {
    const invalid = await request(makeApp())
      .post('/api/fableloom/loom-1/episodes/ep-1/feedback')
      .send({ feedback: '   ' });
    expect(invalid.status).toBe(400);
    expect(fableLoom.feedbackEpisode).not.toHaveBeenCalled();

    fableLoom.feedbackEpisode.mockResolvedValueOnce({ loom: { id: 'loom-1' }, changedScenes: 1 });
    const ok = await request(makeApp())
      .post('/api/fableloom/loom-1/episodes/ep-1/feedback')
      .send({ feedback: 'Tighten the opening.', providerId: 'writer', model: 'large', effort: 'high' });
    expect(ok.status).toBe(200);
    expect(fableLoom.feedbackEpisode).toHaveBeenCalledWith('loom-1', 'ep-1', {
      feedback: 'Tighten the opening.', providerId: 'writer', model: 'large', effort: 'high',
    });
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

  it('POST reformat is episode-scoped, validates the target format, and forwards it', async () => {
    const invalid = await request(makeApp())
      .post('/api/fableloom/loom-1/episodes/ep-1/reformat')
      .send({ format: 'haiku' });
    expect(invalid.status).toBe(400);
    expect(fableLoom.reformatEpisodeScenes).not.toHaveBeenCalled();

    fableLoom.reformatEpisodeScenes.mockResolvedValueOnce({ loom: { id: 'loom-1' }, rewritten: 3 });
    const ok = await request(makeApp())
      .post('/api/fableloom/loom-1/episodes/ep-1/reformat')
      .send({ format: 'teleplay', providerId: 'claude' });
    expect(ok.status).toBe(200);
    expect(fableLoom.reformatEpisodeScenes).toHaveBeenCalledWith('loom-1', 'ep-1', { format: 'teleplay', providerId: 'claude' });

    // The loom-scoped route is gone: one request per episode is the whole point
    // of the change, so a caller still hitting the old path must fail loudly
    // rather than quietly rewriting nothing.
    const legacy = await request(makeApp())
      .post('/api/fableloom/loom-1/reformat')
      .send({ format: 'teleplay' });
    expect(legacy.status).toBe(404);
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

  describe('QR-Hosted Sessions API', () => {
    it('POST preflight checks readiness', async () => {
      fableLoom.checkHostedSessionReadiness.mockResolvedValueOnce({ ready: true, checks: { https: { ok: true } } });
      const res = await request(makeApp()).post('/api/fableloom/loom-1/episodes/ep-1/sessions/preflight');
      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(true);
      expect(fableLoom.checkHostedSessionReadiness).toHaveBeenCalledWith({ loomId: 'loom-1', episodeId: 'ep-1' });
    });

    it('POST host creates hosted session', async () => {
      fableLoom.createHostedSession.mockResolvedValueOnce({ session: { id: 'sess-1' }, token: 'abc' });
      const res = await request(makeApp())
        .post('/api/fableloom/loom-1/episodes/ep-1/sessions/host')
        .send({ audioTarget: 'host' });
      expect(res.status).toBe(201);
      expect(res.body.session.id).toBe('sess-1');
      expect(fableLoom.createHostedSession).toHaveBeenCalledWith('loom-1', 'ep-1', { audioTarget: 'host' });
    });

    it('GET sessions/:sessionId retrieves session or 404s', async () => {
      fableLoom.getHostedSession.mockReturnValueOnce({ id: 'sess-1', status: 'active' });
      const res = await request(makeApp()).get('/api/fableloom/sessions/sess-1');
      expect(res.status).toBe(200);
      expect(res.body.id).toBe('sess-1');

      fableLoom.getHostedSession.mockReturnValueOnce(null);
      const notFound = await request(makeApp()).get('/api/fableloom/sessions/sess-2');
      expect(notFound.status).toBe(404);
    });

    it('PATCH sessions/:sessionId updates session', async () => {
      fableLoom.updateHostedSession.mockReturnValueOnce({ id: 'sess-1', audioTarget: 'audience' });
      const res = await request(makeApp())
        .patch('/api/fableloom/sessions/sess-1')
        .send({ audioTarget: 'audience' });
      expect(res.status).toBe(200);
      expect(res.body.audioTarget).toBe('audience');
    });

    it('DELETE sessions/:sessionId ends session', async () => {
      fableLoom.endHostedSession.mockReturnValueOnce({ ok: true });
      const res = await request(makeApp()).delete('/api/fableloom/sessions/sess-1');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(fableLoom.endHostedSession).toHaveBeenCalledWith('sess-1', { reason: 'api_deleted' });
    });
  });
});


import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./apiCore.js', () => ({
  request: vi.fn(),
}));

let request;
let api;

beforeEach(async () => {
  vi.resetModules();
  ({ request } = await import('./apiCore.js'));
  api = await import('./apiFableLoom.js');
  request.mockReset();
  request.mockResolvedValue({});
});

describe('apiFableLoom', () => {
  it('lists every loom when no series scope is given', async () => {
    await api.listLooms({ silent: true });
    expect(request).toHaveBeenCalledWith('/fableloom', { silent: true });
  });

  it('scopes the index to one series and keeps the remaining request options', async () => {
    await api.listLooms({ seriesId: 'ser/1', silent: true });
    expect(request).toHaveBeenCalledWith('/fableloom?seriesId=ser%2F1', { silent: true });
  });

  it('encodes ids in nested node paths', async () => {
    await api.updateLoomNode('loom/1', 'ep/1', 'node/1', { prose: 'x' }, { silent: true });
    expect(request).toHaveBeenCalledWith('/fableloom/loom%2F1/episodes/ep%2F1/nodes/node%2F1', {
      method: 'PATCH',
      body: JSON.stringify({ prose: 'x' }),
      silent: true,
    });
  });

  it('posts weave options to the episode weave lane', async () => {
    await api.weaveLoomEpisode('loom-1', 'ep-1', { guidance: 'darker', replace: true });
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/episodes/ep-1/weave', {
      method: 'POST',
      body: JSON.stringify({ guidance: 'darker', replace: true }),
    });
  });

  it('posts series-plan generation, analysis, and feedback', async () => {
    await api.generateLoomSeriesPlan('loom-1', { providerId: 'writer', effort: 'high' }, { silent: true });
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/plan/generate', {
      method: 'POST', body: JSON.stringify({ providerId: 'writer', effort: 'high' }), silent: true,
    });

    await api.reviewLoomSeriesPlan('loom/1', { providerId: 'writer' }, { silent: true });
    expect(request).toHaveBeenCalledWith('/fableloom/loom%2F1/plan/review', {
      method: 'POST', body: JSON.stringify({ providerId: 'writer' }), silent: true,
    });

    await api.feedbackLoomSeriesPlan('loom-1', { feedback: 'Raise the stakes.' });
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/plan/feedback', {
      method: 'POST', body: JSON.stringify({ feedback: 'Raise the stakes.' }),
    });
  });

  it('posts play turns with the transcript', async () => {
    const body = { nodeId: 'node-1', message: 'open the gate', transcript: [] };
    await api.playLoomTurn('loom-1', 'ep-1', body);
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/episodes/ep-1/play', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  it('posts conversational episode feedback', async () => {
    await api.feedbackLoomEpisode('loom-1', 'ep-1', {
      feedback: 'Make the opening more urgent.', providerId: 'writer', model: 'large', effort: 'high',
    });
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/episodes/ep-1/feedback', {
      method: 'POST',
      body: JSON.stringify({
        feedback: 'Make the opening more urgent.', providerId: 'writer', model: 'large', effort: 'high',
      }),
    });
  });

  it('reads validation silently for the polling panel', async () => {
    await api.validateLoomEpisode('loom-1', 'ep-1', { silent: true });
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/episodes/ep-1/validate', { silent: true });
  });

  it('posts a new path to the node transitions sub-resource', async () => {
    await api.addLoomTransition('loom-1', 'ep-1', 'node-1', { targetNodeId: 'node-2', intent: '' }, { silent: true });
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/episodes/ep-1/nodes/node-1/transitions', {
      method: 'POST',
      body: JSON.stringify({ targetNodeId: 'node-2', intent: '' }),
      silent: true,
    });
  });

  it('patches and deletes one path by id, encoding every segment', async () => {
    await api.updateLoomTransition('loom-1', 'ep-1', 'node-1', 'tr/1', { intent: 'press on' });
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/episodes/ep-1/nodes/node-1/transitions/tr%2F1', {
      method: 'PATCH',
      body: JSON.stringify({ intent: 'press on' }),
    });

    await api.deleteLoomTransition('loom-1', 'ep-1', 'node-1', 'tr-1');
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/episodes/ep-1/nodes/node-1/transitions/tr-1', {
      method: 'DELETE',
    });
  });

  it('deletes nodes with DELETE', async () => {
    await api.deleteLoomNode('loom-1', 'ep-1', 'node-1');
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/episodes/ep-1/nodes/node-1', { method: 'DELETE' });
  });
});

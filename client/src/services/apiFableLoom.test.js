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

  it('starts and polls one encoded fal.ai browser job path', async () => {
    const body = { prompt: 'One continuous example shot.', aspectRatio: '9:16' };
    await api.startLoomFalVideo('loom/1', 'ep/1', 'node/1', body, { silent: true });
    expect(request).toHaveBeenCalledWith('/fableloom/loom%2F1/episodes/ep%2F1/nodes/node%2F1/fal-video', {
      method: 'POST', body: JSON.stringify(body), silent: true,
    });

    await api.getLoomFalVideo('loom/1', 'ep/1', 'node/1', 'fal/1', { silent: true });
    expect(request).toHaveBeenCalledWith(
      '/fableloom/loom%2F1/episodes/ep%2F1/nodes/node%2F1/fal-video/fal%2F1',
      { silent: true },
    );
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

  it('routes editorial remediation, playthrough review, and bounded autopilot operations', async () => {
    await api.remediateLoomEditorial('loom/1', { providerId: 'writer' }, { silent: true });
    expect(request).toHaveBeenCalledWith('/fableloom/loom%2F1/editorial/remediate', {
      method: 'POST', body: JSON.stringify({ providerId: 'writer' }), silent: true,
    });

    await api.reviewLoomPlaythroughs('loom-1', { aiReview: true });
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/playtest', {
      method: 'POST', body: JSON.stringify({ aiReview: true }),
    });

    await api.startLoomEditorialAutopilot('loom-1', { maxRounds: 3, selfImprove: true });
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/editorial/autopilot/start', {
      method: 'POST', body: JSON.stringify({ maxRounds: 3, selfImprove: true }),
    });

    await api.getLoomEditorialAutopilotStatus('loom-1', { silent: true });
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/editorial/autopilot/status', { silent: true });

    await api.getLoomEditorialAutopilotRun('loom-1', 'run/1', { silent: true });
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/editorial/autopilot/run%2F1', { silent: true });

    await api.cancelLoomEditorialAutopilot('loom-1', 'run-1');
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/editorial/autopilot/run-1/cancel', {
      method: 'POST', body: JSON.stringify({}),
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

  it('posts production planning and batch operations', async () => {
    await api.planLoomEpisodeProduction('loom-1', 'ep-1', { mode: 'current_canon' });
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/episodes/ep-1/production/plan', {
      method: 'POST',
      body: JSON.stringify({ mode: 'current_canon' }),
    });

    await api.startLoomEpisodeProductionBatch('loom-1', 'ep-1', { mode: 'exact_inputs' });
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/episodes/ep-1/production/batch', {
      method: 'POST',
      body: JSON.stringify({ mode: 'exact_inputs' }),
    });

    await api.getLoomEpisodeProductionBatch('loom-1', 'ep-1', 'batch-1', { silent: true });
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/episodes/ep-1/production/batch/batch-1', { silent: true });

    await api.cancelLoomEpisodeProductionBatch('loom-1', 'ep-1', 'batch-1');
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/episodes/ep-1/production/batch/batch-1/cancel', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    await api.resumeLoomEpisodeProductionBatch('loom-1', 'ep-1', 'batch/1', { silent: true });
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/episodes/ep-1/production/batch/batch%2F1/resume', {
      method: 'POST',
      body: JSON.stringify({}),
      silent: true,
    });
  });

  it('posts episodic continuity review', async () => {
    await api.reviewLoomEpisodeContinuity('loom-1', 'ep-1');
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/episodes/ep-1/continuity/review', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  });
});

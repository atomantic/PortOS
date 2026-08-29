import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const attachNodeVideo = vi.fn(async (loomId, episodeId, nodeId, { videoHistoryId }) => ({
  id: nodeId, videoHistoryId,
}));
vi.mock('./fableLoom/records.js', () => ({ attachNodeVideo }));

const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const hook = await import('./fableLoomSceneVideoHook.js');

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor: predicate never became true');
}

const tag = (over = {}) => ({ loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1', ...over });
const completedVideoJob = ({ params = {}, id = 'video-1', generationId, queuedAt } = {}) => ({
  kind: 'video', id, params,
  result: { generationId: generationId ?? id, filename: `${id}.mp4` },
  ...(queuedAt ? { queuedAt } : {}),
});

describe('fableLoomSceneVideoHook', () => {
  beforeEach(() => {
    hook.__testing.reset();
    hook.initFableLoomSceneVideoHook();
    attachNodeVideo.mockClear();
  });

  afterEach(() => hook.__testing.reset());

  it('files a completed fableLoom-tagged video onto its node', async () => {
    mediaJobEvents.emit('completed', completedVideoJob({ params: { fableLoom: tag() } }));
    await waitFor(() => attachNodeVideo.mock.calls.length > 0);
    expect(attachNodeVideo).toHaveBeenCalledWith('loom-1', 'ep-1', 'node-1', { videoHistoryId: 'video-1' });
  });

  it('falls back to the queue job id when generationId is absent', async () => {
    mediaJobEvents.emit('completed', {
      kind: 'video', id: 'video-2', params: { fableLoom: tag() }, result: { filename: 'video-2.mp4' },
    });
    await waitFor(() => attachNodeVideo.mock.calls.length > 0);
    expect(attachNodeVideo.mock.calls[0][3]).toEqual({ videoHistoryId: 'video-2' });
  });

  it('ignores image jobs and videos without a complete destination tag', async () => {
    mediaJobEvents.emit('completed', { kind: 'image', id: 'image-1', params: { fableLoom: tag() }, result: { filename: 'image-1.png' } });
    mediaJobEvents.emit('completed', completedVideoJob({ params: { fableLoom: { loomId: 'loom-1' } } }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(attachNodeVideo).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the project store so the hook's tag-decode + serialize + emit logic is
// exercised without touching disk or a DB. `updateScene` is reprogrammed
// per-test to stand in for the durable attach.
const updateScene = vi.fn(async (projectId, sceneId, patch) => ({ sceneId, ...patch }));
vi.mock('./musicVideo/projects.js', () => ({ updateScene }));

const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const { musicVideoEvents } = await import('./musicVideo/events.js');
const hook = await import('./musicVideoSceneVideoHook.js');

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: predicate never became true');
}

const tag = (over = {}) => ({ projectId: 'mv-1', sceneId: 'mvs-1', ...over });
// A completed video job: the queue stores the videoGenEvents 'completed' payload
// as job.result, which echoes the history id as generationId.
const completedVideoJob = ({ params = {}, id = 'vid-abc', generationId, queuedAt } = {}) => ({
  kind: 'video', id, params,
  result: { generationId: generationId ?? id, filename: `${id}.mp4`, path: `/data/videos/${id}.mp4` },
  ...(queuedAt ? { queuedAt } : {}),
});

describe('musicVideoSceneVideoHook', () => {
  let emitted;
  const capture = (data) => emitted.push(data);

  beforeEach(() => {
    hook.__testing.reset();
    hook.initMusicVideoSceneVideoHook();
    updateScene.mockReset();
    updateScene.mockImplementation(async (projectId, sceneId, patch) => ({ sceneId, ...patch }));
    emitted = [];
    musicVideoEvents.on('scene-video', capture);
  });

  afterEach(() => {
    hook.__testing.reset();
    musicVideoEvents.off('scene-video', capture);
  });

  it('attaches the clip history id and emits scene-video for a musicVideo-tagged video job', async () => {
    mediaJobEvents.emit('completed', completedVideoJob({
      params: { musicVideo: tag(), prompt: 'a neon skyline dolly' }, id: 'vid-abc',
    }));
    await waitFor(() => emitted.length > 0);
    expect(updateScene).toHaveBeenCalledWith('mv-1', 'mvs-1', { videoHistoryId: 'vid-abc' });
    expect(emitted[0]).toEqual({ projectId: 'mv-1', sceneId: 'mvs-1', videoHistoryId: 'vid-abc' });
  });

  it('falls back to job.id when the result omits generationId', async () => {
    mediaJobEvents.emit('completed', { kind: 'video', id: 'vid-xyz', params: { musicVideo: tag() }, result: { filename: 'vid-xyz.mp4' } });
    await waitFor(() => emitted.length > 0);
    expect(updateScene).toHaveBeenCalledWith('mv-1', 'mvs-1', { videoHistoryId: 'vid-xyz' });
    expect(emitted[0].videoHistoryId).toBe('vid-xyz');
  });

  it('ignores a completed job with no musicVideo tag', async () => {
    mediaJobEvents.emit('completed', completedVideoJob({ params: { prompt: 'plain video-gen render' } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(updateScene).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('ignores a non-video job kind (the image hook owns those)', async () => {
    mediaJobEvents.emit('completed', { kind: 'image', id: 'img1', params: { musicVideo: tag() }, result: { filename: 'img1.png' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(updateScene).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('skips a tag missing projectId or sceneId', async () => {
    mediaJobEvents.emit('completed', completedVideoJob({ params: { musicVideo: { projectId: 'mv-1' } } }));
    mediaJobEvents.emit('completed', completedVideoJob({ params: { musicVideo: { sceneId: 'mvs-1' } } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(updateScene).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('does not emit (or throw) when the attach fails — project/scene deleted mid-render', async () => {
    updateScene.mockRejectedValueOnce(Object.assign(new Error('Project not found'), { status: 404 }));
    mediaJobEvents.emit('completed', completedVideoJob({ params: { musicVideo: tag() } }));
    await waitFor(() => updateScene.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(emitted).toHaveLength(0);
  });

  it('does not let an older render (earlier queuedAt) overwrite a newer clip on the same scene', async () => {
    mediaJobEvents.emit('completed', completedVideoJob({
      params: { musicVideo: tag() }, id: 'new', queuedAt: '2026-06-29T00:00:02.000Z',
    }));
    await waitFor(() => updateScene.mock.calls.length > 0);
    mediaJobEvents.emit('completed', completedVideoJob({
      params: { musicVideo: tag() }, id: 'old', queuedAt: '2026-06-29T00:00:01.000Z',
    }));
    await new Promise((r) => setTimeout(r, 30));
    expect(updateScene).toHaveBeenCalledTimes(1);
    expect(updateScene).toHaveBeenCalledWith('mv-1', 'mvs-1', { videoHistoryId: 'new' });
    expect(emitted.map((e) => e.videoHistoryId)).toEqual(['new']);
  });

  it('serializes attaches for the same project so concurrent renders do not clobber', async () => {
    const order = [];
    let resolveFirst;
    updateScene
      .mockImplementationOnce(() => new Promise((resolve) => {
        order.push('start-1');
        resolveFirst = () => { order.push('end-1'); resolve({ videoHistoryId: 'a' }); };
      }))
      .mockImplementationOnce(async () => { order.push('start-2'); return { videoHistoryId: 'b' }; });

    mediaJobEvents.emit('completed', completedVideoJob({ params: { musicVideo: tag({ sceneId: 'mvs-1' }) }, id: 'a' }));
    mediaJobEvents.emit('completed', completedVideoJob({ params: { musicVideo: tag({ sceneId: 'mvs-2' }) }, id: 'b' }));

    await waitFor(() => order.includes('start-1'));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['start-1']);
    resolveFirst();
    await waitFor(() => order.includes('start-2'));
    expect(order).toEqual(['start-1', 'end-1', 'start-2']);
  });
});

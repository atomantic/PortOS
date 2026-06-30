import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the project store so the hook's tag-decode + serialize logic is
// exercised without touching disk or a DB. `updateScene` is reprogrammed
// per-test to stand in for the durable attach.
const updateScene = vi.fn(async (projectId, sceneId, patch) => ({ sceneId, ...patch }));
vi.mock('./creativeDirector/local.js', () => ({ updateScene }));

const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const hook = await import('./creativeDirectorSceneImageHook.js');

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: predicate never became true');
}

const tag = (over = {}) => ({ projectId: 'cd-1', sceneId: 'scene-1', ...over });
const completedImageJob = ({ params = {}, filename = 'job-abc.png', id = 'job-abc', queuedAt } = {}) => ({
  kind: 'image', id, params, result: { filename }, ...(queuedAt ? { queuedAt } : {}),
});

describe('creativeDirectorSceneImageHook', () => {
  beforeEach(() => {
    hook.__testing.reset();
    hook.initCreativeDirectorSceneImageHook();
    updateScene.mockReset();
    updateScene.mockImplementation(async (projectId, sceneId, patch) => ({ sceneId, ...patch }));
  });

  afterEach(() => {
    hook.__testing.reset();
  });

  it('attaches the rendered filename to sourceImageFile for a creativeDirector-tagged job', async () => {
    mediaJobEvents.emit('completed', completedImageJob({
      params: { creativeDirector: tag(), prompt: 'a cat walks into a noir alley' },
      filename: 'job-abc.png', id: 'job-abc',
    }));
    await waitFor(() => updateScene.mock.calls.length > 0);
    expect(updateScene).toHaveBeenCalledWith('cd-1', 'scene-1', { sourceImageFile: 'job-abc.png' });
  });

  it('ignores a completed job with no creativeDirector tag', async () => {
    mediaJobEvents.emit('completed', completedImageJob({
      params: { musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' } },
    }));
    await new Promise((r) => setTimeout(r, 20));
    expect(updateScene).not.toHaveBeenCalled();
  });

  it('ignores a non-image job kind', async () => {
    mediaJobEvents.emit('completed', { kind: 'video', id: 'v1', params: { creativeDirector: tag() }, result: { filename: 'v1.mp4' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(updateScene).not.toHaveBeenCalled();
  });

  it('skips a tag missing projectId or sceneId', async () => {
    mediaJobEvents.emit('completed', completedImageJob({ params: { creativeDirector: { projectId: 'cd-1' } } }));
    mediaJobEvents.emit('completed', completedImageJob({ params: { creativeDirector: { sceneId: 'scene-1' } } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(updateScene).not.toHaveBeenCalled();
  });

  it('does not throw when the attach fails — project/scene deleted mid-render', async () => {
    updateScene.mockRejectedValueOnce(Object.assign(new Error('Project not found'), { status: 404 }));
    mediaJobEvents.emit('completed', completedImageJob({ params: { creativeDirector: tag() } }));
    await waitFor(() => updateScene.mock.calls.length > 0);
    // No further assertions needed — a thrown rejection inside the hook would
    // surface as an unhandled rejection and fail the test run.
    await new Promise((r) => setTimeout(r, 20));
  });

  it('does not let an older render (earlier queuedAt) overwrite a newer frame on the same scene', async () => {
    mediaJobEvents.emit('completed', completedImageJob({
      params: { creativeDirector: tag() }, filename: 'new.png', id: 'b', queuedAt: '2026-06-29T00:00:02.000Z',
    }));
    await waitFor(() => updateScene.mock.calls.length > 0);
    mediaJobEvents.emit('completed', completedImageJob({
      params: { creativeDirector: tag() }, filename: 'old.png', id: 'a', queuedAt: '2026-06-29T00:00:01.000Z',
    }));
    await new Promise((r) => setTimeout(r, 30));
    expect(updateScene).toHaveBeenCalledTimes(1);
    expect(updateScene).toHaveBeenCalledWith('cd-1', 'scene-1', { sourceImageFile: 'new.png' });
  });

  it('serializes attaches for the same project so concurrent renders do not clobber', async () => {
    const order = [];
    let resolveFirst;
    updateScene
      .mockImplementationOnce(() => new Promise((resolve) => {
        order.push('start-1');
        resolveFirst = () => { order.push('end-1'); resolve({ sourceImageFile: 'a.png' }); };
      }))
      .mockImplementationOnce(async () => { order.push('start-2'); return { sourceImageFile: 'b.png' }; });

    mediaJobEvents.emit('completed', completedImageJob({ params: { creativeDirector: tag({ sceneId: 'scene-1' }) }, filename: 'a.png', id: 'a' }));
    mediaJobEvents.emit('completed', completedImageJob({ params: { creativeDirector: tag({ sceneId: 'scene-2' }) }, filename: 'b.png', id: 'b' }));

    await waitFor(() => order.includes('start-1'));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['start-1']);
    resolveFirst();
    await waitFor(() => order.includes('start-2'));
    expect(order).toEqual(['start-1', 'end-1', 'start-2']);
  });
});

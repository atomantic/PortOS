import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the project store so the hook's tag-decode + serialize + emit logic is
// exercised without touching disk or a DB. `updateScene` is reprogrammed
// per-test to stand in for the durable attach.
const updateScene = vi.fn(async (projectId, sceneId, patch) => ({
  sceneId, ...patch,
}));
vi.mock('./musicVideo/projects.js', () => ({ updateScene }));

const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const { musicVideoEvents } = await import('./musicVideo/events.js');
const hook = await import('./musicVideoSceneImageHook.js');

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: predicate never became true');
}

const tag = (over = {}) => ({ projectId: 'mv-1', sceneId: 'mvs-1', ...over });
const completedImageJob = ({ params = {}, filename = 'job-abc.png', id = 'job-abc', queuedAt } = {}) => ({
  kind: 'image', id, params, result: { filename }, ...(queuedAt ? { queuedAt } : {}),
});

describe('musicVideoSceneImageHook', () => {
  let emitted;
  const capture = (data) => emitted.push(data);

  beforeEach(() => {
    hook.__testing.reset();
    hook.initMusicVideoSceneImageHook();
    updateScene.mockReset();
    updateScene.mockImplementation(async (projectId, sceneId, patch) => ({ sceneId, ...patch }));
    emitted = [];
    musicVideoEvents.on('scene-image', capture);
  });

  afterEach(() => {
    hook.__testing.reset();
    musicVideoEvents.off('scene-image', capture);
  });

  it('attaches the rendered filename and emits scene-image for a musicVideo-tagged job', async () => {
    mediaJobEvents.emit('completed', completedImageJob({
      params: { musicVideo: tag(), prompt: 'a neon skyline' },
      filename: 'job-abc.png', id: 'job-abc',
    }));
    await waitFor(() => emitted.length > 0);
    expect(updateScene).toHaveBeenCalledWith('mv-1', 'mvs-1', { referenceImageId: 'job-abc.png' });
    expect(emitted[0]).toEqual({ projectId: 'mv-1', sceneId: 'mvs-1', referenceImageId: 'job-abc.png' });
  });

  it('ignores a completed job with no musicVideo tag', async () => {
    mediaJobEvents.emit('completed', completedImageJob({
      params: { writersRoom: { workId: 'w', analysisId: 'a', sceneId: 's' } },
    }));
    // Give the async IIFE a chance to run before asserting it did nothing.
    await new Promise((r) => setTimeout(r, 20));
    expect(updateScene).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('ignores a non-image job kind', async () => {
    mediaJobEvents.emit('completed', { kind: 'video', id: 'v1', params: { musicVideo: tag() }, result: { filename: 'v1.mp4' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(updateScene).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('skips a tag missing projectId or sceneId', async () => {
    mediaJobEvents.emit('completed', completedImageJob({ params: { musicVideo: { projectId: 'mv-1' } } }));
    mediaJobEvents.emit('completed', completedImageJob({ params: { musicVideo: { sceneId: 'mvs-1' } } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(updateScene).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('does not emit (or throw) when the attach fails — project/scene deleted mid-render', async () => {
    updateScene.mockRejectedValueOnce(Object.assign(new Error('Project not found'), { status: 404 }));
    mediaJobEvents.emit('completed', completedImageJob({ params: { musicVideo: tag() } }));
    await waitFor(() => updateScene.mock.calls.length > 0);
    // The failed attach must not surface as a scene-image event.
    await new Promise((r) => setTimeout(r, 20));
    expect(emitted).toHaveLength(0);
  });

  it('does not let an older render (earlier queuedAt) overwrite a newer frame on the same scene', async () => {
    // Newer render lands first, then an out-of-order older one completes.
    mediaJobEvents.emit('completed', completedImageJob({
      params: { musicVideo: tag() }, filename: 'new.png', id: 'b', queuedAt: '2026-06-29T00:00:02.000Z',
    }));
    await waitFor(() => updateScene.mock.calls.length > 0);
    mediaJobEvents.emit('completed', completedImageJob({
      params: { musicVideo: tag() }, filename: 'old.png', id: 'a', queuedAt: '2026-06-29T00:00:01.000Z',
    }));
    // Give the older job's handler a chance to run and be dropped.
    await new Promise((r) => setTimeout(r, 30));
    // The newer frame attached; the older one was skipped (never re-attached).
    expect(updateScene).toHaveBeenCalledTimes(1);
    expect(updateScene).toHaveBeenCalledWith('mv-1', 'mvs-1', { referenceImageId: 'new.png' });
    expect(emitted.map((e) => e.referenceImageId)).toEqual(['new.png']);
  });

  it('serializes attaches for the same project so concurrent renders do not clobber', async () => {
    // Resolve order is gated by the queue: a slow first attach must settle before
    // the second begins, so updateScene is never re-entered for the same project.
    const order = [];
    let resolveFirst;
    updateScene
      .mockImplementationOnce(() => new Promise((resolve) => {
        order.push('start-1');
        resolveFirst = () => { order.push('end-1'); resolve({ referenceImageId: 'a.png' }); };
      }))
      .mockImplementationOnce(async () => { order.push('start-2'); return { referenceImageId: 'b.png' }; });

    mediaJobEvents.emit('completed', completedImageJob({ params: { musicVideo: tag({ sceneId: 'mvs-1' }) }, filename: 'a.png', id: 'a' }));
    mediaJobEvents.emit('completed', completedImageJob({ params: { musicVideo: tag({ sceneId: 'mvs-2' }) }, filename: 'b.png', id: 'b' }));

    await waitFor(() => order.includes('start-1'));
    // The second attach must NOT have started while the first is still pending.
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['start-1']);
    resolveFirst();
    await waitFor(() => order.includes('start-2'));
    expect(order).toEqual(['start-1', 'end-1', 'start-2']);
  });
});

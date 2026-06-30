import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the evaluator so the hook's tag-decode + serialize + emit logic is
// exercised without touching disk. `persistSceneImage` is reprogrammed per-test
// to stand in for the durable attach.
const persistSceneImage = vi.fn(async (workId, analysisId, { sceneId, filename, jobId, prompt }) => ({
  analysis: { id: analysisId, sceneImages: { [sceneId]: { filename, jobId, prompt, generatedAt: 't' } } },
  collectionId: 'col-1',
}));
vi.mock('./writersRoom/evaluator.js', () => ({ persistSceneImage }));

const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const { writersRoomEvents } = await import('./writersRoomEvents.js');
const hook = await import('./writersRoomSceneImageHook.js');

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: predicate never became true');
}

const tag = (over = {}) => ({ workId: 'w1', analysisId: 'script', sceneId: 's1', ...over });
const completedImageJob = ({ params = {}, filename = 'job-abc.png', id = 'job-abc' } = {}) => ({
  kind: 'image', id, params, result: { filename },
});

describe('writersRoomSceneImageHook', () => {
  let emitted;
  const capture = (data) => emitted.push(data);

  beforeEach(() => {
    hook.__testing.reset();
    hook.initWritersRoomSceneImageHook();
    persistSceneImage.mockReset();
    persistSceneImage.mockImplementation(async (workId, analysisId, { sceneId, filename, jobId, prompt }) => ({
      analysis: { id: analysisId, sceneImages: { [sceneId]: { filename, jobId, prompt, generatedAt: 't' } } },
      collectionId: 'col-1',
    }));
    emitted = [];
    writersRoomEvents.on('scene-image', capture);
  });

  afterEach(() => {
    hook.__testing.reset();
    writersRoomEvents.off('scene-image', capture);
  });

  it('files a scene image and emits scene-image for a writersRoom-tagged job', async () => {
    mediaJobEvents.emit('completed', completedImageJob({
      params: { writersRoom: tag(), prompt: 'a cinematic alley' },
      filename: 'job-abc.png', id: 'job-abc',
    }));
    await waitFor(() => emitted.length > 0);
    expect(persistSceneImage).toHaveBeenCalledWith('w1', 'script', {
      sceneId: 's1', filename: 'job-abc.png', jobId: 'job-abc', prompt: 'a cinematic alley',
    });
    expect(emitted[0]).toEqual({
      workId: 'w1', analysisId: 'script', sceneId: 's1',
      image: { filename: 'job-abc.png', jobId: 'job-abc', prompt: 'a cinematic alley', generatedAt: 't' },
    });
  });

  it('derives jobId from the filename when the job carries no id', async () => {
    mediaJobEvents.emit('completed', completedImageJob({ params: { writersRoom: tag() }, filename: 'noid.png', id: null }));
    await waitFor(() => persistSceneImage.mock.calls.length > 0);
    expect(persistSceneImage.mock.calls[0][2].jobId).toBe('noid');
    expect(persistSceneImage.mock.calls[0][2].prompt).toBeNull();
  });

  it('serializes two completions for the same analysis (second awaits the first)', async () => {
    const order = [];
    let releaseFirst;
    const firstGate = new Promise((res) => { releaseFirst = res; });
    persistSceneImage.mockImplementation(async (workId, analysisId, { sceneId }) => {
      order.push(`start:${sceneId}`);
      if (sceneId === 's1') await firstGate;
      order.push(`end:${sceneId}`);
      return { analysis: { id: analysisId, sceneImages: { [sceneId]: { filename: 'f' } } }, collectionId: 'c' };
    });
    mediaJobEvents.emit('completed', completedImageJob({ params: { writersRoom: tag({ sceneId: 's1' }) }, id: 'a' }));
    mediaJobEvents.emit('completed', completedImageJob({ params: { writersRoom: tag({ sceneId: 's2' }) }, id: 'b' }));
    // The second must NOT start until the first finishes (same analysis file).
    await waitFor(() => order.length === 1);
    expect(order).toEqual(['start:s1']);
    releaseFirst();
    await waitFor(() => order.length === 4);
    expect(order).toEqual(['start:s1', 'end:s1', 'start:s2', 'end:s2']);
  });

  it('ignores jobs without a writersRoom tag', async () => {
    mediaJobEvents.emit('completed', completedImageJob({ params: { catalogAttach: { ingredientId: 'x' } } }));
    mediaJobEvents.emit('completed', completedImageJob({ params: {} }));
    await new Promise((r) => setTimeout(r, 30));
    expect(persistSceneImage).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('ignores an incomplete writersRoom tag (missing sceneId)', async () => {
    mediaJobEvents.emit('completed', completedImageJob({ params: { writersRoom: { workId: 'w1', analysisId: 'script' } } }));
    await new Promise((r) => setTimeout(r, 30));
    expect(persistSceneImage).not.toHaveBeenCalled();
  });

  it('ignores non-image jobs and jobs with no result filename', async () => {
    mediaJobEvents.emit('completed', { kind: 'video', id: 'v', params: { writersRoom: tag() }, result: { filename: 'v.mp4' } });
    mediaJobEvents.emit('completed', { kind: 'image', id: 'i', params: { writersRoom: tag() }, result: {} });
    await new Promise((r) => setTimeout(r, 30));
    expect(persistSceneImage).not.toHaveBeenCalled();
  });

  it('swallows a persist error without rejecting and emits nothing (best-effort)', async () => {
    persistSceneImage.mockRejectedValueOnce(new Error('disk full'));
    mediaJobEvents.emit('completed', completedImageJob({ params: { writersRoom: tag() } }));
    await new Promise((r) => setTimeout(r, 30));
    expect(emitted).toHaveLength(0);
  });

  it('does not let an older render (earlier queuedAt) overwrite a newer scene frame (#1791)', async () => {
    // Newer render lands first, then an out-of-order older one completes.
    mediaJobEvents.emit('completed', {
      kind: 'image', id: 'b', params: { writersRoom: tag() }, result: { filename: 'new.png' },
      queuedAt: '2026-06-29T00:00:02.000Z',
    });
    await waitFor(() => persistSceneImage.mock.calls.length > 0);
    mediaJobEvents.emit('completed', {
      kind: 'image', id: 'a', params: { writersRoom: tag() }, result: { filename: 'old.png' },
      queuedAt: '2026-06-29T00:00:01.000Z',
    });
    await new Promise((r) => setTimeout(r, 30));
    // The newer frame persisted; the older one was dropped (never re-persisted).
    expect(persistSceneImage).toHaveBeenCalledTimes(1);
    expect(persistSceneImage.mock.calls[0][2].filename).toBe('new.png');
    expect(emitted.map((e) => e.image.filename)).toEqual(['new.png']);
  });

  it('newest-wins is per scene — an older render on a DIFFERENT scene still applies', async () => {
    mediaJobEvents.emit('completed', {
      kind: 'image', id: 'b', params: { writersRoom: tag({ sceneId: 's1' }) }, result: { filename: 'new.png' },
      queuedAt: '2026-06-29T00:00:02.000Z',
    });
    await waitFor(() => persistSceneImage.mock.calls.length > 0);
    // Older queuedAt but a different sceneId — must NOT be dropped.
    mediaJobEvents.emit('completed', {
      kind: 'image', id: 'a', params: { writersRoom: tag({ sceneId: 's2' }) }, result: { filename: 'other.png' },
      queuedAt: '2026-06-29T00:00:01.000Z',
    });
    await waitFor(() => persistSceneImage.mock.calls.length > 1);
    expect(persistSceneImage).toHaveBeenCalledTimes(2);
  });
});

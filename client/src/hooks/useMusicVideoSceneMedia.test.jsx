import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';

const handlers = new Map();
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
    emit: () => {},
  },
}));

const getMusicVideoSceneJobs = vi.fn();
vi.mock('../services/apiMusicVideo.js', () => ({
  addMusicVideoSceneTake: vi.fn(),
  getMusicVideoSceneJobs: (...a) => getMusicVideoSceneJobs(...a),
}));
vi.mock('../services/apiMediaJobs', () => ({ getMediaJob: vi.fn(async () => ({ status: 'failed' })) }));
const generateImage = vi.fn(async () => ({ status: 'queued', jobId: 'new-job' }));
vi.mock('../services/apiSystem.js', () => ({ generateImage: (...a) => generateImage(...a) }));
vi.mock('../services/apiImageVideo.js', () => ({ generateVideo: vi.fn() }));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

const useMusicVideoSceneMedia = (await import('./useMusicVideoSceneMedia.js')).default;

const project = {
  id: 'p1',
  scenes: [
    { sceneId: 's1', order: 0, label: 'Intro', prompt: 'a lighthouse', referenceImageId: null, takes: [] },
    { sceneId: 's2', order: 1, label: 'Verse', prompt: 'a harbor', referenceImageId: null, takes: [] },
  ],
};

const setup = () => {
  const applyScenePatch = vi.fn();
  const view = renderHook(() => useMusicVideoSceneMedia({ project, videoSettings: { settings: {} }, applyScenePatch }));
  return { ...view, applyScenePatch };
};

describe('useMusicVideoSceneMedia in-flight restore and failure chip (#10154)', () => {
  beforeEach(() => { handlers.clear(); generateImage.mockClear(); getMusicVideoSceneJobs.mockReset(); });
  afterEach(cleanup);

  it('restores spinners for the server queue\'s in-flight renders after a reload, and "generate missing" skips them', async () => {
    getMusicVideoSceneJobs.mockResolvedValue({ jobs: [
      { jobId: 'job-a', lane: 'image', sceneId: 's1', status: 'running' },
      { jobId: 'job-b', lane: 'video', sceneId: 's2', status: 'queued' },
    ] });
    const { result } = setup();
    expect(getMusicVideoSceneJobs).toHaveBeenCalledWith('p1', { silent: true });
    await waitFor(() => expect(result.current.genScenes.s1).toBe(true));
    expect(result.current.genVideoScenes.s2).toBe(true);

    act(() => { result.current.generateMissingFrames(); });
    await waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1));
    expect(generateImage.mock.calls[0][0].musicVideo).toMatchObject({ projectId: 'p1', sceneId: 's2' });
  });

  it('a failed lookup leaves the board usable (no restored spinners, no throw)', async () => {
    getMusicVideoSceneJobs.mockRejectedValue(new Error('offline'));
    const { result } = setup();
    await act(async () => { await Promise.resolve(); });
    expect(result.current.genScenes).toEqual({});
  });

  it('folds a persisted scene failure (and its later clearing) onto the scene', async () => {
    getMusicVideoSceneJobs.mockResolvedValue({ jobs: [] });
    const { applyScenePatch } = setup();
    const lastFailure = { lane: 'image', error: 'CUDA out of memory', at: '2026-10-05T00:00:00.000Z' };
    act(() => handlers.get('music-video:scene-failure')({ projectId: 'p1', sceneId: 's1', lastFailure }));
    expect(applyScenePatch).toHaveBeenCalledWith('p1', 's1', { lastFailure });

    // A landed frame's attach event carries lastFailure: null and clears the chip.
    act(() => handlers.get('music-video:scene-image')({ projectId: 'p1', sceneId: 's1', referenceImageId: 'f.png', takes: [], lastFailure: null }));
    expect(applyScenePatch).toHaveBeenLastCalledWith('p1', 's1', { referenceImageId: 'f.png', takes: [], lastFailure: null });
  });
});

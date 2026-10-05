import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const handlers = new Map();
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
    emit: () => {},
  },
}));
const generateVideo = vi.fn();
vi.mock('../services/apiImageVideo.js', () => ({ generateVideo: (...a) => generateVideo(...a) }));
vi.mock('../services/apiSystem.js', () => ({ generateImage: vi.fn() }));
vi.mock('../services/apiMusicVideo.js', () => ({ addMusicVideoSceneTake: vi.fn() }));
const cancelMediaJob = vi.fn(() => Promise.resolve({}));
vi.mock('../services/apiMediaJobs', () => ({ getMediaJob: vi.fn(), cancelMediaJob: (...a) => cancelMediaJob(...a) }));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

const useMusicVideoSceneMedia = (await import('./useMusicVideoSceneMedia.js')).default;

const fire = (event, payload) => act(() => { handlers.get(event)?.(payload); });
const videoSettings = { settings: { backend: 'local' }, audioReactiveSelected: false, videoBlockedReason: '' };
// Ten footage scenes; the last one has no reference frame yet.
const project = {
  id: 'p1',
  scenes: Array.from({ length: 10 }, (_, i) => ({
    sceneId: `s${i}`, order: i, prompt: `shot ${i}`, startSec: i * 4, endSec: i * 4 + 4,
    ...(i < 9 ? { referenceImageId: `f${i}.png` } : {}),
  })),
};

const renderMedia = () => renderHook(() => useMusicVideoSceneMedia({ project, videoSettings, applyScenePatch: vi.fn() }));
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

describe('useMusicVideoSceneMedia clip batch (#10153)', () => {
  beforeEach(() => { handlers.clear(); generateVideo.mockReset(); cancelMediaJob.mockClear(); });

  it('generates a clip for every scene that has a frame while one scene still waits for its own', async () => {
    let n = 0;
    generateVideo.mockImplementation(() => Promise.resolve({ status: 'queued', jobId: `job-${n++}` }));
    const { result } = renderMedia();
    expect(result.current.planMissingVideos().pending).toHaveLength(9);
    act(() => result.current.generateMissingVideos());
    await flush();
    expect(generateVideo).toHaveBeenCalledTimes(9);
    expect(result.current.videoBatch.state).toMatchObject({ total: 9, done: 0, failed: 0 });
    fire('video-gen:started', { generationId: 'job-0' });
    fire('video-gen:progress', { generationId: 'job-0', progress: 0.5 });
    expect(result.current.videoSceneProgress.s0).toEqual({ progress: 0.5 });
    fire('video-gen:completed', { generationId: 'job-0' });
    fire('video-gen:failed', { generationId: 'job-1' });
    expect(result.current.videoBatch.state).toMatchObject({ done: 1, failed: 1 });
  });

  it('Cancel remaining cancels every unfinished job and clears the spinners through the canceled event', async () => {
    let n = 0;
    generateVideo.mockImplementation(() => Promise.resolve({ status: 'queued', jobId: `job-${n++}` }));
    const { result } = renderMedia();
    act(() => result.current.generateMissingVideos());
    await flush();
    fire('video-gen:completed', { generationId: 'job-0' });
    act(() => result.current.videoBatch.cancel());
    expect(cancelMediaJob.mock.calls.map(([id]) => id).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `job-${i + 1}`));
    for (let i = 1; i < 9; i += 1) fire('video-gen:canceled', { generationId: `job-${i}` });
    expect(Object.keys(result.current.genVideoScenes)).toEqual([]);
    expect(result.current.videoBatch.state).toMatchObject({ done: 1, canceled: 8, failed: 0 });
  });
});

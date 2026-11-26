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
vi.mock('../services/apiImageVideo.js', () => ({ generateVideo }));
vi.mock('../services/apiSystem.js', () => ({ generateImage: vi.fn() }));
vi.mock('../services/apiMusicVideo.js', () => ({
  addMusicVideoSceneTake: vi.fn(),
  getMusicVideoSceneJobs: vi.fn(async () => ({ jobs: [] })),
  renderMusicVideoSceneFrame: vi.fn(async () => ({ status: 'queued', jobId: 'frame-job' })),
  renderMusicVideoSceneClip: (_id, _sceneId, body) => generateVideo(body),
}));
const cancelMediaJob = vi.fn(() => Promise.resolve({}));
vi.mock('../services/apiMediaJobs', () => ({ getMediaJob: vi.fn(), cancelMediaJob: (...a) => cancelMediaJob(...a) }));
vi.mock('../components/ui/Toast');

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

  // #16136: a batch on a model with resolution tiers renders drafts; an untiered lane sends no tier.
  it('renders a tiered model as drafts at the draft resolution and leaves an untiered lane alone', async () => {
    generateVideo.mockImplementation(() => Promise.resolve({ status: 'queued', jobId: 'job' }));
    const tiered = { settings: { backend: 'fal', falResolution: '768P' }, audioReactiveSelected: false, videoBlockedReason: '' };
    const { result } = renderHook(() => useMusicVideoSceneMedia({ project, videoSettings: tiered, applyScenePatch: vi.fn() }));
    act(() => result.current.generateMissingVideos());
    await flush();
    expect(generateVideo).toHaveBeenCalledTimes(9);
    for (const [body] of generateVideo.mock.calls) expect(body).toMatchObject({ tier: 'draft', falResolution: '512P' });

    generateVideo.mockClear();
    const local = renderMedia();
    act(() => local.result.current.generateMissingVideos());
    await flush();
    expect(generateVideo.mock.calls.length).toBeGreaterThan(0);
    for (const [body] of generateVideo.mock.calls) expect(body.tier).toBeUndefined();
  });

  it('queues matching LTX inputs for card Render and batch with an omitted greybox set', async () => {
    generateVideo.mockResolvedValue({ status: 'queued', jobId: 'ltx-job' });
    const scene = { ...project.scenes[0], clipLengthSec: 8,
      setReference: { subjectId: 'pier', greyboxShotId: 'wide' }, omittedCatalogSubjectIds: ['pier'] };
    const matchingProject = {
      ...project, scenes: [scene],
      visualSpec: { references: [{ id: 'lead', imageId: 'lead.png', role: 'character', condition: true }] },
    };
    const ltxSettings = {
      settings: { backend: 'local', modelId: 'example-ltx', generationMode: 'ltxReferences' },
      models: [{ id: 'example-ltx', runtime: 'ltx25' }],
    };
    const { result } = renderHook(() => useMusicVideoSceneMedia({
      project: matchingProject, videoSettings: ltxSettings, applyScenePatch: vi.fn(),
    }));
    act(() => result.current.generateMissingVideos());
    await flush();
    fire('video-gen:completed', { generationId: 'ltx-job' });
    await act(() => result.current.generateSceneVideo(scene, {
      card: { prompt: 'Reference sheet: Rider.\n\nGenerated video: A rider turns',
        ltxReferences: true, expectedClipReferenceFiles: ['lead.png'], expectedClipReferenceLabels: ['Rider'] },
    }));

    expect(generateVideo).toHaveBeenCalledTimes(2);
    for (const [body] of generateVideo.mock.calls) {
      expect(body).toMatchObject({ mode: 'ic-ingredients-25', numFrames: 193, icReferenceImageFiles: ['lead.png'] });
    }
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

describe('useMusicVideoSceneMedia shot card Render', () => {
  beforeEach(() => { handlers.clear(); generateVideo.mockReset(); });

  // Uniquely catches a card Render picking up hidden direction, or its Song audio pick not reaching the server.
  it('sends the card prompt untouched, tagged as typed, with its song audio pick', async () => {
    generateVideo.mockResolvedValue({ status: 'queued', jobId: 'job-card' });
    const { result } = renderMedia();
    await act(() => result.current.generateSceneVideo(project.scenes[0], { card: { prompt: 'exactly this', songAudio: true } }));
    const request = generateVideo.mock.calls[0][0];
    expect(request.prompt).toBe('exactly this');
    expect(request.mode).toBe('a2v');
    expect(JSON.parse(request.musicVideo)).toEqual({ projectId: 'p1', sceneId: 's0', compose: true, expectedShot: 'cutaway', promptAsTyped: true, songAudio: true });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';

// Every listener per event, like the real socket: the frame and end-frame
// lanes both listen on music-video:scene-image (#11173).
const listeners = new Map();
const handlers = {
  get: (event) => (data) => [...(listeners.get(event) || [])].forEach((fn) => fn(data)),
  clear: () => listeners.clear(),
};
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => { listeners.set(event, new Set([...(listeners.get(event) || []), fn])); },
    off: (event, fn) => { listeners.get(event)?.delete(fn); },
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
const listCatalogIngredientMedia = vi.fn();
vi.mock('../services/apiCatalog.js', () => ({ listCatalogIngredientMedia: (...a) => listCatalogIngredientMedia(...a) }));

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

describe('useMusicVideoSceneMedia Casting guides (#12763)', () => {
  beforeEach(() => { handlers.clear(); generateImage.mockClear(); getMusicVideoSceneJobs.mockReset(); getMusicVideoSceneJobs.mockResolvedValue({ jobs: [] }); listCatalogIngredientMedia.mockReset(); });
  afterEach(cleanup);

  // Uniquely catches a board render sent without the shot's cast guides, before or after they load.
  it('refuses a frame render until the cast member\'s media loads, then sends only age-compatible guides', async () => {
    let resolveMedia;
    listCatalogIngredientMedia.mockReturnValue(new Promise((resolve) => { resolveMedia = resolve; }));
    const cast = {
      id: 'p2',
      concept: { subjects: [{ id: 'mvc-1', kind: 'character', name: 'Example Lead', ingredientId: 'cat-chr-x' }] },
      scenes: [{ sceneId: 's1', order: 0, label: 'Intro', prompt: 'a lighthouse', referenceImageId: null, takes: [], characterVariant: { ingredientId: 'cat-chr-x', age: 7 } }],
    };
    const { result } = renderHook(() => useMusicVideoSceneMedia({ project: cast, videoSettings: { settings: {} }, applyScenePatch: vi.fn() }));
    expect(listCatalogIngredientMedia).toHaveBeenCalledWith('cat-chr-x', { silent: true });

    let outcome;
    await act(async () => { outcome = await result.current.generateFrame(cast.scenes[0]); });
    expect(outcome).toEqual({ ok: false });
    expect(generateImage).not.toHaveBeenCalled();

    await act(async () => { resolveMedia([
      { mediaKey: 'adult.png', kind: 'reference', library: { variant: { age: 30 }, guide: true } },
      { mediaKey: 'child.png', kind: 'reference', library: { variant: { age: 7 }, guide: true } },
    ]); });
    await act(async () => { await result.current.generateFrame(cast.scenes[0]); });
    expect(generateImage.mock.calls.at(-1)[0].referenceImageFiles).toEqual(['child.png']);
    expect(generateImage.mock.calls.at(-1)[0].musicVideo.castInputs).toEqual({ ingredientId: 'cat-chr-x', guides: ['child.png'], sheets: [] });
  });

  // Uniquely catches a failed reload on tab refocus wiping loaded guides, so renders go out without them.
  it('keeps the loaded guides when a reload on refocus fails', async () => {
    listCatalogIngredientMedia.mockResolvedValueOnce([{ mediaKey: 'child.png', kind: 'reference', library: { variant: { age: 7 }, guide: true } }]);
    const cast = {
      id: 'p3',
      concept: { subjects: [{ id: 'mvc-1', kind: 'character', name: 'Example Lead', ingredientId: 'cat-chr-x' }] },
      scenes: [{ sceneId: 's1', order: 0, label: 'Intro', prompt: 'a lighthouse', referenceImageId: null, takes: [], characterVariant: { ingredientId: 'cat-chr-x', age: 7 } }],
    };
    const { result } = renderHook(() => useMusicVideoSceneMedia({ project: cast, videoSettings: { settings: {} }, applyScenePatch: vi.fn() }));
    await waitFor(() => expect(result.current.castMedia['cat-chr-x']).toHaveLength(1));
    listCatalogIngredientMedia.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(listCatalogIngredientMedia).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.castMedia['cat-chr-x']).toHaveLength(1);
    await act(async () => { await result.current.generateFrame(cast.scenes[0]); });
    expect(generateImage.mock.calls.at(-1)[0].referenceImageFiles).toEqual(['child.png']);
    expect(generateImage.mock.calls.at(-1)[0].musicVideo.castInputs).toEqual({ ingredientId: 'cat-chr-x', guides: ['child.png'], sheets: [] });
  });

  // Uniquely catches a synchronous frame, or a one-tap re-render, posting the take without the guides it sent.
  it('posts the sent guides and a one-tap re-render on a frame that finishes inline', async () => {
    const { addMusicVideoSceneTake } = await import('../services/apiMusicVideo.js');
    addMusicVideoSceneTake.mockReset();
    addMusicVideoSceneTake.mockResolvedValue({ scene: { referenceImageId: 'done.png', takes: [] } });
    generateImage.mockResolvedValueOnce({ filename: 'done.png' });
    listCatalogIngredientMedia.mockResolvedValue([{ mediaKey: 'child.png', kind: 'reference', library: { variant: { age: 7 }, guide: true } }]);
    const cast = {
      id: 'p4',
      concept: { subjects: [{ id: 'mvc-1', kind: 'character', name: 'Example Lead', ingredientId: 'cat-chr-x' }] },
      scenes: [{ sceneId: 's1', order: 0, label: 'Intro', prompt: 'a lighthouse', referenceImageId: null, takes: [], endFramePrompt: 'a sketch', characterVariant: { ingredientId: 'cat-chr-x', age: 7 } }],
    };
    const { result } = renderHook(() => useMusicVideoSceneMedia({ project: cast, videoSettings: { settings: {} }, applyScenePatch: vi.fn() }));
    await waitFor(() => expect(result.current.castMedia['cat-chr-x']).toHaveLength(1));
    await act(async () => { await result.current.generateFrame(cast.scenes[0], { replaceSelection: true }); });
    const castInputs = { ingredientId: 'cat-chr-x', guides: ['child.png'], sheets: [] };
    expect(generateImage.mock.calls.at(-1)[0].musicVideo).toMatchObject({ castInputs, replaceSelection: true });
    expect(addMusicVideoSceneTake).toHaveBeenCalledWith('p4', 's1', {
      kind: 'image', assetId: 'done.png', source: 'generated', castInputs, replaceSelection: true, expectedSelection: null,
    }, { silent: true });
    generateImage.mockResolvedValueOnce({ filename: 'end.png' });
    await act(async () => { await result.current.generateEndFrame(cast.scenes[0], { replaceSelection: true }); });
    expect(generateImage.mock.calls.at(-1)[0].musicVideo).toMatchObject({ slot: 'end', castInputs, replaceSelection: true });
    expect(addMusicVideoSceneTake).toHaveBeenLastCalledWith('p4', 's1', {
      kind: 'endImage', assetId: 'end.png', source: 'generated', castInputs, replaceSelection: true, expectedSelection: null,
    }, { silent: true });
  });
});

describe('useMusicVideoSceneMedia clip from the storyboard panel', () => {
  afterEach(cleanup);

  // Uniquely catches the still render losing the lane the server animates it on.
  it('tags the still render with the lane its clip renders on', async () => {
    const boardProject = { id: 'p5', scenes: [{ sceneId: 's1', order: 0, prompt: 'she laces her skates', panelId: 'pn-1', panelArt: 'panel.png', takes: [], startSec: 0, endSec: 4 }] };
    const { result } = renderHook(() => useMusicVideoSceneMedia({ project: boardProject, videoSettings: { settings: { backend: 'grok' } }, applyScenePatch: vi.fn() }));
    await act(async () => { await result.current.generateFrame(boardProject.scenes[0], { thenClip: { backend: 'grok' } }); });
    expect(generateImage.mock.calls.at(-1)[0].musicVideo).toMatchObject({ projectId: 'p5', sceneId: 's1', thenClip: { backend: 'grok' } });
  });
});

describe('useMusicVideoSceneMedia cold-open clip sound', () => {
  afterEach(cleanup);

  // Uniquely catches a cold-open shot with Clip sound on rendering a silent local clip (or a song shot gaining sound).
  it('asks a local render for sound only on a cold-open shot playing its clip sound', async () => {
    const { generateVideo } = await import('../services/apiImageVideo.js');
    const scene = (sceneId, extra) => ({ sceneId, order: 0, prompt: 'the rink at dawn', referenceImageId: `${sceneId}.png`, takes: [], ...extra });
    const project = { id: 'p6', scenes: [scene('s1', { preMusic: { durationSec: 4, clipVolume: 1 } }), scene('s2', { startSec: 0, endSec: 4 })] };
    const { result } = renderHook(() => useMusicVideoSceneMedia({ project, videoSettings: { settings: { backend: 'local' } }, applyScenePatch: vi.fn() }));
    for (const [index, disableAudio] of [[0, false], [1, true]]) {
      generateVideo.mockResolvedValueOnce({ jobId: `job-${index}`, status: 'queued' });
      await act(async () => { await result.current.generateSceneVideo(project.scenes[index]); });
      expect(generateVideo.mock.calls.at(-1)[0]).toMatchObject({ backend: 'local', disableAudio });
    }
  });
});

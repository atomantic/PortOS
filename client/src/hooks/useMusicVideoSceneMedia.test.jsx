import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import { musicVideoLinkedReferenceId } from '../../../server/lib/musicVideoConditioning.js';

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
const getMediaJob = vi.fn(async () => ({ status: 'failed' }));
vi.mock('../services/apiMediaJobs', () => ({ getMediaJob: (...a) => getMediaJob(...a) }));
const generateImage = vi.fn(async () => ({ status: 'queued', jobId: 'new-job' }));
vi.mock('../services/apiSystem.js', () => ({ generateImage: (...a) => generateImage(...a) }));
vi.mock('../services/apiImageVideo.js', () => ({ generateVideo: vi.fn() }));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
const { default: toast } = await import('../components/ui/Toast');
const toastError = toast.error;
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

describe('useMusicVideoSceneMedia socket reconnect reconcile (#15166)', () => {
  beforeEach(() => { handlers.clear(); getMusicVideoSceneJobs.mockReset(); getMediaJob.mockReset(); toastError.mockClear(); });
  afterEach(() => { cleanup(); getMediaJob.mockReset(); getMediaJob.mockResolvedValue({ status: 'failed' }); });

  const IN_FLIGHT = { jobs: [{ jobId: 'job-a', lane: 'image', sceneId: 's1', status: 'running' }] };

  // Mounts with one restored in-flight frame job, then reconnects with the server's next listing.
  const reconnectWith = async (nextListing) => {
    getMusicVideoSceneJobs.mockResolvedValueOnce(IN_FLIGHT);
    const onReconciled = vi.fn();
    const view = renderHook(() => useMusicVideoSceneMedia({ project, videoSettings: { settings: {} }, applyScenePatch: vi.fn(), onReconciled }));
    await waitFor(() => expect(view.result.current.genScenes.s1).toBe(true));
    getMusicVideoSceneJobs.mockResolvedValueOnce(nextListing);
    await act(async () => { handlers.get('connect')(); });
    return { ...view, onReconciled };
  };

  // Uniquely catches a spinner stranded forever by a terminal event lost in the disconnect gap.
  it('clears a spinner whose job completed during the gap, then reloads the project', async () => {
    getMediaJob.mockResolvedValue({ status: 'completed' });
    const { result, onReconciled } = await reconnectWith({ jobs: [] });
    await waitFor(() => expect(result.current.genScenes.s1).toBeUndefined());
    expect(getMediaJob).toHaveBeenCalledWith('job-a');
    expect(onReconciled).toHaveBeenCalledTimes(1);
    expect(onReconciled).toHaveBeenCalledWith('p1');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('marks the scene failed with one failure toast when the job failed during the gap', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      getMediaJob.mockResolvedValue({ status: 'failed', error: 'CUDA out of memory' });
      const { result } = await reconnectWith({ jobs: [] });
      await waitFor(() => expect(result.current.genScenes.s1).toBeUndefined());
      expect(result.current.failedScenes.frame.s1).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(toastError.mock.calls[0][0]).toContain('CUDA out of memory');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the spinner of a job the server still lists, and does not reload', async () => {
    const { result, onReconciled } = await reconnectWith(IN_FLIGHT);
    expect(getMediaJob).not.toHaveBeenCalled();
    expect(result.current.genScenes.s1).toBe(true);
    expect(onReconciled).not.toHaveBeenCalled();
  });

  it('keeps the spinner when an unlisted job is not terminal yet', async () => {
    getMediaJob.mockResolvedValue({ status: 'running' });
    const { result, onReconciled } = await reconnectWith({ jobs: [] });
    expect(getMediaJob).toHaveBeenCalledWith('job-a');
    expect(result.current.genScenes.s1).toBe(true);
    expect(onReconciled).not.toHaveBeenCalled();
  });

  it('settles a tracked job once even when its live event arrives after the reconcile', async () => {
    getMediaJob.mockResolvedValue({ status: 'completed' });
    const { result, onReconciled } = await reconnectWith({ jobs: [] });
    await waitFor(() => expect(result.current.genScenes.s1).toBeUndefined());
    act(() => handlers.get('image-gen:completed')({ generationId: 'job-a' }));
    expect(onReconciled).toHaveBeenCalledTimes(1);
  });

  // Uniquely catches an older listing landing last and re-lighting a spinner for a job the newer one shows finished.
  it('ignores a stale listing that resolves after a newer reconnect listing', async () => {
    getMusicVideoSceneJobs.mockResolvedValueOnce(IN_FLIGHT);
    getMediaJob.mockResolvedValue({ status: 'completed' });
    const onReconciled = vi.fn();
    const { result } = renderHook(() => useMusicVideoSceneMedia({ project, videoSettings: { settings: {} }, applyScenePatch: vi.fn(), onReconciled }));
    await waitFor(() => expect(result.current.genScenes.s1).toBe(true));
    let resolveStale;
    getMusicVideoSceneJobs.mockReturnValueOnce(new Promise((resolve) => { resolveStale = resolve; }));
    getMusicVideoSceneJobs.mockResolvedValueOnce({ jobs: [] });
    await act(async () => { handlers.get('connect')(); });
    await act(async () => { handlers.get('connect')(); });
    await waitFor(() => expect(result.current.genScenes.s1).toBeUndefined());
    await act(async () => { resolveStale(IN_FLIGHT); });
    expect(result.current.genScenes.s1).toBeUndefined();
    expect(onReconciled).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes the connect listener on unmount', async () => {
    getMusicVideoSceneJobs.mockResolvedValue({ jobs: [] });
    const { unmount } = setup();
    expect(listeners.get('connect')?.size).toBe(1);
    unmount();
    expect(listeners.get('connect')?.size ?? 0).toBe(0);
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

  // Uniquely catches a paid frame going out without the catalog sheet the director picked.
  it.each(['linked', 'guide'])('refuses a frame whose picked %s asset failed to load', async (kind) => {
    listCatalogIngredientMedia.mockRejectedValueOnce(new Error('offline'));
    const cast = {
      id: 'p2',
      concept: { subjects: [{ id: 'mvc-1', kind: 'character', name: 'Example Lead', ingredientId: 'cat-chr-x' }] },
      scenes: [{ sceneId: 's1', order: 0, label: 'Intro', prompt: 'a lighthouse', referenceImageId: null, takes: [], characterVariant: { ingredientId: 'cat-chr-x' }, frameReferenceIds: [kind === 'guide' ? 'mvr-guide-face.png' : musicVideoLinkedReferenceId('face.png')] }],
    };
    const { result } = renderHook(() => useMusicVideoSceneMedia({ project: cast, videoSettings: { settings: {} }, applyScenePatch: vi.fn() }));
    await waitFor(() => expect(result.current.castMedia['cat-chr-x']).toBeNull());
    let outcome;
    await act(async () => { outcome = await result.current.generateFrame(cast.scenes[0]); });
    expect(outcome).toEqual({ ok: false });
    expect(generateImage).not.toHaveBeenCalled();
  });

  // Uniquely catches a failed cast-guide read letting a paid frame or end-frame render go out without the guides.
  it('blocks frame and end-frame renders with a toast after a failed guide read, until reloadCastMedia succeeds', async () => {
    const { default: toast } = await import('../components/ui/Toast');
    toast.error.mockClear();
    listCatalogIngredientMedia.mockRejectedValueOnce(new Error('offline'));
    const cast = {
      id: 'p4',
      concept: { subjects: [{ id: 'mvc-1', kind: 'character', name: 'Example Lead', ingredientId: 'cat-chr-x' }] },
      scenes: [{ sceneId: 's1', order: 0, label: 'Intro', prompt: 'a lighthouse', endFramePrompt: 'dusk', referenceImageId: null, takes: [], characterVariant: { ingredientId: 'cat-chr-x', age: 7 } }],
    };
    const { result } = renderHook(() => useMusicVideoSceneMedia({ project: cast, videoSettings: { settings: {} }, applyScenePatch: vi.fn() }));
    await waitFor(() => expect(result.current.castMedia['cat-chr-x']).toBeNull());
    let a; let b;
    await act(async () => { a = await result.current.generateFrame(cast.scenes[0]); b = await result.current.generateEndFrame(cast.scenes[0]); });
    expect(a).toEqual({ ok: false });
    expect(b).toEqual({ ok: false });
    expect(toast.error).toHaveBeenCalledWith('Cast guides could not be loaded for Example Lead. Retry before rendering.');
    expect(generateImage).not.toHaveBeenCalled();

    let release;
    listCatalogIngredientMedia.mockReset();
    listCatalogIngredientMedia.mockReturnValueOnce(new Promise((r) => { release = r; }));
    await act(async () => { result.current.reloadCastMedia(); });
    expect(result.current.castMedia['cat-chr-x']).toBeUndefined();
    toast.error.mockClear();
    await act(async () => { await result.current.generateFrame(cast.scenes[0]); });
    expect(toast.error).toHaveBeenCalledWith('Cast guides are still loading. Try again in a moment.');
    await act(async () => { release([{ mediaKey: 'child.png', kind: 'reference', library: { variant: { age: 7 }, guide: true } }]); });
    await waitFor(() => expect(result.current.castMedia['cat-chr-x']).toHaveLength(1));
    await act(async () => { await result.current.generateFrame(cast.scenes[0]); });
    expect(generateImage.mock.calls.at(-1)[0].referenceImageFiles).toEqual(['child.png']);
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
    await act(async () => { await result.current.generateFrame(boardProject.scenes[0], { thenClip: { backend: 'grok', songAudio: false } }); });
    expect(generateImage.mock.calls.at(-1)[0].musicVideo).toMatchObject({ projectId: 'p5', sceneId: 's1', thenClip: { backend: 'grok', songAudio: false } });
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

it('sends the clip card\'s expected reference files with the video request', async () => {
  const { generateVideo } = await import('../services/apiImageVideo.js');
  const shot = { sceneId: 's1', order: 0, prompt: 'a rider', referenceImageId: 'start.png', takes: [], startSec: 0, endSec: 4 };
  const project = { id: 'p7', scenes: [shot] };
  const { result } = renderHook(() => useMusicVideoSceneMedia({ project, videoSettings: { settings: { backend: 'grok' } }, applyScenePatch: vi.fn() }));
  generateVideo.mockResolvedValueOnce({ jobId: 'job-reference', status: 'queued' });
  await act(async () => { await result.current.generateSceneVideo(shot, { card: { prompt: shot.prompt, expectedClipReferenceFiles: ['rider.png'] } }); });
  expect(JSON.parse(generateVideo.mock.calls.at(-1)[0].musicVideo)).toMatchObject({ expectedClipReferenceFiles: ['rider.png'] });
  cleanup();
});

it('sends LTX reference sheets separately from the opening frame on a shot', async () => {
  const { generateVideo } = await import('../services/apiImageVideo.js');
  const shot = { sceneId: 's1', shotMode: 'cutaway', prompt: 'A rider turns', referenceImageId: 'start.png',
    startSec: 0, endSec: 4, videoHistoryId: 'selected-video', takes: [] };
  const project = { id: 'p-reference', scenes: [shot] };
  const videoSettings = { settings: { backend: 'local', modelId: 'ltx25_mlx_q8' } };
  const { result } = renderHook(() => useMusicVideoSceneMedia({ project, videoSettings, applyScenePatch: vi.fn() }));
  generateVideo.mockResolvedValueOnce({ jobId: 'job-reference', status: 'queued' });
  await act(async () => { await result.current.generateSceneVideo(shot, {
    target: { numFrames: 123 },
    card: { prompt: 'Reference sheet: Ada.\n\nGenerated video: A rider turns', ltxReferences: true,
      songAudio: false, endFrame: false, expectedClipReferenceFiles: ['ada.png'], expectedClipReferenceLabels: ['Ada'] },
  }); });
  const payload = generateVideo.mock.calls.at(-1)[0];
  expect(payload).toMatchObject({
    modelId: 'ltx25_mlx_q8', mode: 'ic-ingredients-25', numFrames: 129,
    sourceImageFile: 'start.png', icReferenceImageFiles: ['ada.png'],
  });
  expect(JSON.parse(payload.musicVideo)).toMatchObject({ expectedClipReferenceFiles: ['ada.png'], expectedClipReferenceLabels: ['Ada'] });
  expect(payload).not.toHaveProperty('lastImageFile');
  cleanup();
});

it.each([[9, 193], [9.01, 201]])('covers a shot ending at %s when LTX references use the project renderer setting', async (endSec, frames) => {
  const { generateVideo } = await import('../services/apiImageVideo.js');
  const shot = { sceneId: 's1', shotMode: 'cutaway', prompt: 'A rider turns', referenceImageId: 'start.png',
    startSec: 1, endSec, takes: [] };
  const project = { id: 'p-reference', scenes: [shot] };
  const videoSettings = { settings: { backend: 'local', modelId: 'ltx25_mlx_q8' } };
  const { result } = renderHook(() => useMusicVideoSceneMedia({ project, videoSettings, applyScenePatch: vi.fn() }));
  generateVideo.mockResolvedValueOnce({ jobId: 'job-reference', status: 'queued' });
  await act(async () => { await result.current.generateSceneVideo(shot, { card: {
    prompt: 'Reference sheet: Ada.\n\nGenerated video: A rider turns', ltxReferences: true,
    expectedClipReferenceFiles: ['ada.png'], expectedClipReferenceLabels: ['Ada'],
  } }); });
  expect(generateVideo.mock.calls.at(-1)[0]).toMatchObject({ mode: 'ic-ingredients-25', numFrames: frames });
  cleanup();
});

it('asks for a shorter clip when a cold open exceeds the LTX frame limit', async () => {
  const { generateVideo } = await import('../services/apiImageVideo.js');
  const { default: toast } = await import('../components/ui/Toast');
  generateVideo.mockClear();
  toast.error.mockClear();
  const shot = { sceneId: 's1', shotMode: 'cutaway', prompt: 'A rider turns', referenceImageId: 'start.png',
    preMusic: { durationSec: 45 }, takes: [] };
  const project = { id: 'p-reference', scenes: [shot] };
  const videoSettings = { settings: { backend: 'local', modelId: 'ltx25_mlx_q8' } };
  const { result } = renderHook(() => useMusicVideoSceneMedia({ project, videoSettings, applyScenePatch: vi.fn() }));
  let outcome;
  await act(async () => { outcome = await result.current.generateSceneVideo(shot, { card: {
    prompt: 'A rider turns', ltxReferences: true, expectedClipReferenceFiles: ['ada.png'],
  } }); });
  expect(outcome).toEqual({ ok: false });
  expect(generateVideo).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/split it or choose a shorter clip length/i));
  cleanup();
});

// Uniquely catches losing the reference picker's catalog snapshot on start/end still and clip submits.
it('binds shot render inputs to the catalog basis the board displayed', async () => {
  const { generateVideo } = await import('../services/apiImageVideo.js');
  const shot = { sceneId: 's1', prompt: 'A rider turns', endFramePrompt: 'A rider leaves', referenceImageId: 'start.png',
    startSec: 0, endSec: 4, takes: [] };
  const catalogBasis = 'a'.repeat(64);
  const project = { id: 'p-basis', scenes: [shot], castAndSets: { source: 'catalog', catalogCheckin: { basis: catalogBasis, items: [] } } };
  getMusicVideoSceneJobs.mockResolvedValue({ jobs: [] });
  generateImage.mockClear();
  generateVideo.mockResolvedValue({ jobId: 'clip', status: 'queued' });
  const { result } = renderHook(() => useMusicVideoSceneMedia({ project,
    videoSettings: { settings: { backend: 'grok' } }, applyScenePatch: vi.fn() }));
  await act(async () => { await result.current.generateFrame(shot); });
  await act(async () => { await result.current.generateEndFrame(shot); });
  expect(generateImage.mock.calls.map(([body]) => body.musicVideo)).toEqual([
    expect.objectContaining({ catalogBasis, sceneId: 's1' }),
    expect.objectContaining({ catalogBasis, sceneId: 's1', slot: 'end' }),
  ]);
  await act(async () => { await result.current.generateSceneVideo(shot); });
  expect(JSON.parse(generateVideo.mock.calls.at(-1)[0].musicVideo)).toMatchObject({ catalogBasis });
  cleanup();
});

// Uniquely catches a second clip render on one shot clearing (or being blocked by) the first:
// each provider's render keeps its own placeholder until its own job settles (#15128).
it('tracks a local and a grok clip render on the same shot side by side', async () => {
  const { generateVideo } = await import('../services/apiImageVideo.js');
  const shot = { sceneId: 's1', order: 0, prompt: 'a rider', referenceImageId: 'start.png', takes: [], startSec: 0, endSec: 4 };
  const project = { id: 'p-parallel', scenes: [shot] };
  getMusicVideoSceneJobs.mockResolvedValue({ jobs: [] });
  const { result } = renderHook(() => useMusicVideoSceneMedia({ project, videoSettings: { settings: { backend: 'local' } }, applyScenePatch: vi.fn() }));
  generateVideo.mockResolvedValueOnce({ jobId: 'job-local', status: 'queued' });
  await act(async () => { await result.current.generateSceneVideo(shot); });
  generateVideo.mockResolvedValueOnce({ jobId: 'job-grok', status: 'queued' });
  await act(async () => { await result.current.generateSceneVideo(shot, { target: { backend: 'grok' } }); });
  const jobs = () => (result.current.videoSceneJobs.s1 || []).map((job) => [job.jobId, job.label, job.running]);
  expect(jobs()).toEqual([['job-local', 'local', false], ['job-grok', 'grok', false]]);
  act(() => handlers.get('video-gen:progress')({ generationId: 'job-grok', progress: 0.5 }));
  expect(jobs()).toEqual([['job-local', 'local', false], ['job-grok', 'grok', true]]);
  act(() => handlers.get('video-gen:completed')({ generationId: 'job-local' }));
  expect(jobs()).toEqual([['job-grok', 'grok', true]]);
  expect(result.current.genVideoScenes.s1).toBe(true);
  act(() => handlers.get('video-gen:completed')({ generationId: 'job-grok' }));
  expect(result.current.videoSceneJobs.s1).toBeUndefined();
  expect(result.current.genVideoScenes.s1).toBeUndefined();
  cleanup();
});

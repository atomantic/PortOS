import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// Drive the socket handlers the hook registers with `on()`.
const handlers = new Map();
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
    emit: () => {},
  },
}));

const getMediaJob = vi.fn(async () => ({ status: 'failed' }));
vi.mock('../services/apiMediaJobs', () => ({ getMediaJob: (...a) => getMediaJob(...a) }));

const toastError = vi.fn();
vi.mock('../components/ui/Toast', () => ({ default: { error: (...a) => toastError(...a), success: () => {} } }));

const useSceneRenderLifecycle = (await import('./useSceneRenderLifecycle.js')).default;

// An owned failure re-polls the job (800ms timer + fetch) and THEN queues its
// toast on the batch window, so drain timers, microtasks, then the window.
const settleFailureToasts = async () => {
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
};

const fire = (event, payload) => act(() => { handlers.get(event)?.(payload); });

const IMAGE_CFG = {
  attachEvent: 'music-video:scene-image',
  completedEvent: 'image-gen:completed',
  failedEvent: 'image-gen:failed',
  canceledEvent: 'image-gen:canceled',
  failMessage: 'Frame render failed',
};

const renderLane = (overrides = {}) => {
  const apply = vi.fn();
  const view = renderHook(() => useSceneRenderLifecycle({ ...IMAGE_CFG, apply, ...overrides }));
  return { ...view, apply };
};

describe('useSceneRenderLifecycle', () => {
  beforeEach(() => { handlers.clear(); getMediaJob.mockReset(); toastError.mockReset(); });
  afterEach(cleanup);

  it('subscribes to the configured lane events and unsubscribes on unmount', () => {
    const { unmount } = renderLane();
    expect(handlers.has('music-video:scene-image')).toBe(true);
    expect(handlers.has('image-gen:completed')).toBe(true);
    expect(handlers.has('image-gen:failed')).toBe(true);
    expect(handlers.has('image-gen:canceled')).toBe(true);
    unmount();
    expect(handlers.size).toBe(0);
  });

  it('clears the right scene spinner when a tracked job completes', () => {
    const { result } = renderLane();
    act(() => { result.current.startScene('s1'); result.current.trackJob('job-1', 's1'); });
    expect(result.current.genScenes.s1).toBe(true);
    fire('image-gen:completed', { generationId: 'job-1' });
    expect(result.current.genScenes.s1).toBeUndefined();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('attach event folds the asset via apply without touching the spinner', () => {
    const { result, apply } = renderLane();
    act(() => { result.current.startScene('s1'); result.current.trackJob('job-1', 's1'); });
    fire('music-video:scene-image', { projectId: 'p1', sceneId: 's1', referenceImageId: 'img.png' });
    expect(apply).toHaveBeenCalledWith({ projectId: 'p1', sceneId: 's1', referenceImageId: 'img.png' });
    // attach does NOT clear the spinner — only the terminal event does.
    expect(result.current.genScenes.s1).toBe(true);
  });

  it('ignores a terminal event for a job this lane never tracked (orphan stash, no spinner change)', () => {
    const { result } = renderLane();
    act(() => result.current.startScene('s1'));
    fire('image-gen:completed', { generationId: 'unrelated' });
    expect(result.current.genScenes.s1).toBe(true);
  });

  it('trackJob reconciles a completed orphan that raced ahead of the kickoff', () => {
    const { result } = renderLane();
    act(() => result.current.startScene('s1'));
    // Terminal event lands BEFORE trackJob registers the job id.
    fire('image-gen:completed', { generationId: 'job-1' });
    expect(result.current.genScenes.s1).toBe(true); // still spinning — not yet correlated
    act(() => result.current.trackJob('job-1', 's1'));
    expect(result.current.genScenes.s1).toBeUndefined(); // reconciled → spinner cleared
    expect(toastError).not.toHaveBeenCalled();
  });

  it('trackJob reconciles a FAILED orphan and toasts the failure, naming the scene and the reason', () => {
    vi.useFakeTimers();
    const { result } = renderLane({ sceneLabel: (id) => ({ s1: 'Verse 1' })[id] });
    act(() => result.current.startScene('s1'));
    fire('image-gen:failed', { generationId: 'job-1', error: 'CUDA out of memory' });
    act(() => result.current.trackJob('job-1', 's1'));
    expect(result.current.genScenes.s1).toBeUndefined();
    act(() => { vi.runAllTimers(); });
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('Frame render failed: Verse 1 — CUDA out of memory');
    vi.useRealTimers();
  });

  it('collapses a batch of failures into one summary toast instead of one identical toast per scene', async () => {
    vi.useFakeTimers();
    const labels = { s1: 'Intro', s2: 'Verse 1', s3: 'Chorus', s4: 'Bridge' };
    const { result } = renderLane({ sceneLabel: (id) => labels[id] });
    act(() => {
      ['s1', 's2', 's3', 's4'].forEach((id, i) => { result.current.startScene(id); result.current.trackJob(`job-${i}`, id); });
    });
    // Owned failures re-poll the job before toasting (running-cancel disambiguation).
    getMediaJob.mockResolvedValue({ status: 'failed' });
    ['job-0', 'job-1', 'job-2', 'job-3'].forEach((id) => fire('image-gen:failed', { generationId: id, error: 'provider quota exceeded' }));
    await settleFailureToasts();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('Frame render failed for 4 scenes (Intro, Verse 1, Chorus, +1 more) — provider quota exceeded');
    vi.useRealTimers();
  });

  it('does not pop a late failure toast after the board unmounts', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderLane();
    act(() => result.current.startScene('s1'));
    fire('image-gen:failed', { generationId: 'job-1', error: 'boom' });
    act(() => result.current.trackJob('job-1', 's1'));
    unmount();
    act(() => { vi.runAllTimers(); });
    expect(toastError).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('restoreJobs re-lights spinners after a reload and the job terminal event clears the right scene', () => {
    const { result } = renderLane();
    act(() => result.current.restoreJobs([{ jobId: 'job-1', sceneId: 's1' }, { jobId: 'job-2', sceneId: 's2' }]));
    expect(result.current.genScenes).toEqual({ s1: true, s2: true });
    fire('image-gen:completed', { generationId: 'job-2' });
    expect(result.current.genScenes).toEqual({ s1: true });
  });

  it('queued-cancel (canceled with no prior failed) clears the spinner silently', () => {
    const { result } = renderLane();
    act(() => { result.current.startScene('s1'); result.current.trackJob('job-1', 's1'); });
    fire('image-gen:canceled', { generationId: 'job-1' });
    expect(result.current.genScenes.s1).toBeUndefined();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('an owned failure clears the spinner immediately and toasts only after the re-poll confirms it', async () => {
    vi.useFakeTimers();
    getMediaJob.mockResolvedValue({ status: 'failed' });
    const { result } = renderLane();
    act(() => { result.current.startScene('s1'); result.current.trackJob('job-1', 's1'); });
    fire('image-gen:failed', { generationId: 'job-1' });
    // Spinner clears at once; toast is deferred pending the re-poll.
    expect(result.current.genScenes.s1).toBeUndefined();
    expect(toastError).not.toHaveBeenCalled();
    await settleFailureToasts();
    expect(getMediaJob).toHaveBeenCalledWith('job-1');
    expect(toastError).toHaveBeenCalledWith('Frame render failed');
    vi.useRealTimers();
  });

  it('a running-cancel (failed then canceled) cancels the deferred toast — no failure toast', async () => {
    vi.useFakeTimers();
    getMediaJob.mockResolvedValue({ status: 'canceled' });
    const { result } = renderLane();
    act(() => { result.current.startScene('s1'); result.current.trackJob('job-1', 's1'); });
    fire('image-gen:failed', { generationId: 'job-1' });
    // The canceled event arrives before the 800ms timer fires and cancels it.
    fire('image-gen:canceled', { generationId: 'job-1' });
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(toastError).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('a deferred toast whose re-poll resolves to canceled does not fire (running-cancel disambiguation)', async () => {
    vi.useFakeTimers();
    getMediaJob.mockResolvedValue({ status: 'canceled' });
    const { result } = renderLane();
    act(() => { result.current.startScene('s1'); result.current.trackJob('job-1', 's1'); });
    fire('image-gen:failed', { generationId: 'job-1' });
    // Timer fires before the canceled event; the re-poll sees 'canceled' → stays silent.
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(getMediaJob).toHaveBeenCalledWith('job-1');
    expect(toastError).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('reacts only to its configured events — a different lane\'s terminal event is ignored', () => {
    const { result } = renderLane();
    act(() => { result.current.startScene('s1'); result.current.trackJob('job-1', 's1'); });
    // The video lane's terminal event has no handler on this (image) lane, so the
    // image spinner is untouched even on a same job-id collision.
    fire('video-gen:completed', { generationId: 'job-1' });
    expect(result.current.genScenes.s1).toBe(true);
  });
});

describe('useSceneRenderLifecycle progress and settled outcomes (#10153)', () => {
  beforeEach(() => { handlers.clear(); getMediaJob.mockReset(); toastError.mockReset(); });
  afterEach(cleanup);

  const PROGRESS_CFG = { startedEvent: 'image-gen:started', progressEvent: 'image-gen:progress' };

  it('a scene is queued until the job reports running, then carries its progress fraction', () => {
    const { result } = renderLane(PROGRESS_CFG);
    act(() => { result.current.startScene('s1'); result.current.trackJob('job-1', 's1'); });
    expect(result.current.sceneProgress.s1).toBeUndefined();
    fire('image-gen:started', { generationId: 'job-1', totalSteps: 20 });
    expect(result.current.sceneProgress.s1).toEqual({ progress: null });
    fire('image-gen:progress', { generationId: 'job-1', progress: 0.4 });
    expect(result.current.sceneProgress.s1).toEqual({ progress: 0.4 });
    fire('image-gen:progress', { generationId: 'someone-elses', progress: 0.9 });
    expect(result.current.sceneProgress).toEqual({ s1: { progress: 0.4 } });
    fire('image-gen:completed', { generationId: 'job-1' });
    expect(result.current.sceneProgress.s1).toBeUndefined();
  });

  it('reports each tracked job once with its terminal outcome, including an orphan that raced ahead', () => {
    const onSettled = vi.fn();
    const { result } = renderLane({ onSettled });
    act(() => { result.current.startScene('s1'); result.current.startScene('s2'); result.current.startScene('s3'); });
    act(() => { result.current.trackJob('a', 's1'); result.current.trackJob('b', 's2'); });
    fire('image-gen:completed', { generationId: 'a' });
    fire('image-gen:failed', { generationId: 'b' });
    fire('image-gen:canceled', { generationId: 'c' }); // terminal beats trackJob
    act(() => result.current.trackJob('c', 's3'));
    expect(onSettled.mock.calls.map(([e]) => [e.jobId, e.sceneId, e.outcome])).toEqual([
      ['a', 's1', 'completed'], ['b', 's2', 'failed'], ['c', 's3', 'canceled'],
    ]);
  });
});

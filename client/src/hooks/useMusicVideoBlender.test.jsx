import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const handlers = vi.hoisted(() => new Map());
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); },
    off: (event, fn) => { handlers.get(event)?.delete(fn); },
  },
}));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../services/apiMusicVideo.js', () => ({
  getMusicVideoBlender: vi.fn(),
  saveMusicVideoBlenderSettings: vi.fn(),
  createMusicVideoBlenderWorkspace: vi.fn(),
  saveMusicVideoBlenderFile: vi.fn(),
  deleteMusicVideoBlenderFile: vi.fn(),
  syncMusicVideoBlender: vi.fn(),
  renderMusicVideoBlender: vi.fn(),
  clearMusicVideoBlenderFrames: vi.fn(),
  cancelMusicVideoBlenderJob: vi.fn(),
  cancelMusicVideoBlenderJobs: vi.fn(),
  assembleMusicVideoBlenderCut: vi.fn(),
  saveMusicVideoBlenderShotNote: vi.fn(),
  openMusicVideoBlenderShot: vi.fn(),
}));

import useMusicVideoBlender from './useMusicVideoBlender.js';
import toast from '../components/ui/Toast';
import { getMusicVideoBlender, renderMusicVideoBlender, syncMusicVideoBlender } from '../services/apiMusicVideo.js';
import { blenderFilmState } from '../test/blenderFilmFixture.js';

const push = (event, payload) => act(async () => { for (const fn of handlers.get(event) || []) fn(payload); });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const frame = (extra) => ({ projectId: 'mv-test', kind: 'job', job: { id: 'j1', kind: 'render', shotId: 's030', quality: 'preview', status: 'running', index: 9, total: 72, ...extra } });
const jobOf = (result, id = 'j1') => result.current.state.jobs.find((job) => job.id === id);

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  getMusicVideoBlender.mockResolvedValue(blenderFilmState());
});

describe('useMusicVideoBlender', () => {
  it('stays off without a Blender film: no read and no listener', () => {
    const { result } = renderHook(() => useMusicVideoBlender('mv-test', { enabled: false }));
    expect(result.current).toMatchObject({ state: null, status: 'idle' });
    expect(getMusicVideoBlender).not.toHaveBeenCalled();
    expect(handlers.get('music-video:blender')?.size || 0).toBe(0);
  });

  it('keeps a job frame that arrived after a read was issued when the read\'s older answer lands', async () => {
    const first = deferred();
    getMusicVideoBlender.mockReturnValueOnce(first.promise);
    const { result } = renderHook(() => useMusicVideoBlender('mv-test'));
    // The answer in flight was taken before the job started, so it lists no jobs.
    await act(async () => { first.resolve(blenderFilmState()); });
    const refresh = deferred();
    getMusicVideoBlender.mockReturnValueOnce(refresh.promise);
    await push('connect');
    await push('music-video:blender', frame());
    expect(jobOf(result)).toMatchObject({ status: 'running', index: 9 });
    await act(async () => { refresh.resolve(blenderFilmState()); });
    expect(jobOf(result)).toMatchObject({ status: 'running', index: 9 });
    // A read issued after the frame is the newer word on that job.
    getMusicVideoBlender.mockResolvedValueOnce(blenderFilmState({ jobs: [{ ...frame().job, status: 'done' }] }));
    await push('connect');
    await waitFor(() => expect(jobOf(result).status).toBe('done'));
  });

  it('ignores another project\'s frames and re-reads on a state message and on reconnect', async () => {
    const { result } = renderHook(() => useMusicVideoBlender('mv-test'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await push('music-video:blender', { ...frame(), projectId: 'mv-other' });
    await push('music-video:blender', { projectId: 'mv-other', kind: 'state' });
    expect(result.current.state.jobs).toEqual([]);
    expect(getMusicVideoBlender).toHaveBeenCalledTimes(1);
    await push('music-video:blender', { projectId: 'mv-test', kind: 'state' });
    expect(getMusicVideoBlender).toHaveBeenCalledTimes(2);
    await push('connect');
    expect(getMusicVideoBlender).toHaveBeenCalledTimes(3);
  });

  it('runs one read at a time: a burst of state messages costs one more read, not one each', async () => {
    const { result } = renderHook(() => useMusicVideoBlender('mv-test'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const slow = deferred();
    getMusicVideoBlender.mockReturnValueOnce(slow.promise);
    await push('music-video:blender', { projectId: 'mv-test', kind: 'state' });
    await push('music-video:blender', { projectId: 'mv-test', kind: 'state' });
    await push('music-video:blender', { projectId: 'mv-test', kind: 'state' });
    expect(getMusicVideoBlender).toHaveBeenCalledTimes(2);
    await act(async () => { slow.resolve(blenderFilmState()); });
    await waitFor(() => expect(getMusicVideoBlender).toHaveBeenCalledTimes(3));
    await act(async () => {});
    expect(getMusicVideoBlender).toHaveBeenCalledTimes(3);
  });

  it('merges terminal progress immediately and refreshes state and usage only on the follow-up state event', async () => {
    const { result } = renderHook(() => useMusicVideoBlender('mv-test'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    getMusicVideoBlender.mockClear();
    await push('music-video:blender', frame({ status: 'done' }));
    expect(jobOf(result).status).toBe('done');
    expect(getMusicVideoBlender).not.toHaveBeenCalled();
    expect(result.current.usageRevision).toBe(0);
    await push('music-video:blender', { projectId: 'mv-test', kind: 'state' });
    expect(getMusicVideoBlender).toHaveBeenCalledTimes(1);
    expect(result.current.usageRevision).toBe(1);
  });

  it('drops an answer for the project that was open before', async () => {
    const stale = deferred();
    getMusicVideoBlender.mockReturnValueOnce(stale.promise);
    const { result, rerender } = renderHook(({ id }) => useMusicVideoBlender(id), { initialProps: { id: 'mv-test' } });
    const next = blenderFilmState({ manifest: null });
    getMusicVideoBlender.mockResolvedValueOnce(next);
    rerender({ id: 'mv-next' });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { stale.resolve(blenderFilmState()); });
    expect(result.current.state.manifest).toBeNull();
  });

  it('shows the jobs a render queued at once and keeps the state on a failed start', async () => {
    const { result } = renderHook(() => useMusicVideoBlender('mv-test'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    renderMusicVideoBlender.mockResolvedValueOnce({ jobs: [{ ...frame().job, status: 'queued', index: undefined }] });
    let outcome;
    await act(async () => { outcome = await result.current.render({ shotIds: ['s030'], quality: 'preview' }, 's030'); });
    expect(outcome.ok).toBe(true);
    expect(renderMusicVideoBlender).toHaveBeenCalledWith('mv-test', { shotIds: ['s030'], quality: 'preview' }, { silent: true });
    expect(jobOf(result).status).toBe('queued');
    expect(getMusicVideoBlender).toHaveBeenCalledTimes(1);

    renderMusicVideoBlender.mockRejectedValueOnce(Object.assign(new Error('Blender film renders need Trusted local execution'), { status: 409, code: 'MUSIC_VIDEO_BLENDER_NEEDS_TRUSTED_LOCAL' }));
    await act(async () => { outcome = await result.current.render({ shotIds: ['s010'], quality: 'final' }, 's010'); });
    expect(outcome.ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('Blender film renders need Trusted local execution');
    // A refusal means the setup on screen is out of date: read it again.
    expect(getMusicVideoBlender).toHaveBeenCalledTimes(2);
    expect(result.current.pending).toEqual({});
  });

  it('keeps a job a render just queued when a read served before the start lands, and takes a read that lists it', async () => {
    const { result } = renderHook(() => useMusicVideoBlender('mv-test'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const queued = { ...frame().job, status: 'queued', index: undefined };
    // The read left first and was answered before the server queued the job.
    const before = deferred();
    getMusicVideoBlender.mockReturnValueOnce(before.promise);
    await push('connect');
    renderMusicVideoBlender.mockResolvedValueOnce({ jobs: [queued] });
    await act(async () => { await result.current.render({ shotIds: ['s030'], quality: 'preview' }, 's030'); });
    await act(async () => { before.resolve(blenderFilmState()); });
    // Dropping it would re-enable the shot's Render button while the job waits in the queue.
    expect(jobOf(result).status).toBe('queued');

    // The same race the other way round: this read was served after the start, so its copy is the newer one.
    const after = deferred();
    getMusicVideoBlender.mockReturnValueOnce(after.promise);
    await push('connect');
    renderMusicVideoBlender.mockResolvedValueOnce({ jobs: [{ ...queued, id: 'j2', shotId: 's020' }] });
    await act(async () => { await result.current.render({ shotIds: ['s020'], quality: 'preview' }, 's020'); });
    await act(async () => { after.resolve(blenderFilmState({ jobs: [queued, { ...queued, id: 'j2', shotId: 's020', status: 'running', index: 5, total: 108 }] })); });
    expect(jobOf(result, 'j2')).toMatchObject({ status: 'running', index: 5 });
  });

  it('hands a scene conflict back to the caller without a toast', async () => {
    const { result } = renderHook(() => useMusicVideoBlender('mv-test'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    syncMusicVideoBlender.mockRejectedValueOnce(Object.assign(new Error('Two storyboard scenes are not part of this film.'), { status: 409, code: 'MUSIC_VIDEO_BLENDER_SCENES_CONFLICT' }));
    let outcome;
    await act(async () => { outcome = await result.current.sync(); });
    expect(outcome.error.code).toBe('MUSIC_VIDEO_BLENDER_SCENES_CONFLICT');
    expect(toast.error).not.toHaveBeenCalled();
    expect(syncMusicVideoBlender).toHaveBeenCalledWith('mv-test', {}, { silent: true });
  });
});

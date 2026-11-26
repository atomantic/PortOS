import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import useMusicVideoRenderJob from './useMusicVideoRenderJob.js';
import { MockEventSource, lastEventSource } from '../../test/mockEventSource';
import toast from '../ui/Toast';
import { cancelMusicVideoRender, getMusicVideoActiveRender, renderMusicVideoProject } from '../../services/apiMusicVideo.js';

vi.mock('../../services/apiMusicVideo.js', () => ({
  getMusicVideoActiveRender: vi.fn(), renderMusicVideoProject: vi.fn(), musicVideoRenderEventsUrl: id => `/events/${id}`, cancelMusicVideoRender: vi.fn(),
}));
vi.mock('../ui/Toast');
beforeEach(() => { vi.clearAllMocks(); MockEventSource.reset(); vi.stubGlobal('EventSource', MockEventSource); });
afterEach(() => vi.unstubAllGlobals());

it('retains kickoff and terminal failures after the shared SSE slot clears, then clears on retry', async () => {
  renderMusicVideoProject.mockRejectedValueOnce(new Error('Invalid document duration')).mockResolvedValue({ jobId: 'job-example' });
  const onFailed = vi.fn();
  const { result } = renderHook(() => useMusicVideoRenderJob({ onFailed }));
  await act(async () => result.current.start('mv-example'));
  expect(result.current.failure).toEqual({ projectId: 'mv-example', message: 'Invalid document duration' });
  await act(async () => result.current.start('mv-example'));
  expect(result.current.failure).toBeNull();
  act(() => lastEventSource().emit({ type: 'error', error: 'Document capture failed' }));
  expect(result.current.active).toBe(false);
  expect(result.current.failure).toEqual({ projectId: 'mv-example', message: 'Document capture failed' });
  expect(onFailed).toHaveBeenCalledWith('mv-example', 'Document capture failed');
});

// #9940: a reload while the server renders must show the render without a click.
it('reattaches a live final render on load by READING it, never by starting one', async () => {
  getMusicVideoActiveRender.mockResolvedValue({ jobId: 'job-live' });
  const onRendered = vi.fn();
  const { result } = renderHook(() => useMusicVideoRenderJob({ project: { id: 'mv-example', status: 'rendering' }, onRendered }));
  await waitFor(() => expect(result.current.active).toBe(true));
  expect(result.current).toMatchObject({ jobId: 'job-live', context: 'mv-example' });
  expect(getMusicVideoActiveRender).toHaveBeenCalledWith('mv-example', { silent: true });
  // The POST that would start a render is never made by a page load.
  expect(renderMusicVideoProject).not.toHaveBeenCalled();
  act(() => lastEventSource().emit({ type: 'progress', progress: 0.4 }));
  expect(result.current.progress).toBe(40);
  act(() => lastEventSource().emit({ type: 'complete', result: { id: 'hist-example' } }));
  expect(onRendered).toHaveBeenCalledWith('mv-example', { id: 'hist-example' });
});

it('stays idle — and still starts nothing — when no live render is found or the project is not rendering', async () => {
  getMusicVideoActiveRender.mockResolvedValue({ jobId: null });
  const stale = renderHook(() => useMusicVideoRenderJob({ project: { id: 'mv-example', status: 'rendering' } }));
  await waitFor(() => expect(getMusicVideoActiveRender).toHaveBeenCalledTimes(1));
  expect(stale.result.current.active).toBe(false);
  renderHook(() => useMusicVideoRenderJob({ project: { id: 'mv-idle', status: 'complete' } }));
  expect(getMusicVideoActiveRender).toHaveBeenCalledTimes(1);
  expect(renderMusicVideoProject).not.toHaveBeenCalled();
});

it('reattach() is the explicit retry: it attaches a live job and explains when there is none', async () => {
  getMusicVideoActiveRender.mockResolvedValueOnce({ jobId: null });
  const { result } = renderHook(() => useMusicVideoRenderJob({ project: { id: 'mv-example', status: 'complete' } }));
  let found;
  await act(async () => { found = await result.current.reattach('mv-example'); });
  expect(found).toBe(false);
  expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('No live render'));
  getMusicVideoActiveRender.mockResolvedValueOnce({ jobId: 'job-late' });
  await act(async () => { found = await result.current.reattach('mv-example'); });
  expect(found).toBe(true);
  expect(result.current.jobId).toBe('job-late');
});

it('refreshes the project and re-arms Stop when a render is already finishing', async () => {
  const onSettled = vi.fn();
  const error = Object.assign(new Error('Job has finished or is finishing'), { status: 409 });
  cancelMusicVideoRender.mockRejectedValueOnce(error);
  const { result } = renderHook(() => useMusicVideoRenderJob({ onSettled }));
  act(() => result.current.attach('job-live', 'mv-example'));
  act(() => result.current.cancel());
  await waitFor(() => expect(onSettled).toHaveBeenCalledWith('cancel-rejected', 'mv-example'));
  expect(toast.error).toHaveBeenCalledWith(error.message);
  expect(result.current).toMatchObject({ jobId: 'job-live', cancelling: false });
});

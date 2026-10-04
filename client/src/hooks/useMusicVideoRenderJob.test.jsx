import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import useMusicVideoRenderJob from './useMusicVideoRenderJob.js';
import { MockEventSource, lastEventSource } from '../test/mockEventSource';
import toast from '../components/ui/Toast';
import { getMusicVideoActiveRender, renderMusicVideoProject } from '../services/apiMusicVideo.js';

vi.mock('../services/apiMusicVideo.js', () => ({
  getMusicVideoActiveRender: vi.fn(), renderMusicVideoProject: vi.fn(), musicVideoRenderEventsUrl: id => `/events/${id}`, cancelMusicVideoRender: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
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

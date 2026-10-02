import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import useMusicVideoRenderJob from './useMusicVideoRenderJob.js';
import { MockEventSource, lastEventSource } from '../test/mockEventSource';
import { renderMusicVideoProject } from '../services/apiMusicVideo.js';

vi.mock('../services/apiMusicVideo.js', () => ({
  renderMusicVideoProject: vi.fn(), musicVideoRenderEventsUrl: id => `/events/${id}`, cancelMusicVideoRender: vi.fn(),
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

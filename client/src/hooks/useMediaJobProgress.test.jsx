import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';

// Mock the socket module so the test can drive the `image-gen:*` handlers the
// hook registers with `on()`.
const handlers = new Map();
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
    emit: () => {},
  },
}));

// Mock the hydrate fetch so mount doesn't hit the network. Default: an
// in-flight (running) job so the spinner state is the starting point.
const getMediaJob = vi.fn(async () => ({ status: 'running' }));
vi.mock('../services/apiMediaJobs', () => ({ getMediaJob: (...a) => getMediaJob(...a) }));

const useMediaJobProgress = (await import('./useMediaJobProgress.js')).default;

const fire = (event, payload) => act(() => { handlers.get(event)?.(payload); });
// Drain the mount hydrate fetch (a pre-resolved mock promise) inside act so its
// setStatus can't land outside it after the test body.
const settle = () => act(async () => {});

describe('useMediaJobProgress — canceled handling (#1791)', () => {
  beforeEach(() => { handlers.clear(); getMediaJob.mockClear(); getMediaJob.mockResolvedValue({ status: 'running' }); });
  afterEach(cleanup);

  it('settles to canceled on a matching image-gen:canceled without re-fetching', async () => {
    const { result } = renderHook(() => useMediaJobProgress('job-1'));
    await waitFor(() => expect(result.current.status).toBe('running'));
    getMediaJob.mockClear();
    fire('image-gen:canceled', { generationId: 'job-1' });
    expect(result.current.status).toBe('canceled');
    // The canceled event is authoritative — no re-fetch needed (unlike :failed).
    expect(getMediaJob).not.toHaveBeenCalled();
  });

  it('ignores a canceled event for a different job', async () => {
    const { result } = renderHook(() => useMediaJobProgress('job-1'));
    await waitFor(() => expect(result.current.status).toBe('running'));
    fire('image-gen:canceled', { generationId: 'other-job' });
    expect(result.current.status).toBe('running');
  });

  it('subscribes to the video-gen:canceled event when kind=video', async () => {
    renderHook(() => useMediaJobProgress('job-1', { kind: 'video' }));
    await settle();
    expect(handlers.has('video-gen:canceled')).toBe(true);
    expect(handlers.has('image-gen:canceled')).toBe(false);
  });

  // Audio (first-pass music-bed, #1933) rides the audio-gen:* namespace so the
  // Creative Director detail page can surface a failed background render.
  it('subscribes to audio-gen:* events when kind=audio', async () => {
    renderHook(() => useMediaJobProgress('job-1', { kind: 'audio' }));
    await settle();
    expect(handlers.has('audio-gen:failed')).toBe(true);
    expect(handlers.has('audio-gen:completed')).toBe(true);
    expect(handlers.has('image-gen:failed')).toBe(false);
  });

  it('settles to failed on a matching audio-gen:failed with the error', async () => {
    const { result } = renderHook(() => useMediaJobProgress('job-1', { kind: 'audio' }));
    await waitFor(() => expect(result.current.status).toBe('running'));
    // Re-fetch after :failed returns the still-failed job (not a canceled one).
    getMediaJob.mockResolvedValueOnce({ status: 'failed', error: 'sidecar crashed' });
    fire('audio-gen:failed', { generationId: 'job-1', error: 'sidecar crashed' });
    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current.error).toBe('sidecar crashed');
  });

  it('a :failed for a user-canceled running job still corrects to canceled via re-fetch', async () => {
    const { result } = renderHook(() => useMediaJobProgress('job-1'));
    await waitFor(() => expect(result.current.status).toBe('running'));
    // The gen module reports a SIGTERM cancel as a failure; the persisted state
    // is 'canceled', so onFailed re-fetches and corrects.
    getMediaJob.mockResolvedValueOnce({ status: 'canceled', error: 'Canceled while running' });
    fire('image-gen:failed', { generationId: 'job-1', error: 'killed' });
    await waitFor(() => expect(result.current.status).toBe('canceled'));
  });
});

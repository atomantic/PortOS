import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const handlers = new Map();
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
  },
}));
vi.mock('../services/apiMediaJobs', () => ({
  getMediaJob: vi.fn(async () => ({ status: 'running' })),
}));

import useMediaJobProgress from './useMediaJobProgress';

const fire = (event, payload) => act(() => { handlers.get(event)?.(payload); });

describe('useMediaJobProgress — render ETA (#3801)', () => {
  beforeEach(() => { handlers.clear(); });

  it('starts with no estimate', async () => {
    const { result } = renderHook(() => useMediaJobProgress('job-1', { kind: 'video' }));
    // Settle the mount-time GET /api/media-jobs/:id hydration.
    await act(async () => {});
    expect(result.current.etaMs).toBeNull();
  });

  it('picks up the estimate from the started event and repeats it on progress', async () => {
    const { result } = renderHook(() => useMediaJobProgress('job-1', { kind: 'video' }));
    await waitFor(() => expect(handlers.has('video-gen:started')).toBe(true));
    fire('video-gen:started', { generationId: 'job-1', totalSteps: 30, etaMs: 1_800_000 });
    expect(result.current.etaMs).toBe(1_800_000);
    fire('video-gen:progress', { generationId: 'job-1', progress: 0.5, etaMs: 1_800_000 });
    expect(result.current.etaMs).toBe(1_800_000);
  });

  it('keeps the last estimate when a progress frame omits the key', async () => {
    const { result } = renderHook(() => useMediaJobProgress('job-1', { kind: 'video' }));
    await waitFor(() => expect(handlers.has('video-gen:started')).toBe(true));
    fire('video-gen:started', { generationId: 'job-1', etaMs: 600_000 });
    fire('video-gen:progress', { generationId: 'job-1', progress: 0.2 });
    expect(result.current.etaMs).toBe(600_000);
  });

  it('treats an explicit null estimate as "unknown", not as a stale value to keep', async () => {
    const { result } = renderHook(() => useMediaJobProgress('job-1', { kind: 'video' }));
    await waitFor(() => expect(handlers.has('video-gen:started')).toBe(true));
    fire('video-gen:started', { generationId: 'job-1', etaMs: 600_000 });
    fire('video-gen:started', { generationId: 'job-1', etaMs: null });
    expect(result.current.etaMs).toBeNull();
  });

  it('ignores events for a different job', async () => {
    const { result } = renderHook(() => useMediaJobProgress('job-1', { kind: 'video' }));
    await waitFor(() => expect(handlers.has('video-gen:started')).toBe(true));
    fire('video-gen:started', { generationId: 'job-2', etaMs: 600_000 });
    expect(result.current.etaMs).toBeNull();
  });
});

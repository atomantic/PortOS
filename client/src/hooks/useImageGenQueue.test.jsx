import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

const handlers = new Map();
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
    emit: () => {},
  },
}));
const getMediaJob = vi.fn();
vi.mock('../services/apiMediaJobs', () => ({ getMediaJob: (...a) => getMediaJob(...a) }));
vi.mock('../services/apiImageVideo', () => ({ cancelImageGen: vi.fn() }));
vi.mock('../components/ui/Toast', () => ({ default: Object.assign(vi.fn(), { error: vi.fn() }) }));

const useImageGenQueue = (await import('./useImageGenQueue.js')).default;

describe('useImageGenQueue reconnect settle (#15167)', () => {
  beforeEach(() => { vi.useFakeTimers(); handlers.clear(); getMediaJob.mockReset(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('settles and prunes a row left running when its completed event was missed', async () => {
    const { result } = renderHook(() => useImageGenQueue());
    act(() => result.current.register({ jobId: 'job-1', sceneId: 's1', sceneLabel: 'S01' }));
    act(() => handlers.get('image-gen:started')({ generationId: 'job-1' }));
    expect(result.current.renderingCount).toBe(1);

    getMediaJob.mockResolvedValue({ status: 'completed', result: { path: '/data/images/a.png' } });
    await act(async () => { handlers.get('connect')(); });
    expect(getMediaJob).toHaveBeenCalledWith('job-1');
    expect(result.current.renderingCount).toBe(0);
    expect(result.current.queue[0].status).toBe('done');

    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.queue).toEqual([]);
  });

  it('leaves a row alone while the server still reports it running', async () => {
    const { result } = renderHook(() => useImageGenQueue());
    act(() => result.current.register({ jobId: 'job-1', sceneId: 's1', sceneLabel: 'S01' }));
    getMediaJob.mockResolvedValue({ status: 'running' });
    await act(async () => { handlers.get('connect')(); });
    expect(result.current.renderingCount).toBe(1);
  });
});

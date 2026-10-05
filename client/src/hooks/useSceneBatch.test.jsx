import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const cancelMediaJob = vi.fn(() => Promise.resolve({}));
vi.mock('../services/apiMediaJobs', () => ({ cancelMediaJob: (...a) => cancelMediaJob(...a) }));

const useSceneBatch = (await import('./useSceneBatch.js')).default;

describe('useSceneBatch', () => {
  beforeEach(() => cancelMediaJob.mockClear());

  it('counts outcomes only for jobs the batch registered', () => {
    const { result } = renderHook(() => useSceneBatch());
    act(() => { result.current.begin(4); result.current.register('a'); result.current.register('b'); });
    act(() => {
      result.current.settled({ jobId: 'a', outcome: 'completed' });
      result.current.settled({ jobId: 'b', outcome: 'failed' });
      result.current.settled({ jobId: 'unrelated', outcome: 'completed' });
      result.current.kickoffFailed();
      result.current.completedWithoutJob();
    });
    expect(result.current.state).toEqual({ total: 4, done: 2, failed: 2, canceled: 0, cancelRequested: false });
  });

  it('cancel() cancels every unsettled job and counts a running-cancel failure as canceled', () => {
    const { result } = renderHook(() => useSceneBatch());
    act(() => { result.current.begin(3); ['a', 'b', 'c'].forEach(result.current.register); });
    act(() => result.current.settled({ jobId: 'a', outcome: 'completed' }));
    act(() => result.current.cancel());
    expect(cancelMediaJob.mock.calls.map(([id]) => id).sort()).toEqual(['b', 'c']);
    act(() => {
      result.current.settled({ jobId: 'b', outcome: 'failed' }); // running-cancel reports failed first
      result.current.settled({ jobId: 'c', outcome: 'canceled' });
    });
    expect(result.current.state).toMatchObject({ done: 1, failed: 0, canceled: 2, cancelRequested: true });
  });

  it('a kickoff that resolves after cancel is canceled the moment it registers', () => {
    const { result } = renderHook(() => useSceneBatch());
    act(() => { result.current.begin(1); result.current.cancel(); });
    expect(cancelMediaJob).not.toHaveBeenCalled();
    act(() => result.current.register('late'));
    expect(cancelMediaJob).toHaveBeenCalledWith('late', { silent: true });
  });
});

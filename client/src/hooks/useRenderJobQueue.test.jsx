import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRenderJobQueue } from './useRenderJobQueue.js';

describe('useRenderJobQueue', () => {
  it('starts empty', () => {
    const { result } = renderHook(() => useRenderJobQueue());
    expect(result.current.pendingByEntryId).toEqual({});
    expect(result.current.pendingHeadByEntryId).toEqual({});
  });

  it('enqueues variation and canon jobs, skipping other kinds', () => {
    const { result } = renderHook(() => useRenderJobQueue());
    act(() => {
      result.current.enqueueEntryJobs([
        { jobId: 'j1', entryRef: { id: 'a', kind: 'variation' } },
        { jobId: 'j2', entryRef: { id: 'b', kind: 'canon' } },
        { jobId: 'j3', entryRef: { id: 'c', kind: 'sheet' } },
        { jobId: 'j4', entryRef: { id: 'a', kind: 'variation' } },
      ]);
    });
    expect(result.current.pendingByEntryId).toEqual({ a: ['j1', 'j4'], b: ['j2'] });
    // Head map exposes only the first jobId per entry.
    expect(result.current.pendingHeadByEntryId).toEqual({ a: 'j1', b: 'j2' });
  });

  it('ignores malformed entries and no-ops on empty input', () => {
    const { result } = renderHook(() => useRenderJobQueue());
    act(() => {
      result.current.enqueueEntryJobs([]);
      result.current.enqueueEntryJobs([
        { jobId: '', entryRef: { id: 'a', kind: 'variation' } },
        { jobId: 'j1', entryRef: null },
        { jobId: 'j2', entryRef: { kind: 'canon' } },
      ]);
    });
    expect(result.current.pendingByEntryId).toEqual({});
  });

  it('clears a specific jobId and shifts the head forward', () => {
    const { result } = renderHook(() => useRenderJobQueue());
    act(() => {
      result.current.enqueueEntryJobs([
        { jobId: 'j1', entryRef: { id: 'a', kind: 'variation' } },
        { jobId: 'j2', entryRef: { id: 'a', kind: 'variation' } },
      ]);
    });
    act(() => result.current.clearPendingForEntry('a', 'j1'));
    expect(result.current.pendingByEntryId).toEqual({ a: ['j2'] });
    expect(result.current.pendingHeadByEntryId).toEqual({ a: 'j2' });
  });

  it('deletes the entry when the last jobId clears', () => {
    const { result } = renderHook(() => useRenderJobQueue());
    act(() => {
      result.current.enqueueEntryJobs([
        { jobId: 'j1', entryRef: { id: 'a', kind: 'canon' } },
      ]);
    });
    act(() => result.current.clearPendingForEntry('a', 'j1'));
    expect(result.current.pendingByEntryId).toEqual({});
  });

  it('drops every pending job for an entry when no jobId is given', () => {
    const { result } = renderHook(() => useRenderJobQueue());
    act(() => {
      result.current.enqueueEntryJobs([
        { jobId: 'j1', entryRef: { id: 'a', kind: 'variation' } },
        { jobId: 'j2', entryRef: { id: 'a', kind: 'variation' } },
      ]);
    });
    act(() => result.current.clearPendingForEntry('a'));
    expect(result.current.pendingByEntryId).toEqual({});
  });

  it('is a no-op when clearing an unknown entry or with no entryId', () => {
    const { result } = renderHook(() => useRenderJobQueue());
    act(() => {
      result.current.enqueueEntryJobs([
        { jobId: 'j1', entryRef: { id: 'a', kind: 'variation' } },
      ]);
    });
    act(() => {
      result.current.clearPendingForEntry('missing', 'jX');
      result.current.clearPendingForEntry(null);
    });
    expect(result.current.pendingByEntryId).toEqual({ a: ['j1'] });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const getHfTokenStatus = vi.fn();
vi.mock('../services/apiImageVideo.js', () => ({
  getHfTokenStatus: (...a) => getHfTokenStatus(...a),
}));

import { useHfTokenStatus } from './useHfTokenStatus';

describe('useHfTokenStatus', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('starts unknown and resolves to the fetched presence + source', async () => {
    getHfTokenStatus.mockResolvedValue({ hfTokenPresent: true, source: 'env' });
    const { result } = renderHook(() => useHfTokenStatus());
    // Tri-state: unknown BEFORE the fetch settles — callers render nothing here
    // rather than flashing a token nag at someone who has one.
    expect(result.current.present).toBeNull();
    await waitFor(() => expect(result.current.present).toBe(true));
    expect(result.current.source).toBe('env');
  });

  it('leaves the status unknown when the fetch fails, by default', async () => {
    getHfTokenStatus.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useHfTokenStatus());
    await waitFor(() => expect(getHfTokenStatus).toHaveBeenCalled());
    // A transient blip must not read as "no token" — that's the absent-vs-failed rule.
    expect(result.current.present).toBeNull();
  });

  it('reports a failed fetch as absent when the caller opts in', async () => {
    getHfTokenStatus.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useHfTokenStatus({ errorAs: 'absent' }));
    await waitFor(() => expect(result.current.present).toBe(false));
    expect(result.current.source).toBe('none');
  });

  it('does not fetch while disabled, and resets to unknown when disabled again', async () => {
    getHfTokenStatus.mockResolvedValue({ hfTokenPresent: true, source: 'stored' });
    const { result, rerender } = renderHook(({ enabled }) => useHfTokenStatus({ enabled }), {
      initialProps: { enabled: false },
    });
    expect(getHfTokenStatus).not.toHaveBeenCalled();
    expect(result.current.present).toBeNull();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.present).toBe(true));

    // Closing a modal must clear the answer so the next open re-checks rather than
    // showing a stale one.
    rerender({ enabled: false });
    expect(result.current.present).toBeNull();
  });

  it('refresh() re-reads the status after a token is saved', async () => {
    getHfTokenStatus.mockResolvedValue({ hfTokenPresent: false, source: 'none' });
    const { result } = renderHook(() => useHfTokenStatus());
    await waitFor(() => expect(result.current.present).toBe(false));

    getHfTokenStatus.mockResolvedValue({ hfTokenPresent: true, source: 'stored' });
    act(() => { result.current.refresh(); });
    await waitFor(() => expect(result.current.present).toBe(true));
    expect(result.current.source).toBe('stored');
  });

  it('drops a stale in-flight response so it cannot overwrite a newer one', async () => {
    let resolveFirst;
    getHfTokenStatus.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
    const { result } = renderHook(() => useHfTokenStatus());

    // A second read starts and lands while the first is still pending.
    getHfTokenStatus.mockResolvedValue({ hfTokenPresent: true, source: 'stored' });
    act(() => { result.current.refresh(); });
    await waitFor(() => expect(result.current.present).toBe(true));

    // The stale first response now settles — it must NOT clobber the newer answer.
    await act(async () => { resolveFirst({ hfTokenPresent: false, source: 'none' }); });
    expect(result.current.present).toBe(true);
    expect(result.current.source).toBe('stored');
  });
});

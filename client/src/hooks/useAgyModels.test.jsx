import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAgyModels } from './useAgyModels';
import { listAgyImageModels } from '../services/apiImageVideo.js';

vi.mock('../services/apiImageVideo.js', () => ({
  listAgyImageModels: vi.fn(),
}));

describe('useAgyModels', () => {
  beforeEach(() => vi.clearAllMocks());

  // The probe spawns `agy models` server-side. A backend the user hasn't
  // selected must not pay for a child process, so `enabled` gates the call
  // itself — not just what the hook renders with the result.
  it('does not probe while disabled', () => {
    const { result } = renderHook(() => useAgyModels(false));
    expect(listAgyImageModels).not.toHaveBeenCalled();
    expect(result.current.models).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('probes silently once enabled and exposes the catalog', async () => {
    listAgyImageModels.mockResolvedValue({ models: ['gemini-3.6-flash-high', 'gemini-3.1-pro-high'] });
    const { result } = renderHook(() => useAgyModels(true));

    // `silent: true` — callers render the error inline next to the field, so the
    // shared request() helper must not also toast it (one layer wins).
    expect(listAgyImageModels).toHaveBeenCalledWith({ silent: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.models).toEqual(['gemini-3.6-flash-high', 'gemini-3.1-pro-high']);
    expect(result.current.error).toBeNull();
  });

  // A reachable-but-list-failed probe carries `{ models: [], error }` in a 200
  // body rather than rejecting. Surfacing that error is what keeps "probe
  // failed" from reading as "the catalog is empty".
  it('surfaces an in-body error without throwing', async () => {
    listAgyImageModels.mockResolvedValue({ models: [], error: 'agy models timed out' });
    const { result } = renderHook(() => useAgyModels(true));
    await waitFor(() => expect(result.current.error).toBe('agy models timed out'));
    expect(result.current.models).toEqual([]);
  });

  it('surfaces a rejected request and clears any stale catalog', async () => {
    listAgyImageModels.mockRejectedValue(new Error('Agy CLI not found'));
    const { result } = renderHook(() => useAgyModels(true));
    await waitFor(() => expect(result.current.error).toBe('Agy CLI not found'));
    expect(result.current.models).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  // A non-array `models` (older peer, malformed body) must degrade to [] rather
  // than reaching a `.map()` in the picker.
  it('coerces a non-array models field to an empty list', async () => {
    listAgyImageModels.mockResolvedValue({ models: 'gemini-3.6-flash-high' });
    const { result } = renderHook(() => useAgyModels(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.models).toEqual([]);
  });

  it('re-probes on demand via refresh', async () => {
    listAgyImageModels.mockResolvedValue({ models: ['gemini-3.5-flash-high'] });
    const { result } = renderHook(() => useAgyModels(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { result.current.refresh(); });
    expect(listAgyImageModels).toHaveBeenCalledTimes(2);
  });
});

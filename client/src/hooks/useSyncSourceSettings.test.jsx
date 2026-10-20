import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const getSettings = vi.fn();
const updateSettings = vi.fn();

vi.mock('../services/api', () => ({
  getSettings: (...args) => getSettings(...args),
  updateSettings: (...args) => updateSettings(...args),
}));

import { useSyncSourceSettings } from './useSyncSourceSettings.js';

const getStatus = vi.fn();
const options = { domain: 'signal', defaultInterval: 60, getStatus };

beforeEach(() => {
  getSettings.mockReset();
  updateSettings.mockReset();
  getStatus.mockReset();
});

describe('useSyncSourceSettings', () => {
  it('loads source settings and status silently', async () => {
    getSettings.mockResolvedValue({ signal: { enabled: true, intervalMinutes: 90 } });
    getStatus.mockResolvedValue({ ready: true });

    const { result } = renderHook(() => useSyncSourceSettings(options));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.enabled).toBe(true);
    expect(result.current.intervalMinutes).toBe(90);
    expect(result.current.status).toEqual({ ready: true });
    expect(result.current.dirty).toBe(false);
    expect(getSettings).toHaveBeenCalledWith({ silent: true });
    expect(getStatus).toHaveBeenCalledWith({ silent: true });
  });

  it('reports a failed settings read instead of seeding defaults, refuses save, and recovers on retry', async () => {
    getSettings.mockRejectedValueOnce(new Error('offline'));
    getStatus.mockResolvedValue(null);

    const { result } = renderHook(() => useSyncSourceSettings(options));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadError).toBe(true);
    await act(async () => expect(await result.current.save()).toBe(false));
    expect(updateSettings).not.toHaveBeenCalled();

    getSettings.mockResolvedValue({ signal: { enabled: true, intervalMinutes: 90 } });
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadError).toBe(false);
    expect(result.current.enabled).toBe(true);
    expect(result.current.intervalMinutes).toBe(90);
  });

  it('clamps and persists the changed source settings', async () => {
    getSettings.mockResolvedValue({});
    getStatus.mockResolvedValue(null);
    updateSettings.mockResolvedValue({ signal: { enabled: true, intervalMinutes: 1440 } });
    const { result } = renderHook(() => useSyncSourceSettings(options));

    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      result.current.setEnabled(true);
      result.current.setIntervalMinutes(2000);
    });
    expect(result.current.dirty).toBe(true);

    await act(async () => expect(await result.current.save()).toBe(true));

    expect(updateSettings).toHaveBeenCalledWith({ signal: { enabled: true, intervalMinutes: 1440 } });
    expect(result.current.intervalMinutes).toBe(1440);
    expect(result.current.dirty).toBe(false);
  });

  it('keeps edits dirty when saving fails', async () => {
    getSettings.mockResolvedValue({});
    getStatus.mockResolvedValue(null);
    updateSettings.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useSyncSourceSettings(options));

    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setEnabled(true));

    await act(async () => expect(await result.current.save()).toBe(false));

    expect(result.current.dirty).toBe(true);
  });
});

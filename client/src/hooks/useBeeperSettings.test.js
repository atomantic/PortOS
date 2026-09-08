import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const api = vi.hoisted(() => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
vi.mock('../services/api', () => api);

import { useBeeperSettings, BEEPER_DEFAULT_BASE_URL } from './useBeeperSettings.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useBeeperSettings', () => {
  it('loads the stored config and allows a normal save', async () => {
    api.getSettings.mockResolvedValue({
      beeper: {
        enabled: true, intervalMinutes: 10, baseUrl: 'http://127.0.0.1:23373', attachmentBudgetGb: 8, allowNonLoopbackBaseUrl: false,
      },
    });
    api.updateSettings.mockResolvedValue({ beeper: {} });

    const { result } = renderHook(() => useBeeperSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.loadFailed).toBe(false);
    expect(result.current.form.enabled).toBe(true);
    expect(result.current.form.intervalMinutes).toBe(10);

    let saved;
    await act(async () => { saved = await result.current.save(); });
    expect(saved).toBe(true);
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
  });

  // The regression this exists for: an empty `.catch(() => {})` used to turn a
  // failed settings GET into a card silently showing DEFAULTS, and the next
  // Save PUT those defaults over whatever config was actually stored. The hook
  // must hold a distinguishable load-failed state and refuse Save from it.
  it('leaves loadFailed:true after a failed GET and refuses Save — no PUT of default values', async () => {
    api.getSettings.mockRejectedValue(new Error('network error'));

    const { result } = renderHook(() => useBeeperSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.loadFailed).toBe(true);
    // The DEFAULTS a caller might otherwise mistake for "this install's saved
    // config" are still what `form` holds — proving the refusal below is load
    // bearing rather than incidental.
    expect(result.current.form.baseUrl).toBe(BEEPER_DEFAULT_BASE_URL);

    let saved;
    await act(async () => { saved = await result.current.save(); });
    expect(saved).toBe(false);
    expect(api.updateSettings).not.toHaveBeenCalled();
  });
});

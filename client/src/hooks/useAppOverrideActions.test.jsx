import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const updateAppTaskTypeOverride = vi.fn();
const bulkUpdateAppTaskTypeOverride = vi.fn();
vi.mock('../services/apiApps.js', () => ({
  updateAppTaskTypeOverride: (...args) => updateAppTaskTypeOverride(...args),
  bulkUpdateAppTaskTypeOverride: (...args) => bulkUpdateAppTaskTypeOverride(...args),
}));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('../components/ui/Toast', () => ({ default: { success: (...a) => toastSuccess(...a), error: (...a) => toastError(...a) } }));

import { useAppOverrideActions } from './useAppOverrideActions.js';

const APPS = [{ id: 'app-1', name: 'Acme' }];

function setup(refetch = vi.fn()) {
  const { result } = renderHook(() => useAppOverrideActions(APPS, refetch));
  return { result, refetch };
}

beforeEach(() => {
  updateAppTaskTypeOverride.mockReset();
  bulkUpdateAppTaskTypeOverride.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe('useAppOverrideActions', () => {
  it('updates an override silently, toasts the app name, and refetches', async () => {
    updateAppTaskTypeOverride.mockResolvedValue({ success: true });
    const { result, refetch } = setup();

    await act(async () => {
      await result.current.handleUpdateOverride('app-1', 'do-replan', { enabled: true, interval: 'daily' });
    });

    expect(updateAppTaskTypeOverride).toHaveBeenCalledWith('app-1', 'do-replan', { enabled: true, interval: 'daily' }, { silent: true });
    expect(toastSuccess).toHaveBeenCalledWith('Updated do-replan override for Acme');
    expect(refetch).toHaveBeenCalledOnce();
  });

  // The patch used to be re-listed field by field here, which silently dropped
  // every field the hook hadn't been taught about — the route then 400s on the
  // resulting empty body, so clearing a per-app provider pin could never work.
  it('forwards fields it was never taught about, like a provider pin clear', async () => {
    updateAppTaskTypeOverride.mockResolvedValue({ success: true });
    const { result } = setup();

    await act(async () => {
      await result.current.handleUpdateOverride('app-1', 'layered-intelligence', { providerId: null, model: null });
    });

    expect(updateAppTaskTypeOverride).toHaveBeenCalledWith('app-1', 'layered-intelligence', { providerId: null, model: null }, { silent: true });
  });

  it('falls back to the app id when the app is unknown', async () => {
    updateAppTaskTypeOverride.mockResolvedValue({ success: true });
    const { result } = setup();

    await act(async () => {
      await result.current.handleUpdateOverride('ghost', 'do-replan', { enabled: false });
    });

    expect(toastSuccess).toHaveBeenCalledWith('Updated do-replan override for ghost');
  });

  it('does not refetch and shows an error toast when the update rejects', async () => {
    updateAppTaskTypeOverride.mockRejectedValue(new Error('boom'));
    const { result, refetch } = setup();

    await act(async () => {
      await result.current.handleUpdateOverride('app-1', 'do-replan', { enabled: true });
    });

    expect(toastError).toHaveBeenCalledWith('boom');
    expect(refetch).not.toHaveBeenCalled();
  });

  it('bulk-toggles all apps and refetches with the enabled/disabled wording', async () => {
    bulkUpdateAppTaskTypeOverride.mockResolvedValue({ success: true });
    const { result, refetch } = setup();

    await act(async () => {
      await result.current.handleBulkToggleOverride('do-replan', false);
    });

    expect(bulkUpdateAppTaskTypeOverride).toHaveBeenCalledWith('do-replan', { enabled: false }, { silent: true });
    expect(toastSuccess).toHaveBeenCalledWith('Disabled do-replan for all apps');
    expect(refetch).toHaveBeenCalledOnce();
  });
});

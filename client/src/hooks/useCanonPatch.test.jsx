import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const updateUniverse = vi.fn();
vi.mock('../services/apiUniverseBuilder', () => ({
  updateUniverse: (...args) => updateUniverse(...args),
}));
const toastError = vi.fn();
vi.mock('../components/ui/Toast', () => ({ default: { error: (...a) => toastError(...a) } }));

import { useCanonPatch } from './useCanonPatch.js';

const KIND = { key: 'characters' };
const baseUniverse = {
  id: 'u1',
  characters: [
    { id: 'c1', name: 'Alice', intExt: 'INT' },
    { id: 'c2', name: 'Bob' },
  ],
};

function setup(overrides = {}) {
  const apply = vi.fn();
  const mountedRef = { current: true };
  const props = {
    universe: baseUniverse,
    apply,
    mountedRef,
    ...overrides,
  };
  const { result } = renderHook(() => useCanonPatch(props));
  return { result, apply, mountedRef };
}

beforeEach(() => {
  updateUniverse.mockReset();
  toastError.mockReset();
});

describe('useCanonPatch', () => {
  it('optimistically applies the patched kind list, then re-applies the server copy', async () => {
    const serverCopy = { id: 'u1', characters: [{ id: 'c1', name: 'Alice', intExt: 'EXT' }] };
    updateUniverse.mockResolvedValue(serverCopy);
    const { result, apply } = setup();

    await act(async () => {
      await result.current.patchEntry(KIND, 'c1', { intExt: 'EXT' });
    });

    // Optimistic apply mutates only the targeted entry.
    expect(apply).toHaveBeenNthCalledWith(1, {
      ...baseUniverse,
      characters: [
        { id: 'c1', name: 'Alice', intExt: 'EXT' },
        { id: 'c2', name: 'Bob' },
      ],
    });
    // PATCH sends the full kind list, silently (the hook owns the error toast).
    expect(updateUniverse).toHaveBeenCalledWith('u1', {
      characters: [
        { id: 'c1', name: 'Alice', intExt: 'EXT' },
        { id: 'c2', name: 'Bob' },
      ],
    }, { silent: true });
    // Server response re-applied.
    expect(apply).toHaveBeenNthCalledWith(2, serverCopy);
  });

  it('no-ops when the universe is missing', async () => {
    const { result, apply } = setup({ universe: null });
    await act(async () => {
      await result.current.patchEntry(KIND, 'c1', { intExt: 'EXT' });
    });
    expect(apply).not.toHaveBeenCalled();
    expect(updateUniverse).not.toHaveBeenCalled();
  });

  it('no-ops when the patch is missing or not an object', async () => {
    const { result, apply } = setup();
    await act(async () => {
      await result.current.patchEntry(KIND, 'c1', null);
      await result.current.patchEntry(KIND, 'c1', 'nope');
    });
    expect(apply).not.toHaveBeenCalled();
    expect(updateUniverse).not.toHaveBeenCalled();
  });

  it('toasts and skips the re-apply when the PATCH fails', async () => {
    updateUniverse.mockRejectedValue(new Error('boom'));
    const { result, apply } = setup();
    await act(async () => {
      await result.current.patchEntry(KIND, 'c1', { intExt: 'EXT' });
    });
    expect(apply).toHaveBeenCalledTimes(1); // optimistic only
    expect(toastError).toHaveBeenCalledWith('Save failed: boom');
  });

  it('does not re-apply the server copy after unmount', async () => {
    let resolveUpdate;
    updateUniverse.mockReturnValue(new Promise((res) => { resolveUpdate = res; }));
    const { result, apply, mountedRef } = setup();
    let pending;
    act(() => { pending = result.current.patchEntry(KIND, 'c1', { intExt: 'EXT' }); });
    expect(apply).toHaveBeenCalledTimes(1); // optimistic apply fired
    mountedRef.current = false;
    await act(async () => { resolveUpdate({ id: 'u1', characters: [] }); await pending; });
    expect(apply).toHaveBeenCalledTimes(1); // server copy NOT re-applied
  });

  it('PATCHes the loaded record id and drops a re-apply after the loaded universe swaps', async () => {
    let resolveUpdate;
    updateUniverse.mockReturnValue(new Promise((res) => { resolveUpdate = res; }));
    const apply = vi.fn();
    const mountedRef = { current: true };
    const props = { universe: baseUniverse, apply, mountedRef };
    const { result, rerender } = renderHook((p) => useCanonPatch(p), { initialProps: props });

    let pending;
    act(() => { pending = result.current.patchEntry(KIND, 'c1', { intExt: 'EXT' }); });
    // PATCH targets the loaded record's id, not a separately-passed prop.
    expect(updateUniverse).toHaveBeenCalledWith('u1', expect.any(Object), { silent: true });
    // The loaded universe swaps to a different world before the PATCH settles
    // (e.g. useUniverse refetched for a new series.universeId).
    rerender({ ...props, universe: { id: 'u2', characters: [] } });
    await waitFor(() => {}); // flush the id-sync effect
    await act(async () => { resolveUpdate({ id: 'u1', characters: [] }); await pending; });
    expect(apply).toHaveBeenCalledTimes(1); // stale server copy dropped
  });
});

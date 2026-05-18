import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const toastMock = {
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(() => 'tid-1'),
  dismiss: vi.fn(),
};

vi.mock('../components/ui/Toast', () => ({ default: toastMock }));

let useUniverseAction;
beforeEach(async () => {
  Object.values(toastMock).forEach((fn) => fn.mockReset?.());
  toastMock.loading.mockImplementation(() => 'tid-1');
  vi.resetModules();
  ({ default: useUniverseAction } = await import('./useUniverseAction.js'));
});

function buildHook({ selectedId = 'u1', setWorlds = vi.fn() } = {}) {
  const mountedRef = { current: true };
  const { result } = renderHook(() => useUniverseAction({ selectedId, mountedRef, setWorlds }));
  return { run: result.current, mountedRef, setWorlds };
}

describe('useUniverseAction', () => {
  it('errors with notSavedMessage when selectedId is missing', async () => {
    const { run } = buildHook({ selectedId: null });
    const action = vi.fn();
    const out = await run({ action, notSavedMessage: 'Save first' });
    expect(out).toBeNull();
    expect(action).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith('Save first');
  });

  it('re-entrancy: when ref.current is true, returns null without firing action', async () => {
    const { run } = buildHook();
    const ref = { current: true };
    const action = vi.fn();
    const out = await run({ ref, action });
    expect(out).toBeNull();
    expect(action).not.toHaveBeenCalled();
  });

  it('happy path: setWorlds + onFreshResult + dismiss + success toast', async () => {
    const setWorlds = vi.fn((fn) => fn([{ id: 'u1', name: 'old' }, { id: 'u2' }]));
    const { run } = buildHook({ setWorlds });
    const ref = { current: false };
    const setBusy = vi.fn();
    const action = vi.fn(async (id) => ({ universe: { id, name: 'new' }, extra: 'x' }));
    const onFreshResult = vi.fn(() => 'Done');
    const out = await run({
      ref, setBusy,
      loadingMessage: 'Working…',
      action,
      onFreshResult,
    });
    expect(action).toHaveBeenCalledWith('u1');
    expect(setBusy).toHaveBeenNthCalledWith(1, true);
    expect(setBusy).toHaveBeenNthCalledWith(2, false);
    expect(ref.current).toBe(false);
    expect(toastMock.loading).toHaveBeenCalledWith('Working…');
    expect(setWorlds).toHaveBeenCalled();
    const updated = setWorlds.mock.results[0].value;
    expect(updated[0]).toEqual({ id: 'u1', name: 'new' });
    expect(onFreshResult).toHaveBeenCalledWith(out, { capturedId: 'u1' });
    expect(toastMock.dismiss).toHaveBeenCalledWith('tid-1');
    expect(toastMock.success).toHaveBeenCalledWith('Done');
  });

  it('stale-write: capturedId !== selectedId at result time → setWorlds runs, onFreshResult skipped, no success toast', async () => {
    // Simulate selectedId changing mid-flight. We can't mutate the original
    // closure's selectedId, but the hook captures it once into capturedId on
    // entry. Achieve "stale" by mutating mountedRef.current to false (covers
    // both stale-write paths: unmount and id change).
    const setWorlds = vi.fn((fn) => fn([]));
    const { run, mountedRef } = buildHook({ setWorlds });
    const action = vi.fn(async (id) => {
      mountedRef.current = false;
      return { universe: { id, name: 'new' } };
    });
    const onFreshResult = vi.fn();
    const out = await run({ loadingMessage: 'go', action, onFreshResult });
    expect(out).toEqual({ universe: { id: 'u1', name: 'new' } });
    expect(setWorlds).toHaveBeenCalled();
    expect(onFreshResult).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.dismiss).toHaveBeenCalledWith('tid-1');
  });

  it('action rejects → error toast with prefix, dismiss, ref + busy reset', async () => {
    const { run } = buildHook();
    const ref = { current: false };
    const setBusy = vi.fn();
    const action = vi.fn(async () => { throw new Error('boom'); });
    const onFreshResult = vi.fn();
    const out = await run({
      ref, setBusy,
      loadingMessage: 'go',
      errorPrefix: 'Promote failed',
      action,
      onFreshResult,
    });
    expect(out).toBeNull();
    expect(toastMock.error).toHaveBeenCalledWith('Promote failed: boom');
    expect(toastMock.dismiss).toHaveBeenCalledWith('tid-1');
    expect(ref.current).toBe(false);
    expect(setBusy).toHaveBeenLastCalledWith(false);
    expect(onFreshResult).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('no loading toast when loadingMessage is omitted', async () => {
    const { run } = buildHook();
    const action = vi.fn(async (id) => ({ universe: { id } }));
    await run({ action, onFreshResult: () => 'ok' });
    expect(toastMock.loading).not.toHaveBeenCalled();
    expect(toastMock.dismiss).not.toHaveBeenCalled();
    expect(toastMock.success).toHaveBeenCalledWith('ok');
  });

  it('result without .universe → dismiss + return result without setWorlds or onFreshResult', async () => {
    const setWorlds = vi.fn();
    const { run } = buildHook({ setWorlds });
    const action = vi.fn(async () => ({ universe: null, note: 'nothing changed' }));
    const onFreshResult = vi.fn();
    const out = await run({ loadingMessage: 'go', action, onFreshResult });
    expect(out).toEqual({ universe: null, note: 'nothing changed' });
    expect(setWorlds).not.toHaveBeenCalled();
    expect(onFreshResult).not.toHaveBeenCalled();
    expect(toastMock.dismiss).toHaveBeenCalledWith('tid-1');
  });

  it('onFreshResult returning null/void suppresses the success toast', async () => {
    const { run } = buildHook();
    const action = vi.fn(async (id) => ({ universe: { id } }));
    await run({ loadingMessage: 'go', action, onFreshResult: () => null });
    expect(toastMock.dismiss).toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('preflight returning false aborts before action, resets ref + busy', async () => {
    const { run } = buildHook();
    const ref = { current: false };
    const setBusy = vi.fn();
    const action = vi.fn();
    const preflight = vi.fn(async () => false);
    const out = await run({
      ref, setBusy,
      loadingMessage: 'go',
      action,
      preflight,
    });
    expect(out).toBeNull();
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();
    expect(toastMock.loading).not.toHaveBeenCalled();
    expect(ref.current).toBe(false);
    expect(setBusy).toHaveBeenNthCalledWith(1, true);
    expect(setBusy).toHaveBeenNthCalledWith(2, false);
  });

  it('preflight rejecting (throw) aborts the same as returning false', async () => {
    const { run } = buildHook();
    const ref = { current: false };
    const action = vi.fn();
    const preflight = vi.fn(async () => { throw new Error('save failed'); });
    const out = await run({ ref, action, preflight });
    expect(out).toBeNull();
    expect(action).not.toHaveBeenCalled();
    expect(ref.current).toBe(false);
  });

  it('preflight returning true allows the action to run', async () => {
    const { run } = buildHook();
    const ref = { current: false };
    const action = vi.fn(async (id) => ({ universe: { id, name: 'after-flush' } }));
    const preflight = vi.fn(async () => true);
    const out = await run({
      ref,
      action,
      preflight,
      onFreshResult: () => 'ok',
    });
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith('u1');
    expect(out).toEqual({ universe: { id: 'u1', name: 'after-flush' } });
  });

  it('preflight runs AFTER the ref guard so double-clicks short-circuit before flushing', async () => {
    const { run } = buildHook();
    const ref = { current: true };
    const preflight = vi.fn(async () => true);
    const action = vi.fn();
    const out = await run({ ref, action, preflight });
    expect(out).toBeNull();
    expect(preflight).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it('unmount before action resolves: ref/busy NOT reset, but setWorlds still fires (cross-navigation list update)', async () => {
    const setWorlds = vi.fn();
    const { run, mountedRef } = buildHook({ setWorlds });
    const ref = { current: false };
    const setBusy = vi.fn();
    const action = vi.fn(async (id) => {
      mountedRef.current = false;
      return { universe: { id } };
    });
    await run({ ref, setBusy, action });
    // CLAUDE.md "Deferred work must respect both staleness and unmount" —
    // hook intentionally skips ref/busy reset when unmounted to avoid
    // post-unmount setState.
    expect(ref.current).toBe(true);
    expect(setBusy).toHaveBeenCalledTimes(1);
    expect(setBusy).toHaveBeenCalledWith(true);
    expect(setWorlds).toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import usePersistedOptions, { readBoolean, readInteger, readNumber } from './usePersistedOptions';

const SPECS = {
  rounds: { defaultValue: 3, read: readInteger, clamp: (v) => (v === '' ? 3 : Math.min(20, Math.max(0, Math.round(v)))) },
  delta: { defaultValue: 0.3, read: readNumber, clamp: (v) => (v === '' ? 0.3 : v) },
  enabled: { defaultValue: false, read: readBoolean, persistOnEdit: true },
};

const setup = (persist) => renderHook(({ p }) => usePersistedOptions(SPECS, p), {
  initialProps: { p: persist },
});

describe('usePersistedOptions', () => {
  it('starts every option at its declared default', () => {
    const { result } = setup();
    expect(result.current.values).toEqual({ rounds: 3, delta: 0.3, enabled: false });
    expect(result.current.collectOverrides()).toEqual({});
  });

  it('hydrates untouched options from saved settings', () => {
    const { result } = setup();
    act(() => result.current.hydrate({ rounds: 7, delta: 1.5, enabled: true }));
    expect(result.current.values).toEqual({ rounds: 7, delta: 1.5, enabled: true });
    // Hydration is not an edit — nothing is sent as a per-run override.
    expect(result.current.collectOverrides()).toEqual({});
  });

  it('falls back to the default for an absent or wrong-typed saved value', () => {
    const { result } = setup();
    act(() => result.current.hydrate({ rounds: 'nine', enabled: 'yes' }));
    expect(result.current.values).toEqual({ rounds: 3, delta: 0.3, enabled: false });
  });

  it('never lets a late load clobber an edited field, per field', () => {
    const { result } = setup();
    act(() => result.current.edit('rounds', 9));
    act(() => result.current.hydrate({ rounds: 1, delta: 2 }));
    expect(result.current.values.rounds).toBe(9); // edited — load ignored
    expect(result.current.values.delta).toBe(2); // untouched — load applied
  });

  it('collects ONLY edited options, clamped', () => {
    const { result } = setup();
    act(() => result.current.edit('rounds', 99));
    expect(result.current.collectOverrides()).toEqual({ rounds: 20 });
  });

  it('collects an edit made in the same frame, before React re-renders', () => {
    const { result } = setup();
    // A blur that edits and a click that starts the run can land in one batched
    // frame; reading only the rendered `values` would send the pre-edit value.
    let collected = null;
    act(() => {
      result.current.edit('rounds', 12);
      collected = result.current.collectOverrides();
      expect(result.current.inputProps('rounds').value).toBe(12);
    });
    expect(collected).toEqual({ rounds: 12 });
  });

  it('sends an explicitly edited falsy value rather than dropping it', () => {
    const { result } = setup();
    act(() => result.current.hydrate({ rounds: 5, enabled: true }));
    act(() => result.current.edit('rounds', 0));
    act(() => result.current.edit('enabled', false));
    expect(result.current.collectOverrides()).toEqual({ rounds: 0, enabled: false });
  });

  it('persists a persistOnEdit option immediately, exactly once', () => {
    const persist = vi.fn();
    const { result } = setup(persist);
    act(() => result.current.edit('enabled', true));
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ enabled: true });
  });

  it('does not persist an option that saves on blur instead', () => {
    const persist = vi.fn();
    const { result } = setup(persist);
    act(() => result.current.edit('rounds', 4));
    expect(persist).not.toHaveBeenCalled();
  });

  it('calls the LATEST persist callback, not the one captured at mount', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = setup(first);
    rerender({ p: second });
    act(() => result.current.edit('enabled', true));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ enabled: true });
  });

  it('keeps every callback identity-stable across renders and edits', () => {
    const { result } = setup();
    const before = result.current;
    act(() => result.current.edit('rounds', 5));
    expect(result.current.edit).toBe(before.edit);
    expect(result.current.hydrate).toBe(before.hydrate);
    expect(result.current.collectOverrides).toBe(before.collectOverrides);
    expect(result.current.inputProps).toBe(before.inputProps);
  });

  it('inputProps binds the option key, live value, its clamp and persist', () => {
    const persist = vi.fn();
    const { result } = setup(persist);
    act(() => result.current.hydrate({ rounds: 6 }));
    const props = result.current.inputProps('rounds');
    expect(props.settingKey).toBe('rounds');
    expect(props.value).toBe(6);
    expect(props.clamp(99)).toBe(20); // same clamp collectOverrides applies
    act(() => props.setValue(8));
    expect(result.current.values.rounds).toBe(8);
    expect(result.current.collectOverrides()).toEqual({ rounds: 8 });
    props.persist({ rounds: 8 });
    expect(persist).toHaveBeenCalledWith({ rounds: 8 });
  });
});

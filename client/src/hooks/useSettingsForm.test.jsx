import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useSettingsForm from './useSettingsForm';

const INITIAL = { mode: 'external', url: '', cleaners: { local: true, codex: false }, pins: {} };

describe('useSettingsForm', () => {
  it('tracks dirtiness against the loaded snapshot and writes nested paths immutably', () => {
    const { result } = renderHook(() => useSettingsForm(INITIAL));
    expect(result.current.isDirty).toBe(false);

    act(() => { result.current.load({ ...INITIAL, url: 'http://example.com' }); });
    expect(result.current.values.url).toBe('http://example.com');
    expect(result.current.isDirty).toBe(false);

    const before = result.current.values;
    act(() => { result.current.set('cleaners.codex', true); });
    expect(result.current.values.cleaners).toEqual({ local: true, codex: true });
    expect(before.cleaners.codex).toBe(false);
    expect(result.current.isDirty).toBe(true);

    // Back to the saved value: a round trip is not a change.
    act(() => { result.current.set('cleaners.codex', false); });
    expect(result.current.isDirty).toBe(false);
  });

  it('accepts an updater and lets markSaved reflect normalized values into the inputs', () => {
    const { result } = renderHook(() => useSettingsForm(INITIAL));
    act(() => { result.current.set('pins', (pins) => ({ ...pins, bible: { imageMode: 'codex' } })); });
    act(() => { result.current.set('url', ' http://example.com/ '); });
    expect(result.current.isDirty).toBe(true);

    const normalized = { ...result.current.values, url: 'http://example.com' };
    act(() => { result.current.markSaved(normalized); });
    expect(result.current.values.url).toBe('http://example.com');
    expect(result.current.saved).toBe(result.current.values);
    expect(result.current.isDirty).toBe(false);

    act(() => { result.current.set('mode', 'local'); });
    act(() => { result.current.markSaved(); });
    expect(result.current.saved.mode).toBe('local');
    expect(result.current.isDirty).toBe(false);
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useCitySettings, { TIME_OF_DAY_AUTO_EVENT } from './useCitySettings.js';

const STORAGE_KEY = 'portos-city-settings';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('useCitySettings localStorage resilience', () => {
  it('initializes to defaults when reads throw (blocked storage)', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });

    let result;
    expect(() => {
      ({ result } = renderHook(() => useCitySettings()));
    }).not.toThrow();

    const [settings] = result.current;
    expect(settings.timeOfDay).toBe('auto');
    expect(settings.qualityPreset).toBe('high');
  });

  it('initializes to defaults when stored JSON is corrupt', () => {
    window.localStorage.setItem(STORAGE_KEY, '{ not valid json');
    const { result } = renderHook(() => useCitySettings());
    const [settings] = result.current;
    expect(settings.qualityPreset).toBe('high');
  });

  it('keeps in-memory setting updates working when writes throw', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });

    const { result } = renderHook(() => useCitySettings());

    expect(() => {
      act(() => {
        const [, updateSetting] = result.current;
        updateSetting('timeOfDay', 'night');
      });
    }).not.toThrow();

    const [settings] = result.current;
    expect(settings.timeOfDay).toBe('night');
  });

  it('defaults a fresh install to Auto quality beginning at High', () => {
    const { result } = renderHook(() => useCitySettings());
    const [settings] = result.current;
    expect(settings.qualityMode).toBe('auto');
    expect(settings.qualityPreset).toBe('high');
  });

  it('loads an existing pre-Auto payload as Manual, keeping its preset', () => {
    // A stored payload from before Auto mode has no `qualityMode` key.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ qualityPreset: 'ultra' }));
    const { result } = renderHook(() => useCitySettings());
    const [settings] = result.current;
    expect(settings.qualityMode).toBe('manual');
    expect(settings.qualityPreset).toBe('ultra');
  });

  it('preserves a stored qualityMode of auto (present-but-set, not absent)', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ qualityMode: 'auto', qualityPreset: 'medium' }));
    const { result } = renderHook(() => useCitySettings());
    const [settings] = result.current;
    expect(settings.qualityMode).toBe('auto');
  });

  it('picking a manual preset pins Manual mode', () => {
    const { result } = renderHook(() => useCitySettings());
    act(() => {
      const [, updateSetting] = result.current;
      updateSetting('qualityPreset', 'low');
    });
    const [settings] = result.current;
    expect(settings.qualityMode).toBe('manual');
    expect(settings.qualityPreset).toBe('low');
    expect(settings.reflectionsEnabled).toBe(false); // low preset bulk-applied
  });

  it('bumps resetNonce on reset so the runtime budget can re-arm', () => {
    const { result } = renderHook(() => useCitySettings());
    const before = result.current[3];
    act(() => {
      const resetSettings = result.current[2];
      resetSettings();
    });
    expect(result.current[3]).toBe(before + 1);
    const [settings] = result.current;
    expect(settings.qualityMode).toBe('auto'); // reset restores Auto default
  });

  it('handles the time-of-day-auto event without throwing when writes fail', () => {
    // This is the listener fired by useTheme.setTheme; with storage blocked its
    // write must not surface an unhandled error on the theme-switch path.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ timeOfDay: 'night' }));
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });

    const { result } = renderHook(() => useCitySettings());

    expect(() => {
      act(() => {
        window.dispatchEvent(new Event(TIME_OF_DAY_AUTO_EVENT));
      });
    }).not.toThrow();

    const [settings] = result.current;
    expect(settings.timeOfDay).toBe('auto');
  });
});

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
    vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
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
    vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
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

  it('handles the time-of-day-auto event without throwing when writes fail', () => {
    // This is the listener fired by useTheme.setTheme; with storage blocked its
    // write must not surface an unhandled error on the theme-switch path.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ timeOfDay: 'night' }));
    vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
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

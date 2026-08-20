import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useOpenWorldSettings, { TIME_OF_DAY_AUTO_EVENT } from './useOpenWorldSettings.js';

const STORAGE_KEY = 'portos-city-settings';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('useOpenWorldSettings localStorage resilience', () => {
  it('initializes to defaults when reads throw (blocked storage)', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });

    let result;
    expect(() => {
      ({ result } = renderHook(() => useOpenWorldSettings()));
    }).not.toThrow();

    const [settings] = result.current;
    expect(settings.timeOfDay).toBe('auto');
    expect(settings.worldStyle).toBe('vibes');
  });

  it('initializes to defaults when stored JSON is corrupt', () => {
    window.localStorage.setItem(STORAGE_KEY, '{ not valid json');
    const { result } = renderHook(() => useOpenWorldSettings());
    const [settings] = result.current;
    expect(settings.worldStyle).toBe('vibes');
  });

  it('keeps in-memory setting updates working when writes throw', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });

    const { result } = renderHook(() => useOpenWorldSettings());

    expect(() => {
      act(() => {
        const [, updateSetting] = result.current;
        updateSetting('timeOfDay', 'night');
      });
    }).not.toThrow();

    const [settings] = result.current;
    expect(settings.timeOfDay).toBe('night');
  });

  it('defaults a fresh install to player-facing world settings', () => {
    const { result } = renderHook(() => useOpenWorldSettings());
    const [settings] = result.current;
    expect(settings.explorationMode).toBe(true);
    expect(settings.cameraView).toBe('third');
    expect(settings.worldStyle).toBe('vibes');
    expect(settings.qualityMode).toBeUndefined();
    expect(settings.qualityPreset).toBeUndefined();
    expect(settings.reflectionsEnabled).toBeUndefined();
    expect(settings.scanlineOverlay).toBeUndefined();
  });

  it('drops legacy renderer controls when loading an existing payload', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      worldStyle: 'cyber',
      qualityMode: 'manual',
      qualityPreset: 'ultra',
      reflectionsEnabled: true,
      scanlineOverlay: true,
      ambientBrightness: 2,
      neonBrightness: 2,
      particleDensity: 2,
      dpr: [1, 2],
    }));
    const { result } = renderHook(() => useOpenWorldSettings());
    const [settings] = result.current;
    expect(settings.worldStyle).toBe('cyber');
    for (const key of ['qualityMode', 'qualityPreset', 'reflectionsEnabled', 'scanlineOverlay', 'ambientBrightness', 'neonBrightness', 'particleDensity', 'dpr']) {
      expect(settings[key]).toBeUndefined();
    }
  });

  it('bumps resetNonce on reset so the runtime budget can re-arm', () => {
    const { result } = renderHook(() => useOpenWorldSettings());
    const before = result.current[3];
    act(() => {
      const resetSettings = result.current[2];
      resetSettings();
    });
    expect(result.current[3]).toBe(before + 1);
    const [settings] = result.current;
    expect(settings.explorationMode).toBe(true);
    expect(settings.cameraView).toBe('third');
  });

  it('handles the time-of-day-auto event without throwing when writes fail', () => {
    // This is the listener fired by useTheme.setTheme; with storage blocked its
    // write must not surface an unhandled error on the theme-switch path.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ timeOfDay: 'night' }));
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });

    const { result } = renderHook(() => useOpenWorldSettings());

    expect(() => {
      act(() => {
        window.dispatchEvent(new Event(TIME_OF_DAY_AUTO_EVENT));
      });
    }).not.toThrow();

    const [settings] = result.current;
    expect(settings.timeOfDay).toBe('auto');
  });
});

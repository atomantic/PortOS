import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useTheme from './useTheme.js';
import { DEFAULT_THEME_ID, THEME_IDS } from '../themes/portosThemes.js';

// Pick any non-default valid theme to prove in-memory switching still works.
const OTHER_THEME_ID = THEME_IDS.find((id) => id !== DEFAULT_THEME_ID);

beforeEach(() => {
  // Neutralize the server-sync effect so tests exercise localStorage paths only.
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, json: async () => ({}) });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-port-theme');
  window.localStorage.clear();
});

describe('useTheme localStorage resilience', () => {
  it('initializes to the default theme when reads throw (blocked storage)', () => {
    vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });

    let result;
    // Initial render must not throw even though getItem throws.
    expect(() => {
      ({ result } = renderHook(() => useTheme()));
    }).not.toThrow();

    expect(result.current.themeId).toBe(DEFAULT_THEME_ID);
  });

  it('falls back to the default theme when stored value is invalid', () => {
    window.localStorage.setItem('portos-theme', 'not-a-real-theme');
    const { result } = renderHook(() => useTheme());
    expect(result.current.themeId).toBe(DEFAULT_THEME_ID);
  });

  it('keeps in-memory theme switching functional when writes throw', () => {
    vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });

    const { result } = renderHook(() => useTheme());

    // setTheme writes to localStorage (which throws) but must still update state.
    expect(() => {
      act(() => {
        result.current.setTheme(OTHER_THEME_ID);
      });
    }).not.toThrow();

    expect(result.current.themeId).toBe(OTHER_THEME_ID);
    expect(result.current.theme.id).toBe(OTHER_THEME_ID);
  });

  it('applies a valid stored theme on init when storage is healthy', () => {
    window.localStorage.setItem('portos-theme', OTHER_THEME_ID);
    const { result } = renderHook(() => useTheme());
    expect(result.current.themeId).toBe(OTHER_THEME_ID);
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useChartColors, { tripleToRgb } from './useChartColors.js';

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-port-theme');
});

describe('tripleToRgb', () => {
  it('converts a space-separated RGB triple to an rgb() string', () => {
    expect(tripleToRgb('59 130 246', '#000')).toBe('rgb(59, 130, 246)');
  });

  it('tolerates leading/trailing/extra whitespace', () => {
    expect(tripleToRgb('  34   197 94  ', '#000')).toBe('rgb(34, 197, 94)');
  });

  it('falls back when the value is empty or malformed', () => {
    expect(tripleToRgb('', '#fallback')).toBe('#fallback');
    expect(tripleToRgb('   ', '#fallback')).toBe('#fallback');
    expect(tripleToRgb('59 130', '#fallback')).toBe('#fallback');
    expect(tripleToRgb(undefined, '#fallback')).toBe('#fallback');
  });
});

describe('useChartColors', () => {
  it('resolves --port-* tokens set on <html> into rgb() strings', () => {
    const root = document.documentElement;
    root.style.setProperty('--port-accent', '10 20 30');
    root.style.setProperty('--port-chart-grid', '64 64 64');

    const { result } = renderHook(() => useChartColors());
    expect(result.current.accent).toBe('rgb(10, 20, 30)');
    expect(result.current.grid).toBe('rgb(64, 64, 64)');
  });

  it('uses fallbacks when tokens are absent', () => {
    const { result } = renderHook(() => useChartColors());
    // No CSS vars applied in jsdom → classic-midnight fallbacks.
    expect(result.current.accent).toBe('#3b82f6');
    expect(result.current.error).toBe('#ef4444');
  });

  it('re-resolves when the theme dataset attribute changes', async () => {
    const root = document.documentElement;
    root.style.setProperty('--port-accent', '1 1 1');
    const { result, unmount } = renderHook(() => useChartColors());
    expect(result.current.accent).toBe('rgb(1, 1, 1)');

    await act(async () => {
      root.style.setProperty('--port-accent', '2 2 2');
      root.setAttribute('data-port-theme', 'some-other-theme');
      // Allow the MutationObserver microtask to flush.
      await Promise.resolve();
    });

    expect(result.current.accent).toBe('rgb(2, 2, 2)');
    // Unmount before afterEach strips data-port-theme — that mutation would
    // otherwise fire the observer's setColors outside act.
    unmount();
  });
});

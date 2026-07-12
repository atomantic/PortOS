import { afterEach, describe, expect, it, vi } from 'vitest';
import { layerColor, roundRect, rollPalette, ROLL_BG } from './canvasRoll.js';

describe('layerColor', () => {
  it('cycles through the palette and wraps at both ends', () => {
    expect(layerColor(0)).not.toBe(layerColor(1));
    expect(layerColor(8)).toBe(layerColor(0)); // 8-hue palette wraps
    expect(layerColor(-1)).toBe(layerColor(7)); // negative wraps positively
  });
});

describe('roundRect', () => {
  it('uses the native ctx.roundRect when available', () => {
    const ctx = { roundRect: vi.fn(), beginPath: vi.fn() };
    roundRect(ctx, 0, 0, 20, 10, 3);
    expect(ctx.roundRect).toHaveBeenCalledWith(0, 0, 20, 10, 3);
  });

  it('falls back to an arcTo path when ctx.roundRect is missing', () => {
    const ctx = { beginPath: vi.fn(), moveTo: vi.fn(), arcTo: vi.fn(), closePath: vi.fn() };
    roundRect(ctx, 0, 0, 20, 10, 3);
    expect(ctx.arcTo).toHaveBeenCalledTimes(4);
    expect(ctx.closePath).toHaveBeenCalled();
  });

  it('clamps the radius so it never exceeds half the smaller side', () => {
    const ctx = { roundRect: vi.fn(), beginPath: vi.fn() };
    roundRect(ctx, 0, 0, 8, 4, 100);
    expect(ctx.roundRect).toHaveBeenCalledWith(0, 0, 8, 4, 2); // min(100, 4, 2) = 2
  });
});

describe('rollPalette', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves --port-accent from the theme into concrete strings', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name) => (name === '--port-accent' ? ' 168 85 247 ' : ''),
    });
    const p = rollPalette();
    expect(p.bg).toBe(ROLL_BG);
    expect(p.accentRgb).toBe('168 85 247');
    expect(p.accent).toBe('rgb(168 85 247)');
  });

  it('falls back to the Classic Midnight accent when the var is missing', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ getPropertyValue: () => '' });
    const p = rollPalette();
    expect(p.accent).toBe('rgb(59 130 246)');
    expect(p.accentRgb).toBe('59 130 246');
  });
});

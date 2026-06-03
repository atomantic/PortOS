import { describe, it, expect } from 'vitest';
import {
  MONUMENT,
  streakLevel,
  velocityTier,
  computeProductivityMonument,
} from './cityProductivity';

const full = {
  streak: { current: 12, longest: 30, weekly: 3, lastActive: '2026-06-02' },
  today: { completed: 8, succeeded: 7, failed: 1 },
  velocity: { percentage: 130, label: 'surging' },
};

describe('streakLevel', () => {
  it('maps streak/cap into 0..1', () => {
    expect(streakLevel(15, 30)).toBe(0.5);
    expect(streakLevel(30, 30)).toBe(1);
  });

  it('clamps above the cap to 1 and negatives to 0', () => {
    expect(streakLevel(999, 30)).toBe(1);
    expect(streakLevel(-5, 30)).toBe(0);
  });

  it('treats a legitimate zero streak as level 0, not absent', () => {
    expect(streakLevel(0, 30)).toBe(0);
  });

  it('returns null for non-numeric streaks or bad caps', () => {
    expect(streakLevel(undefined)).toBeNull();
    expect(streakLevel(null)).toBeNull();
    expect(streakLevel(NaN)).toBeNull();
    expect(streakLevel('12')).toBeNull();
    expect(streakLevel(12, 0)).toBeNull();
    expect(streakLevel(12, -1)).toBeNull();
  });
});

describe('velocityTier', () => {
  it('classifies into the expected tiers', () => {
    expect(velocityTier(130).key).toBe('surging');
    expect(velocityTier(100).key).toBe('steady');
    expect(velocityTier(60).key).toBe('slowing');
    expect(velocityTier(10).key).toBe('idle');
    expect(velocityTier(0).key).toBe('idle');
  });

  it('returns null for non-numeric velocity', () => {
    expect(velocityTier(undefined)).toBeNull();
    expect(velocityTier(null)).toBeNull();
    expect(velocityTier(NaN)).toBeNull();
    expect(velocityTier('100')).toBeNull();
  });
});

describe('computeProductivityMonument', () => {
  it('carries the fixed position and base width through unchanged', () => {
    const vm = computeProductivityMonument(full);
    expect(vm.position).toEqual(MONUMENT.position);
    expect(vm.baseWidth).toBe(MONUMENT.baseWidth);
  });

  it('derives a full view-model from complete data', () => {
    const vm = computeProductivityMonument(full);
    expect(vm.present).toBe(true);
    expect(vm.current).toBe(12);
    expect(vm.longest).toBe(30);
    expect(vm.completedToday).toBe(8);
    expect(vm.level).toBeCloseTo(0.4);
    expect(vm.color).toBe('#22c55e'); // surging tier
    expect(vm.tierKey).toBe('surging');
    expect(vm.surging).toBe(true);
    expect(vm.streakLabel).toBe('12 DAYS STREAK');
    expect(vm.height).toBeGreaterThan(MONUMENT.minHeight);
  });

  it('singularizes a one-day streak label', () => {
    const vm = computeProductivityMonument({ ...full, streak: { current: 1 } });
    expect(vm.streakLabel).toBe('1 DAY STREAK');
  });

  it('distinguishes a real zero-day streak from absent data', () => {
    const zero = computeProductivityMonument({ streak: { current: 0 }, velocity: { percentage: 50 } });
    expect(zero.present).toBe(true);
    expect(zero.current).toBe(0);
    expect(zero.level).toBe(0);
    expect(zero.streakLabel).toBe('NO STREAK');
    expect(zero.color).toBe('#f59e0b'); // slowing tier still colors it, not slate
    expect(zero.height).toBeCloseTo(MONUMENT.minHeight);
    expect(zero.intensity).toBeGreaterThan(0.1); // faintly lit, above the absent floor

    const absent = computeProductivityMonument({});
    expect(absent.present).toBe(false);
    expect(absent.current).toBeNull();
    expect(absent.level).toBe(0);
    expect(absent.streakLabel).toBe('NO DATA');
    expect(absent.tierLabel).toBe('NO DATA');
    expect(absent.color).toBe('#64748b'); // slate
    expect(absent.height).toBeCloseTo(MONUMENT.minHeight);
    expect(absent.intensity).toBeLessThan(zero.intensity);
  });

  it('colors a present-but-velocity-missing payload as idle, never dark', () => {
    const vm = computeProductivityMonument({ streak: { current: 5 } });
    expect(vm.present).toBe(true);
    expect(vm.color).toBe('#ef4444'); // idle tier fallback
    expect(vm.tierLabel).toBe('IDLE');
  });

  it('clamps a streak above the cap to full height', () => {
    const vm = computeProductivityMonument({ streak: { current: 9999 }, velocity: { percentage: 100 } });
    expect(vm.level).toBe(1);
    expect(vm.height).toBeCloseTo(MONUMENT.maxHeight);
    expect(vm.intensity).toBeCloseTo(1);
  });

  it('handles null / undefined / non-object input as absent without crashing', () => {
    for (const bad of [null, undefined, 'nope', 42, []]) {
      const vm = computeProductivityMonument(bad);
      expect(vm.present).toBe(false);
      expect(vm.level).toBe(0);
      expect(vm.streakLabel).toBe('NO DATA');
      expect(vm.position).toEqual(MONUMENT.position);
    }
  });

  it('tolerates a non-object streak/today/velocity sub-field', () => {
    const vm = computeProductivityMonument({ streak: 'oops', today: 5, velocity: null });
    expect(vm.present).toBe(false);
    expect(vm.completedToday).toBeNull();
    expect(vm.longest).toBeNull();
  });
});

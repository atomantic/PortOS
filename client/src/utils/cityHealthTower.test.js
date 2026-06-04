import { describe, it, expect } from 'vitest';
import {
  TOWER,
  METRICS,
  normalizeLevel,
  computeSegment,
  computeHealthTower,
} from './cityHealthTower';

const full = {
  heart_rate: { date: '2026-06-01', value: 60 },
  step_count: { date: '2026-06-01', value: 5000 },
  active_energy: { date: '2026-06-01', value: 300 },
  sleep_analysis: { date: '2026-06-01', value: 4 },
};

describe('normalizeLevel', () => {
  it('maps value/target into 0..1', () => {
    expect(normalizeLevel(5000, 10000)).toBe(0.5);
    expect(normalizeLevel(120, 120)).toBe(1);
  });

  it('clamps above target to 1 and below zero to 0', () => {
    expect(normalizeLevel(99999, 10000)).toBe(1);
    expect(normalizeLevel(-50, 10000)).toBe(0);
  });

  it('returns null for non-finite values or bad targets', () => {
    expect(normalizeLevel(NaN, 10000)).toBeNull();
    expect(normalizeLevel(undefined, 10000)).toBeNull();
    expect(normalizeLevel('5000', 10000)).toBeNull();
    expect(normalizeLevel(5000, 0)).toBeNull();
    expect(normalizeLevel(5000, -1)).toBeNull();
  });

  it('treats a legitimate zero value as level 0, not absent', () => {
    expect(normalizeLevel(0, 10000)).toBe(0);
  });
});

describe('computeSegment', () => {
  const heart = METRICS.find((m) => m.key === 'heart_rate');

  it('derives a present segment with proportional level and full color', () => {
    const seg = computeSegment(heart, { date: '2026-06-01', value: 60 });
    expect(seg.present).toBe(true);
    expect(seg.value).toBe(60);
    expect(seg.level).toBe(0.5);
    expect(seg.color).toBe(heart.color);
    expect(seg.height).toBeGreaterThan(TOWER.minHeight);
  });

  it('distinguishes a zero-value-but-present metric from an absent one', () => {
    const zero = computeSegment(heart, { date: '2026-06-01', value: 0 });
    expect(zero.present).toBe(true);
    expect(zero.value).toBe(0);
    expect(zero.level).toBe(0);
    expect(zero.color).toBe(heart.color); // still lit color, not the dim slate
    expect(zero.height).toBeCloseTo(TOWER.minHeight);
    expect(zero.intensity).toBeGreaterThan(0.08); // faintly lit, above the absent floor

    const absent = computeSegment(heart, null);
    expect(absent.present).toBe(false);
    expect(absent.value).toBeNull();
    expect(absent.level).toBe(0);
    expect(absent.color).not.toBe(heart.color); // dim slate
    expect(absent.height).toBeCloseTo(TOWER.minHeight);
    expect(absent.intensity).toBeLessThan(zero.intensity);
  });

  it('treats a missing/undefined entry as absent without crashing', () => {
    expect(computeSegment(heart, undefined).present).toBe(false);
    expect(computeSegment(heart, {}).present).toBe(false);
    expect(computeSegment(heart, { date: '2026-06-01', value: null }).present).toBe(false);
    expect(computeSegment(heart, { value: 'oops' }).present).toBe(false);
  });

  it('clamps a level above target to 1', () => {
    const seg = computeSegment(heart, { value: 999 });
    expect(seg.level).toBe(1);
    expect(seg.height).toBeCloseTo(TOWER.minHeight + TOWER.segmentHeight);
  });
});

describe('computeHealthTower', () => {
  it('carries the fixed position and base radius through unchanged', () => {
    const vm = computeHealthTower(full);
    expect(vm.position).toEqual(TOWER.position);
    expect(vm.baseRadius).toBe(TOWER.baseRadius);
  });

  it('produces one segment per metric in stacking order', () => {
    const vm = computeHealthTower(full);
    expect(vm.segments).toHaveLength(METRICS.length);
    expect(vm.segments.map((s) => s.key)).toEqual(METRICS.map((m) => m.key));
  });

  it('stacks segments upward with strictly increasing y', () => {
    const vm = computeHealthTower(full);
    for (let i = 1; i < vm.segments.length; i++) {
      expect(vm.segments[i].y).toBeGreaterThan(vm.segments[i - 1].y);
    }
  });

  it('reports presentCount and hasData from full metrics', () => {
    const vm = computeHealthTower(full);
    expect(vm.presentCount).toBe(METRICS.length);
    expect(vm.hasData).toBe(true);
    expect(vm.heartLevel).toBeCloseTo(0.5);
  });

  it('handles partial metrics — absent segments dim, present ones lit', () => {
    const vm = computeHealthTower({ step_count: { value: 10000 } });
    expect(vm.presentCount).toBe(1);
    expect(vm.hasData).toBe(true);
    const steps = vm.segments.find((s) => s.key === 'step_count');
    const heart = vm.segments.find((s) => s.key === 'heart_rate');
    expect(steps.present).toBe(true);
    expect(steps.level).toBe(1);
    expect(heart.present).toBe(false);
    expect(heart.level).toBe(0);
  });

  it('handles an all-null payload as an all-absent tower (no crash)', () => {
    const vm = computeHealthTower({
      heart_rate: null,
      step_count: null,
      active_energy: null,
      sleep_analysis: null,
    });
    expect(vm.presentCount).toBe(0);
    expect(vm.hasData).toBe(false);
    expect(vm.segments.every((s) => !s.present)).toBe(true);
  });

  it('handles null / undefined / non-object input as all-absent', () => {
    for (const bad of [null, undefined, 'nope', 42, []]) {
      const vm = computeHealthTower(bad);
      expect(vm.presentCount).toBe(0);
      expect(vm.hasData).toBe(false);
      expect(vm.segments).toHaveLength(METRICS.length);
    }
  });

  it('keeps all segment levels within [0,1]', () => {
    const vm = computeHealthTower({
      heart_rate: { value: -10 },
      step_count: { value: 1e9 },
      active_energy: { value: 0 },
      sleep_analysis: { value: 8 },
    });
    for (const s of vm.segments) {
      expect(s.level).toBeGreaterThanOrEqual(0);
      expect(s.level).toBeLessThanOrEqual(1);
    }
  });
});

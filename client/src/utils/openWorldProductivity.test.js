import { describe, expect, it } from 'vitest';
import {
  MONUMENT,
  computeProductivityMonument,
  throughputLevel,
  velocityTier,
} from './openWorldProductivity';

describe('throughputLevel', () => {
  it('maps completed tasks into a clamped 0..1 level', () => {
    expect(throughputLevel(10, 20)).toBe(0.5);
    expect(throughputLevel(999, 20)).toBe(1);
    expect(throughputLevel(-5, 20)).toBe(0);
    expect(throughputLevel(0, 20)).toBe(0);
  });

  it('returns null for absent values and invalid caps', () => {
    expect(throughputLevel(undefined)).toBeNull();
    expect(throughputLevel('10')).toBeNull();
    expect(throughputLevel(10, 0)).toBeNull();
  });
});

// @vitest-environment node

describe('velocityTier', () => {
  it('classifies present pace values and preserves absence', () => {
    expect(velocityTier(150)?.key).toBe('surging');
    expect(velocityTier(100)?.key).toBe('steady');
    expect(velocityTier(50)?.key).toBe('slowing');
    expect(velocityTier(0)?.key).toBe('idle');
    expect(velocityTier(undefined)).toBeNull();
  });
});

describe('computeProductivityMonument', () => {
  it('uses today throughput for height and labeling', () => {
    const vm = computeProductivityMonument({
      today: { completed: 10 },
      velocity: { percentage: 125 },
    });

    expect(vm.present).toBe(true);
    expect(vm.completedToday).toBe(10);
    expect(vm.level).toBe(0.5);
    expect(vm.height).toBe(MONUMENT.minHeight + 0.5 * (MONUMENT.maxHeight - MONUMENT.minHeight));
    expect(vm.throughputLabel).toBe('10 TASKS TODAY');
    expect(vm.tierKey).toBe('surging');
  });

  it('distinguishes zero throughput from absent data', () => {
    const zero = computeProductivityMonument({ today: { completed: 0 }, velocity: { percentage: 50 } });
    expect(zero.present).toBe(true);
    expect(zero.throughputLabel).toBe('NO TASKS TODAY');
    expect(zero.height).toBe(MONUMENT.minHeight);

    const absent = computeProductivityMonument({});
    expect(absent.present).toBe(false);
    expect(absent.throughputLabel).toBe('NO DATA');
    expect(absent.height).toBe(MONUMENT.minHeight);
  });

  it('tolerates malformed payloads and clamps unusually high throughput', () => {
    expect(computeProductivityMonument(null).throughputLabel).toBe('NO DATA');
    expect(computeProductivityMonument({ today: 5 }).throughputLabel).toBe('NO DATA');
    expect(computeProductivityMonument({ today: { completed: 9999 } }).level).toBe(1);
  });
});

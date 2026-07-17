import { describe, it, expect } from 'vitest';
import {
  EGGS,
  EASTER_EGGS,
  eggContext,
  unlockedEggs,
  placeEgg,
  computeEasterEggs,
} from './cityEasterEggs';

const on = (month, day) => new Date(2025, month - 1, day, 12, 0, 0);
const completedGoals = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `g-${i}`, status: 'completed' }));

describe('eggContext', () => {
  it('normalizes level to a floored nonnegative int, else null', () => {
    expect(eggContext({ character: { level: 7.9 } }).level).toBe(7);
    // Age level 0 (birthDate < 1yr ago) is authoritative now (#2673), not null.
    expect(eggContext({ character: { level: 0 } }).level).toBe(0);
    // Explicit null (no birthDate) and an absent character both yield null.
    expect(eggContext({ character: { level: null } }).level).toBeNull();
    expect(eggContext({}).level).toBeNull();
  });

  it('counts goals and total from a list or wrapper, ignoring junk entries', () => {
    const ctx = eggContext({ goals: [{ status: 'completed' }, { status: 'active' }, null, 'x'] });
    expect(ctx.completedGoals).toBe(1);
    expect(ctx.totalGoals).toBe(2); // two real objects, junk dropped
  });

  it('prefers longest streak over current, else null (never 0 from absence)', () => {
    expect(eggContext({ productivityData: { streak: { current: 2, longest: 11 } } }).bestStreak).toBe(11);
    expect(eggContext({ productivityData: { streak: { current: 4 } } }).bestStreak).toBe(4);
    expect(eggContext({}).bestStreak).toBeNull();
  });
});

describe('unlockedEggs — conditions', () => {
  it('unlocks nothing for an empty/default context', () => {
    expect(unlockedEggs({})).toEqual([]);
  });

  it('unlocks the April Fools egg only on Apr 1', () => {
    expect(unlockedEggs({ date: on(4, 1) }).map((e) => e.id)).toContain('april-fools');
    expect(unlockedEggs({ date: on(4, 2) }).map((e) => e.id)).not.toContain('april-fools');
    expect(unlockedEggs({ date: on(3, 1) }).map((e) => e.id)).not.toContain('april-fools');
  });

  it('unlocks the leet egg at exactly level 13 (not a threshold)', () => {
    expect(unlockedEggs({ character: { level: 13 } }).map((e) => e.id)).toContain('leet');
    expect(unlockedEggs({ character: { level: 14 } }).map((e) => e.id)).not.toContain('leet');
    expect(unlockedEggs({ character: { level: 12 } }).map((e) => e.id)).not.toContain('leet');
  });

  it('unlocks the answer egg at exactly level 42', () => {
    expect(unlockedEggs({ character: { level: 42 } }).map((e) => e.id)).toContain('answer');
    expect(unlockedEggs({ character: { level: 41 } }).map((e) => e.id)).not.toContain('answer');
  });

  it('unlocks the palindrome-streak egg only for a palindromic best streak >= 10', () => {
    expect(unlockedEggs({ productivityData: { streak: { longest: 22 } } }).map((e) => e.id)).toContain('palindrome-streak');
    expect(unlockedEggs({ productivityData: { streak: { longest: 121 } } }).map((e) => e.id)).toContain('palindrome-streak');
    expect(unlockedEggs({ productivityData: { streak: { longest: 23 } } }).map((e) => e.id)).not.toContain('palindrome-streak');
    expect(unlockedEggs({ productivityData: { streak: { longest: 7 } } }).map((e) => e.id)).not.toContain('palindrome-streak'); // single digit
  });

  it('unlocks the clean-sweep egg only when all (>=1) goals are completed', () => {
    expect(unlockedEggs({ goals: completedGoals(3) }).map((e) => e.id)).toContain('clean-sweep');
    const mixed = [...completedGoals(2), { id: 'x', status: 'active' }];
    expect(unlockedEggs({ goals: mixed }).map((e) => e.id)).not.toContain('clean-sweep');
    expect(unlockedEggs({ goals: [] }).map((e) => e.id)).not.toContain('clean-sweep'); // empty board does not count
  });

  it('preserves the stable table order when several unlock at once', () => {
    const ids = unlockedEggs({
      date: on(4, 1),
      character: { level: 13 },
      goals: completedGoals(2),
    }).map((e) => e.id);
    // april-fools precedes leet precedes clean-sweep in EASTER_EGGS
    expect(ids).toEqual(['april-fools', 'leet', 'clean-sweep']);
  });

  it('every egg descriptor carries an id, label, hint, and color', () => {
    for (const egg of EASTER_EGGS) {
      expect(typeof egg.id).toBe('string');
      expect(typeof egg.label).toBe('string');
      expect(typeof egg.hint).toBe('string');
      expect(typeof egg.color).toBe('string');
      expect(typeof egg.test).toBe('function');
    }
  });
});

describe('placeEgg', () => {
  it('centers the first column on base.x and wraps toward +Z', () => {
    const first = placeEgg({ id: 'a', color: '#fff' }, 0);
    const wrapped = placeEgg({ id: 'b', color: '#fff' }, EGGS.columns);
    expect(wrapped.position[0]).toBeCloseTo(first.position[0]); // same column
    expect(wrapped.position[2]).toBe(EGGS.base[2] + EGGS.spacing); // one row toward +Z
  });

  it('attaches a deterministic 0..1 phase per id', () => {
    const a = placeEgg({ id: 'leet', color: '#fff' }, 0);
    const b = placeEgg({ id: 'leet', color: '#fff' }, 0);
    expect(a.phase).toBe(b.phase);
    expect(a.phase).toBeGreaterThanOrEqual(0);
    expect(a.phase).toBeLessThanOrEqual(1);
  });
});

describe('computeEasterEggs', () => {
  it('handles an empty input as an empty cluster (no crash)', () => {
    const vm = computeEasterEggs({});
    expect(vm.eggs).toEqual([]);
    expect(vm.total).toBe(0);
    expect(vm.hasData).toBe(false);
    expect(vm.base).toEqual(EGGS.base);
  });

  it('handles a fully-undefined call', () => {
    expect(computeEasterEggs().hasData).toBe(false);
  });

  it('places one egg per unlocked condition', () => {
    const vm = computeEasterEggs({ date: on(4, 1), character: { level: 13 } });
    expect(vm.total).toBe(2);
    expect(vm.hasData).toBe(true);
    for (const e of vm.eggs) {
      expect(e.position).toHaveLength(3);
      expect(typeof e.color).toBe('string');
    }
  });
});

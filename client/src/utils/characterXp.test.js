import { describe, it, expect } from 'vitest';
import {
  XP_THRESHOLDS,
  MAX_LEVEL,
  levelFromXP,
  computeXpView,
  computeAgeView,
  diffXp,
} from './characterXp';

describe('levelFromXP', () => {
  it('maps XP to the right level at and above each threshold', () => {
    expect(levelFromXP(0)).toBe(1);
    expect(levelFromXP(299)).toBe(1);
    expect(levelFromXP(300)).toBe(2); // boundary is inclusive
    expect(levelFromXP(899)).toBe(2);
    expect(levelFromXP(900)).toBe(3);
  });

  it('caps at MAX_LEVEL for very high XP', () => {
    expect(levelFromXP(XP_THRESHOLDS[MAX_LEVEL - 1])).toBe(MAX_LEVEL);
    expect(levelFromXP(10_000_000)).toBe(MAX_LEVEL);
  });

  it('clamps negative / NaN XP to level 1', () => {
    expect(levelFromXP(-50)).toBe(1);
    expect(levelFromXP(NaN)).toBe(1);
    expect(levelFromXP(undefined)).toBe(1);
  });
});

describe('computeXpView', () => {
  it('computes progress mid-level', () => {
    // Level 2 spans [300, 900) — 600 XP wide. At 600 XP we're 300 into 600.
    const vm = computeXpView({ xp: 600, level: 2 });
    expect(vm.level).toBe(2);
    expect(vm.xpIntoLevel).toBe(300);
    expect(vm.xpForNextLevel).toBe(600);
    expect(vm.progress).toBeCloseTo(0.5);
    expect(vm.xpToNext).toBe(300);
    expect(vm.atMax).toBe(false);
  });

  it('is 0 progress exactly at a level floor (inclusive boundary)', () => {
    const vm = computeXpView({ xp: 300, level: 2 });
    expect(vm.level).toBe(2);
    expect(vm.xpIntoLevel).toBe(0);
    expect(vm.progress).toBe(0);
  });

  it('approaches 1 just below the next threshold without reaching it', () => {
    const vm = computeXpView({ xp: 899, level: 2 });
    expect(vm.progress).toBeGreaterThan(0.99);
    expect(vm.progress).toBeLessThan(1);
  });

  it('at max level: atMax true, progress pinned to 1, no NaN', () => {
    const maxXp = XP_THRESHOLDS[MAX_LEVEL - 1] + 50_000;
    const vm = computeXpView({ xp: maxXp, level: MAX_LEVEL });
    expect(vm.level).toBe(MAX_LEVEL);
    expect(vm.atMax).toBe(true);
    expect(vm.progress).toBe(1);
    expect(vm.xpForNextLevel).toBe(0);
    expect(vm.xpToNext).toBe(0);
    expect(Number.isNaN(vm.progress)).toBe(false);
  });

  it('returns a sane zero view for null / missing character', () => {
    for (const input of [null, undefined, {}]) {
      const vm = computeXpView(input);
      expect(vm.xp).toBe(0);
      expect(vm.level).toBe(1);
      expect(vm.progress).toBe(0);
      expect(vm.atMax).toBe(false);
      expect(vm.hp).toBeNull();
      expect(vm.maxHp).toBeNull();
      expect(Number.isNaN(vm.progress)).toBe(false);
    }
  });

  it('derives level from xp when the level field is absent / invalid', () => {
    const vm = computeXpView({ xp: 1000 }); // no level field → derive (level 3)
    expect(vm.level).toBe(3);
  });

  it('carries hp / maxHp through when present', () => {
    const vm = computeXpView({ xp: 0, level: 1, hp: 12, maxHp: 15 });
    expect(vm.hp).toBe(12);
    expect(vm.maxHp).toBe(15);
  });

  it('distinguishes absent xp (zero view) from a legitimate zero xp', () => {
    expect(computeXpView({}).xp).toBe(0);
    expect(computeXpView({ xp: 0, level: 1 }).xp).toBe(0);
    // both render as zero, but neither throws or NaNs
    expect(computeXpView({ xp: 0, level: 1 }).progress).toBe(0);
  });
});

describe('computeAgeView', () => {
  it('derives the age level and progress toward the next birthday', () => {
    const vm = computeAgeView({ level: 42, ageYears: 42.5, xp: 1000, hp: 12, maxHp: 15 });
    expect(vm.level).toBe(42);
    expect(vm.hasBirthDate).toBe(true);
    expect(vm.progress).toBeCloseTo(0.5);
    expect(vm.xp).toBe(1000);
    expect(vm.hp).toBe(12);
    expect(vm.maxHp).toBe(15);
    expect(Number.isNaN(vm.progress)).toBe(false);
  });

  it('floors ageYears for level when only ageYears is present', () => {
    const vm = computeAgeView({ ageYears: 30.9, xp: 0 });
    expect(vm.level).toBe(30);
    expect(vm.progress).toBeCloseTo(0.9);
    expect(vm.hasBirthDate).toBe(true);
  });

  it('is 0 progress exactly on a birthday', () => {
    const vm = computeAgeView({ level: 40, ageYears: 40 });
    expect(vm.level).toBe(40);
    expect(vm.progress).toBe(0);
  });

  it('returns a safe no-birthDate view (null level, no NaN)', () => {
    for (const input of [null, undefined, {}, { level: null, ageYears: null, xp: 500 }]) {
      const vm = computeAgeView(input);
      expect(vm.level).toBeNull();
      expect(vm.hasBirthDate).toBe(false);
      expect(vm.progress).toBe(0);
      expect(vm.daysToNextBirthday).toBeNull();
      expect(Number.isNaN(vm.progress)).toBe(false);
    }
  });

  it('carries xp through as a stat while level is null (no birthDate)', () => {
    const vm = computeAgeView({ level: null, ageYears: null, xp: 777 });
    expect(vm.xp).toBe(777);
    expect(vm.level).toBeNull();
  });

  it('computes a bounded days-to-next-birthday countdown', () => {
    const vm = computeAgeView({ level: 25, ageYears: 25.0 });
    expect(vm.daysToNextBirthday).toBeGreaterThan(360);
    expect(vm.daysToNextBirthday).toBeLessThanOrEqual(366);
  });
});

describe('diffXp', () => {
  it('reports a gain when XP increased without a level change', () => {
    const d = diffXp({ xp: 100, level: 1 }, { xp: 250, level: 1 });
    expect(d.gained).toBe(150);
    expect(d.leveledUp).toBe(false);
  });

  it('reports no change when XP is identical', () => {
    const d = diffXp({ xp: 250, level: 2 }, { xp: 250, level: 2 });
    expect(d.gained).toBe(0);
    expect(d.leveledUp).toBe(false);
  });

  it('reports a level-up when XP crosses a threshold', () => {
    const d = diffXp({ xp: 250, level: 1 }, { xp: 400, level: 2 });
    expect(d.gained).toBe(150);
    expect(d.leveledUp).toBe(true);
  });

  it('does NOT infer a level-up from XP when level fields are absent (level is age-based)', () => {
    // No birthDate → level is null on both snapshots. An XP gain crossing a legacy
    // threshold must not fire the birthday "level-up" flash (#2673 decouples xp from level).
    const d = diffXp({ xp: 250 }, { xp: 400 }); // crosses the 300 threshold
    expect(d.gained).toBe(150);
    expect(d.leveledUp).toBe(false);
  });

  it('fires a level-up only on a real age-level increase (birthday)', () => {
    const d = diffXp({ xp: 100, level: 41 }, { xp: 150, level: 42 });
    expect(d.gained).toBe(50);
    expect(d.leveledUp).toBe(true);
  });

  it('does not burst on the first poll (no prior snapshot)', () => {
    expect(diffXp(null, { xp: 500, level: 2 })).toEqual({ gained: 0, leveledUp: false });
    expect(diffXp(undefined, { xp: 500 })).toEqual({ gained: 0, leveledUp: false });
  });

  it('never reports a negative gain when XP drops (reset)', () => {
    const d = diffXp({ xp: 5000, level: 4 }, { xp: 0, level: 1 });
    expect(d.gained).toBe(0);
    expect(d.leveledUp).toBe(false);
  });
});

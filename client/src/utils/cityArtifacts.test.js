import { describe, it, expect } from 'vitest';
import {
  ARTIFACTS,
  LEVEL_MILESTONES,
  GOAL_MILESTONES,
  STREAK_MILESTONES,
  effectiveLevel,
  completedGoalCount,
  bestStreakDays,
  earnedArtifacts,
  placeArtifact,
  computeArtifacts,
} from './cityArtifacts';

const completedGoals = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `g-${i}`, status: 'completed' }));

describe('effectiveLevel', () => {
  it('trusts a stored, consistent level', () => {
    expect(effectiveLevel({ level: 7 })).toBe(7);
    expect(effectiveLevel({ level: 3.9 })).toBe(3); // floored
  });

  it('derives level from xp only when the level field is ABSENT (legacy payload)', () => {
    expect(effectiveLevel({ xp: 300 })).toBe(2); // 300 xp → level 2
    expect(effectiveLevel({ xp: 0 })).toBe(1);
  });

  it('returns null for an explicit null level (age unknown) — no XP fallback', () => {
    // Age-based level (#2673): birthDate unset → level: null. XP must not resurrect a level,
    // or trophies/eggs would unlock while the HUD shows "LV —".
    expect(effectiveLevel({ level: null, xp: 999999 })).toBeNull();
    expect(effectiveLevel({ level: null, xp: 0 })).toBeNull();
  });

  it('treats age level 0 (birthDate < 1yr ago) as authoritative, not an XP fallback', () => {
    expect(effectiveLevel({ level: 0, xp: 999999 })).toBe(0);
  });

  it('returns null when neither level nor xp is usable', () => {
    expect(effectiveLevel(null)).toBeNull();
    expect(effectiveLevel({})).toBeNull();
    expect(effectiveLevel({ level: null, xp: 'nope' })).toBeNull();
  });
});

describe('completedGoalCount', () => {
  it('counts only completed goals', () => {
    const goals = [
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'active' },
      { id: 'c', status: 'completed' },
      { id: 'd', status: 'abandoned' },
    ];
    expect(completedGoalCount(goals)).toBe(2);
  });

  it('accepts the API wrapper { goals: [] }', () => {
    expect(completedGoalCount({ goals: completedGoals(3) })).toBe(3);
  });

  it('is 0 for missing / garbage / null-entry input', () => {
    for (const bad of [null, undefined, 'nope', 42, {}]) {
      expect(completedGoalCount(bad)).toBe(0);
    }
    expect(completedGoalCount([null, 'x', { status: 'completed' }])).toBe(1);
  });
});

describe('bestStreakDays', () => {
  it('prefers longest over current', () => {
    expect(bestStreakDays({ streak: { current: 2, longest: 9 } })).toBe(9);
  });

  it('falls back to current when longest absent', () => {
    expect(bestStreakDays({ streak: { current: 4 } })).toBe(4);
  });

  it('returns null when no streak data', () => {
    expect(bestStreakDays(null)).toBeNull();
    expect(bestStreakDays({})).toBeNull();
    expect(bestStreakDays({ streak: {} })).toBeNull();
    expect(bestStreakDays({ streak: 'nope' })).toBeNull();
  });
});

describe('earnedArtifacts — thresholds', () => {
  it('returns nothing when nothing is earned', () => {
    expect(earnedArtifacts({})).toEqual([]);
    expect(earnedArtifacts({ character: { level: 1 }, goals: [], productivityData: { streak: { longest: 0 } } })).toEqual([]);
  });

  it('earns level milestones at/above each threshold', () => {
    const ids = earnedArtifacts({ character: { level: 5 } }).map((a) => a.id);
    expect(ids).toContain('level-2');
    expect(ids).toContain('level-5');
    expect(ids).not.toContain('level-10');
  });

  it('does not earn a level statue at level 1', () => {
    expect(earnedArtifacts({ character: { level: 1 } })).toEqual([]);
  });

  it('earns goal milestones for completed-goal counts', () => {
    const ids = earnedArtifacts({ goals: completedGoals(5) }).map((a) => a.id);
    expect(ids).toContain('goals-1');
    expect(ids).toContain('goals-5');
    expect(ids).not.toContain('goals-10');
  });

  it('earns streak milestones from the best streak', () => {
    const ids = earnedArtifacts({ productivityData: { streak: { longest: 7 } } }).map((a) => a.id);
    expect(ids).toContain('streak-3');
    expect(ids).toContain('streak-7');
    expect(ids).not.toContain('streak-30');
  });

  it('combines all three sources in stable order (level → goal → streak)', () => {
    const earned = earnedArtifacts({
      character: { level: 2 },
      goals: completedGoals(1),
      productivityData: { streak: { longest: 3 } },
    });
    expect(earned.map((a) => a.kind)).toEqual(['level', 'goal', 'streak']);
    expect(earned.map((a) => a.id)).toEqual(['level-2', 'goals-1', 'streak-3']);
  });

  it('attaches a tier + label to each descriptor', () => {
    const [a] = earnedArtifacts({ character: { level: 2 } });
    expect(a.tier).toBe('bronze');
    expect(a.label).toBe('NOVICE');
    expect(a.threshold).toBe(2);
  });
});

describe('placeArtifact', () => {
  it('centers the first row on base.x and resolves the tier color', () => {
    const placed = placeArtifact({ id: 'x', kind: 'level', tier: 'gold', label: 'L' }, 1);
    // index 1 is the middle column of a 3-wide grid → centered on base.x
    expect(placed.position[0]).toBeCloseTo(ARTIFACTS.base[0]);
    expect(placed.position[2]).toBe(ARTIFACTS.base[2]);
    expect(placed.color).toBe('#22c55e');
    expect(placed.intensity).toBeGreaterThan(0);
  });

  it('wraps to the next row toward -Z after columns are filled', () => {
    const first = placeArtifact({ id: 'a', tier: 'bronze' }, 0);
    const wrapped = placeArtifact({ id: 'b', tier: 'bronze' }, ARTIFACTS.columns);
    expect(wrapped.position[0]).toBeCloseTo(first.position[0]); // same column
    expect(wrapped.position[2]).toBe(ARTIFACTS.base[2] - ARTIFACTS.spacing); // one row back
  });

  it('falls back to the bronze tier for an unknown tier', () => {
    const placed = placeArtifact({ id: 'x', tier: 'unknown' }, 0);
    expect(placed.color).toBe('#f59e0b');
  });
});

describe('computeArtifacts', () => {
  it('handles all-absent input as an empty cluster (no crash)', () => {
    const vm = computeArtifacts({});
    expect(vm.artifacts).toEqual([]);
    expect(vm.total).toBe(0);
    expect(vm.hasData).toBe(false);
    expect(vm.base).toEqual(ARTIFACTS.base);
  });

  it('handles a fully-undefined call', () => {
    const vm = computeArtifacts();
    expect(vm.hasData).toBe(false);
  });

  it('places one artifact per earned milestone', () => {
    const vm = computeArtifacts({
      character: { level: 10 }, // 3 level milestones
      goals: completedGoals(10), // 3 goal milestones
      productivityData: { streak: { longest: 30 } }, // 3 streak milestones
    });
    expect(vm.total).toBe(LEVEL_MILESTONES.length + GOAL_MILESTONES.length + STREAK_MILESTONES.length);
    expect(vm.hasData).toBe(true);
    for (const a of vm.artifacts) {
      expect(a.position).toHaveLength(3);
      expect(typeof a.color).toBe('string');
    }
  });
});

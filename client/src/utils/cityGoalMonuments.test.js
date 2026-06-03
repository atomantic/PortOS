import { describe, it, expect } from 'vitest';
import {
  MONUMENTS,
  FOREST,
  STALL_DAYS,
  daysSinceLastProgress,
  effectiveGoalStatus,
  buildCompleteness,
  placeMonument,
  computeGoalMonuments,
  isMilestoneDone,
  computeMilestoneSegments,
  buildGoalForest,
  countDescendants,
  computeGoalForest,
} from './cityGoalMonuments';

const NOW = Date.parse('2026-06-03T00:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();

const goal = (over = {}) => ({
  id: 'goal-1',
  title: 'Run a marathon',
  status: 'active',
  progress: 50,
  createdAt: daysAgo(10),
  progressHistory: [{ date: daysAgo(5), value: 50 }],
  ...over,
});

describe('daysSinceLastProgress', () => {
  it('measures from the most recent progressHistory entry', () => {
    const g = goal({ progressHistory: [{ date: daysAgo(3), value: 20 }, { date: daysAgo(10), value: 5 }] });
    expect(daysSinceLastProgress(g, NOW)).toBeCloseTo(3, 1);
  });

  it('falls back to createdAt when no history', () => {
    const g = goal({ progressHistory: [], createdAt: daysAgo(7) });
    expect(daysSinceLastProgress(g, NOW)).toBeCloseTo(7, 1);
  });

  it('returns null when there is no usable date', () => {
    expect(daysSinceLastProgress({ progressHistory: [] }, NOW)).toBeNull();
    expect(daysSinceLastProgress(null, NOW)).toBeNull();
    expect(daysSinceLastProgress({ progressHistory: [{ date: 'nope' }] }, NOW)).toBeNull();
  });
});

describe('effectiveGoalStatus', () => {
  it('maps stored completed/abandoned through unchanged', () => {
    expect(effectiveGoalStatus(goal({ status: 'completed' }), NOW)).toBe('completed');
    expect(effectiveGoalStatus(goal({ status: 'abandoned' }), NOW)).toBe('abandoned');
  });

  it('treats progress >= 100 as completed even if stored active', () => {
    expect(effectiveGoalStatus(goal({ status: 'active', progress: 100 }), NOW)).toBe('completed');
  });

  it('derives stalled for an active goal with no progress past the threshold', () => {
    const stale = goal({ progressHistory: [{ date: daysAgo(STALL_DAYS + 5), value: 50 }] });
    expect(effectiveGoalStatus(stale, NOW)).toBe('stalled');
  });

  it('keeps a recently-progressed active goal active', () => {
    const fresh = goal({ progressHistory: [{ date: daysAgo(2), value: 50 }] });
    expect(effectiveGoalStatus(fresh, NOW)).toBe('active');
  });

  it('defaults to active for an unknown/missing status', () => {
    expect(effectiveGoalStatus({ progressHistory: [{ date: daysAgo(1) }] }, NOW)).toBe('active');
  });
});

describe('buildCompleteness', () => {
  it('is always 1 for a completed monument', () => {
    expect(buildCompleteness(goal({ progress: 12 }), 'completed')).toBe(1);
  });

  it('tracks progress/100 for active, clamped', () => {
    expect(buildCompleteness(goal({ progress: 40 }), 'active')).toBeCloseTo(0.4);
    expect(buildCompleteness(goal({ progress: 250 }), 'active')).toBe(1);
    expect(buildCompleteness(goal({ progress: -5 }), 'active')).toBe(0);
  });

  it('treats missing progress as 0 (a floor stub), not a crash', () => {
    expect(buildCompleteness({}, 'active')).toBe(0);
  });
});

describe('placeMonument', () => {
  it('maps status to color/opacity/dim/built', () => {
    const completed = placeMonument(goal({ status: 'completed' }), 0, 1, NOW);
    expect(completed.built).toBe(true);
    expect(completed.dim).toBe(false);
    expect(completed.completeness).toBe(1);
    expect(completed.height).toBeCloseTo(MONUMENTS.fullHeight);

    const abandoned = placeMonument(goal({ status: 'abandoned' }), 0, 1, NOW);
    expect(abandoned.dim).toBe(true);
    expect(abandoned.built).toBe(false);
    expect(abandoned.opacity).toBeLessThan(completed.opacity);
  });

  it('progress drives height between min and full', () => {
    const half = placeMonument(goal({ status: 'active', progress: 50, progressHistory: [{ date: daysAgo(1) }] }), 0, 1, NOW);
    expect(half.height).toBeGreaterThan(MONUMENTS.minHeight);
    expect(half.height).toBeLessThan(MONUMENTS.fullHeight);
  });

  it('centers a single monument on base.x', () => {
    const only = placeMonument(goal(), 0, 1, NOW);
    expect(only.position[0]).toBeCloseTo(MONUMENTS.base[0]);
    expect(only.position[2]).toBe(MONUMENTS.z);
  });

  it('lays out a row centered around base.x with consistent spacing', () => {
    const a = placeMonument(goal(), 0, 3, NOW);
    const b = placeMonument(goal(), 1, 3, NOW);
    const c = placeMonument(goal(), 2, 3, NOW);
    expect(b.position[0]).toBeCloseTo(MONUMENTS.base[0]); // middle slot on center
    expect(b.position[0] - a.position[0]).toBeCloseTo(MONUMENTS.spacing);
    expect(c.position[0] - b.position[0]).toBeCloseTo(MONUMENTS.spacing);
  });

  it('falls back to a title and id without crashing', () => {
    const m = placeMonument({}, 2, 5, NOW);
    expect(m.title).toBe('Untitled Goal');
    expect(m.id).toBe('goal-2');
  });
});

describe('computeGoalMonuments', () => {
  it('handles missing / non-array input as an empty district', () => {
    for (const bad of [null, undefined, 'nope', 42, {}]) {
      const vm = computeGoalMonuments(bad, NOW);
      expect(vm.monuments).toEqual([]);
      expect(vm.overflow).toBeNull();
      expect(vm.hasData).toBe(false);
      expect(vm.total).toBe(0);
    }
  });

  it('places one monument per goal up to the cap', () => {
    const goals = Array.from({ length: 4 }, (_, i) => goal({ id: `g-${i}` }));
    const vm = computeGoalMonuments(goals, NOW);
    expect(vm.monuments).toHaveLength(4);
    expect(vm.overflow).toBeNull();
    expect(vm.total).toBe(4);
    expect(vm.hasData).toBe(true);
  });

  it('caps at maxMonuments and folds the rest into an overflow marker', () => {
    const goals = Array.from({ length: MONUMENTS.maxMonuments + 3 }, (_, i) => goal({ id: `g-${i}` }));
    const vm = computeGoalMonuments(goals, NOW);
    expect(vm.monuments).toHaveLength(MONUMENTS.maxMonuments);
    expect(vm.overflow).not.toBeNull();
    expect(vm.overflow.count).toBe(3);
    expect(vm.overflow.position[2]).toBe(MONUMENTS.z);
    expect(vm.total).toBe(MONUMENTS.maxMonuments + 3);
  });

  it('orders completed monuments before active before stalled before abandoned', () => {
    const goals = [
      goal({ id: 'ab', status: 'abandoned' }),
      goal({ id: 'co', status: 'completed' }),
      goal({ id: 'st', progressHistory: [{ date: daysAgo(STALL_DAYS + 1) }] }),
      goal({ id: 'ac', progressHistory: [{ date: daysAgo(1) }] }),
    ];
    const vm = computeGoalMonuments(goals, NOW);
    expect(vm.monuments.map((m) => m.status)).toEqual(['completed', 'active', 'stalled', 'abandoned']);
  });

  it('reports completed / active counts', () => {
    const goals = [
      goal({ id: 'a', status: 'completed' }),
      goal({ id: 'b', status: 'completed' }),
      goal({ id: 'c', progressHistory: [{ date: daysAgo(1) }] }),
    ];
    const vm = computeGoalMonuments(goals, NOW);
    expect(vm.completedCount).toBe(2);
    expect(vm.activeCount).toBe(1);
  });

  it('skips null / non-object entries without crashing', () => {
    const vm = computeGoalMonuments([null, goal({ id: 'ok' }), 'bad', 42], NOW);
    expect(vm.monuments).toHaveLength(1);
    expect(vm.monuments[0].id).toBe('ok');
  });
});

const milestone = (over = {}) => ({ id: `ms-${over.order ?? 0}`, title: `MS`, order: 0, completedAt: null, ...over });

describe('isMilestoneDone', () => {
  it('is true when completedAt is a non-empty string', () => {
    expect(isMilestoneDone(milestone({ completedAt: '2026-01-01T00:00:00Z' }))).toBe(true);
  });

  it('is true when the explicit completed flag is set', () => {
    expect(isMilestoneDone(milestone({ completed: true, completedAt: null }))).toBe(true);
  });

  it('is false when neither signal is present', () => {
    expect(isMilestoneDone(milestone({ completedAt: null }))).toBe(false);
    expect(isMilestoneDone(milestone({ completedAt: '' }))).toBe(false);
    expect(isMilestoneDone(null)).toBe(false);
    expect(isMilestoneDone('nope')).toBe(false);
  });
});

describe('computeMilestoneSegments', () => {
  it('returns an empty array for a goal with no milestones', () => {
    expect(computeMilestoneSegments(goal({ milestones: [] }), 10)).toEqual([]);
    expect(computeMilestoneSegments(goal({ milestones: undefined }), 10)).toEqual([]);
    expect(computeMilestoneSegments(goal(), 0)).toEqual([]);
  });

  it('splits the height evenly into ordered, stacked floors', () => {
    const g = goal({ milestones: [milestone({ order: 0 }), milestone({ order: 1 }), milestone({ order: 2 })] });
    const segs = computeMilestoneSegments(g, 12);
    expect(segs).toHaveLength(3);
    expect(segs.map((s) => s.segHeight)).toEqual([4, 4, 4]);
    expect(segs[0].y0).toBe(0);
    expect(segs[0].y1).toBe(4);
    expect(segs[1].y0).toBe(4);
    expect(segs[2].y1).toBeCloseTo(12);
    expect(segs[1].cy).toBe(6);
  });

  it('sorts by the order field, ties keep input order', () => {
    const g = goal({ milestones: [
      milestone({ id: 'c', order: 2, title: 'Third' }),
      milestone({ id: 'a', order: 0, title: 'First' }),
      milestone({ id: 'b', order: 1, title: 'Second' }),
    ] });
    const segs = computeMilestoneSegments(g, 9);
    expect(segs.map((s) => s.title)).toEqual(['First', 'Second', 'Third']);
    expect(segs.map((s) => s.order)).toEqual([0, 1, 2]); // re-indexed slot order
  });

  it('falls back to input index when the order field is absent (manual milestones)', () => {
    // addMilestone() on the server omits `order`; computeMilestoneSegments must keep input
    // order for those (sort key = input index). An explicit `order` (AI phases set it)
    // sorts by its value; ties with an index-keyed entry break by original input index.
    const g = goal({ milestones: [
      { id: 'm1', title: 'First added' },           // no order → key = index 0
      { id: 'm2', title: 'Second added' },          // no order → key = index 1
      { id: 'm3', title: 'Phase', order: 5 },       // explicit order 5 → sorts last
    ] });
    const segs = computeMilestoneSegments(g, 9);
    expect(segs.map((s) => s.title)).toEqual(['First added', 'Second added', 'Phase']);
  });

  it('marks the done flag per milestone', () => {
    const g = goal({ milestones: [
      milestone({ order: 0, completedAt: '2026-01-01T00:00:00Z' }),
      milestone({ order: 1, completedAt: null }),
    ] });
    const segs = computeMilestoneSegments(g, 8);
    expect(segs[0].done).toBe(true);
    expect(segs[1].done).toBe(false);
  });

  it('skips non-object milestone entries', () => {
    const g = goal({ milestones: [null, milestone({ order: 0 }), 42] });
    expect(computeMilestoneSegments(g, 6)).toHaveLength(1);
  });
});

describe('placeMonument with milestones', () => {
  it('attaches milestone segments and done/total counts', () => {
    const g = goal({ status: 'active', progress: 60, progressHistory: [{ date: daysAgo(1) }], milestones: [
      milestone({ order: 0, completedAt: '2026-01-01T00:00:00Z' }),
      milestone({ order: 1, completedAt: '2026-02-01T00:00:00Z' }),
      milestone({ order: 2, completedAt: null }),
    ] });
    const m = placeMonument(g, 0, 1, NOW);
    expect(m.segments).toHaveLength(3);
    expect(m.milestoneTotal).toBe(3);
    expect(m.milestoneDone).toBe(2);
  });

  it('honors an explicit position override (forest layout)', () => {
    const m = placeMonument(goal(), 0, 1, NOW, [5, 0, -10]);
    expect(m.position).toEqual([5, 0, -10]);
  });

  it('reports zero milestones for a goal without any', () => {
    const m = placeMonument(goal({ milestones: [] }), 0, 1, NOW);
    expect(m.segments).toEqual([]);
    expect(m.milestoneTotal).toBe(0);
    expect(m.milestoneDone).toBe(0);
  });
});

describe('buildGoalForest', () => {
  it('attaches children under a present parent and leaves the rest as roots', () => {
    const goals = [
      goal({ id: 'root', parentId: null }),
      goal({ id: 'child-a', parentId: 'root' }),
      goal({ id: 'child-b', parentId: 'root' }),
      goal({ id: 'orphan', parentId: 'gone' }), // dangling parentId → root
    ];
    const { roots } = buildGoalForest(goals);
    const ids = roots.map((r) => r.goal.id).sort();
    expect(ids).toEqual(['orphan', 'root']);
    const root = roots.find((r) => r.goal.id === 'root');
    expect(root.children.map((c) => c.goal.id).sort()).toEqual(['child-a', 'child-b']);
  });

  it('does not attach a goal to itself', () => {
    const { roots } = buildGoalForest([goal({ id: 'self', parentId: 'self' })]);
    expect(roots).toHaveLength(1);
    expect(roots[0].children).toHaveLength(0);
  });

  it('ignores entries without an id or non-objects', () => {
    const { roots } = buildGoalForest([null, 'x', { parentId: 'p' }, goal({ id: 'ok' })]);
    expect(roots.map((r) => r.goal.id)).toEqual(['ok']);
  });

  it('nests grandchildren under children (multi-level)', () => {
    const { roots } = buildGoalForest([
      goal({ id: 'root', parentId: null }),
      goal({ id: 'child', parentId: 'root' }),
      goal({ id: 'grand', parentId: 'child' }),
    ]);
    expect(roots).toHaveLength(1);
    const child = roots[0].children[0];
    expect(child.goal.id).toBe('child');
    expect(child.children.map((g) => g.goal.id)).toEqual(['grand']);
  });
});

describe('countDescendants', () => {
  const forestOf = (goals) => buildGoalForest(goals).roots[0];

  it('counts children and grandchildren, excluding the node itself', () => {
    const root = forestOf([
      goal({ id: 'root', parentId: null }),
      goal({ id: 'c1', parentId: 'root' }),
      goal({ id: 'c2', parentId: 'root' }),
      goal({ id: 'g1', parentId: 'c1' }),
      goal({ id: 'g2', parentId: 'c1' }),
    ]);
    expect(countDescendants(root)).toBe(4); // c1, c2, g1, g2
  });

  it('is 0 for a leaf', () => {
    const root = forestOf([goal({ id: 'solo', parentId: null })]);
    expect(countDescendants(root)).toBe(0);
  });
});

describe('computeGoalForest', () => {
  const tree = () => [
    goal({ id: 'apex', parentId: null, status: 'active', progressHistory: [{ date: daysAgo(1) }] }),
    goal({ id: 'c1', parentId: 'apex', progressHistory: [{ date: daysAgo(1) }] }),
    goal({ id: 'c2', parentId: 'apex', progressHistory: [{ date: daysAgo(1) }] }),
  ];

  it('reports hasHierarchy only when a root has children', () => {
    const flat = computeGoalForest([goal({ id: 'a' }), goal({ id: 'b' })], NOW);
    expect(flat.hasHierarchy).toBe(false);
    const nested = computeGoalForest(tree(), NOW);
    expect(nested.hasHierarchy).toBe(true);
  });

  it('places a root spire taller than a flat monument and clusters its children', () => {
    const vm = computeGoalForest(tree(), NOW);
    expect(vm.clusters).toHaveLength(1);
    const cluster = vm.clusters[0];
    expect(cluster.spire.isSpire).toBe(true);
    const flat = placeMonument(goal({ id: 'apex', status: 'active', progressHistory: [{ date: daysAgo(1) }] }), 0, 1, NOW);
    expect(cluster.spire.height).toBeCloseTo(flat.height * FOREST.spireBoost);
    expect(cluster.children).toHaveLength(2);
    // Children carry a parentId back-reference and one link each to the spire apex.
    expect(cluster.children.every((c) => c.parentId === 'apex')).toBe(true);
    expect(cluster.links).toHaveLength(2);
    // Links join the tower tops, which sit a 0.4 plinth above the height baseline.
    expect(cluster.links[0].to).toEqual([cluster.spire.position[0], 0.4 + cluster.spire.height, cluster.spire.position[2]]);
  });

  it('centers a single root cluster on FOREST.base', () => {
    const vm = computeGoalForest(tree(), NOW);
    expect(vm.clusters[0].spire.position[0]).toBeCloseTo(FOREST.base[0]);
    expect(vm.clusters[0].spire.position[2]).toBe(FOREST.base[2]);
  });

  it('caps root clusters and reports the overflow (folded roots + their descendants)', () => {
    const goals = [];
    for (let i = 0; i < FOREST.maxRoots + 2; i++) {
      goals.push(goal({ id: `r${i}`, parentId: null }));
      goals.push(goal({ id: `c${i}`, parentId: `r${i}` }));
    }
    const vm = computeGoalForest(goals, NOW);
    expect(vm.clusters).toHaveLength(FOREST.maxRoots);
    // 2 overflowed roots, each with 1 child → 2 * (1 + 1) = 4 goals folded away.
    expect(vm.rootOverflow).toBe(4);
    expect(vm.rootCount).toBe(FOREST.maxRoots + 2);
  });

  it('flips to the forest view when only an OVERFLOWED root has children', () => {
    // First maxRoots roots are flat leaves; the next root (which overflows the cap) is the
    // only one with a child. hasHierarchy must be derived pre-cap so the forest still shows.
    // Status ties sort by id ascending, so the flat roots use ids that sort BEFORE the deep
    // one ('aflat*' < 'zdeep-root') to guarantee the child-bearing root lands past the cap.
    const goals = [];
    for (let i = 0; i < FOREST.maxRoots; i++) goals.push(goal({ id: `aflat${i}`, parentId: null }));
    goals.push(goal({ id: 'zdeep-root', parentId: null }));
    goals.push(goal({ id: 'zdeep-child', parentId: 'zdeep-root' }));
    const vm = computeGoalForest(goals, NOW);
    // The child-bearing root is beyond FOREST.maxRoots, so it is NOT in the visible clusters…
    expect(vm.clusters.every((c) => c.children.length === 0)).toBe(true);
    // …yet the district must still pick the forest layout (pre-cap hierarchy detection)…
    expect(vm.hasHierarchy).toBe(true);
    // …and the overflowed root + its child are both counted, not silently dropped.
    expect(vm.rootOverflow).toBe(2);
  });

  it('surfaces a descendant count on a child that has its own sub-tree (no silent drop)', () => {
    const vm = computeGoalForest([
      goal({ id: 'apex', parentId: null }),
      goal({ id: 'child', parentId: 'apex', progressHistory: [{ date: daysAgo(1) }] }),
      goal({ id: 'grand1', parentId: 'child' }),
      goal({ id: 'grand2', parentId: 'child' }),
    ], NOW);
    const child = vm.clusters[0].children.find((c) => c.id === 'child');
    expect(child.descendantCount).toBe(2); // grand1 + grand2, summarized not dropped
  });

  it('caps children per root and reports childOverflow', () => {
    const goals = [goal({ id: 'apex', parentId: null })];
    for (let i = 0; i < FOREST.maxChildren + 3; i++) goals.push(goal({ id: `c${i}`, parentId: 'apex' }));
    const vm = computeGoalForest(goals, NOW);
    expect(vm.clusters[0].children).toHaveLength(FOREST.maxChildren);
    expect(vm.clusters[0].childOverflow).toBe(3);
  });

  it('handles missing / non-array input as an empty forest', () => {
    for (const bad of [null, undefined, 'nope', 42, {}]) {
      const vm = computeGoalForest(bad, NOW);
      expect(vm.clusters).toEqual([]);
      expect(vm.hasData).toBe(false);
      expect(vm.hasHierarchy).toBe(false);
    }
  });
});

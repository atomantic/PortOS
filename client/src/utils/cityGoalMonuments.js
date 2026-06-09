// Pure, deterministic helpers for CyberCity's "goal monuments" (roadmap 2.7): each
// life goal renders as a structure in a northeast monument district. Active goals are
// construction sites (scaffolded/partial towers whose build completeness tracks
// progress); completed goals are polished, fully-built monuments that shimmer; stalled
// goals (active but with no recent progress) and abandoned goals read dim. The goal
// list is capped to a sensible row; the rest are summarized by an overflow marker. No
// three.js / React imports so the topology is unit-testable (mirrors cityFederation.js
// / cityHealthTower.js).

import { PARCELS } from './cityPlan';

export const MONUMENTS = {
  // Northeast monument district — a row anchored by the master plan (cityPlan.js), clear
  // of the vault, task-queue, voice beacon, health tower, AI core, and productivity district.
  base: PARCELS.goals.anchor, // center of the row
  spacing: 9, // x-distance between adjacent monuments
  z: PARCELS.goals.anchor[2], // shared depth of the row
  maxMonuments: 8, // cap; goals beyond this fold into an overflow marker
  minHeight: 2, // floor height so even a 0%-progress site reads as a small structure
  fullHeight: 12, // height of a completed (100%) monument
  baseWidth: 2.4,
};

// Status → visual treatment. `dim` collapses opacity + glow so stalled/abandoned goals
// recede; `built` flags a finished monument (drives the polished material + shimmer).
const STATUS_STYLES = {
  completed: { color: '#22c55e', opacity: 1, intensity: 0.7, dim: false, built: true }, // port-success
  active: { color: '#3b82f6', opacity: 0.92, intensity: 0.4, dim: false, built: false }, // port-accent — under construction
  stalled: { color: '#f59e0b', opacity: 0.55, intensity: 0.18, dim: true, built: false }, // port-warning, dimmed
  abandoned: { color: '#64748b', opacity: 0.32, intensity: 0.08, dim: true, built: false }, // slate, dimmed
};

const DEFAULT_STYLE = STATUS_STYLES.active;

const clamp01 = (n) => Math.max(0, Math.min(1, n));

// Days since the most recent progressHistory entry (or createdAt as a fallback).
// Returns null when there's nothing to measure from, so callers can distinguish
// "no signal" from a real recency.
export function daysSinceLastProgress(goal, now = Date.now()) {
  const history = Array.isArray(goal?.progressHistory) ? goal.progressHistory : [];
  let latest = null;
  for (const entry of history) {
    const t = entry?.date ? Date.parse(entry.date) : NaN;
    if (Number.isFinite(t) && (latest === null || t > latest)) latest = t;
  }
  if (latest === null) {
    const created = goal?.createdAt ? Date.parse(goal.createdAt) : NaN;
    if (Number.isFinite(created)) latest = created;
  }
  if (latest === null) return null;
  return Math.max(0, (now - latest) / (1000 * 60 * 60 * 24));
}

// Derive the *effective* status used for visualization. The stored status enum is
// active | completed | abandoned (server: goalStatusEnum). "stalled" is a derived
// state — an active, not-yet-complete goal with no progress in STALL_DAYS — so the
// monument visibly dims when a goal goes quiet. Threshold is conservative.
export const STALL_DAYS = 45;

export function effectiveGoalStatus(goal, now = Date.now()) {
  const raw = goal?.status;
  if (raw === 'completed') return 'completed';
  if (raw === 'abandoned') return 'abandoned';
  // Treat anything else as active for styling purposes.
  const progress = Number.isFinite(goal?.progress) ? goal.progress : 0;
  if (progress >= 100) return 'completed';
  const idleDays = daysSinceLastProgress(goal, now);
  if (idleDays !== null && idleDays >= STALL_DAYS) return 'stalled';
  return 'active';
}

// Build completeness 0..1: completed monuments are always fully built; everything else
// tracks `progress` (clamped). A present-but-zero progress reads as a 1-floor stub, not
// nothing, so a freshly-created goal still shows on the row.
export function buildCompleteness(goal, status) {
  if (status === 'completed') return 1;
  const progress = Number.isFinite(goal?.progress) ? goal.progress : 0;
  return clamp01(progress / 100);
}

// A milestone is "done" when it carries a completion timestamp (`completedAt`, the
// server's stored field) or an explicit `completed: true` flag. Absent both, it's
// pending. Kept tolerant so an older/foreign goal record doesn't crash the view.
export function isMilestoneDone(milestone) {
  if (!milestone || typeof milestone !== 'object') return false;
  if (milestone.completed === true) return true;
  return typeof milestone.completedAt === 'string' && milestone.completedAt.length > 0;
}

// Break a monument's height into ordered milestone segments (floors). Each segment
// reports its vertical extent (`y0`..`y1`, centered at `cy`) and whether the milestone
// is done — so the component can render completed floors solid and pending floors as
// translucent scaffold rungs. `height` is the monument's built+scaffold total; segments
// are sorted by the milestone `order` field (stable, ties keep input order) and split the
// height evenly. A goal with no milestones returns an empty array (the caller falls back
// to the plain built/scaffold split). Pure + deterministic — no three.js.
export function computeMilestoneSegments(goal, height) {
  const raw = Array.isArray(goal?.milestones) ? goal.milestones.filter((m) => m && typeof m === 'object') : [];
  if (raw.length === 0 || !(height > 0)) return [];

  // Stable order: by `order` field ascending, ties keep original index.
  const ordered = raw
    .map((milestone, i) => ({ milestone, i }))
    .sort((a, b) => {
      const oa = Number.isFinite(a.milestone.order) ? a.milestone.order : a.i;
      const ob = Number.isFinite(b.milestone.order) ? b.milestone.order : b.i;
      if (oa !== ob) return oa - ob;
      return a.i - b.i;
    });

  const segHeight = height / ordered.length;
  return ordered.map(({ milestone }, slot) => {
    const y0 = slot * segHeight;
    const y1 = y0 + segHeight;
    return {
      id: milestone.id || `ms-${slot}`,
      title: typeof milestone.title === 'string' && milestone.title ? milestone.title : `Milestone ${slot + 1}`,
      order: slot,
      done: isMilestoneDone(milestone),
      y0,
      y1,
      cy: (y0 + y1) / 2,
      segHeight,
    };
  });
}

// Stamp a monument view-model with its milestone segments + done/total counts. Used by
// placeMonument and again by the forest layout after a spire's height is boosted (the
// segments must be recomputed against the taller height). Mutates and returns `monument`.
function attachMilestones(monument, goal, height) {
  monument.segments = computeMilestoneSegments(goal, height);
  monument.milestoneTotal = monument.segments.length;
  monument.milestoneDone = monument.segments.filter((s) => s.done).length;
  return monument;
}

// Status ordering shared by the flat row and the forest: completed first (trophies up
// front), then active, stalled, abandoned; ties broken by goal id for a layout that
// doesn't reshuffle across refetches. Used as an Array.sort comparator over items that
// expose `{ status, id }`.
const STATUS_RANK = { completed: 0, active: 1, stalled: 2, abandoned: 3 };
function compareByStatusThenId(a, b) {
  const sa = STATUS_RANK[a.status] ?? 9;
  const sb = STATUS_RANK[b.status] ?? 9;
  if (sa !== sb) return sa - sb;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

// Map one goal to its placed monument view-model. `index` is the slot in the row (0-based);
// `count` is how many monuments are actually placed, so the row is centered on MONUMENTS.base.
// When `position` is supplied (goal-forest layout) it overrides the centered-row placement,
// so the same monument view-model serves both the flat row and the hierarchy spires.
// `heightScale` (forest spires) boosts the tower height; passing it here means milestone
// segments are computed once against the final height instead of re-segmented after.
export function placeMonument(goal, index, count, now = Date.now(), position = null, heightScale = 1) {
  const status = effectiveGoalStatus(goal, now);
  const style = STATUS_STYLES[status] || DEFAULT_STYLE;
  const completeness = buildCompleteness(goal, status);
  const height = (MONUMENTS.minHeight + completeness * (MONUMENTS.fullHeight - MONUMENTS.minHeight)) * heightScale;

  // Center the row: slot 0 sits at the leftmost, the middle slot aligns with base.x.
  const offset = (index - (count - 1) / 2) * MONUMENTS.spacing;
  const x = MONUMENTS.base[0] + offset;

  return attachMilestones({
    id: goal?.id || `goal-${index}`,
    title: typeof goal?.title === 'string' && goal.title ? goal.title : 'Untitled Goal',
    status,
    progress: Number.isFinite(goal?.progress) ? clamp01(goal.progress / 100) * 100 : 0,
    completeness, // 0..1 — fraction of the monument that is "built"
    color: style.color,
    opacity: style.opacity,
    intensity: style.intensity,
    dim: style.dim,
    built: style.built,
    height,
    width: MONUMENTS.baseWidth,
    position: Array.isArray(position) ? position : [x, 0, MONUMENTS.z],
  }, goal, height);
}

// Full derived view-model for the component. `goals` is the raw goals list (the API
// returns `{ goals: [...] }`; callers should pass `data?.goals`). A missing / non-array
// input yields an empty district rather than a crash. Goals beyond MONUMENTS.maxMonuments
// fold into an `overflow` marker placed just past the end of the row.
export function computeGoalMonuments(goals, now = Date.now()) {
  const list = Array.isArray(goals) ? goals.filter((g) => g && typeof g === 'object') : [];

  // Stable ordering so the row doesn't reshuffle across refetches (see STATUS_RANK).
  const ranked = list
    .map((goal) => ({ goal, id: goal?.id, status: effectiveGoalStatus(goal, now) }))
    .sort(compareByStatusThenId);

  const visible = ranked.slice(0, MONUMENTS.maxMonuments);
  const overflowCount = Math.max(0, ranked.length - visible.length);

  const monuments = visible.map(({ goal }, index) =>
    placeMonument(goal, index, visible.length, now)
  );

  // Overflow marker sits one slot past the right end of the row.
  let overflow = null;
  if (overflowCount > 0) {
    const offset = (visible.length - (visible.length - 1) / 2) * MONUMENTS.spacing;
    overflow = {
      count: overflowCount,
      position: [MONUMENTS.base[0] + offset, 0, MONUMENTS.z],
    };
  }

  const completedCount = ranked.filter((r) => r.status === 'completed').length;
  const activeCount = ranked.filter((r) => r.status === 'active').length;

  return {
    base: MONUMENTS.base,
    monuments,
    overflow,
    total: ranked.length,
    completedCount,
    activeCount,
    hasData: ranked.length > 0,
  };
}

// Goal-tree (hierarchy) layout. Goals carry `parentId`; the server's getGoalsTree()
// builds the same parent→child forest. Here we lay each ROOT goal out as a central spire
// (taller than a flat-row monument) with its direct children clustered in a ring around
// it and a link drawn from each child up to the parent apex — so a glance reads which
// goals roll up under which. Multiple roots are spread along the row depth so their
// clusters don't overlap. Pure + deterministic (no three.js): the component consumes the
// returned positions/links directly.
export const FOREST = {
  base: MONUMENTS.base, // shared center with the flat row
  clusterSpacing: 26, // x-distance between adjacent root clusters
  childRadius: 7.5, // ring radius of children around their root spire
  spireBoost: 1.5, // root spires render this much taller than a flat monument
  maxRoots: 4, // cap root clusters so the district stays legible
  maxChildren: 6, // cap children per root (ring slots); extras fold into the root's count
};

// Build the { id -> goal, children: [...] } forest from a flat goals list using parentId.
// Mirrors getGoalsTree()'s tree builder: a goal whose parentId points at a present goal
// becomes that goal's child; everything else (null/dangling parentId) is a root. Cycles
// are impossible because the server validates parentId against ancestor cycles on write,
// but we still guard by only attaching when the parent exists and isn't the node itself.
export function buildGoalForest(goals) {
  const list = Array.isArray(goals) ? goals.filter((g) => g && typeof g === 'object' && g.id) : [];
  const byId = new Map(list.map((g) => [g.id, { goal: g, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    const pid = node.goal.parentId;
    if (pid && pid !== node.goal.id && byId.has(pid)) {
      byId.get(pid).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return { roots, byId };
}

// Total number of goals nested under a forest node (its children, grandchildren, …),
// excluding the node itself. The forest layout renders only two visible levels (root spire
// + child ring), so a node's deeper descendants are summarized by this count rather than
// drawn — nothing is silently dropped. Guarded against the (server-prevented) cycle case
// via a visited set so a hand-corrupted parentId loop can't recurse forever.
export function countDescendants(node, seen = new Set()) {
  if (!node || seen.has(node)) return 0;
  seen.add(node);
  let total = 0;
  for (const child of node.children || []) {
    total += 1 + countDescendants(child, seen);
  }
  return total;
}

// Full hierarchy view-model. Returns root spires (each a placed monument with extra
// height) plus their child monuments arranged in a ring, and `links` joining each child
// apex-ward to its root. Roots are ordered completed→active→stalled→abandoned (same as the
// flat row) so finished towers lead; ties broken by id for stable layout across refetches.
export function computeGoalForest(goals, now = Date.now()) {
  const { roots } = buildGoalForest(goals);

  // Same completed→active→stalled→abandoned ordering as the flat row (see STATUS_RANK).
  const rankedRoots = roots
    .map((node) => ({ node, id: node.goal?.id, status: effectiveGoalStatus(node.goal, now) }))
    .sort(compareByStatusThenId);

  const visibleRoots = rankedRoots.slice(0, FOREST.maxRoots);
  // Root overflow counts the folded-away root trees AND everything nested under them, so a
  // child-bearing root past the cap isn't silently undercounted (it's `roots + descendants`).
  const rootOverflow = rankedRoots
    .slice(FOREST.maxRoots)
    .reduce((sum, { node }) => sum + 1 + countDescendants(node), 0);

  const clusters = visibleRoots.map(({ node }, rootIndex) => {
    // Spread root clusters along x, centered on FOREST.base.
    const clusterX = FOREST.base[0] + (rootIndex - (visibleRoots.length - 1) / 2) * FOREST.clusterSpacing;
    const clusterZ = FOREST.base[2];

    // Root spire — a placed monument boosted in height so it visually anchors the cluster.
    // The spireBoost is applied inside placeMonument so milestone floors fill the taller
    // tower in one pass (no discarded re-segment).
    const spire = placeMonument(node.goal, 0, 1, now, [clusterX, 0, clusterZ], FOREST.spireBoost);
    spire.isSpire = true;

    const childNodes = node.children.slice(0, FOREST.maxChildren);
    // Child overflow counts the folded-away children plus their own sub-trees, mirroring
    // the descendantCount surfaced on displayed children — nothing nested vanishes silently.
    const childOverflow = node.children
      .slice(FOREST.maxChildren)
      .reduce((sum, child) => sum + 1 + countDescendants(child), 0);

    // Children ring around the spire. A single child sits directly in front; multiple
    // children spread evenly across a forward-facing arc so links don't cross the spire.
    const children = childNodes.map((child, ci) => {
      const n = childNodes.length;
      const angle = n === 1 ? Math.PI / 2 : (Math.PI / (n + 1)) * (ci + 1); // 0..PI forward arc
      const cx = clusterX + Math.cos(angle) * FOREST.childRadius;
      const cz = clusterZ + Math.sin(angle) * FOREST.childRadius; // +z = toward the camera/front
      const m = placeMonument(child.goal, 0, 1, now, [cx, 0, cz]);
      m.parentId = node.goal.id;
      // Deeper descendants aren't drawn (the layout is two levels); surface their count so
      // a grandchild-bearing sub-goal advertises its sub-tree instead of hiding it.
      m.descendantCount = countDescendants(child);
      return m;
    });

    // Links: from each child's apex up to the root spire's apex. Towers rise from a 0.4
    // plinth, so the nominal top sits at 0.4 + height — links join near the tips (segmented
    // towers leave a sub-floor gap below this from the inter-floor spacing, visually fine).
    const links = children.map((child) => ({
      from: [child.position[0], 0.4 + child.height, child.position[2]],
      to: [spire.position[0], 0.4 + spire.height, spire.position[2]],
      childId: child.id,
    }));

    return { spire, children, links, childOverflow };
  });

  return {
    base: FOREST.base,
    clusters,
    rootOverflow,
    rootCount: rankedRoots.length,
    hasData: rankedRoots.length > 0,
    // A forest is only worth showing when at least one root actually has children;
    // otherwise it's just the flat row with extra spacing. The component uses this to
    // decide whether to render the hierarchy view vs. fall back to the flat row.
    // Derived from ALL ranked roots (pre-cap) so a child-bearing root that overflows past
    // FOREST.maxRoots still flips the district into the forest layout instead of the flat
    // row — otherwise its sub-tree would be invisible AND uncounted.
    hasHierarchy: rankedRoots.some(({ node }) => node.children.length > 0),
  };
}

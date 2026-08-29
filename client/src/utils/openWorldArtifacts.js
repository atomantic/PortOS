// Pure, deterministic helpers for OpenWorld's "earned artifacts" (roadmap 3.5): a small
// "Hall of Achievements" cluster of trophies/statues that only appear once a milestone is
// earned. Artifacts are DERIVED from data the city already has — no new endpoint:
//   • level milestones  — D&D-style character level crossing a threshold (level-up statues)
//   • completed-goal milestones — every Nth completed life goal (achievement trophies)
// Nothing earned → empty cluster (no crash). No three.js / React imports so the topology is
// unit-testable (mirrors openWorldGoalMonuments.js / openWorldProductivity.js).

import { levelFromXP } from './characterXp';
import { gridIndexToPosition } from './openWorldDistrictLayout';
import { PARCELS } from './openWorldPlan';

// Hall of Achievements — a clear cluster in the +X / -Z quadrant, between the task-queue,
// health tower, goal-monument row, and voice beacon. Artifacts lay out in a tight grid
// centered on this base, anchored by the master plan (openWorldPlan.js).
export const ARTIFACTS = {
  base: PARCELS.artifacts.anchor, // center of the cluster
  spacing: 6, // distance between adjacent pedestals (both x and z)
  columns: 3, // grid width before wrapping to the next row (toward -Z)
  pedestalWidth: 2,
  pedestalHeight: 1.2,
  emblemSize: 1.4, // size of the glowing emblem atop a pedestal
};

// Tiers drive the emblem color + glow so a richer milestone reads brighter. Colors reuse the
// PortOS Tailwind design tokens.
const TIERS = {
  bronze: { color: '#f59e0b', intensity: 0.45 }, // port-warning
  silver: { color: '#94a3b8', intensity: 0.6 }, // slate-light
  gold: { color: '#22c55e', intensity: 0.85 }, // port-success
};

// Level-up milestones: a statue per crossed level threshold. Below level 2 nothing is earned
// (level 1 is the starting state). Higher levels read as richer tiers.
export const LEVEL_MILESTONES = [
  { level: 2, tier: 'bronze', label: 'NOVICE' },
  { level: 5, tier: 'silver', label: 'ADEPT' },
  { level: 10, tier: 'gold', label: 'MASTER' },
];

// Completed-goal milestones: a trophy for every Nth completed life goal.
export const GOAL_MILESTONES = [
  { count: 1, tier: 'bronze', label: 'FIRST GOAL' },
  { count: 5, tier: 'silver', label: '5 GOALS' },
  { count: 10, tier: 'gold', label: '10 GOALS' },
];

// Coerce a value to a finite number or return null (the "absent" sentinel) so an absent field
// never collapses into a real 0.
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Effective character level. The level is age-based now (#2673): a finite `level` is the
// age-derived value; an explicit `null` means the birthDate is unset, so age — the ONLY level
// source — is unknown and we return null WITHOUT resurrecting an XP-derived level (otherwise
// XP would silently unlock level trophies/eggs while the HUD shows "LV —"). Only an ABSENT
// `level` field (a legacy payload that predates age-based level) falls back to XP.
export function effectiveLevel(character) {
  const lvl = character?.level;
  // Any finite nonnegative level is authoritative — including 0, a legitimate age level for a
  // birthDate less than a year ago. (`>= 1` would reject it and let XP unlock level artifacts.)
  if (Number.isFinite(lvl) && lvl >= 0) return Math.floor(lvl);
  if (lvl === null) return null;
  const xp = finiteOrNull(character?.xp);
  if (xp === null) return null;
  return levelFromXP(xp);
}

// Count completed goals from the goals payload. Accepts either the API wrapper `{ goals: [] }`
// or a bare array; a missing/garbage input counts as 0.
export function completedGoalCount(goals) {
  const list = Array.isArray(goals) ? goals : Array.isArray(goals?.goals) ? goals.goals : [];
  return list.filter((g) => g && typeof g === 'object' && g.status === 'completed').length;
}

// Build the list of EARNED artifact descriptors (kind/label/tier/threshold) from the three
// inputs, before placement. Deterministic and side-effect-free.
export function earnedArtifacts({ character, goals } = {}) {
  const earned = [];

  const level = effectiveLevel(character);
  if (level !== null) {
    for (const m of LEVEL_MILESTONES) {
      if (level >= m.level) {
        earned.push({ id: `level-${m.level}`, kind: 'level', tier: m.tier, label: m.label, threshold: m.level });
      }
    }
  }

  const completed = completedGoalCount(goals);
  for (const m of GOAL_MILESTONES) {
    if (completed >= m.count) {
      earned.push({ id: `goals-${m.count}`, kind: 'goal', tier: m.tier, label: m.label, threshold: m.count });
    }
  }

  return earned;
}

// Place a descriptor into the cluster grid. `index` is the 0-based slot; the grid fills left→
// right across ARTIFACTS.columns, then wraps to the next row toward -Z. Centered on base.x.
export function placeArtifact(descriptor, index) {
  const tier = TIERS[descriptor.tier] || TIERS.bronze;
  return {
    ...descriptor,
    color: tier.color,
    intensity: tier.intensity,
    position: gridIndexToPosition(index, {
      base: ARTIFACTS.base,
      columns: ARTIFACTS.columns,
      spacing: ARTIFACTS.spacing,
      rowDir: -1, // rows wrap toward -Z
    }),
  };
}

// Full derived view-model for the component. Injects all inputs; an all-absent / nothing-earned
// state yields an empty cluster (`hasData: false`) rather than a crash. Ordering is stable
// (level → goal, each ascending threshold) so the cluster doesn't reshuffle across
// refetches.
export function computeArtifacts({ character, goals } = {}) {
  const descriptors = earnedArtifacts({ character, goals });
  const artifacts = descriptors.map((d, i) => placeArtifact(d, i));

  return {
    base: ARTIFACTS.base,
    artifacts,
    total: artifacts.length,
    hasData: artifacts.length > 0,
  };
}

// Pure, deterministic helpers for CyberCity's "easter eggs" (roadmap 3.5 follow-up, #824):
// hidden/rare artifacts that only appear when a special, non-obvious condition is met. Unlike
// the earned-artifact trophies (cityArtifacts.js), which mark expected milestones, easter eggs
// are surprises — a developer's date (Apr 1), a numerically-special level (the "leet" 13/42),
// a palindrome streak, or an exact all-goals-complete state. Each is DERIVED from data the city
// already has plus a caller-supplied date — nothing here calls `new Date()` so every condition
// is unit-testable on a fixed day. No three.js / React imports (mirrors cityArtifacts.js).
//
// Easter eggs render as small, glowing, rare emblems tucked at the city's edge — found, not
// announced. A given egg appears at most once (deduped by id) and the set is stable-ordered so
// the placement doesn't reshuffle across refetches.

import { hashString } from './hashString';
import { effectiveLevel, completedGoalCount, bestStreakDays } from './cityArtifacts';

// Placement: a tight cluster at the far -X / +Z corner, deliberately off in a quiet quadrant
// away from the achievement hall (+X/-Z) so an egg reads as "hidden" rather than featured.
export const EGGS = {
  base: [-46, 0, 40],
  spacing: 5,
  columns: 2,
  size: 1.1,
};

// A number reads the same forwards and backwards (and is >= 10 so single digits don't trivially
// qualify). Used by the palindrome-streak egg.
function isPalindrome(n) {
  if (!Number.isInteger(n) || n < 10) return false;
  const s = String(n);
  return s === [...s].reverse().join('');
}

// Each egg is { id, label, hint, color, test }. `test` is a pure predicate over the derived
// context { date, level, completedGoals, totalGoals, bestStreak }. Ordered most-special first
// for stable placement. Colors lean into rare/arcade neon (the city's accent palette).
export const EASTER_EGGS = [
  {
    id: 'april-fools',
    label: '?!',
    hint: "APRIL FOOLS",
    color: '#ec4899',
    test: ({ date }) =>
      !!date && typeof date.getMonth === 'function' && date.getMonth() + 1 === 4 && date.getDate() === 1,
  },
  {
    id: 'leet',
    label: '1337',
    hint: 'LEET',
    color: '#22c55e',
    // The classic "elite" level. Exact match, not a threshold — it's a wink, not a milestone.
    test: ({ level }) => level === 13,
  },
  {
    id: 'answer',
    label: '42',
    hint: 'THE ANSWER',
    color: '#3b82f6',
    test: ({ level }) => level === 42,
  },
  {
    id: 'palindrome-streak',
    label: '⇄',
    hint: 'PALINDROME STREAK',
    color: '#a855f7',
    test: ({ bestStreak }) => bestStreak !== null && isPalindrome(bestStreak),
  },
  {
    id: 'clean-sweep',
    label: '★',
    hint: 'CLEAN SWEEP',
    color: '#fcd34d',
    // Every tracked goal completed (and there is at least one) — a rare, perfect board.
    test: ({ completedGoals, totalGoals }) => totalGoals > 0 && completedGoals === totalGoals,
  },
];

// Count the "real" goal entries (objects) from a list or the API `{ goals: [] }` wrapper, so the
// clean-sweep egg can compare completed vs total. Mirrors completedGoalCount's input tolerance.
function totalGoalCount(goals) {
  const list = Array.isArray(goals) ? goals : Array.isArray(goals?.goals) ? goals.goals : [];
  return list.filter((g) => g && typeof g === 'object').length;
}

// Normalize the raw inputs into the flat predicate context, reusing the cityArtifacts derivations
// so the egg conditions stay consistent with the earned-artifact trophies. `level` and `bestStreak`
// are nullable (absent → null, never 0) so an "exact value" egg can't false-fire on missing data.
export function eggContext({ date, character, goals, productivityData } = {}) {
  return {
    date: date || null,
    level: effectiveLevel(character), // floored level or null (xp-derived if needed)
    completedGoals: completedGoalCount(goals),
    totalGoals: totalGoalCount(goals),
    bestStreak: bestStreakDays(productivityData), // longest, else current, else null
  };
}

// Build the list of UNLOCKED egg descriptors. Deterministic, side-effect-free, stable order.
export function unlockedEggs(inputs = {}) {
  const ctx = eggContext(inputs);
  return EASTER_EGGS.filter((egg) => egg.test(ctx)).map((egg) => ({
    id: egg.id,
    label: egg.label,
    hint: egg.hint,
    color: egg.color,
  }));
}

// Place an egg descriptor into the corner cluster grid (left→right, wrapping toward +Z), seeded
// per-id so the per-egg float phase differs. Mirrors cityArtifacts.placeArtifact.
export function placeEgg(descriptor, index) {
  const col = index % EGGS.columns;
  const row = Math.floor(index / EGGS.columns);
  const xOffset = (col - (EGGS.columns - 1) / 2) * EGGS.spacing;
  const x = EGGS.base[0] + xOffset;
  const z = EGGS.base[2] + row * EGGS.spacing;
  const seed = hashString(descriptor.id);

  return {
    ...descriptor,
    position: [x, EGGS.size + 0.6, z],
    phase: (seed % 100) / 100,
  };
}

// Full derived view-model for the easter-egg component. Inject the date so calendar eggs are
// deterministic in tests. Nothing unlocked → empty cluster (`hasData: false`), never a crash.
export function computeEasterEggs(inputs = {}) {
  const descriptors = unlockedEggs(inputs);
  const eggs = descriptors.map((d, i) => placeEgg(d, i));

  return {
    base: EGGS.base,
    eggs,
    total: eggs.length,
    hasData: eggs.length > 0,
  };
}

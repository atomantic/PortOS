// Pure, deterministic helpers for CyberCity's character XP HUD badge (roadmap 2.11):
// given the D&D-style character sheet from GET /api/character, compute a view-model
// for the floating level/XP badge (current level, progress toward the next level) and
// detect XP gains / level-ups by diffing two successive character snapshots. No React
// imports so the math is unit-testable (mirrors cityTaskQueue.js).

// MIRRORS the server constant `XP_THRESHOLDS` in server/services/character.js — index i
// is the cumulative XP required to reach level i+1. Keep these two arrays in sync: if the
// server's level curve changes, update this copy (and the test) in the same change.
export const XP_THRESHOLDS = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000,
  85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000,
];

export const MAX_LEVEL = XP_THRESHOLDS.length;

// Level for a given total XP, mirroring server `getLevelFromXP`. Clamps negative/NaN xp
// to level 1 so a missing/garbage value can't produce a negative or NaN level.
export function levelFromXP(xp) {
  const safeXp = Number.isFinite(xp) ? xp : 0;
  for (let i = XP_THRESHOLDS.length - 1; i >= 0; i--) {
    if (safeXp >= XP_THRESHOLDS[i]) return i + 1;
  }
  return 1;
}

// Derived view-model for the XP badge. Tolerates a missing/null character (returns a sane
// level-1 zero view). `progress` is 0..1 within the current level; at max level it pins to
// 1 with `atMax: true` and never produces NaN (no "next threshold" to divide by).
export function computeXpView(character) {
  const rawXp = character?.xp;
  const xp = Number.isFinite(rawXp) ? Math.max(0, rawXp) : 0;
  // Trust the server's stored level when present and consistent; otherwise derive it so a
  // legacy/absent level field still yields a correct badge.
  const level = Number.isFinite(character?.level) && character.level >= 1
    ? Math.min(MAX_LEVEL, Math.floor(character.level))
    : levelFromXP(xp);

  const atMax = level >= MAX_LEVEL;
  const levelFloor = XP_THRESHOLDS[level - 1] ?? 0;
  const nextThreshold = atMax ? null : XP_THRESHOLDS[level];

  const xpIntoLevel = Math.max(0, xp - levelFloor);
  const xpForNextLevel = atMax ? 0 : nextThreshold - levelFloor;
  const progress = atMax
    ? 1
    : (xpForNextLevel > 0 ? Math.min(1, Math.max(0, xpIntoLevel / xpForNextLevel)) : 0);

  return {
    xp,
    level,
    xpIntoLevel,
    xpForNextLevel,
    xpToNext: atMax ? 0 : Math.max(0, nextThreshold - xp),
    progress,
    atMax,
    hp: Number.isFinite(character?.hp) ? character.hp : null,
    maxHp: Number.isFinite(character?.maxHp) ? character.maxHp : null,
  };
}

// Compare two character snapshots to detect a fresh XP gain / level-up so the badge can
// fire a transient burst. Tolerates null on either side (first poll has no prev). `gained`
// is clamped to >= 0 so a manual XP reset (xp dropping) never reports a negative burst.
export function diffXp(prev, next) {
  const prevXp = Number.isFinite(prev?.xp) ? prev.xp : null;
  const nextXp = Number.isFinite(next?.xp) ? next.xp : null;
  const prevLevel = Number.isFinite(prev?.level) ? prev.level : null;
  const nextLevel = Number.isFinite(next?.level) ? next.level : null;

  // No comparable prior snapshot → treat as no change (first load shouldn't burst).
  if (prevXp == null || nextXp == null) {
    return { gained: 0, leveledUp: false };
  }

  const gained = Math.max(0, nextXp - prevXp);
  const leveledUp = prevLevel != null && nextLevel != null
    ? nextLevel > prevLevel
    : levelFromXP(nextXp) > levelFromXP(prevXp);

  return { gained, leveledUp: gained > 0 && leveledUp };
}

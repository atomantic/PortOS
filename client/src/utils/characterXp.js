// Pure, deterministic helpers for CyberCity's character HUD badge (roadmap 2.11): given the
// character sheet from GET /api/character, compute the badge view-model and detect XP gains
// by diffing two successive snapshots. No React imports so the math is unit-testable.
//
// As of #2673 the badge shows an **age-based level** (`computeAgeView`) — level = years lived
// — with a progress bar toward the next birthday. The legacy XP-threshold helpers below
// (`levelFromXP`, `computeXpView`, `XP_THRESHOLDS`) are retained for `cityArtifacts` and the
// D&D-style `/character` page; the badge no longer uses them.

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

// Age-based level view-model for the CyberCity badge (#2673, epic #2672). The Character's
// level is now life experience = age: `level = floor(ageYears)`, derived server-side from
// the canonical birthDate. The badge shows that age level and a progress bar = fractional
// part of the current year of life (progress toward the next birthday). Tolerates a missing
// character / unset birthDate (server sends `level: null`, `ageYears: null`) by returning a
// zeroed view with `hasBirthDate: false` and never NaNs.
export function computeAgeView(character) {
  const ageYears = Number.isFinite(character?.ageYears) ? character.ageYears : null;
  // Prefer the server-derived level; fall back to flooring ageYears if only that came through.
  const level = Number.isFinite(character?.level)
    ? Math.floor(character.level)
    : (ageYears != null ? Math.floor(ageYears) : null);
  const hasBirthDate = level != null;

  // Fraction through the current year of life = progress toward the next birthday.
  const progress = (hasBirthDate && ageYears != null)
    ? Math.min(1, Math.max(0, ageYears - Math.floor(ageYears)))
    : 0;

  const xp = Number.isFinite(character?.xp) ? Math.max(0, character.xp) : 0;

  return {
    level,
    ageYears,
    hasBirthDate,
    progress,
    // Rough countdown to next birthday for the badge caption; null when age is unknown.
    daysToNextBirthday: hasBirthDate ? Math.max(0, Math.ceil((1 - progress) * 365.25)) : null,
    xp,
    hp: Number.isFinite(character?.hp) ? character.hp : null,
    maxHp: Number.isFinite(character?.maxHp) ? character.maxHp : null,
  };
}

// Compare two character snapshots to detect a fresh XP gain (cyan burst) and a level tick
// (amber "level-up" burst). Since #2673 the level is age-based, so a level tick is a
// *birthday* — detected purely from the `level` field, never from XP thresholds. Tolerates
// null on either side (first poll has no prev). `gained` is clamped to >= 0 so a manual XP
// reset (xp dropping) never reports a negative burst.
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
  // Level is decoupled from XP now: a level-up burst fires only on a real age-level increase
  // (a birthday), never when an XP gain crosses a legacy threshold. When level is unknown
  // (no birthDate on either snapshot) there is no level-up to celebrate. This is independent
  // of `gained` — a birthday almost never coincides with an XP gain, so gating it on XP would
  // mean the celebration never fires. The badge decides to burst on `gained > 0 || leveledUp`.
  const leveledUp = prevLevel != null && nextLevel != null && nextLevel > prevLevel;

  return { gained, leveledUp };
}

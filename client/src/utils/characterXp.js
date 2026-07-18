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
  // Server-derived classification of WHY there's no level (#2757). Absent on an older server
  // bundle → treat as 'unset' (the historical behavior). Carried through so the badge can show
  // a "fix" prompt for a present-but-unusable date instead of a "set" prompt.
  const birthDateStatus = character?.birthDateStatus ?? (hasBirthDate ? 'ok' : 'unset');

  // Fraction through the current year of life = progress toward the next birthday.
  const progress = (hasBirthDate && ageYears != null)
    ? Math.min(1, Math.max(0, ageYears - Math.floor(ageYears)))
    : 0;

  const xp = Number.isFinite(character?.xp) ? Math.max(0, character.xp) : 0;

  return {
    level,
    ageYears,
    hasBirthDate,
    birthDateStatus,
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

// Map a server-derived `birthDateStatus` (#2757) to the call-to-action the level surfaces render
// when there is no usable level. The CTA distinguishes a genuinely UNSET birth date ("set")
// from one that is present-but-unusable — invalid, in the future, or an unreadable config ("fix")
// — so a user is never told to *set* a date they already entered. Every case deep-links to the
// age editor (`/meatspace/age`) where the field lives. Returns `null` for 'ok' (a real level
// exists; no CTA). Tolerates an absent/unknown status by treating it as 'unset'.
export function birthDateCta(status) {
  const fix = (caption) => ({
    kind: 'fix',
    path: '/meatspace/age',
    title: 'Fix your birth date',
    heading: 'Fix your birth date',
    caption,
    badgeLabel: 'LV !',
    badgeCaption: 'FIX BIRTH DATE',
  });
  switch (status) {
    case 'ok':
      return null;
    case 'unreadable':
      return fix("Your birth date couldn't be read. Re-enter it to restore your level.");
    case 'future':
      return fix('Your birth date is in the future. Update it to see your level.');
    case 'invalid':
      return fix('Your birth date looks invalid. Update it to see your level.');
    case 'unset':
    default:
      return {
        kind: 'set',
        path: '/meatspace/age',
        title: 'Set your birth date',
        heading: 'Set your birth date',
        caption: 'Your level is your life experience — each year lived is a level. Add your birth date to see it.',
        badgeLabel: 'LV —',
        badgeCaption: 'SET BIRTH DATE',
      };
  }
}

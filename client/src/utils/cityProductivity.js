// Pure, deterministic helpers for CyberCity's productivity district (roadmap 2.6): a
// streak monument (a glowing obelisk) in a southwest district whose height and glow scale
// with the user's current CoS completion streak, tiered by recent velocity. The monument
// distinguishes "no productivity data yet" (absent → dim, reads "NO DATA") from a real
// zero-day streak (present but unlit beyond the base). No three.js / React imports so the
// topology is unit-testable (mirrors cityBackupVault.js / cityHealthTower.js).

export const MONUMENT = {
  position: [-48, 0, 28], // southwest district — clear of the vault (-34), grid, archive, and the SE wellness tower
  baseWidth: 5, // footprint of the obelisk base
  minHeight: 3, // floor height so a 0-streak monument still reads as a stub, not nothing
  maxHeight: 26, // height at/above STREAK_CAP days
  streakCap: 30, // streak length mapped to full height; longer streaks stay capped (don't overrun the skybox)
};

// Velocity tiers drive the monument color so the district speaks recent throughput at a
// glance. `velocity.percentage` from the quick-summary payload is "today vs. historical
// average", where 100 ≈ on pace. Colors reuse the PortOS Tailwind design tokens.
const TIERS = [
  { min: 120, key: 'surging', color: '#22c55e', label: 'SURGING' }, // port-success — well above pace
  { min: 80, key: 'steady', color: '#3b82f6', label: 'STEADY' }, // port-accent — roughly on pace
  { min: 40, key: 'slowing', color: '#f59e0b', label: 'SLOWING' }, // port-warning — below pace
  { min: 0, key: 'idle', color: '#ef4444', label: 'IDLE' }, // port-error — little/no recent throughput
];

const ABSENT_COLOR = '#64748b'; // slate — no productivity data at all

const clamp01 = (n) => Math.max(0, Math.min(1, n));

// Coerce a value to a finite number or return null (the "absent" sentinel) so callers can
// distinguish a missing/garbage field from a legitimate 0.
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Map a streak length (in days) to a 0..1 fill against the cap, clamped. Returns null for a
// non-numeric input so an absent streak never collapses into a real 0-day streak.
export function streakLevel(streak, cap = MONUMENT.streakCap) {
  const s = finiteOrNull(streak);
  if (s === null) return null;
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) return null;
  return clamp01(s / cap);
}

// Classify recent velocity into a color tier. A non-numeric velocity (absent) falls through
// to the lowest tier's color via the caller; here we only resolve a present number.
export function velocityTier(velocity) {
  const v = finiteOrNull(velocity);
  if (v === null) return null;
  return TIERS.find((t) => v >= t.min) || TIERS[TIERS.length - 1];
}

// Full derived view-model for the component. `productivityData` is the quick-summary payload
// (`{ streak: { current, longest, weekly, lastActive }, today: { completed, ... },
// velocity: { percentage, ... } }`). A missing/non-object payload, or one with no streak
// field, yields an absent monument (dim, floor height) rather than a crash.
export function computeProductivityMonument(productivityData) {
  const payload = productivityData && typeof productivityData === 'object' ? productivityData : {};
  const streakSrc = payload.streak && typeof payload.streak === 'object' ? payload.streak : {};
  const todaySrc = payload.today && typeof payload.today === 'object' ? payload.today : {};
  const velocitySrc = payload.velocity && typeof payload.velocity === 'object' ? payload.velocity : {};

  const current = finiteOrNull(streakSrc.current);
  const longest = finiteOrNull(streakSrc.longest);
  const completedToday = finiteOrNull(todaySrc.completed);
  const level = streakLevel(current) ?? 0; // 0 for both absent and a real 0-streak; `present` disambiguates
  const present = current !== null;

  const tier = velocityTier(velocitySrc.percentage);
  // Absent productivity data reads slate/dim; a present payload always gets a tier color
  // (idle red when velocity is missing-but-data-exists, so the monument never goes dark on
  // a real-but-quiet day).
  const color = present ? (tier?.color ?? TIERS[TIERS.length - 1].color) : ABSENT_COLOR;
  const tierLabel = present ? (tier?.label ?? TIERS[TIERS.length - 1].label) : 'NO DATA';

  const height = MONUMENT.minHeight + level * (MONUMENT.maxHeight - MONUMENT.minHeight);
  // Emissive intensity: brighter as the streak grows; a present-but-zero streak still glows
  // faintly so it's legible; an absent monument is nearly dark.
  const intensity = present ? 0.3 + level * 0.7 : 0.1;

  // Short streak label: "12 DAY STREAK" / "1 DAY STREAK" / "NO STREAK" (real 0) / "NO DATA".
  let streakLabel;
  if (!present) streakLabel = 'NO DATA';
  else if (current === 0) streakLabel = 'NO STREAK';
  else streakLabel = `${current} DAY${current === 1 ? '' : 'S'} STREAK`;

  return {
    position: MONUMENT.position,
    baseWidth: MONUMENT.baseWidth,
    height,
    level,
    present,
    current: present ? current : null,
    longest,
    completedToday,
    color,
    intensity,
    tierKey: present ? (tier?.key ?? TIERS[TIERS.length - 1].key) : 'absent',
    tierLabel,
    streakLabel,
    // The monument pulses brighter the higher the streak; surging velocity adds urgency.
    surging: tier?.key === 'surging',
  };
}

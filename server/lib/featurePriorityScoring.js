// Pure scoring that turns an area's active days into a P0-P3 priority tier, plus the pin, feature-off and default fallbacks.
//
// No I/O: callers pass the distinct active days (UTC `YYYY-MM-DD` strings) per feature area and the current time.
// Tiers describe one install's own usage. Precedence in resolveTier: a pin, then the feature-off rule, then the
// learned tier, then P1. The learned tier needs MIN_EVIDENCE_DAYS distinct active days install-wide, so a fresh,
// headless or rarely opened install stays at P1 instead of marking every area dormant.
import { QUALITY_RECENCY_HALF_LIFE_DAYS } from './auditDomains.js';

// Highest priority first; the index is the rank.
export const FEATURE_PRIORITY_TIERS = Object.freeze(['P0', 'P1', 'P2', 'P3']);
export const DEFAULT_FEATURE_PRIORITY_TIER = 'P1';

export const ACTIVITY_WINDOW_DAYS = 90;
export const DORMANT_AFTER_DAYS = 30;
export const MIN_EVIDENCE_DAYS = 14;
export const P0_SCORE_THRESHOLD = 6;
export const P1_SCORE_THRESHOLD = 1.5;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const startOfUtcDay = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;

// Whole UTC days between `day` and today (0 = today); null for a malformed day, a future day or one outside the window.
function ageInDays(day, now) {
  if (typeof day !== 'string' || !DAY_PATTERN.test(day)) return null;
  const dayMs = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(dayMs)) return null;
  const age = Math.round((startOfUtcDay(new Date(now).getTime()) - dayMs) / DAY_MS);
  return age >= 0 && age < ACTIVITY_WINDOW_DAYS ? age : null;
}

const windowAges = (days, now) => [...new Set(days ?? [])]
  .map((day) => ageInDays(day, now))
  .filter((age) => age !== null);

/** Sum of `0.5 ** (ageDays / half-life)` over the distinct active days in the last 90 days. */
export const scoreActiveDays = (days, now) => windowAges(days, now)
  .reduce((sum, age) => sum + 0.5 ** (age / QUALITY_RECENCY_HALF_LIFE_DAYS), 0);

/** Whole days since the most recent active day in the window, or null when there is none. */
export function lastActiveAgeDays(days, now) {
  const ages = windowAges(days, now);
  return ages.length ? Math.min(...ages) : null;
}

const isDormant = (ageDays) => ageDays == null || ageDays >= DORMANT_AFTER_DAYS;

/**
 * Tier learned from usage, or null when the install has fewer than MIN_EVIDENCE_DAYS distinct active days.
 * A dormant optional area is P3 whatever its older score; a core area never learns below P2.
 */
export function learnedTier({ score, lastActiveAgeDays: lastActive, optional, evidenceDays }) {
  if (!(evidenceDays >= MIN_EVIDENCE_DAYS)) return null;
  if (optional && isDormant(lastActive)) return 'P3';
  if (score >= P0_SCORE_THRESHOLD) return 'P0';
  if (score >= P1_SCORE_THRESHOLD) return 'P1';
  return 'P2';
}

/** `featureEnabled === false` marks an optional area whose instance feature is off; core areas leave it undefined. */
export function resolveTier({ pinned, featureEnabled, lastActiveAgeDays: lastActive, learned }) {
  if (FEATURE_PRIORITY_TIERS.includes(pinned)) return { tier: pinned, source: 'pinned' };
  if (featureEnabled === false && isDormant(lastActive)) return { tier: 'P3', source: 'feature-off' };
  if (FEATURE_PRIORITY_TIERS.includes(learned)) return { tier: learned, source: 'learned' };
  return { tier: DEFAULT_FEATURE_PRIORITY_TIER, source: 'default' };
}

/** The highest-priority tier among the given area ids; P1 when there are none. `areaTiers` is a Map or plain object of area id to tier. */
export function highestTier(areaIds, areaTiers) {
  const tierOf = (id) => (areaTiers instanceof Map ? areaTiers.get(id) : areaTiers?.[id]);
  const ranks = areaIds
    .map((id) => FEATURE_PRIORITY_TIERS.indexOf(tierOf(id) ?? DEFAULT_FEATURE_PRIORITY_TIER))
    .filter((rank) => rank >= 0);
  return FEATURE_PRIORITY_TIERS[ranks.length ? Math.min(...ranks) : FEATURE_PRIORITY_TIERS.indexOf(DEFAULT_FEATURE_PRIORITY_TIER)];
}

/**
 * Season/episode structure recommendation.
 *
 * Comic-as-TV norms: 6–10 issues per season/volume is the sweet spot. Single
 * volume up to 12 (the classic 12-issue maxi-series); 3-volume arc lands
 * roughly at 18–30 issues; 4+ volumes only past 30. The "3 × 8 = 24" point
 * is the canonical "3-season arc" target.
 *
 * Used both as renderer input to the arc-overview LLM prompt (so the LLM
 * stops slicing 12-issue runs into three 4-issue seasons) and as the
 * client-side hint shown next to the issue-count input.
 */

export const SEASON_MIN_EPISODES = 6;
export const SEASON_MAX_EPISODES = 11;

/**
 * Pick the natural season count for a given total. Boundaries are tuned so
 * 12 → 1 season, 18 → 3, 24 → 3, 30 → 3, 36 → 4.
 */
function pickSeasonCount(total) {
  if (total <= 12) return 1;
  if (total <= 17) return 2;
  if (total <= 32) return 3;
  if (total <= 44) return 4;
  return 5;
}

/**
 * Compute the recommended structure for a total issue/episode count.
 *
 *   recommendStructure(12) → { seasons: 1, perSeason: [12] }
 *   recommendStructure(24) → { seasons: 3, perSeason: [8, 8, 8] }
 *   recommendStructure(20) → { seasons: 3, perSeason: [7, 7, 6] }
 *
 * Returns `null` for zero/negative input so callers can short-circuit
 * (e.g. the UI hint hides itself when the user hasn't entered a target yet).
 */
export function recommendStructure(total) {
  const n = Math.floor(Number(total) || 0);
  if (n <= 0) return null;
  const seasons = pickSeasonCount(n);
  const base = Math.floor(n / seasons);
  const remainder = n % seasons;
  // Front-load extras into the earlier seasons so the array stays
  // monotonically non-increasing — a 22-issue run reads as [8,7,7] not [7,7,8].
  const perSeason = Array.from(
    { length: seasons },
    (_, i) => base + (i < remainder ? 1 : 0),
  );
  return { seasons, perSeason };
}

/**
 * Human-readable summary like "3 volumes × 8 episodes" or "2 volumes
 * × ~9 (9, 9)". Used in the LLM prompt and the client hint.
 */
export function describeStructure(structure) {
  if (!structure) return '';
  const { seasons, perSeason } = structure;
  const allSame = perSeason.every((n) => n === perSeason[0]);
  if (allSame) {
    return seasons === 1
      ? `1 volume × ${perSeason[0]} episodes`
      : `${seasons} volumes × ${perSeason[0]} episodes`;
  }
  return `${seasons} volumes × ~${Math.round(perSeason.reduce((a, b) => a + b, 0) / seasons)} (${perSeason.join(', ')})`;
}

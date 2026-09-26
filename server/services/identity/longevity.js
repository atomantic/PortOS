import { getGenomeSummary } from '../genome.js';
import {
  GOALS_FILE,
  LONGEVITY_FILE,
  DEFAULT_GOALS,
  DEFAULT_LONGEVITY,
  loadJSON,
  saveJSON
} from './store.js';
import {
  computeLifeExpectancy,
  computeTimeHorizons,
  extractLongevityMarkers,
  extractCardiovascularMarkers
} from './markers.js';

/**
 * Overlay freshly-computed `timeHorizons` onto a stored longevity snapshot.
 *
 * `deriveLongevity()` only runs on `setBirthDate` or an explicit derive, so the
 * persisted `timeHorizons.yearsRemaining` is frozen as of that run and drifts a
 * little further from the truth every day (#4122). Every read path funnels through
 * here so urgency, feasibility and the insight rules rank on today's number.
 *
 * When the horizons can't be recomputed — no birth date, or no derived life
 * expectancy to measure against — the stored snapshot is returned untouched.
 * Nulling it there would turn "we lost the inputs" into "you have no horizons",
 * which is a different and more misleading claim than a slightly stale number.
 */
export function applyFreshTimeHorizons(longevity, birthDate) {
  const timeHorizons = computeTimeHorizons(birthDate, longevity?.lifeExpectancy?.adjusted);
  if (!timeHorizons) return longevity;
  return { ...longevity, timeHorizons };
}

/**
 * Load the persisted longevity snapshot with `timeHorizons` re-derived against
 * today. Callers that already hold the goals record should call
 * `applyFreshTimeHorizons` directly rather than paying for the extra read here.
 */
export async function readLongevity() {
  const [longevity, goals] = await Promise.all([
    loadJSON(LONGEVITY_FILE, DEFAULT_LONGEVITY),
    loadJSON(GOALS_FILE, DEFAULT_GOALS)
  ]);
  return applyFreshTimeHorizons(longevity, goals?.birthDate);
}

export async function getLongevity() {
  const existing = await readLongevity();
  if (existing.derivedAt) return existing;
  return deriveLongevity();
}

export async function deriveLongevity(birthDate) {
  const genomeSummary = await getGenomeSummary();
  const savedMarkers = genomeSummary?.savedMarkers || {};

  const longevityMarkers = extractLongevityMarkers(savedMarkers);
  const cardiovascularMarkers = extractCardiovascularMarkers(savedMarkers);

  // Use provided birthDate or fall back to stored goals birthDate
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const effectiveBirthDate = birthDate || goals.birthDate || null;

  const { longevityScore, cardiovascularRisk, lifeExpectancy, timeHorizons, confidence } =
    computeLifeExpectancy(longevityMarkers, cardiovascularMarkers, effectiveBirthDate);

  const longevity = {
    longevityMarkers,
    cardiovascularMarkers,
    longevityScore,
    cardiovascularRisk,
    lifeExpectancy,
    timeHorizons,
    confidence,
    derivedAt: new Date().toISOString()
  };

  await saveJSON(LONGEVITY_FILE, longevity);
  const markerCount = Object.keys(longevityMarkers).length + Object.keys(cardiovascularMarkers).length;
  console.log(`🧬 Longevity derived: ${lifeExpectancy.adjusted}y (${markerCount} markers, confidence: ${confidence})`);

  return longevity;
}

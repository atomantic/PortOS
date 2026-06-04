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
  extractLongevityMarkers,
  extractCardiovascularMarkers
} from './markers.js';

export async function getLongevity() {
  const existing = await loadJSON(LONGEVITY_FILE, DEFAULT_LONGEVITY);
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

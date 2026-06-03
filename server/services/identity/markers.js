import { SSA_BASELINE_LIFE_EXPECTANCY } from './store.js';

// === Sleep / Chronotype Marker Definitions ===

export const SLEEP_MARKERS = {
  rs1801260: 'clockGene',
  rs57875989: 'dec2',
  rs35333999: 'per2',
  rs2287161: 'cry1',
  rs4753426: 'mtnr1b'
};

export const CAFFEINE_MARKERS = {
  rs762551: 'cyp1a2',
  rs73598374: 'ada'
};

export const MARKER_WEIGHTS = {
  cry1: 0.30,
  clockGene: 0.25,
  per2: 0.20,
  mtnr1b: 0.15,
  dec2: 0.10
};

// Maps marker status → directional signal per marker
// -1 = morning tendency, 0 = neutral, +1 = evening tendency
export const SIGNAL_MAP = {
  clockGene: { beneficial: -1, typical: 0, concern: 1 },
  dec2: { beneficial: -1, typical: 0, concern: 1 },
  per2: { beneficial: -1, typical: 0, concern: 1 },
  cry1: { beneficial: 1, typical: 0, concern: -1 },
  mtnr1b: { beneficial: 0, typical: 0, concern: 1 }
};

// === Longevity & Cardiovascular Marker Definitions ===

export const LONGEVITY_MARKERS = {
  rs2802292: { name: 'foxo3a', gene: 'FOXO3A', weight: 0.25, label: 'Longevity / FOXO3A' },
  rs2229765: { name: 'igf1r', gene: 'IGF1R', weight: 0.20, label: 'Growth Factor Receptor' },
  rs5882: { name: 'cetp', gene: 'CETP', weight: 0.20, label: 'HDL Cholesterol' },
  rs12366: { name: 'ipmk', gene: 'IPMK', weight: 0.15, label: 'Nutrient Sensing' },
  rs10936599: { name: 'terc', gene: 'TERC', weight: 0.20, label: 'Telomere Length' }
};

export const CARDIOVASCULAR_MARKERS = {
  rs6025: { name: 'factorV', gene: 'F5', weight: 0.20, label: 'Factor V Leiden' },
  rs1333049: { name: 'cad9p21', gene: '9p21.3', weight: 0.20, label: 'Coronary Artery Disease' },
  rs10455872: { name: 'lpa', gene: 'LPA', weight: 0.15, label: 'Lipoprotein(a)' },
  rs1799963: { name: 'prothrombin', gene: 'F2', weight: 0.15, label: 'Prothrombin Thrombophilia' },
  rs1800795: { name: 'il6', gene: 'IL-6', weight: 0.15, label: 'Inflammation / IL-6' },
  rs1800629: { name: 'tnfa', gene: 'TNF-alpha', weight: 0.15, label: 'Inflammation / TNF-alpha' }
};

// Longevity signal: beneficial = +1 (lifespan bonus), concern = -1 (lifespan penalty)
export const LONGEVITY_SIGNAL = { beneficial: 1, typical: 0, concern: -1 };

// Cardiovascular risk: concern = +1 (adds risk), beneficial = -1 (reduces risk)
export const CARDIO_SIGNAL = { beneficial: -1, typical: 0, concern: 1, major_concern: 1.5 };

// === Pure Functions (exported for testing) ===

export function extractSleepMarkers(savedMarkers) {
  const results = {};
  const markerValues = Object.values(savedMarkers || {});

  for (const [rsid, name] of Object.entries(SLEEP_MARKERS)) {
    const found = markerValues.find(m => m.rsid === rsid);
    if (found) {
      const signalMap = SIGNAL_MAP[name];
      const signal = signalMap?.[found.status] ?? 0;
      results[name] = {
        rsid,
        genotype: found.genotype,
        status: found.status,
        signal
      };
    }
  }

  return results;
}

export function extractCaffeineMarkers(savedMarkers) {
  const results = {};
  const markerValues = Object.values(savedMarkers || {});

  for (const [rsid, name] of Object.entries(CAFFEINE_MARKERS)) {
    const found = markerValues.find(m => m.rsid === rsid);
    if (found) {
      results[name] = {
        rsid,
        genotype: found.genotype,
        status: found.status
      };
    }
  }

  return results;
}

export function extractLongevityMarkers(savedMarkers) {
  const results = {};
  const markerValues = Object.values(savedMarkers || {});

  for (const [rsid, def] of Object.entries(LONGEVITY_MARKERS)) {
    const found = markerValues.find(m => m.rsid === rsid);
    if (found) {
      const signal = LONGEVITY_SIGNAL[found.status] ?? 0;
      results[def.name] = {
        rsid,
        gene: def.gene,
        label: def.label,
        genotype: found.genotype,
        status: found.status,
        weight: def.weight,
        signal
      };
    }
  }

  return results;
}

export function extractCardiovascularMarkers(savedMarkers) {
  const results = {};
  const markerValues = Object.values(savedMarkers || {});

  for (const [rsid, def] of Object.entries(CARDIOVASCULAR_MARKERS)) {
    const found = markerValues.find(m => m.rsid === rsid);
    if (found) {
      const signal = CARDIO_SIGNAL[found.status] ?? 0;
      results[def.name] = {
        rsid,
        gene: def.gene,
        label: def.label,
        genotype: found.genotype,
        status: found.status,
        weight: def.weight,
        signal
      };
    }
  }

  return results;
}

export function computeLifeExpectancy(longevityMarkers, cardiovascularMarkers, birthDate) {
  // Longevity score: weighted average of signals (+1 beneficial, -1 concern)
  let longevityScore = 0;
  let longevityWeight = 0;
  for (const marker of Object.values(longevityMarkers)) {
    longevityScore += marker.signal * marker.weight;
    longevityWeight += marker.weight;
  }
  if (longevityWeight > 0) longevityScore /= longevityWeight;

  // Cardiovascular risk: weighted average of signals (+1 concern adds risk)
  let cardioRisk = 0;
  let cardioWeight = 0;
  for (const marker of Object.values(cardiovascularMarkers)) {
    cardioRisk += marker.signal * marker.weight;
    cardioWeight += marker.weight;
  }
  if (cardioWeight > 0) cardioRisk /= cardioWeight;

  // Longevity adjustment: max ±5 years from favorable/unfavorable longevity markers
  const longevityAdjustment = Math.round(longevityScore * 5 * 100) / 100 || 0;

  // Cardiovascular adjustment: max ±4 years from cardio risk markers
  const cardiovascularAdjustment = Math.round(-cardioRisk * 4 * 100) / 100 || 0;

  const adjusted = Math.round((SSA_BASELINE_LIFE_EXPECTANCY + longevityAdjustment + cardiovascularAdjustment) * 10) / 10;

  // Confidence based on marker coverage
  const longevityCount = Object.keys(longevityMarkers).length;
  const cardioCount = Object.keys(cardiovascularMarkers).length;
  const maxLongevity = Object.keys(LONGEVITY_MARKERS).length;
  const maxCardio = Object.keys(CARDIOVASCULAR_MARKERS).length;
  const coverage = (longevityCount + cardioCount) / (maxLongevity + maxCardio);
  const confidence = Math.round(Math.min(1, coverage) * 100) / 100;

  // Time horizons if birth date provided
  let timeHorizons = null;
  if (birthDate) {
    const birth = new Date(birthDate);
    const now = new Date();
    const ageYears = (now - birth) / (365.25 * 24 * 60 * 60 * 1000);
    const yearsRemaining = Math.max(0, Math.round((adjusted - ageYears) * 10) / 10);
    // Healthy years: estimate ~85% of remaining years are active/healthy
    const healthyYearsRemaining = Math.round(yearsRemaining * 0.85 * 10) / 10;
    const percentLifeComplete = Math.round((ageYears / adjusted) * 1000) / 10;

    timeHorizons = {
      ageYears: Math.round(ageYears * 10) / 10,
      yearsRemaining,
      healthyYearsRemaining,
      percentLifeComplete: Math.min(100, percentLifeComplete)
    };
  }

  return {
    longevityScore: Math.round(longevityScore * 1000) / 1000,
    cardiovascularRisk: Math.round(cardioRisk * 1000) / 1000,
    lifeExpectancy: {
      baseline: SSA_BASELINE_LIFE_EXPECTANCY,
      adjusted,
      longevityAdjustment,
      cardiovascularAdjustment
    },
    timeHorizons,
    confidence
  };
}

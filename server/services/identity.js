import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { PATHS, ensureDir, safeJSONParse } from '../lib/fileUtils.js';
import { getGenomeSummary } from './genome.js';
import { getTasteProfile } from './taste-questionnaire.js';

const IDENTITY_DIR = PATHS.digitalTwin;
const IDENTITY_FILE = join(IDENTITY_DIR, 'identity.json');
const CHRONOTYPE_FILE = join(IDENTITY_DIR, 'chronotype.json');
const LONGEVITY_FILE = join(IDENTITY_DIR, 'longevity.json');
const GOALS_FILE = join(IDENTITY_DIR, 'goals.json');

// === Marker Definitions ===

const SLEEP_MARKERS = {
  rs1801260: 'clockGene',
  rs57875989: 'dec2',
  rs35333999: 'per2',
  rs2287161: 'cry1',
  rs4753426: 'mtnr1b'
};

const CAFFEINE_MARKERS = {
  rs762551: 'cyp1a2',
  rs73598374: 'ada'
};

const MARKER_WEIGHTS = {
  cry1: 0.30,
  clockGene: 0.25,
  per2: 0.20,
  mtnr1b: 0.15,
  dec2: 0.10
};

// Maps marker status → directional signal per marker
// -1 = morning tendency, 0 = neutral, +1 = evening tendency
const SIGNAL_MAP = {
  clockGene: { beneficial: -1, typical: 0, concern: 1 },
  dec2: { beneficial: -1, typical: 0, concern: 1 },
  per2: { beneficial: -1, typical: 0, concern: 1 },
  cry1: { beneficial: 1, typical: 0, concern: -1 },
  mtnr1b: { beneficial: 0, typical: 0, concern: 1 }
};

const SCHEDULE_TEMPLATES = {
  morning: {
    wakeTime: '06:00',
    sleepTime: '22:00',
    peakFocusStart: '08:00',
    peakFocusEnd: '12:00',
    exerciseWindow: '06:30-08:00',
    windDownStart: '20:30'
  },
  intermediate: {
    wakeTime: '07:00',
    sleepTime: '23:00',
    peakFocusStart: '09:30',
    peakFocusEnd: '13:00',
    exerciseWindow: '07:30-09:00',
    windDownStart: '21:30'
  },
  evening: {
    wakeTime: '08:30',
    sleepTime: '00:30',
    peakFocusStart: '11:00',
    peakFocusEnd: '15:00',
    exerciseWindow: '10:00-12:00',
    windDownStart: '23:00'
  }
};

// === Longevity & Cardiovascular Marker Definitions ===

const LONGEVITY_MARKERS = {
  rs2802292: { name: 'foxo3a', gene: 'FOXO3A', weight: 0.25, label: 'Longevity / FOXO3A' },
  rs2229765: { name: 'igf1r', gene: 'IGF1R', weight: 0.20, label: 'Growth Factor Receptor' },
  rs5882: { name: 'cetp', gene: 'CETP', weight: 0.20, label: 'HDL Cholesterol' },
  rs12366: { name: 'ipmk', gene: 'IPMK', weight: 0.15, label: 'Nutrient Sensing' },
  rs10936599: { name: 'terc', gene: 'TERC', weight: 0.20, label: 'Telomere Length' }
};

const CARDIOVASCULAR_MARKERS = {
  rs6025: { name: 'factorV', gene: 'F5', weight: 0.20, label: 'Factor V Leiden' },
  rs1333049: { name: 'cad9p21', gene: '9p21.3', weight: 0.20, label: 'Coronary Artery Disease' },
  rs10455872: { name: 'lpa', gene: 'LPA', weight: 0.15, label: 'Lipoprotein(a)' },
  rs1799963: { name: 'prothrombin', gene: 'F2', weight: 0.15, label: 'Prothrombin Thrombophilia' },
  rs1800795: { name: 'il6', gene: 'IL-6', weight: 0.15, label: 'Inflammation / IL-6' },
  rs1800629: { name: 'tnfa', gene: 'TNF-alpha', weight: 0.15, label: 'Inflammation / TNF-alpha' }
};

// Longevity signal: beneficial = +1 (lifespan bonus), concern = -1 (lifespan penalty)
const LONGEVITY_SIGNAL = { beneficial: 1, typical: 0, concern: -1 };

// Cardiovascular risk: concern = +1 (adds risk), beneficial = -1 (reduces risk)
const CARDIO_SIGNAL = { beneficial: -1, typical: 0, concern: 1, major_concern: 1.5 };

// US Social Security Administration actuarial baseline by decade (average M/F)
const SSA_BASELINE_LIFE_EXPECTANCY = 78.5;

// === Default Data Structures ===

const DEFAULT_IDENTITY = {
  sections: {
    genome: { status: 'unavailable', label: 'Genome', updatedAt: null },
    chronotype: { status: 'unavailable', label: 'Chronotype', updatedAt: null },
    longevity: { status: 'unavailable', label: 'Longevity', updatedAt: null },
    aesthetics: { status: 'unavailable', label: 'Aesthetics', updatedAt: null },
    goals: { status: 'unavailable', label: 'Goals', updatedAt: null }
  },
  updatedAt: null
};

const DEFAULT_CHRONOTYPE = {
  type: 'intermediate',
  confidence: 0,
  geneticMarkers: {},
  caffeineMarkers: {},
  behavioralData: null,
  recommendations: null,
  derivedAt: null
};

const DEFAULT_LONGEVITY = {
  longevityMarkers: {},
  cardiovascularMarkers: {},
  longevityScore: 0,
  cardiovascularRisk: 0,
  lifeExpectancy: {
    baseline: SSA_BASELINE_LIFE_EXPECTANCY,
    adjusted: null,
    longevityAdjustment: 0,
    cardiovascularAdjustment: 0
  },
  confidence: 0,
  derivedAt: null
};

const DEFAULT_GOALS = {
  birthDate: null,
  lifeExpectancy: null,
  timeHorizons: null,
  goals: [],
  updatedAt: null
};

// === File I/O ===

async function ensureIdentityDir() {
  await ensureDir(IDENTITY_DIR);
}

async function loadJSON(filePath, defaultVal) {
  const raw = await readFile(filePath, 'utf-8').catch(() => null);
  if (!raw) return { ...defaultVal };
  return safeJSONParse(raw, { ...defaultVal });
}

async function saveJSON(filePath, data) {
  await ensureIdentityDir();
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

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

export function computeGoalUrgency(goal, timeHorizons) {
  if (!timeHorizons || !goal.horizon) return null;

  const horizonMap = {
    '1-year': 1,
    '3-year': 3,
    '5-year': 5,
    '10-year': 10,
    '20-year': 20,
    'lifetime': timeHorizons.yearsRemaining
  };

  const horizonYears = horizonMap[goal.horizon] ?? 5;
  const yearsRemaining = timeHorizons.yearsRemaining;

  // Urgency: higher when horizon approaches or exceeds remaining years
  // 0 = plenty of time, 1 = urgent
  const rawUrgency = 1 - Math.min(1, yearsRemaining / (horizonYears * 2));
  // Boost urgency for goals whose horizon exceeds remaining healthy years
  const healthPressure = horizonYears > timeHorizons.healthyYearsRemaining ? 0.2 : 0;
  const urgency = Math.min(1, Math.round((rawUrgency + healthPressure) * 100) / 100);

  return urgency;
}

export function computeChronotype(geneticMarkers, behavioralData) {
  const markerNames = Object.keys(geneticMarkers);
  const hasGenetic = markerNames.length > 0;
  const hasBehavioral = behavioralData?.preferredWakeTime || behavioralData?.preferredSleepTime;

  // Genetic score: weighted average of directional signals
  let geneticScore = 0;
  let totalWeight = 0;
  for (const name of markerNames) {
    const weight = MARKER_WEIGHTS[name] ?? 0;
    geneticScore += geneticMarkers[name].signal * weight;
    totalWeight += weight;
  }
  if (totalWeight > 0) {
    geneticScore /= totalWeight;
  }

  // Behavioral score from wake/sleep times
  let behavioralScore = 0;
  if (hasBehavioral) {
    const scores = [];
    if (behavioralData.preferredWakeTime) {
      const [h] = behavioralData.preferredWakeTime.split(':').map(Number);
      // Before 7 = morning (-1), after 9 = evening (+1), between = interpolate
      scores.push(Math.max(-1, Math.min(1, (h - 8) / 2)));
    }
    if (behavioralData.preferredSleepTime) {
      const [h] = behavioralData.preferredSleepTime.split(':').map(Number);
      // Normalize: hours after midnight (0-5) count as 24-29
      const normalizedH = h < 6 ? h + 24 : h;
      // Before 22 = morning (-1), after midnight (24) = evening (+1)
      scores.push(Math.max(-1, Math.min(1, (normalizedH - 23) / 2)));
    }
    if (scores.length > 0) {
      behavioralScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    }
  }

  // Composite score
  let composite;
  if (hasGenetic && hasBehavioral) {
    composite = (geneticScore + behavioralScore) / 2;
  } else if (hasGenetic) {
    composite = geneticScore;
  } else if (hasBehavioral) {
    composite = behavioralScore;
  } else {
    composite = 0;
  }

  // Classification
  let type;
  if (composite < -0.25) {
    type = 'morning';
  } else if (composite > 0.25) {
    type = 'evening';
  } else {
    type = 'intermediate';
  }

  // Confidence calculation
  const markerCount = markerNames.length;
  const maxMarkers = Object.keys(MARKER_WEIGHTS).length;
  const markerConfidence = Math.min(0.5, (markerCount / maxMarkers) * 0.5);
  const behavioralConfidence = hasBehavioral ? 0.3 : 0;

  let agreementBonus = 0;
  if (hasGenetic && hasBehavioral) {
    const sameDirection = Math.sign(geneticScore) === Math.sign(behavioralScore) &&
      Math.sign(geneticScore) !== 0;
    agreementBonus = sameDirection ? 0.2 : -0.1;
  }

  const confidence = Math.max(0, Math.min(1,
    markerConfidence + behavioralConfidence + agreementBonus
  ));

  return {
    type,
    confidence: Math.round(confidence * 100) / 100,
    scores: {
      genetic: Math.round(geneticScore * 1000) / 1000,
      behavioral: Math.round(behavioralScore * 1000) / 1000,
      composite: Math.round(composite * 1000) / 1000
    }
  };
}

export function computeRecommendations(type, caffeineMarkers, mtnr1bStatus) {
  const schedule = { ...SCHEDULE_TEMPLATES[type] };

  // Caffeine cutoff based on CYP1A2 metabolism
  const cyp1a2 = caffeineMarkers?.cyp1a2;
  if (cyp1a2?.status === 'beneficial') {
    schedule.caffeineCutoff = '16:00';
    schedule.caffeineNote = 'Fast metabolizer — caffeine clears quickly';
  } else if (cyp1a2?.status === 'concern' || cyp1a2?.status === 'major_concern') {
    schedule.caffeineCutoff = '12:00';
    schedule.caffeineNote = 'Slow metabolizer — limit afternoon caffeine';
  } else {
    schedule.caffeineCutoff = '14:00';
    schedule.caffeineNote = 'Typical metabolism — moderate afternoon cutoff';
  }

  // Late-eating cutoff based on MTNR1B
  if (mtnr1bStatus === 'concern' || mtnr1bStatus === 'major_concern') {
    schedule.lastMealCutoff = '19:00';
    schedule.mealNote = 'MTNR1B variant — earlier meals may improve glucose response';
  } else {
    schedule.lastMealCutoff = '20:30';
    schedule.mealNote = 'Standard meal timing recommendation';
  }

  return schedule;
}

// === Exported Service Functions ===

export async function getIdentityStatus() {
  await ensureIdentityDir();
  const identity = await loadJSON(IDENTITY_FILE, DEFAULT_IDENTITY);

  // Check genome status
  const genomeSummary = await getGenomeSummary();
  if (genomeSummary?.uploaded) {
    const markerCount = genomeSummary.markerCount || 0;
    identity.sections.genome = {
      status: markerCount > 0 ? 'active' : 'pending',
      label: 'Genome',
      markerCount,
      updatedAt: genomeSummary.uploadedAt
    };
  } else {
    identity.sections.genome = { status: 'unavailable', label: 'Genome', updatedAt: null };
  }

  // Check chronotype status
  const chronotype = await loadJSON(CHRONOTYPE_FILE, DEFAULT_CHRONOTYPE);
  if (chronotype.derivedAt) {
    identity.sections.chronotype = {
      status: 'active',
      label: 'Chronotype',
      type: chronotype.type,
      confidence: chronotype.confidence,
      updatedAt: chronotype.derivedAt
    };
  } else {
    identity.sections.chronotype = {
      status: genomeSummary?.uploaded ? 'pending' : 'unavailable',
      label: 'Chronotype',
      updatedAt: null
    };
  }

  // Check longevity status
  const longevity = await loadJSON(LONGEVITY_FILE, DEFAULT_LONGEVITY);
  if (longevity.derivedAt) {
    const markerCount = Object.keys(longevity.longevityMarkers).length +
      Object.keys(longevity.cardiovascularMarkers).length;
    identity.sections.longevity = {
      status: 'active',
      label: 'Longevity',
      markerCount,
      adjustedLifeExpectancy: longevity.lifeExpectancy?.adjusted,
      confidence: longevity.confidence,
      updatedAt: longevity.derivedAt
    };
  } else {
    identity.sections.longevity = {
      status: genomeSummary?.uploaded ? 'pending' : 'unavailable',
      label: 'Longevity',
      updatedAt: null
    };
  }

  // Check aesthetics (taste profile) status
  const tasteProfile = await getTasteProfile();
  if (tasteProfile?.completedCount > 0) {
    identity.sections.aesthetics = {
      status: tasteProfile.overallPercentage >= 100 ? 'active' : 'pending',
      label: 'Aesthetics',
      completedSections: tasteProfile.completedCount,
      totalSections: tasteProfile.totalSections,
      updatedAt: tasteProfile.lastSessionAt
    };
  } else {
    identity.sections.aesthetics = { status: 'unavailable', label: 'Aesthetics', updatedAt: null };
  }

  // Goals status — check goals.json for user-defined goals
  const goalsData = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const activeGoals = goalsData.goals?.filter(g => g.status === 'active') || [];
  if (activeGoals.length > 0) {
    identity.sections.goals = {
      status: 'active',
      label: 'Goals',
      goalCount: activeGoals.length,
      hasBirthDate: !!goalsData.birthDate,
      updatedAt: goalsData.updatedAt
    };
  } else if (goalsData.birthDate) {
    identity.sections.goals = {
      status: 'pending',
      label: 'Goals',
      hasBirthDate: true,
      updatedAt: goalsData.updatedAt
    };
  } else {
    identity.sections.goals = { status: 'unavailable', label: 'Goals', updatedAt: null };
  }

  identity.updatedAt = new Date().toISOString();
  await saveJSON(IDENTITY_FILE, identity);

  return identity;
}

export async function getChronotype() {
  const existing = await loadJSON(CHRONOTYPE_FILE, DEFAULT_CHRONOTYPE);
  if (existing.derivedAt) return existing;
  return deriveChronotype();
}

export async function deriveChronotype() {
  const genomeSummary = await getGenomeSummary();
  const savedMarkers = genomeSummary?.savedMarkers || {};

  const geneticMarkers = extractSleepMarkers(savedMarkers);
  const caffeineMarkers = extractCaffeineMarkers(savedMarkers);

  // Load existing behavioral data if present
  const existing = await loadJSON(CHRONOTYPE_FILE, DEFAULT_CHRONOTYPE);
  const behavioralData = existing.behavioralData;

  const { type, confidence, scores } = computeChronotype(geneticMarkers, behavioralData);

  const mtnr1bStatus = geneticMarkers.mtnr1b?.status ?? null;
  const recommendations = computeRecommendations(type, caffeineMarkers, mtnr1bStatus);

  const chronotype = {
    type,
    confidence,
    scores,
    geneticMarkers,
    caffeineMarkers,
    behavioralData,
    recommendations,
    derivedAt: new Date().toISOString()
  };

  await saveJSON(CHRONOTYPE_FILE, chronotype);
  console.log(`🧬 Chronotype derived: ${type} (confidence: ${confidence})`);

  return chronotype;
}

export async function updateChronotypeBehavioral(overrides) {
  const existing = await loadJSON(CHRONOTYPE_FILE, DEFAULT_CHRONOTYPE);
  const behavioralData = { ...(existing.behavioralData || {}), ...overrides };

  // Save behavioral data then re-derive
  existing.behavioralData = behavioralData;
  await saveJSON(CHRONOTYPE_FILE, existing);

  return deriveChronotype();
}

// === Longevity Service Functions ===

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

// === Goal Service Functions ===

export async function getGoals() {
  return loadJSON(GOALS_FILE, DEFAULT_GOALS);
}

export async function setBirthDate(birthDate) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  goals.birthDate = birthDate;
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);

  // Re-derive longevity with new birth date
  const longevity = await deriveLongevity(birthDate);

  // Recalculate urgency for all active goals
  if (longevity.timeHorizons) {
    for (const goal of goals.goals) {
      if (goal.status === 'active') {
        goal.urgency = computeGoalUrgency(goal, longevity.timeHorizons);
      }
    }
    goals.lifeExpectancy = longevity.lifeExpectancy;
    goals.timeHorizons = longevity.timeHorizons;
    await saveJSON(GOALS_FILE, goals);
  }

  return goals;
}

export async function createGoal({ title, description, horizon, category }) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const longevity = await loadJSON(LONGEVITY_FILE, DEFAULT_LONGEVITY);

  const id = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const goal = {
    id,
    title,
    description: description || '',
    horizon: horizon || '5-year',
    category: category || 'mastery',
    urgency: null,
    status: 'active',
    milestones: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  // Calculate urgency if time horizons available
  if (longevity.timeHorizons) {
    goal.urgency = computeGoalUrgency(goal, longevity.timeHorizons);
  }

  goals.goals.push(goal);
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);

  console.log(`🎯 Goal created: "${title}" (${horizon}, urgency: ${goal.urgency ?? 'n/a'})`);
  return goal;
}

export async function updateGoal(goalId, updates) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const idx = goals.goals.findIndex(g => g.id === goalId);
  if (idx === -1) return null;

  const goal = goals.goals[idx];
  const allowed = ['title', 'description', 'horizon', 'category', 'status'];
  for (const key of allowed) {
    if (updates[key] !== undefined) goal[key] = updates[key];
  }
  goal.updatedAt = new Date().toISOString();

  // Recalculate urgency if horizon changed
  const longevity = await loadJSON(LONGEVITY_FILE, DEFAULT_LONGEVITY);
  if (longevity.timeHorizons) {
    goal.urgency = computeGoalUrgency(goal, longevity.timeHorizons);
  }

  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  return goal;
}

export async function deleteGoal(goalId) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const idx = goals.goals.findIndex(g => g.id === goalId);
  if (idx === -1) return false;

  goals.goals.splice(idx, 1);
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  return true;
}

export async function addMilestone(goalId, { title, targetDate }) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  const milestone = {
    id: `ms-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title,
    targetDate: targetDate || null,
    completedAt: null,
    createdAt: new Date().toISOString()
  };

  goal.milestones.push(milestone);
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  return milestone;
}

export async function completeMilestone(goalId, milestoneId) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  const milestone = goal.milestones.find(m => m.id === milestoneId);
  if (!milestone) return null;

  milestone.completedAt = new Date().toISOString();
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  return milestone;
}

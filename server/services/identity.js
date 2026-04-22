import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { PATHS, ensureDir, safeJSONParse } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { getGenomeSummary } from './genome.js';
import { getTasteProfile } from './taste-questionnaire.js';
import { getActivities } from './meatspaceCalendar.js';
import { callProviderAISimple, parseLLMJSON } from '../lib/aiProvider.js';
import { goalTypeEnum } from '../lib/identityValidation.js';
import { isMortalLoomEnabled, mlArrayIfEnabled, mlReplace } from './mortalLoomStore.js';

const PORTOS_GOAL_DEFAULTS = {
  parentId: null,
  tags: [],
  linkedActivities: [],
  linkedCalendars: [],
  progress: 0,
  progressHistory: [],
  todos: [],
  targetDate: null,
  timeBlockConfig: null,
  scheduledEvents: [],
  checkIns: [],
  milestones: [],
  goalType: 'standard'
};

const normalizeGoal = g => ({ ...PORTOS_GOAL_DEFAULTS, ...g });

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
  const data = raw ? safeJSONParse(raw, structuredClone(defaultVal)) : structuredClone(defaultVal);
  // When MortalLoom iCloud sync is enabled, the goals array is sourced from
  // MortalLoom.json; birthDate and lifeExpectancy metadata stay in local PortOS.
  if (filePath === GOALS_FILE) {
    const mlGoals = await mlArrayIfEnabled('goals');
    if (mlGoals) data.goals = mlGoals.map(normalizeGoal);
  }
  return data;
}

async function saveJSON(filePath, data) {
  await ensureIdentityDir();
  await writeFile(filePath, JSON.stringify(data, null, 2));
  // Mirror goals array into MortalLoom.json so iOS/macOS app sees the change.
  if (filePath === GOALS_FILE && (await isMortalLoomEnabled()) && Array.isArray(data.goals)) {
    await mlReplace('goals', data.goals);
  }
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

function getHorizonYears(horizon, timeHorizons) {
  const map = { '1-year': 1, '3-year': 3, '5-year': 5, '10-year': 10, '20-year': 20, 'lifetime': timeHorizons.yearsRemaining };
  return map[horizon] ?? 5;
}

/**
 * Compute time feasibility for a goal based on its linked activities.
 * Returns { feasible, totalPerWeek, weeksAvailable, links } or null if no links.
 */
export function computeGoalFeasibility(goal, timeHorizons, activities) {
  if (!goal.linkedActivities?.length || !timeHorizons) return null;

  const horizonYears = getHorizonYears(goal.horizon, timeHorizons);
  const weeksAvailable = Math.floor(Math.min(horizonYears, timeHorizons.yearsRemaining) * 52);

  let totalPerWeek = 0;
  const links = [];
  for (const link of goal.linkedActivities) {
    const activity = activities.find(a => a.name === link.activityName);
    if (!activity) continue;
    const freq = link.requiredFrequency ?? activity.frequency;
    // Normalize to per-week
    let perWeek;
    switch (activity.cadence) {
      case 'day': perWeek = freq * 7; break;
      case 'week': perWeek = freq; break;
      case 'month': perWeek = freq / 4.35; break;
      case 'year': perWeek = freq / 52; break;
      default: perWeek = 0;
    }
    totalPerWeek += perWeek;
    const totalOverHorizon = Math.floor(perWeek * weeksAvailable);
    links.push({ activityName: link.activityName, perWeek: Math.round(perWeek * 10) / 10, totalOverHorizon });
  }

  return {
    feasible: weeksAvailable > 0,
    weeksAvailable,
    totalPerWeek: Math.round(totalPerWeek * 10) / 10,
    links
  };
}

export function computeGoalUrgency(goal, timeHorizons) {
  if (!timeHorizons || !goal.horizon) return null;

  const horizonYears = getHorizonYears(goal.horizon, timeHorizons);
  const yearsRemaining = timeHorizons.yearsRemaining;

  if (horizonYears <= 0 || yearsRemaining <= 0) return 1;

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

/**
 * Get structured energy zones for the day based on chronotype.
 * Returns time blocks with zone type, start/end times, and display metadata.
 */
export async function getEnergySchedule() {
  const chronotype = await getChronotype();
  if (!chronotype?.recommendations) return { zones: [], type: null, confidence: 0 };

  const rec = chronotype.recommendations;

  const parseTime = (str) => {
    const [h, m] = (str || '').split(':').map(Number);
    const mins = h * 60 + (m || 0);
    return Number.isFinite(mins) && mins >= 0 && mins <= 1440 ? mins : NaN;
  };

  const validMinutes = (...vals) => vals.every(v => Number.isFinite(v));

  const zones = [];

  // Wake-up zone
  if (rec.wakeTime) {
    const wake = parseTime(rec.wakeTime);
    if (validMinutes(wake)) {
      zones.push({ id: 'wake', label: 'Wake Up', startMin: wake, endMin: wake + 30, color: '#f59e0b', opacity: 0.12 });
    }
  }

  // Exercise window (e.g., "06:30-08:00")
  if (rec.exerciseWindow) {
    const [exStart, exEnd] = rec.exerciseWindow.split('-').map(parseTime);
    if (validMinutes(exStart, exEnd) && exEnd >= exStart) {
      zones.push({ id: 'exercise', label: 'Exercise', startMin: exStart, endMin: exEnd, color: '#22c55e', opacity: 0.10 });
    }
  }

  // Peak focus
  if (rec.peakFocusStart && rec.peakFocusEnd) {
    const start = parseTime(rec.peakFocusStart);
    const end = parseTime(rec.peakFocusEnd);
    if (validMinutes(start, end) && end >= start) {
      zones.push({
        id: 'peak-focus',
        label: 'Peak Focus',
        startMin: start,
        endMin: end,
        color: '#3b82f6',
        opacity: 0.12
      });
    }
  }

  // Caffeine cutoff (marker, not a zone)
  if (rec.caffeineCutoff) {
    const cutoff = parseTime(rec.caffeineCutoff);
    if (validMinutes(cutoff)) {
      zones.push({ id: 'caffeine-cutoff', label: 'Caffeine Cutoff', startMin: cutoff, endMin: cutoff, color: '#ef4444', opacity: 0, marker: true });
    }
  }

  // Last meal cutoff
  if (rec.lastMealCutoff) {
    const meal = parseTime(rec.lastMealCutoff);
    if (validMinutes(meal)) {
      zones.push({ id: 'meal-cutoff', label: 'Last Meal', startMin: meal, endMin: meal, color: '#f97316', opacity: 0, marker: true });
    }
  }

  // Wind-down
  if (rec.windDownStart && rec.sleepTime) {
    const windStart = parseTime(rec.windDownStart);
    const windEnd = parseTime(rec.sleepTime);
    if (validMinutes(windStart, windEnd) && windEnd >= windStart) {
      zones.push({
        id: 'wind-down',
        label: 'Wind Down',
        startMin: windStart,
        endMin: windEnd,
        color: '#8b5cf6',
        opacity: 0.10
      });
    }
  }

  return {
    zones,
    type: chronotype.type,
    confidence: chronotype.confidence,
    wakeTime: rec.wakeTime,
    sleepTime: rec.sleepTime
  };
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
  const data = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  // Lazy migration: backfill parentId, tags, linkedActivities on goals missing them
  let needsSave = false;
  for (const goal of data.goals) {
    if (goal.parentId === undefined) { goal.parentId = null; needsSave = true; }
    if (!Array.isArray(goal.tags)) { goal.tags = []; needsSave = true; }
    if (!Array.isArray(goal.linkedActivities)) { goal.linkedActivities = []; needsSave = true; }
    if (!Array.isArray(goal.linkedCalendars)) { goal.linkedCalendars = []; needsSave = true; }
    if (goal.progress === undefined) { goal.progress = 0; needsSave = true; }
    if (!Array.isArray(goal.progressHistory)) { goal.progressHistory = []; needsSave = true; }
    if (!Array.isArray(goal.todos)) { goal.todos = []; needsSave = true; }
    if (goal.targetDate === undefined) { goal.targetDate = null; needsSave = true; }
    if (goal.timeBlockConfig === undefined) { goal.timeBlockConfig = null; needsSave = true; }
    if (!Array.isArray(goal.scheduledEvents)) { goal.scheduledEvents = []; needsSave = true; }
    if (!Array.isArray(goal.checkIns)) { goal.checkIns = []; needsSave = true; }
    if (!goal.goalType) { goal.goalType = 'standard'; needsSave = true; }
    // Lazy-migrate milestones with description and order
    for (const ms of (goal.milestones || [])) {
      if (ms.description === undefined) { ms.description = ''; needsSave = true; }
      if (ms.order === undefined) { ms.order = 0; needsSave = true; }
    }
  }
  if (needsSave) await saveJSON(GOALS_FILE, data);
  return data;
}

export async function setBirthDate(birthDate) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  goals.birthDate = birthDate;
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);

  // Sync to meatspace config (canonical source), skip goals sync since we just wrote it
  const { updateBirthDate } = await import('./meatspace.js');
  await updateBirthDate(birthDate, { syncGoals: false });

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

export async function createGoal({ title, description, horizon, category, goalType, parentId, tags, targetDate, timeBlockConfig }) {
  const goals = await getGoals();
  const longevity = await loadJSON(LONGEVITY_FILE, DEFAULT_LONGEVITY);

  // Validate parentId references an existing goal
  if (parentId && !goals.goals.find(g => g.id === parentId)) {
    throw new ServerError('Parent goal not found', { status: 400, code: 'INVALID_PARENT' });
  }

  const id = `goal-${uuidv4()}`;
  const goal = {
    id,
    title,
    description: description || '',
    horizon: horizon || '5-year',
    category: category || 'mastery',
    goalType: goalType || 'standard',
    parentId: parentId || null,
    tags: [...new Set((tags || []).map(t => t.trim()).filter(Boolean))],
    linkedActivities: [],
    linkedCalendars: [],
    targetDate: targetDate || null,
    timeBlockConfig: timeBlockConfig || null,
    scheduledEvents: [],
    checkIns: [],
    urgency: null,
    status: 'active',
    milestones: [],
    progress: 0,
    progressHistory: [],
    todos: [],
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

function hasAncestorCycle(goals, goalId, newParentId) {
  let current = newParentId;
  const visited = new Set();
  while (current) {
    if (current === goalId) return true;
    if (visited.has(current)) return true;
    visited.add(current);
    const parent = goals.find(g => g.id === current);
    current = parent?.parentId || null;
  }
  return false;
}

export async function updateGoal(goalId, updates) {
  const goals = await getGoals();
  const idx = goals.goals.findIndex(g => g.id === goalId);
  if (idx === -1) return null;

  const goal = goals.goals[idx];

  // Validate parentId doesn't create a cycle
  if (updates.parentId !== undefined && updates.parentId !== null) {
    if (!goals.goals.find(g => g.id === updates.parentId)) {
      throw new ServerError('Parent goal not found', { status: 400, code: 'INVALID_PARENT' });
    }
    if (hasAncestorCycle(goals.goals, goalId, updates.parentId)) {
      throw new ServerError('Cannot set parent: would create a cycle', { status: 400, code: 'CYCLE_DETECTED' });
    }
  }

  const allowed = ['title', 'description', 'horizon', 'category', 'goalType', 'status', 'parentId', 'tags', 'targetDate', 'timeBlockConfig'];
  for (const key of allowed) {
    if (updates[key] !== undefined) goal[key] = updates[key];
  }
  // Normalize tags: deduplicate and trim
  if (goal.tags) {
    goal.tags = [...new Set(goal.tags.map(t => t.trim()).filter(Boolean))];
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
  const goals = await getGoals();
  const idx = goals.goals.findIndex(g => g.id === goalId);
  if (idx === -1) return false;

  const deletedGoal = goals.goals[idx];
  // Orphan children: reparent to deleted goal's parent (or root)
  const now = new Date().toISOString();
  for (const goal of goals.goals) {
    if (goal.parentId === goalId) {
      goal.parentId = deletedGoal.parentId || null;
      goal.updatedAt = now;
    }
  }

  goals.goals.splice(idx, 1);
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  return true;
}

export async function getGoalsTree() {
  const goals = await getGoals();
  const longevity = await loadJSON(LONGEVITY_FILE, DEFAULT_LONGEVITY);
  const activities = await getActivities();

  // Enrich goals with urgency, feasibility, velocity, and time tracking
  const enriched = goals.goals.map(goal => {
    const enrichedGoal = { ...goal };
    if (goal.status === 'active' && longevity.timeHorizons) {
      enrichedGoal.urgency = computeGoalUrgency(goal, longevity.timeHorizons);
      enrichedGoal.feasibility = computeGoalFeasibility(goal, longevity.timeHorizons, activities);
    }
    enrichedGoal.velocity = computeGoalVelocity(goal);
    enrichedGoal.timeTracking = computeTimeTracking(goal);
    return enrichedGoal;
  });

  // Build hierarchical tree
  const goalMap = new Map(enriched.map(g => [g.id, { ...g, children: [] }]));
  const roots = [];
  for (const node of goalMap.values()) {
    if (node.parentId && goalMap.has(node.parentId)) {
      goalMap.get(node.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Build tag index (deduplicated per tag)
  const tagIndex = {};
  for (const goal of enriched) {
    for (const tag of new Set(goal.tags || [])) {
      if (!tagIndex[tag]) tagIndex[tag] = [];
      tagIndex[tag].push(goal.id);
    }
  }

  return {
    roots,
    flat: enriched,
    tagIndex,
    birthDate: goals.birthDate,
    lifeExpectancy: longevity.lifeExpectancy || goals.lifeExpectancy,
    timeHorizons: longevity.timeHorizons || goals.timeHorizons
  };
}

export async function linkActivity(goalId, { activityName, requiredFrequency, note }) {
  const goals = await getGoals();
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  // Prevent duplicates
  if (goal.linkedActivities.some(l => l.activityName === activityName)) {
    // Update existing link
    const link = goal.linkedActivities.find(l => l.activityName === activityName);
    if (requiredFrequency !== undefined) link.requiredFrequency = requiredFrequency;
    if (note !== undefined) link.note = note;
  } else {
    goal.linkedActivities.push({
      activityName,
      requiredFrequency: requiredFrequency || null,
      note: note || ''
    });
  }
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  console.log(`🔗 Activity "${activityName}" linked to goal "${goal.title}"`);
  return goal;
}

export async function unlinkActivity(goalId, activityName) {
  const goals = await getGoals();
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  const idx = goal.linkedActivities.findIndex(l => l.activityName === activityName);
  if (idx === -1) return goal;

  goal.linkedActivities.splice(idx, 1);
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  console.log(`🔗 Activity "${activityName}" unlinked from goal "${goal.title}"`);
  return goal;
}

export async function addMilestone(goalId, { title, targetDate }) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  const milestone = {
    id: `ms-${uuidv4()}`,
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

export async function addProgressEntry(goalId, { date, note, durationMinutes }) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  if (!goal.progressLog) goal.progressLog = [];

  const entry = {
    id: `prog-${uuidv4()}`,
    date,
    note,
    durationMinutes: durationMinutes || null,
    createdAt: new Date().toISOString()
  };

  goal.progressLog.push(entry);
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);

  console.log(`📝 Progress logged for "${goal.title}": ${note} (${durationMinutes ? durationMinutes + 'min' : 'no duration'})`);
  return entry;
}

export async function deleteProgressEntry(goalId, entryId) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  const idx = (goal.progressLog || []).findIndex(e => e.id === entryId);
  if (idx === -1) return null;

  goal.progressLog.splice(idx, 1);
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  return { deleted: true };
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

export async function linkCalendarToGoal(goalId, { subcalendarId, subcalendarName, matchPattern }) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  if (!goal.linkedCalendars) goal.linkedCalendars = [];

  // Prevent duplicates
  const existing = goal.linkedCalendars.find(lc => lc.subcalendarId === subcalendarId);
  if (existing) {
    existing.subcalendarName = subcalendarName;
    existing.matchPattern = matchPattern || '';
  } else {
    goal.linkedCalendars.push({
      subcalendarId,
      subcalendarName,
      matchPattern: matchPattern || '',
      linkedAt: new Date().toISOString()
    });
  }

  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  console.log(`📅 Calendar "${subcalendarName}" linked to goal "${goal.title}"`);
  return goal;
}

export async function unlinkCalendarFromGoal(goalId, subcalendarId) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  if (!goal.linkedCalendars) return goal;
  const idx = goal.linkedCalendars.findIndex(lc => lc.subcalendarId === subcalendarId);
  if (idx === -1) return goal;

  goal.linkedCalendars.splice(idx, 1);
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  console.log(`📅 Calendar unlinked from goal "${goal.title}"`);
  return goal;
}

export async function getGoalCalendarEvents(goalId, startDate, endDate) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal || !goal.linkedCalendars?.length) return [];

  const { getEvents } = await import('./calendarSync.js');
  const { events } = await getEvents({ startDate, endDate, limit: 200 });

  const linkedIds = new Set(goal.linkedCalendars.map(lc => lc.subcalendarId));
  const patternMap = {};
  for (const lc of goal.linkedCalendars) {
    patternMap[lc.subcalendarId] = lc.matchPattern;
  }

  return events.filter(e => {
    if (!linkedIds.has(e.subcalendarId)) return false;
    const pattern = patternMap[e.subcalendarId];
    if (!pattern) return true;
    return e.title?.toLowerCase().includes(pattern.toLowerCase());
  });
}

// =============================================================================
// AI Phase Planning
// =============================================================================

export async function generateGoalPhases(goalId, { providerId, model } = {}) {
  const { getActiveProvider, getProviderById } = await import('./providers.js');
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });
  if (!goal.targetDate) throw new ServerError('Goal must have a target date to generate phases', { status: 400, code: 'MISSING_TARGET_DATE' });

  const provider = providerId ? await getProviderById(providerId) : await getActiveProvider();
  if (!provider) throw new ServerError('No AI provider available', { status: 503, code: 'NO_PROVIDER' });
  const selectedModel = model ?? provider.defaultModel;

  const today = new Date().toISOString().slice(0, 10);
  const prompt = `You are a goal planning assistant. Given a goal with a target completion date, generate 3-7 ordered phases that break this goal into achievable milestones.

Goal title: ${goal.title}
Goal description: ${goal.description || 'No description provided'}
Today's date: ${today}
Target completion date: ${goal.targetDate}

Generate phases that:
- Are ordered chronologically with evenly distributed target dates between now and the target date
- Have clear, actionable titles
- Include brief descriptions of what each phase involves
- The last phase's target date should match or be near the goal's target date

Respond with a JSON array only (no markdown fences, no explanation). Each element must have:
- "title": string (phase name)
- "description": string (1-2 sentences)
- "targetDate": string (YYYY-MM-DD format)
- "order": number (0-based index)`;

  const result = await callProviderAISimple(provider, selectedModel, prompt, { max_tokens: 2000 });
  if (result.error) throw new ServerError(`AI generation failed: ${result.error}`, { status: 502, code: 'AI_ERROR' });

  let parsed;
  try {
    parsed = parseLLMJSON(result.text);
  } catch (e) {
    throw new ServerError(`AI returned invalid phase data: ${e.message}`, { status: 502, code: 'AI_PARSE_ERROR' });
  }
  if (!Array.isArray(parsed)) throw new ServerError('AI returned invalid phase data', { status: 502, code: 'AI_PARSE_ERROR' });

  console.log(`🎯 Generated ${parsed.length} phases for goal "${goal.title}"`);
  return parsed;
}

export async function acceptGoalPhases(goalId, phases) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });

  goal.milestones = phases.map((phase, idx) => ({
    id: `ms-${uuidv4()}`,
    title: phase.title,
    description: phase.description || '',
    targetDate: phase.targetDate || null,
    order: phase.order ?? idx,
    completedAt: null,
    createdAt: new Date().toISOString()
  }));

  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  console.log(`🎯 Accepted ${phases.length} phases for goal "${goal.title}"`);
  return goal;
}

// =============================================================================
// Goal Hierarchy Organization (LLM-powered)
// =============================================================================

export async function organizeGoals({ providerId, model } = {}) {
  const { getActiveProvider, getProviderById } = await import('./providers.js');
  const goals = await getGoals();
  const activeGoals = goals.goals.filter(g => g.status === 'active');

  if (activeGoals.length < 2) {
    throw new ServerError('Need at least 2 active goals to organize', { status: 400, code: 'TOO_FEW_GOALS' });
  }

  const provider = providerId ? await getProviderById(providerId) : await getActiveProvider();
  if (!provider) throw new ServerError('No AI provider available', { status: 503, code: 'NO_PROVIDER' });
  const selectedModel = model ?? provider.defaultModel;

  const goalSummaries = activeGoals.map(g => ({
    id: g.id,
    title: g.title,
    description: g.description || '',
    horizon: g.horizon,
    category: g.category,
    currentType: g.goalType || 'standard',
    currentParentId: g.parentId
  }));

  const prompt = `You are a life purpose analyst. Given a list of personal goals, analyze them and organize them into a meaningful hierarchy.

Your task:
1. Identify the single APEX goal — the ultimate north-star purpose that all other goals serve. This is the person's deepest "why". If none of the existing goals captures this, suggest one.
2. Identify SUB-APEX goals — major life pillars that directly support the apex goal (e.g., "Stay alive and healthy as long as possible", "Build lasting legacy").
3. Organize remaining goals as STANDARD goals under the appropriate sub-apex or apex parent.
4. Suggest a parentId hierarchy — which goal should be parent of which.

Current goals:
${JSON.stringify(goalSummaries, null, 2)}

Respond with JSON only (no markdown fences). The response must be an object with:
- "apexGoal": { "existingId": string|null, "suggestedTitle": string|null, "suggestedDescription": string|null } — if an existing goal IS the apex, set existingId. If no existing goal fits, suggest a new one.
- "organization": array of { "id": string, "goalType": "apex"|"sub-apex"|"standard", "suggestedParentId": string|null, "reasoning": string }
  - For each existing goal, assign its type and suggested parent.
  - The apex goal has null parentId.
  - Sub-apex goals MUST have suggestedParentId set to the apex goal's existingId (if an existing goal is the apex) or "__new_apex__" (if you are suggesting a new apex goal). Sub-apex goals are never root nodes.
  - Standard goals should have suggestedParentId set to the most appropriate sub-apex goal id, or to the apex goal id if they directly support the apex.
  - The reasoning should be 1 sentence explaining why this goal fits where it does.
- "suggestedSubApex": array of { "title": string, "description": string, "category": string, "suggestedParentId": string|null } — suggest 0-3 sub-apex goals if the existing goals don't cover major life pillars well. Set suggestedParentId to the apex goal's existingId or "__new_apex__" if suggesting a new apex.
- "analysis": string — 2-3 sentences summarizing the person's core purpose and how their goals connect.`;

  const result = await callProviderAISimple(provider, selectedModel, prompt, { max_tokens: 3000, temperature: 0.4 });
  if (result.error) throw new ServerError(`AI organization failed: ${result.error}`, { status: 502, code: 'AI_ERROR' });

  let parsed;
  try {
    parsed = parseLLMJSON(result.text);
  } catch (e) {
    throw new ServerError(`AI returned invalid organization data: ${e.message}`, { status: 502, code: 'AI_PARSE_ERROR' });
  }

  // Validate required shape from LLM response
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.organization)) {
    throw new ServerError('AI returned unexpected shape: missing organization array', { status: 502, code: 'AI_PARSE_ERROR' });
  }
  if (!parsed.apexGoal || typeof parsed.apexGoal !== 'object') {
    throw new ServerError('AI returned unexpected shape: missing apexGoal', { status: 502, code: 'AI_PARSE_ERROR' });
  }

  // Filter organization to only known goal IDs
  const goalIds = new Set(activeGoals.map(g => g.id));
  parsed.organization = parsed.organization.filter(item => item.id && goalIds.has(item.id));

  console.log(`🎯 Organized ${activeGoals.length} goals into hierarchy`);
  return parsed;
}

export async function applyGoalOrganization(organization) {
  const goals = await getGoals();
  const now = new Date().toISOString();
  const goalMap = new Map(goals.goals.map(g => [g.id, g]));
  let changed = 0;

  for (const item of organization) {
    const goal = goalMap.get(item.id);
    if (!goal) continue;

    let goalChanged = false;

    if (item.goalType && goalTypeEnum.options.includes(item.goalType)) {
      if (goal.goalType !== item.goalType) {
        goal.goalType = item.goalType;
        goalChanged = true;
      }
    }
    if (item.suggestedParentId !== undefined) {
      const newParentId = item.suggestedParentId;
      if (newParentId === null || goalMap.has(newParentId)) {
        if (!newParentId || !hasAncestorCycle(goals.goals, goal.id, newParentId)) {
          if (goal.parentId !== newParentId) {
            goal.parentId = newParentId;
            goalChanged = true;
          }
        }
      }
    }
    if (goalChanged) {
      goal.updatedAt = now;
      changed++;
    }
  }

  if (changed > 0) {
    goals.updatedAt = now;
    await saveJSON(GOALS_FILE, goals);
  }
  console.log(`🎯 Applied organization to ${changed} goals`);
  return { applied: changed };
}

// =============================================================================
// Goal AI Check-In
// =============================================================================

export async function checkInGoal(goalId, { providerId, model } = {}) {
  const { getActiveProvider, getProviderById } = await import('./providers.js');
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });

  const provider = providerId ? await getProviderById(providerId) : await getActiveProvider();
  if (!provider) throw new ServerError('No AI provider available', { status: 503, code: 'NO_PROVIDER' });
  const selectedModel = model ?? provider.defaultModel;

  const today = new Date().toISOString().slice(0, 10);
  const velocity = computeGoalVelocity(goal);

  // Calculate expected progress based on creation date and target date
  let expectedProgress = null;
  if (goal.targetDate) {
    const created = new Date(goal.createdAt).getTime();
    const target = new Date(goal.targetDate + 'T00:00:00').getTime();
    const now = Date.now();
    const elapsed = now - created;
    const total = target - created;
    expectedProgress = total > 0 ? Math.min(100, Math.round((elapsed / total) * 100)) : 100;
  }

  // Gather activity attendance if linked activities exist
  let attendanceRate = null;
  if (goal.linkedActivities?.length > 0) {
    const totalRequired = goal.linkedActivities.reduce((sum, a) => sum + (a.requiredFrequency || 1), 0);
    const recentEntries = (goal.progressLog || []).filter(e => {
      const daysAgo = (Date.now() - new Date(e.date + 'T00:00:00').getTime()) / (1000 * 60 * 60 * 24);
      return daysAgo <= 30;
    });
    attendanceRate = totalRequired > 0 ? Math.min(100, Math.round((recentEntries.length / (totalRequired * 4)) * 100)) : null;
  }

  const milestoneSummary = (goal.milestones || []).map(m =>
    `- ${m.title}${m.completedAt ? ' (DONE)' : m.targetDate ? ` (due ${m.targetDate})` : ''}`
  ).join('\n');

  const recentProgress = (goal.progressLog || []).slice(-5).map(e =>
    `- ${e.date}: ${e.note}${e.durationMinutes ? ` (${e.durationMinutes}min)` : ''}`
  ).join('\n');

  const prompt = `You are a goal coaching assistant doing a check-in assessment. Analyze the current state of this goal and provide honest, actionable feedback.

Goal: ${goal.title}
Description: ${goal.description || 'No description'}
Category: ${goal.category}
Horizon: ${goal.horizon}
Current progress: ${goal.progress}%${expectedProgress != null ? `\nExpected progress by now: ${expectedProgress}%` : ''}
Target date: ${goal.targetDate || 'None set'}
Created: ${goal.createdAt?.slice(0, 10)}
Today: ${today}${velocity ? `\nVelocity: ${velocity.percentPerMonth}%/month (${velocity.trend})${velocity.projectedCompletion ? `, projected completion: ${velocity.projectedCompletion}` : ''}` : ''}${attendanceRate != null ? `\nActivity attendance (30 days): ${attendanceRate}%` : ''}
${milestoneSummary ? `\nMilestones:\n${milestoneSummary}` : ''}
${recentProgress ? `\nRecent progress entries:\n${recentProgress}` : '\nNo recent progress logged.'}

Respond with JSON only (no markdown fences). The response must be an object with:
- "status": "on-track" | "behind" | "at-risk" — honest assessment of goal health
- "assessment": string — 2-3 sentence assessment of where things stand
- "recommendations": string[] — 2-4 specific, actionable next steps
- "encouragement": string — 1 brief motivational sentence`;

  const result = await callProviderAISimple(provider, selectedModel, prompt, { max_tokens: 1000, temperature: 0.5 });
  if (result.error) throw new ServerError(`AI check-in failed: ${result.error}`, { status: 502, code: 'AI_ERROR' });

  let parsed;
  try {
    parsed = parseLLMJSON(result.text);
  } catch (e) {
    throw new ServerError(`AI returned invalid check-in data: ${e.message}`, { status: 502, code: 'AI_PARSE_ERROR' });
  }

  const validStatuses = ['on-track', 'behind', 'at-risk'];
  const checkIn = {
    id: `ci-${uuidv4()}`,
    date: today,
    status: validStatuses.includes(parsed.status) ? parsed.status : 'behind',
    actualProgress: goal.progress,
    expectedProgress,
    attendanceRate,
    assessment: parsed.assessment || '',
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.slice(0, 5) : [],
    encouragement: parsed.encouragement || '',
    createdAt: new Date().toISOString()
  };

  if (!Array.isArray(goal.checkIns)) goal.checkIns = [];
  goal.checkIns.push(checkIn);
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);

  console.log(`📋 Check-in for "${goal.title}": ${checkIn.status} (${goal.progress}%${expectedProgress != null ? ` vs ${expectedProgress}% expected` : ''})`);
  return checkIn;
}

// =============================================================================
// Goal Progress Percentage
// =============================================================================

export async function updateGoalProgress(goalId, value) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  const prev = goal.progress ?? 0;
  goal.progress = value;
  if (!goal.progressHistory) goal.progressHistory = [];

  // Only log if value changed; deduplicate same-day entries to prevent bloat
  if (prev !== value) {
    const today = new Date().toISOString().slice(0, 10);
    const lastEntry = goal.progressHistory[goal.progressHistory.length - 1];
    if (lastEntry?.date === today) {
      lastEntry.value = value;
      lastEntry.timestamp = new Date().toISOString();
    } else {
      goal.progressHistory.push({ date: today, value, timestamp: new Date().toISOString() });
    }
  }

  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);

  console.log(`📊 Progress for "${goal.title}": ${prev}% → ${value}%`);
  return goal;
}

// =============================================================================
// Goal Velocity & Projection (pure functions)
// =============================================================================

/**
 * Compute velocity (percent/month) and trend from progressHistory.
 * Returns { percentPerMonth, trend, projectedCompletion } or null if insufficient data.
 */
export function computeGoalVelocity(goal) {
  const history = goal.progressHistory;
  if (!history?.length || history.length < 2) return null;

  // Find earliest and latest entries in O(n) instead of sorting
  let first = history[0];
  let last = history[0];
  for (const entry of history) {
    if (entry.date < first.date) first = entry;
    if (entry.date >= last.date) last = entry;
  }

  const daysDiff = (new Date(last.date) - new Date(first.date)) / (1000 * 60 * 60 * 24);
  if (daysDiff < 1) return null;

  const monthsDiff = daysDiff / 30.44;
  const totalChange = last.value - first.value;
  const percentPerMonth = Math.round((totalChange / monthsDiff) * 10) / 10;

  // Trend: compare recent half vs first half velocity using median date
  let trend = 'stable';
  if (history.length >= 4) {
    const midDate = new Date((new Date(first.date).getTime() + new Date(last.date).getTime()) / 2);
    // Find entry closest to midpoint
    let midEntry = first;
    let minDist = Infinity;
    for (const entry of history) {
      const dist = Math.abs(new Date(entry.date) - midDate);
      if (dist < minDist) { minDist = dist; midEntry = entry; }
    }
    const firstHalfDays = (new Date(midEntry.date) - new Date(first.date)) / (1000 * 60 * 60 * 24);
    const secondHalfDays = (new Date(last.date) - new Date(midEntry.date)) / (1000 * 60 * 60 * 24);
    if (firstHalfDays > 0 && secondHalfDays > 0) {
      const firstVel = (midEntry.value - first.value) / firstHalfDays;
      const secondVel = (last.value - midEntry.value) / secondHalfDays;
      if (secondVel > firstVel * 1.2) trend = 'increasing';
      else if (secondVel < firstVel * 0.8) trend = 'decreasing';
    }
  }

  // Projected completion date
  let projectedCompletion = null;
  const remaining = 100 - (goal.progress ?? 0);
  if (percentPerMonth > 0 && remaining > 0) {
    const monthsToGo = remaining / percentPerMonth;
    const projected = new Date();
    projected.setDate(projected.getDate() + Math.round(monthsToGo * 30.44));
    projectedCompletion = projected.toISOString().slice(0, 10);
  }

  return { percentPerMonth, trend, projectedCompletion };
}

/**
 * Compute time tracking stats from progressLog entries.
 * Returns { totalMinutes, weeklyAverage, entriesCount }.
 */
export function computeTimeTracking(goal) {
  const log = goal.progressLog;
  if (!log?.length) return { totalMinutes: 0, weeklyAverage: 0, entriesCount: 0 };

  let totalMinutes = 0;
  let minDate = log[0].date;
  let maxDate = log[0].date;
  for (const e of log) {
    totalMinutes += e.durationMinutes || 0;
    if (e.date < minDate) minDate = e.date;
    if (e.date > maxDate) maxDate = e.date;
  }

  const daySpan = (new Date(maxDate) - new Date(minDate)) / (1000 * 60 * 60 * 24);
  const weeks = Math.max(1, daySpan / 7);
  const weeklyAverage = Math.round(totalMinutes / weeks);

  return { totalMinutes, weeklyAverage, entriesCount: log.length };
}

// =============================================================================
// Goal Todos
// =============================================================================

export async function addTodo(goalId, { title, priority, estimateMinutes }) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  if (!goal.todos) goal.todos = [];

  const todo = {
    id: `todo-${uuidv4()}`,
    title,
    status: 'pending',
    priority: priority || 'medium',
    estimateMinutes: estimateMinutes || null,
    createdAt: new Date().toISOString(),
    completedAt: null
  };

  goal.todos.push(todo);
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);

  console.log(`✅ Todo added to "${goal.title}": "${title}"`);
  return todo;
}

export async function updateTodo(goalId, todoId, updates) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  const todo = (goal.todos || []).find(t => t.id === todoId);
  if (!todo) return null;

  const allowed = ['title', 'status', 'priority', 'estimateMinutes'];
  for (const key of allowed) {
    if (updates[key] !== undefined) todo[key] = updates[key];
  }

  // Auto-set completedAt when marked done
  if (updates.status === 'done' && !todo.completedAt) {
    todo.completedAt = new Date().toISOString();
  } else if (updates.status && updates.status !== 'done') {
    todo.completedAt = null;
  }

  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  return todo;
}

export async function deleteTodo(goalId, todoId) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  const idx = (goal.todos || []).findIndex(t => t.id === todoId);
  if (idx === -1) return null;

  goal.todos.splice(idx, 1);
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  return { deleted: true };
}

// =============================================================================
// CROSS-INSIGHTS ENGINE (P5)
// =============================================================================

const INSIGHT_RULES = [
  {
    id: 'caffeine-chronotype',
    category: 'lifestyle',
    evaluate({ chronotype }) {
      if (!chronotype?.caffeineMarkers || !chronotype?.recommendations?.caffeineCutoff) return null;
      const { cyp1a2, ada } = chronotype.caffeineMarkers;
      if (!cyp1a2 && !ada) return null;

      const markers = [cyp1a2?.rsid, ada?.rsid].filter(Boolean);
      const sources = ['genome', 'chronotype'];
      const isSlowMetabolizer = cyp1a2?.status === 'concern' || ada?.status === 'concern';
      const cutoff = chronotype.recommendations.caffeineCutoff;
      const type = chronotype.type || 'intermediate';

      if (isSlowMetabolizer) {
        return {
          severity: 'warning', title: 'Caffeine Sensitivity', markers, sources,
          text: `Your caffeine metabolism markers suggest slower processing. Combined with your ${type} chronotype, cut caffeine by ${cutoff} to protect sleep quality.`
        };
      }

      return {
        severity: 'info', title: 'Caffeine Timing', markers, sources,
        text: `Your caffeine metabolism is typical. With your ${type} chronotype, a ${cutoff} cutoff keeps caffeine from interfering with your sleep window.`
      };
    }
  },

  {
    id: 'mtnr1b-meal-timing',
    category: 'lifestyle',
    evaluate({ chronotype }) {
      const mtnr1b = chronotype?.geneticMarkers?.mtnr1b;
      if (!mtnr1b || mtnr1b.status === 'not_found') return null;

      const cutoff = chronotype?.recommendations?.lastMealCutoff;
      if (!cutoff || mtnr1b.status !== 'concern') return null;

      return {
        severity: 'warning', title: 'Late Eating Risk',
        text: `Your MTNR1B variant (${mtnr1b.genotype}) impairs nighttime glucose handling. Finish eating by ${cutoff} to avoid metabolic disruption during sleep.`,
        markers: [mtnr1b.rsid], sources: ['genome', 'chronotype']
      };
    }
  },

  {
    id: 'chronotype-deep-work',
    category: 'productivity',
    evaluate({ chronotype }) {
      if (!chronotype?.recommendations?.peakFocusStart) return null;
      const { peakFocusStart, peakFocusEnd } = chronotype.recommendations;
      const type = chronotype.type || 'intermediate';
      const confidence = chronotype.confidence ?? 0;
      if (confidence < 0.3) return null;

      return {
        severity: 'info', title: 'Peak Focus Window',
        text: `Your ${type} chronotype (${Math.round(confidence * 100)}% confidence) suggests peak focus between ${peakFocusStart}–${peakFocusEnd}. Schedule demanding cognitive work in this window.`,
        markers: [], sources: ['chronotype']
      };
    }
  },

  {
    id: 'longevity-overview',
    category: 'health',
    evaluate({ longevity }) {
      if (!longevity?.derivedAt) return null;
      const { lifeExpectancy, confidence } = longevity;
      if (confidence < 0.5) return null;

      const adjustment = (lifeExpectancy?.longevityAdjustment ?? 0) + (lifeExpectancy?.cardiovascularAdjustment ?? 0);
      const direction = adjustment >= 0 ? 'favorable' : 'unfavorable';

      return {
        severity: adjustment >= 0 ? 'success' : 'warning', title: 'Genetic Life Expectancy',
        text: `Your genome markers shift life expectancy by ${adjustment >= 0 ? '+' : ''}${Math.round(adjustment * 10) / 10} years from the ${lifeExpectancy?.baseline ?? 78.5}-year baseline (${direction} overall). Adjusted estimate: ${lifeExpectancy?.adjusted ?? '—'} years.`,
        markers: [], sources: ['genome', 'longevity']
      };
    }
  },

  {
    id: 'inflammation-health-goals',
    category: 'health',
    evaluate({ longevity, goals }) {
      const il6 = longevity?.cardiovascularMarkers?.il6;
      const tnfa = longevity?.cardiovascularMarkers?.tnfa;
      if (!il6 && !tnfa) return null;
      if (il6?.status !== 'concern' && tnfa?.status !== 'concern') return null;

      const healthGoals = (goals?.goals || []).filter(g => g.category === 'health' && g.status === 'active');
      const concernMarkers = [
        il6?.status === 'concern' ? `IL-6 (${il6.genotype})` : null,
        tnfa?.status === 'concern' ? `TNF-alpha (${tnfa.genotype})` : null
      ].filter(Boolean);

      const goalNote = healthGoals.length > 0
        ? `Your ${healthGoals.length} active health goal${healthGoals.length > 1 ? 's' : ''} align${healthGoals.length === 1 ? 's' : ''} with managing this risk.`
        : 'Consider adding health goals focused on anti-inflammatory lifestyle changes.';

      return {
        severity: 'warning', title: 'Inflammation Risk',
        text: `Elevated inflammation markers: ${concernMarkers.join(', ')}. These increase cardiovascular risk over time. ${goalNote}`,
        markers: [il6?.rsid, tnfa?.rsid].filter(Boolean), sources: ['genome', 'longevity', 'goals']
      };
    }
  },

  {
    id: 'longevity-goal-urgency',
    category: 'goals',
    evaluate({ longevity, goals }) {
      if (!longevity?.timeHorizons?.yearsRemaining) return null;
      const activeGoals = (goals?.goals || []).filter(g => g.status === 'active');
      if (!activeGoals.length) return null;

      const { yearsRemaining, percentLifeComplete } = longevity.timeHorizons;
      const horizonYears = { '1-year': 1, '3-year': 3, '5-year': 5, '10-year': 10, 'lifetime': yearsRemaining };
      const atRiskGoals = activeGoals.filter(g => (horizonYears[g.horizon] ?? 999) > yearsRemaining * 0.8);

      if (!atRiskGoals.length) {
        return {
          severity: 'info', title: 'Goal Timeline',
          text: `At ${Math.round(percentLifeComplete)}% life complete with ~${Math.round(yearsRemaining)} years remaining, all ${activeGoals.length} active goals fit within your projected timeline.`,
          markers: [], sources: ['longevity', 'goals']
        };
      }

      return {
        severity: 'warning', title: 'Goal Timeline Pressure',
        text: `At ${Math.round(percentLifeComplete)}% life complete, ${atRiskGoals.length} goal${atRiskGoals.length > 1 ? 's' : ''} may need reprioritization: ${atRiskGoals.map(g => g.title).join(', ')}. ~${Math.round(yearsRemaining)} estimated years remaining.`,
        markers: [], sources: ['longevity', 'goals']
      };
    }
  },

  {
    id: 'foxo3a-longevity',
    category: 'health',
    evaluate({ longevity }) {
      const foxo3a = longevity?.longevityMarkers?.foxo3a;
      if (!foxo3a || foxo3a.status !== 'concern') return null;

      return {
        severity: 'warning', title: 'FOXO3A Longevity Variant',
        text: `Your FOXO3A variant (${foxo3a.genotype}) is associated with reduced longevity. FOXO3A regulates stress resistance and cellular repair. Caloric moderation, exercise, and stress management can help activate compensatory pathways.`,
        markers: [foxo3a.rsid], sources: ['genome', 'longevity']
      };
    }
  },

  {
    id: 'terc-telomere',
    category: 'health',
    evaluate({ longevity }) {
      const terc = longevity?.longevityMarkers?.terc;
      if (!terc || terc.status !== 'concern') return null;

      return {
        severity: 'warning', title: 'Telomere Length',
        text: `Your TERC variant (${terc.genotype}) is linked to shorter telomere length, a marker of cellular aging. Regular aerobic exercise and stress reduction are associated with slower telomere attrition.`,
        markers: [terc.rsid], sources: ['genome', 'longevity']
      };
    }
  },

  {
    id: 'cardiovascular-protection',
    category: 'health',
    evaluate({ longevity }) {
      if (!longevity?.cardiovascularMarkers) return null;
      const markers = Object.values(longevity.cardiovascularMarkers);
      const beneficial = markers.filter(m => m.status === 'beneficial');
      if (beneficial.length < 2) return null;

      return {
        severity: 'success', title: 'Cardiovascular Protection',
        text: `${beneficial.length} of ${markers.length} cardiovascular markers show protective variants: ${beneficial.map(m => m.gene).join(', ')}. This provides a favorable baseline for heart health.`,
        markers: beneficial.map(m => m.rsid), sources: ['genome', 'longevity']
      };
    }
  }
];

export async function getCrossInsights() {
  const [chronotype, longevity, goalsData] = await Promise.all([
    loadJSON(CHRONOTYPE_FILE, DEFAULT_CHRONOTYPE),
    loadJSON(LONGEVITY_FILE, DEFAULT_LONGEVITY),
    loadJSON(GOALS_FILE, DEFAULT_GOALS)
  ]);

  const context = { chronotype, longevity, goals: goalsData };

  // Rules return partial objects; engine injects id/category from rule definition
  const insights = INSIGHT_RULES
    .map(rule => {
      const result = rule.evaluate(context);
      return result ? { id: rule.id, category: rule.category, ...result } : null;
    })
    .filter(Boolean);

  console.log(`🔮 Cross-insights generated: ${insights.length} insights from ${INSIGHT_RULES.length} rules`);

  return {
    insights,
    generatedAt: new Date().toISOString(),
    dataSources: {
      chronotype: !!chronotype?.derivedAt,
      longevity: !!longevity?.derivedAt,
      goals: (goalsData?.goals || []).length > 0
    }
  };
}

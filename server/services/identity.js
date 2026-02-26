import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { PATHS, ensureDir, safeJSONParse } from '../lib/fileUtils.js';
import { getGenomeSummary } from './genome.js';
import { getTasteProfile } from './taste-questionnaire.js';

const IDENTITY_DIR = PATHS.digitalTwin;
const IDENTITY_FILE = join(IDENTITY_DIR, 'identity.json');
const CHRONOTYPE_FILE = join(IDENTITY_DIR, 'chronotype.json');

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

// === Default Data Structures ===

const DEFAULT_IDENTITY = {
  sections: {
    genome: { status: 'unavailable', label: 'Genome', updatedAt: null },
    chronotype: { status: 'unavailable', label: 'Chronotype', updatedAt: null },
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

  // Goals status — check if GOALS.md exists
  const goalsPath = join(PATHS.root, 'GOALS.md');
  const goalsExist = await readFile(goalsPath, 'utf-8').catch(() => null);
  identity.sections.goals = {
    status: goalsExist ? 'active' : 'unavailable',
    label: 'Goals',
    updatedAt: goalsExist ? new Date().toISOString() : null
  };

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

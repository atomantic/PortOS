import { join } from 'path';
import { atomicWrite, PATHS, ensureDir, safeJSONParse, tryReadFile } from '../../lib/fileUtils.js';
import { isMortalLoomEnabled, mlArrayIfEnabled, mlReplace } from '../mortalLoomStore.js';

// === Goal normalization defaults ===

export const PORTOS_GOAL_DEFAULTS = {
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

export const normalizeGoal = g => ({ ...PORTOS_GOAL_DEFAULTS, ...g });

// === File paths ===

export const IDENTITY_DIR = PATHS.digitalTwin;
export const IDENTITY_FILE = join(IDENTITY_DIR, 'identity.json');
export const CHRONOTYPE_FILE = join(IDENTITY_DIR, 'chronotype.json');
export const LONGEVITY_FILE = join(IDENTITY_DIR, 'longevity.json');
export const GOALS_FILE = join(IDENTITY_DIR, 'goals.json');

// === Default Data Structures ===

// US Social Security Administration actuarial baseline by decade (average M/F)
export const SSA_BASELINE_LIFE_EXPECTANCY = 78.5;

export const DEFAULT_IDENTITY = {
  sections: {
    genome: { status: 'unavailable', label: 'Genome', updatedAt: null },
    chronotype: { status: 'unavailable', label: 'Chronotype', updatedAt: null },
    longevity: { status: 'unavailable', label: 'Longevity', updatedAt: null },
    aesthetics: { status: 'unavailable', label: 'Aesthetics', updatedAt: null },
    goals: { status: 'unavailable', label: 'Goals', updatedAt: null }
  },
  updatedAt: null
};

export const DEFAULT_CHRONOTYPE = {
  type: 'intermediate',
  confidence: 0,
  geneticMarkers: {},
  caffeineMarkers: {},
  behavioralData: null,
  recommendations: null,
  derivedAt: null
};

export const DEFAULT_LONGEVITY = {
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

export const DEFAULT_GOALS = {
  birthDate: null,
  lifeExpectancy: null,
  timeHorizons: null,
  goals: [],
  updatedAt: null
};

// === File I/O ===

export async function ensureIdentityDir() {
  await ensureDir(IDENTITY_DIR);
}

export async function loadJSON(filePath, defaultVal) {
  const raw = await tryReadFile(filePath);
  const data = raw ? safeJSONParse(raw, structuredClone(defaultVal)) : structuredClone(defaultVal);
  // When MortalLoom iCloud sync is enabled, the goals array is sourced from
  // MortalLoom.json; birthDate and lifeExpectancy metadata stay in local PortOS.
  if (filePath === GOALS_FILE) {
    const mlGoals = await mlArrayIfEnabled('goals');
    if (mlGoals) data.goals = mlGoals.map(normalizeGoal);
  }
  return data;
}

export async function saveJSON(filePath, data) {
  await ensureIdentityDir();
  await atomicWrite(filePath, data);
  // Mirror goals array into MortalLoom.json so iOS/macOS app sees the change.
  if (filePath === GOALS_FILE && (await isMortalLoomEnabled()) && Array.isArray(data.goals)) {
    await mlReplace('goals', data.goals);
  }
}

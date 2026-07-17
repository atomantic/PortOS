import { join } from 'path';
import { atomicWrite, PATHS, ensureDir, readJSONFileStrict } from '../../lib/fileUtils.js';
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

/**
 * @param {string} filePath
 * @param {*} defaultVal
 * @param {{ strict?: boolean }} [options] - `strict: true` throws when `filePath`
 *   exists but can't be read or parsed, instead of silently returning `defaultVal`.
 *   Off by default so every existing caller keeps the fallback. Callers that COUNT
 *   what they load opt in, so an unreadable file can't report as an empty one
 *   (#2726). A genuinely absent file (never written) still returns `defaultVal`
 *   under strict — that IS a trustworthy empty.
 */
export async function loadJSON(filePath, defaultVal, { strict = false } = {}) {
  // `readJSONFileStrict` rather than tryReadFile+safeJSONParse: both of those
  // swallow, so together they can't tell "no goals yet" from "goals.json is
  // corrupt" — and this is the read the Strategist skill counts. Passing `null` as
  // its default (rather than `defaultVal`) keeps "the file gave us nothing" legible
  // here: a parsed file can never BE null (bare `null` fails validation), so `value`
  // is null exactly when the file was absent, unreadable, or corrupt.
  const { ok, value } = await readJSONFileStrict(filePath, null);
  const data = value ?? structuredClone(defaultVal);
  // When MortalLoom iCloud sync is enabled, the goals array is sourced from
  // MortalLoom.json; birthDate and lifeExpectancy metadata stay in local PortOS.
  let mlGoals = null;
  if (filePath === GOALS_FILE) {
    mlGoals = await mlArrayIfEnabled('goals');
    if (mlGoals) data.goals = mlGoals.map(normalizeGoal);
  }
  // Strictness gates on the source that actually supplies the counted array, which
  // is why this sits AFTER the MortalLoom probe. On an ML-backed install the local
  // file contributes only birthDate/lifeExpectancy metadata — failing to read it
  // costs no goals, so reporting Strategist "unavailable" off it would be a lie in
  // the opposite direction: the goals were right there and readable.
  if (strict && !ok && !mlGoals) {
    throw new Error(`Unreadable identity file: ${filePath}`);
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

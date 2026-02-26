/**
 * MeatSpace Core Service
 *
 * Config CRUD, sex detection from genome, death clock computation,
 * and LEV 2045 tracker. Reads genome/longevity data from Digital Twin.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { PATHS, ensureDir, readJSONFile } from '../lib/fileUtils.js';
import { getSnpIndex } from './genome.js';

const MEATSPACE_DIR = PATHS.meatspace;
const CONFIG_FILE = join(MEATSPACE_DIR, 'config.json');
const DAILY_LOG_FILE = join(MEATSPACE_DIR, 'daily-log.json');

// Digital Twin paths (read-only)
const LONGEVITY_FILE = join(PATHS.digitalTwin, 'longevity.json');
const GOALS_FILE = join(PATHS.digitalTwin, 'goals.json');

const SSA_BASELINE = 78.5;

const DEFAULT_CONFIG = {
  sex: null,
  sexSource: null,
  lifestyle: {
    smokingStatus: 'never',
    exerciseMinutesPerWeek: 150,
    sleepHoursPerNight: 7.5,
    dietQuality: 'good',
    stressLevel: 'moderate',
    bmi: null,
    chronicConditions: []
  },
  updatedAt: null
};

const LEV_TARGET_YEAR = 2045;
const LEV_START_YEAR = 2000;

// === File I/O ===

async function ensureMeatspaceDir() {
  await ensureDir(MEATSPACE_DIR);
}

async function loadConfig() {
  return readJSONFile(CONFIG_FILE, structuredClone(DEFAULT_CONFIG));
}

async function saveConfig(config) {
  await ensureMeatspaceDir();
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// === Sex Detection ===

export async function detectSexFromGenome() {
  const index = await getSnpIndex();
  if (!index) return null;

  let yCount = 0;
  for (const [, snp] of index) {
    if (snp.chromosome === 'Y') yCount++;
  }
  return yCount > 1000 ? 'male' : 'female';
}

// === Lifestyle Adjustments (Pure) ===

export function computeLifestyleAdjustment(lifestyle) {
  if (!lifestyle) return 0;

  let adj = 0;

  // Smoking
  const smoking = lifestyle.smokingStatus || 'never';
  if (smoking === 'never') adj += 0;
  else if (smoking === 'former') adj -= 2;
  else if (smoking === 'current') adj -= 10;

  // Alcohol (from daily average or questionnaire)
  const drinks = lifestyle.alcoholDrinksPerDay;
  if (drinks != null) {
    if (drinks <= 2) adj += 0.5;
    else if (drinks > 3) adj -= 5;
  }

  // Exercise
  const exercise = lifestyle.exerciseMinutesPerWeek ?? 150;
  if (exercise > 150) adj += 2;
  else if (exercise >= 75) adj += 0.5;
  else adj -= 2;

  // Sleep
  const sleep = lifestyle.sleepHoursPerNight ?? 7.5;
  if (sleep >= 7 && sleep <= 9) adj += 1;
  else if (sleep >= 6 && sleep < 7) adj += 0;
  else adj -= 1.5;

  // Diet
  const diet = lifestyle.dietQuality || 'good';
  if (diet === 'excellent') adj += 2;
  else if (diet === 'good') adj += 0.5;
  else if (diet === 'fair') adj += 0;
  else adj -= 3;

  // Stress
  const stress = lifestyle.stressLevel || 'moderate';
  if (stress === 'low') adj += 1;
  else if (stress === 'moderate') adj += 0;
  else adj -= 2;

  // BMI
  const bmi = lifestyle.bmi;
  if (bmi != null) {
    if (bmi >= 18.5 && bmi < 25) adj += 0.5;
    else if (bmi >= 25 && bmi < 30) adj -= 0.5;
    else if (bmi >= 30) adj -= 3;
  }

  return Math.round(adj * 100) / 100;
}

// === Death Clock ===

export function computeDeathClock(birthDate, genomeAdjustedLE, lifestyleAdj) {
  const baseline = genomeAdjustedLE ?? SSA_BASELINE;
  const totalLE = baseline + lifestyleAdj;

  const birth = new Date(birthDate);
  const deathDate = new Date(birth);
  deathDate.setFullYear(deathDate.getFullYear() + Math.floor(totalLE));
  deathDate.setMonth(deathDate.getMonth() + Math.round((totalLE % 1) * 12));

  const now = new Date();
  const msRemaining = deathDate.getTime() - now.getTime();
  const ageYears = (now - birth) / (365.25 * 24 * 60 * 60 * 1000);
  const yearsRemaining = Math.max(0, totalLE - ageYears);
  const healthyYearsRemaining = Math.round(yearsRemaining * 0.85 * 10) / 10;
  const percentComplete = Math.min(100, Math.round((ageYears / totalLE) * 1000) / 10);

  return {
    birthDate,
    deathDate: deathDate.toISOString(),
    msRemaining: Math.max(0, msRemaining),
    lifeExpectancy: {
      baseline: SSA_BASELINE,
      genomeAdjusted: genomeAdjustedLE ?? SSA_BASELINE,
      lifestyleAdjustment: lifestyleAdj,
      total: Math.round(totalLE * 10) / 10
    },
    ageYears: Math.round(ageYears * 100) / 100,
    yearsRemaining: Math.round(yearsRemaining * 100) / 100,
    healthyYearsRemaining,
    percentComplete
  };
}

// === LEV Tracker ===

export function computeLEV(birthDate, adjustedLE) {
  const birthYear = new Date(birthDate).getFullYear();
  const now = new Date();
  const currentYear = now.getFullYear() + now.getMonth() / 12;
  const ageAtLEV = LEV_TARGET_YEAR - birthYear;
  const yearsToLEV = LEV_TARGET_YEAR - currentYear;
  const researchProgress = Math.round(((currentYear - LEV_START_YEAR) / (LEV_TARGET_YEAR - LEV_START_YEAR)) * 1000) / 10;
  const onTrack = adjustedLE > ageAtLEV;

  return {
    targetYear: LEV_TARGET_YEAR,
    ageAtLEV,
    yearsToLEV: Math.round(yearsToLEV * 10) / 10,
    researchProgress: Math.min(100, researchProgress),
    onTrack,
    adjustedLifeExpectancy: adjustedLE
  };
}

// === Exported Service Functions ===

export async function getConfig() {
  const config = await loadConfig();

  // Auto-detect sex from genome if not set
  if (!config.sex) {
    const detectedSex = await detectSexFromGenome();
    if (detectedSex) {
      config.sex = detectedSex;
      config.sexSource = 'genome';
      config.updatedAt = new Date().toISOString();
      await saveConfig(config);
      console.log(`🧬 Sex auto-detected from genome: ${detectedSex}`);
    }
  }

  return config;
}

export async function updateConfig(updates) {
  const config = await loadConfig();
  if (updates.sex !== undefined) config.sex = updates.sex;
  if (updates.sexSource !== undefined) config.sexSource = updates.sexSource;
  if (updates.lifestyle) {
    config.lifestyle = { ...config.lifestyle, ...updates.lifestyle };
  }
  config.updatedAt = new Date().toISOString();
  await saveConfig(config);
  return config;
}

export async function updateLifestyle(updates) {
  const config = await loadConfig();
  config.lifestyle = { ...config.lifestyle, ...updates };
  config.updatedAt = new Date().toISOString();
  await saveConfig(config);
  return config;
}

export async function getDeathClock() {
  const [config, longevity, goals] = await Promise.all([
    loadConfig(),
    readJSONFile(LONGEVITY_FILE, null),
    readJSONFile(GOALS_FILE, null)
  ]);

  const birthDate = goals?.birthDate;
  if (!birthDate) {
    return { error: 'Birth date not set. Set it in Digital Twin > Goals.' };
  }

  const genomeAdjusted = longevity?.lifeExpectancy?.adjusted ?? null;
  const lifestyleAdj = computeLifestyleAdjustment(config.lifestyle);

  return computeDeathClock(birthDate, genomeAdjusted, lifestyleAdj);
}

export async function getLEV() {
  const [longevity, goals, config] = await Promise.all([
    readJSONFile(LONGEVITY_FILE, null),
    readJSONFile(GOALS_FILE, null),
    loadConfig()
  ]);

  const genomeAdjusted = longevity?.lifeExpectancy?.adjusted ?? SSA_BASELINE;
  const lifestyleAdj = computeLifestyleAdjustment(config.lifestyle);
  const totalLE = genomeAdjusted + lifestyleAdj;

  return computeLEV(goals?.birthDate, totalLE);
}

export async function getOverview() {
  const [config, deathClock, lev, dailyLog] = await Promise.all([
    getConfig(),
    getDeathClock(),
    getLEV(),
    readJSONFile(DAILY_LOG_FILE, { entries: [] })
  ]);

  const entryCount = dailyLog.entries?.length || 0;
  const lastEntry = dailyLog.entries?.[entryCount - 1] || null;

  return {
    config,
    deathClock,
    lev,
    summary: {
      totalEntries: entryCount,
      lastEntryDate: lastEntry?.date || null,
      hasGenomeData: deathClock.lifeExpectancy?.genomeAdjusted !== SSA_BASELINE,
      hasLifestyleData: !!config.lifestyle?.smokingStatus
    }
  };
}

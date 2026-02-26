/**
 * MeatSpace Alcohol Service
 *
 * Drink logging, standard drink calculation, and rolling averages.
 * Reads/writes daily-log.json entries for alcohol data.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { PATHS, ensureDir, readJSONFile } from '../lib/fileUtils.js';

const MEATSPACE_DIR = PATHS.meatspace;
const DAILY_LOG_FILE = join(MEATSPACE_DIR, 'daily-log.json');
const CONFIG_FILE = join(MEATSPACE_DIR, 'config.json');

// Cache for rolling averages (invalidated on writes)
let averageCache = null;
let averageCacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// === Pure Functions ===

// 1 standard drink = 0.6 oz pure alcohol = ~14g pure alcohol
export const GRAMS_PER_STD_DRINK = 14;

/**
 * Calculate standard drinks from oz and ABV.
 * 1 standard drink = 0.6 oz pure alcohol.
 */
export function computeStandardDrinks(oz, abv) {
  const pureAlcoholOz = oz * (abv / 100);
  return Math.round((pureAlcoholOz / 0.6) * 100) / 100;
}

/**
 * Convert standard drinks to grams of pure alcohol.
 */
export function drinksToGrams(standardDrinks) {
  return Math.round(standardDrinks * GRAMS_PER_STD_DRINK * 100) / 100;
}

/**
 * Compute rolling averages from daily entries.
 */
export function computeRollingAverages(entries, sex = 'male') {
  const now = new Date();
  const today = now.toISOString().split('T')[0];

  // Filter entries with alcohol data, sorted by date
  const alcoholEntries = entries
    .filter(e => e.alcohol?.standardDrinks > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const allEntries = entries.sort((a, b) => a.date.localeCompare(b.date));

  // Today's total
  const todayEntry = allEntries.find(e => e.date === today);
  const todayDrinks = todayEntry?.alcohol?.standardDrinks || 0;

  // Helper: average over last N days (including zero-drink days)
  const rollingAverage = (days) => {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    let totalDrinks = 0;
    let dayCount = 0;

    for (const entry of allEntries) {
      if (entry.date >= cutoffStr && entry.date <= today) {
        totalDrinks += entry.alcohol?.standardDrinks || 0;
        dayCount++;
      }
    }

    // Use actual calendar days for denominator, not just entries
    return dayCount > 0 ? Math.round((totalDrinks / days) * 100) / 100 : 0;
  };

  // All-time average
  let allTimeAvg = 0;
  if (allEntries.length > 0) {
    const firstDate = new Date(allEntries[0].date);
    const totalDays = Math.max(1, Math.ceil((now - firstDate) / (24 * 60 * 60 * 1000)));
    const totalDrinks = allEntries.reduce((sum, e) => sum + (e.alcohol?.standardDrinks || 0), 0);
    allTimeAvg = Math.round((totalDrinks / totalDays) * 100) / 100;
  }

  // NIAAA thresholds (drinks) + longevity thresholds (grams)
  const thresholds = sex === 'female'
    ? { dailyMax: 1, weeklyMax: 7 }
    : { dailyMax: 2, weeklyMax: 14 };
  const gramThresholds = { dailyTarget: 10, dailyDanger: 40 };

  const avg7day = rollingAverage(7);
  const avg30day = rollingAverage(30);
  const weeklyTotal = Math.round(avg7day * 7 * 100) / 100;

  return {
    today: todayDrinks,
    avg7day,
    avg30day,
    allTimeAvg,
    weeklyTotal,
    thresholds,
    gramThresholds,
    grams: {
      today: drinksToGrams(todayDrinks),
      avg7day: drinksToGrams(avg7day),
      avg30day: drinksToGrams(avg30day),
      allTimeAvg: drinksToGrams(allTimeAvg),
      weeklyTotal: drinksToGrams(weeklyTotal)
    },
    riskLevel: weeklyTotal > thresholds.weeklyMax ? 'high'
      : weeklyTotal > thresholds.weeklyMax * 0.7 ? 'moderate'
      : 'low',
    drinkingDays: alcoholEntries.length,
    totalEntries: allEntries.length
  };
}

// === File I/O ===

async function loadDailyLog() {
  return readJSONFile(DAILY_LOG_FILE, { entries: [], lastEntryDate: null });
}

async function saveDailyLog(log) {
  await ensureDir(MEATSPACE_DIR);
  await writeFile(DAILY_LOG_FILE, JSON.stringify(log, null, 2));
  averageCache = null; // Invalidate cache
}

// === Exported Service Functions ===

export async function getAlcoholSummary() {
  const now = Date.now();
  if (averageCache && (now - averageCacheAt < CACHE_TTL_MS)) {
    return averageCache;
  }

  const [log, config] = await Promise.all([
    loadDailyLog(),
    readJSONFile(CONFIG_FILE, { sex: 'male' })
  ]);

  const averages = computeRollingAverages(log.entries || [], config.sex || 'male');

  // Recent drinks (last 7 days)
  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = weekAgo.toISOString().split('T')[0];

  const recentEntries = (log.entries || [])
    .filter(e => e.date >= weekAgoStr && e.date <= today && e.alcohol?.drinks?.length > 0)
    .sort((a, b) => b.date.localeCompare(a.date)); // Newest first

  averageCache = { ...averages, recentEntries };
  averageCacheAt = now;

  return averageCache;
}

export async function getDailyAlcohol(from, to) {
  const log = await loadDailyLog();
  let entries = (log.entries || []).filter(e => e.alcohol?.drinks?.length > 0);

  if (from) entries = entries.filter(e => e.date >= from);
  if (to) entries = entries.filter(e => e.date <= to);

  return entries.sort((a, b) => b.date.localeCompare(a.date));
}

export async function logDrink({ name, oz, abv, count = 1, date }) {
  const log = await loadDailyLog();
  const targetDate = date || new Date().toISOString().split('T')[0];

  const standardDrinks = computeStandardDrinks(oz * count, abv);
  const drink = { name: name || '', abv, oz, count };

  // Find or create daily entry
  let entry = log.entries.find(e => e.date === targetDate);
  if (!entry) {
    entry = { date: targetDate };
    log.entries.push(entry);
  }

  // Initialize alcohol section
  if (!entry.alcohol) {
    entry.alcohol = { drinks: [], standardDrinks: 0 };
  }

  entry.alcohol.drinks.push(drink);

  // Recalculate total standard drinks for the day
  entry.alcohol.standardDrinks = entry.alcohol.drinks.reduce((sum, d) => {
    return sum + computeStandardDrinks((d.oz || 0) * (d.count || 1), d.abv || 0);
  }, 0);
  entry.alcohol.standardDrinks = Math.round(entry.alcohol.standardDrinks * 100) / 100;

  // Re-sort and update lastEntryDate
  log.entries.sort((a, b) => a.date.localeCompare(b.date));
  log.lastEntryDate = log.entries[log.entries.length - 1].date;

  await saveDailyLog(log);
  console.log(`🍺 Logged drink: ${name || 'unnamed'} ${oz}oz @ ${abv}% (${standardDrinks} std drinks) on ${targetDate}`);

  return { drink, standardDrinks, date: targetDate, dayTotal: entry.alcohol.standardDrinks };
}

export async function updateDrink(date, index, updates) {
  const log = await loadDailyLog();
  const entry = log.entries.find(e => e.date === date);
  if (!entry?.alcohol?.drinks?.[index]) return null;

  const drink = entry.alcohol.drinks[index];
  if (updates.name !== undefined) drink.name = updates.name;
  if (updates.oz !== undefined) drink.oz = updates.oz;
  if (updates.abv !== undefined) drink.abv = updates.abv;
  if (updates.count !== undefined) drink.count = updates.count;

  // Recalculate total
  entry.alcohol.standardDrinks = entry.alcohol.drinks.reduce((sum, d) => {
    return sum + computeStandardDrinks((d.oz || 0) * (d.count || 1), d.abv || 0);
  }, 0);
  entry.alcohol.standardDrinks = Math.round(entry.alcohol.standardDrinks * 100) / 100;

  await saveDailyLog(log);
  console.log(`📝 Updated drink on ${date}[${index}]: ${drink.name || 'unnamed'} ${drink.oz}oz @ ${drink.abv}%`);
  return { drink, dayTotal: entry.alcohol.standardDrinks };
}

export async function removeDrink(date, index) {
  const log = await loadDailyLog();
  const entry = log.entries.find(e => e.date === date);
  if (!entry?.alcohol?.drinks?.[index]) return null;

  const removed = entry.alcohol.drinks.splice(index, 1)[0];

  // Recalculate total
  entry.alcohol.standardDrinks = entry.alcohol.drinks.reduce((sum, d) => {
    return sum + computeStandardDrinks((d.oz || 0) * (d.count || 1), d.abv || 0);
  }, 0);
  entry.alcohol.standardDrinks = Math.round(entry.alcohol.standardDrinks * 100) / 100;

  // Remove alcohol section if empty
  if (entry.alcohol.drinks.length === 0) {
    delete entry.alcohol;
  }

  await saveDailyLog(log);
  return removed;
}

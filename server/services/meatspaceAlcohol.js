/**
 * MeatSpace Alcohol Service
 *
 * Drink logging, standard drink calculation, and rolling averages.
 * Reads/writes daily-log.json entries for alcohol data.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { PATHS, ensureDir, readJSONFile, getDateString } from '../lib/fileUtils.js';
import {
  isMortalLoomEnabled,
  readDailyLogIfEnabled,
  mlPush,
  mlPatchById,
  mlRemoveById,
  mlIdAtDateIndex
} from './mortalLoomStore.js';

const MEATSPACE_DIR = PATHS.meatspace;
const DAILY_LOG_FILE = join(MEATSPACE_DIR, 'daily-log.json');
const CONFIG_FILE = join(MEATSPACE_DIR, 'config.json');
const CUSTOM_DRINKS_FILE = join(MEATSPACE_DIR, 'custom-drinks.json');

const DEFAULT_DRINK_BUTTONS = [
  { name: 'Modelo Especial (12oz)', oz: 12, abv: 4.4 },
  { name: 'Nitro Guinness (14.9oz)', oz: 14.9, abv: 4.2 },
  { name: 'Old Fashioned (2oz)', oz: 2, abv: 40 },
  { name: 'Guinness 0 (14.9oz)', oz: 14.9, abv: 0.4 },
  { name: 'N/A Beer (12oz)', oz: 12, abv: 0.4 }
];

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
  const today = getDateString(now);

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
    const cutoffStr = getDateString(cutoff);

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
  const gramThresholds = { dailyTarget: 10, dailyDanger: 40, weeklyMax: drinksToGrams(thresholds.weeklyMax) };

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
  const ml = await readDailyLogIfEnabled();
  if (ml) return ml;
  const raw = await readJSONFile(DAILY_LOG_FILE, { entries: [], lastEntryDate: null }, { allowArray: false });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { entries: [], lastEntryDate: null };
  if (!Array.isArray(raw.entries)) raw.entries = [];
  return raw;
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
  const today = getDateString();
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = getDateString(weekAgo);

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
  const targetDate = date || getDateString();
  const standardDrinks = computeStandardDrinks(oz * count, abv);
  const drink = { name: name || '', abv, oz, count };

  if (await isMortalLoomEnabled()) {
    await mlPush('alcoholDrinks', { ...drink, date: targetDate });
    averageCache = null;
    const log = await loadDailyLog();
    const entry = log.entries.find(e => e.date === targetDate);
    console.log(`🍺 Logged drink (MortalLoom): ${name || 'unnamed'} ${oz}oz @ ${abv}% (${standardDrinks} std) on ${targetDate}`);
    return { drink, standardDrinks, date: targetDate, dayTotal: entry?.alcohol?.standardDrinks || standardDrinks };
  }

  const log = await loadDailyLog();
  let entry = log.entries.find(e => e.date === targetDate);
  if (!entry) { entry = { date: targetDate }; log.entries.push(entry); }
  if (!entry.alcohol) entry.alcohol = { drinks: [], standardDrinks: 0 };

  const existing = entry.alcohol.drinks.find(d => d.name === drink.name && d.oz === drink.oz && d.abv === drink.abv);
  if (existing) existing.count = (existing.count || 1) + count;
  else entry.alcohol.drinks.push(drink);

  recalcAlcoholTotal(entry);
  log.entries.sort((a, b) => a.date.localeCompare(b.date));
  log.lastEntryDate = log.entries.at(-1).date;
  await saveDailyLog(log);
  console.log(`🍺 Logged drink: ${name || 'unnamed'} ${oz}oz @ ${abv}% (${standardDrinks} std) on ${targetDate}`);
  return { drink, standardDrinks, date: targetDate, dayTotal: entry.alcohol.standardDrinks };
}

function recalcAlcoholTotal(entry) {
  entry.alcohol.standardDrinks = entry.alcohol.drinks.reduce((sum, d) => {
    return sum + computeStandardDrinks((d.oz || 0) * (d.count || 1), d.abv || 0);
  }, 0);
  entry.alcohol.standardDrinks = Math.round(entry.alcohol.standardDrinks * 100) / 100;
}

export async function updateDrink(date, index, updates) {
  if (await isMortalLoomEnabled()) {
    const id = await mlIdAtDateIndex('alcoholDrinks', date, index);
    if (!id) return null;
    const patch = {};
    for (const k of ['name', 'oz', 'abv', 'count', 'date']) {
      if (updates[k] !== undefined) patch[k] = updates[k];
    }
    const updated = await mlPatchById('alcoholDrinks', id, patch);
    averageCache = null;
    const effectiveDate = updated?.date || date;
    const log = await loadDailyLog();
    const entry = log.entries.find(e => e.date === effectiveDate);
    console.log(`📝 Updated drink (MortalLoom) ${date}[${index}] → ${effectiveDate}: ${updated?.name}`);
    return { drink: { name: updated.name, oz: updated.oz, abv: updated.abv, count: updated.count },
             dayTotal: entry?.alcohol?.standardDrinks || 0,
             date: effectiveDate };
  }

  const log = await loadDailyLog();
  const entry = log.entries.find(e => e.date === date);
  if (!entry?.alcohol?.drinks?.[index]) return null;

  const drink = entry.alcohol.drinks[index];
  if (updates.name !== undefined) drink.name = updates.name;
  if (updates.oz !== undefined) drink.oz = updates.oz;
  if (updates.abv !== undefined) drink.abv = updates.abv;
  if (updates.count !== undefined) drink.count = updates.count;

  // Move to different date if requested
  const newDate = updates.date;
  if (newDate && newDate !== date) {
    entry.alcohol.drinks.splice(index, 1);
    if (entry.alcohol.drinks.length === 0) {
      delete entry.alcohol;
      // Remove entry entirely if no other data keys remain
      if (Object.keys(entry).length <= 1) {
        log.entries = log.entries.filter(e => e !== entry);
      }
    } else {
      recalcAlcoholTotal(entry);
    }

    let targetEntry = log.entries.find(e => e.date === newDate);
    if (!targetEntry) {
      targetEntry = { date: newDate };
      log.entries.push(targetEntry);
    }
    if (!targetEntry.alcohol) targetEntry.alcohol = { drinks: [], standardDrinks: 0 };
    targetEntry.alcohol.drinks.push(drink);
    recalcAlcoholTotal(targetEntry);

    log.entries.sort((a, b) => a.date.localeCompare(b.date));
    log.lastEntryDate = log.entries[log.entries.length - 1].date;

    await saveDailyLog(log);
    console.log(`📝 Moved drink from ${date}[${index}] to ${newDate}: ${drink.name || 'unnamed'} ${drink.oz}oz @ ${drink.abv}%`);
    return { drink, dayTotal: targetEntry.alcohol.standardDrinks, date: newDate };
  }

  recalcAlcoholTotal(entry);

  await saveDailyLog(log);
  console.log(`📝 Updated drink on ${date}[${index}]: ${drink.name || 'unnamed'} ${drink.oz}oz @ ${drink.abv}%`);
  return { drink, dayTotal: entry.alcohol.standardDrinks };
}

export async function removeDrink(date, index) {
  if (await isMortalLoomEnabled()) {
    const id = await mlIdAtDateIndex('alcoholDrinks', date, index);
    if (!id) return null;
    const removed = await mlRemoveById('alcoholDrinks', id);
    averageCache = null;
    return removed;
  }

  const log = await loadDailyLog();
  const entry = log.entries.find(e => e.date === date);
  if (!entry?.alcohol?.drinks?.[index]) return null;

  const removed = entry.alcohol.drinks.splice(index, 1)[0];
  if (entry.alcohol.drinks.length === 0) delete entry.alcohol;
  else recalcAlcoholTotal(entry);
  await saveDailyLog(log);
  return removed;
}

// === Custom Drink Buttons ===

async function loadCustomDrinks() {
  const data = await readJSONFile(CUSTOM_DRINKS_FILE, null, { allowArray: false });
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    // Return defaults in-memory without writing — persist only on explicit mutations
    return { drinks: DEFAULT_DRINK_BUTTONS.map(d => ({ ...d })) };
  }
  if (!Array.isArray(data.drinks)) data.drinks = [];
  return data;
}

async function saveCustomDrinks(data) {
  await ensureDir(MEATSPACE_DIR);
  await writeFile(CUSTOM_DRINKS_FILE, JSON.stringify(data, null, 2));
}

export async function getCustomDrinks() {
  const data = await loadCustomDrinks();
  return data.drinks || [];
}

export async function addCustomDrink({ name, oz, abv }) {
  const data = await loadCustomDrinks();
  const drink = { name, oz, abv };
  data.drinks.push(drink);
  await saveCustomDrinks(data);
  console.log(`🍺 Added custom drink button: ${name} ${oz}oz @ ${abv}%`);
  return drink;
}

export async function updateCustomDrink(index, updates) {
  if (!Number.isInteger(index)) return null;
  const data = await loadCustomDrinks();
  if (index < 0 || index >= data.drinks.length) return null;
  const drink = data.drinks[index];
  if (updates.name !== undefined) drink.name = updates.name;
  if (updates.oz !== undefined) drink.oz = updates.oz;
  if (updates.abv !== undefined) drink.abv = updates.abv;
  await saveCustomDrinks(data);
  console.log(`📝 Updated custom drink button [${index}]: ${drink.name}`);
  return drink;
}

export async function removeCustomDrink(index) {
  if (!Number.isInteger(index)) return null;
  const data = await loadCustomDrinks();
  if (index < 0 || index >= data.drinks.length) return null;
  const removed = data.drinks.splice(index, 1)[0];
  await saveCustomDrinks(data);
  console.log(`🗑️ Removed custom drink button: ${removed.name}`);
  return removed;
}

export async function reorderCustomDrinks(fromIndex, toIndex) {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return null;
  const data = await loadCustomDrinks();
  if (fromIndex < 0 || fromIndex >= data.drinks.length) return null;
  if (toIndex < 0 || toIndex >= data.drinks.length) return null;
  const [moved] = data.drinks.splice(fromIndex, 1);
  data.drinks.splice(toIndex, 0, moved);
  await saveCustomDrinks(data);
  return data.drinks;
}

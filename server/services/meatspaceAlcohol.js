/**
 * MeatSpace Alcohol Service
 *
 * Drink logging, standard drink calculation, and rolling averages.
 * Reads/writes daily-log.json entries for alcohol data.
 */

import { join } from 'path';
import { PATHS, readJSONFile, getDateString } from '../lib/fileUtils.js';
import { createSubstanceLog } from './meatspaceSubstanceLog.js';
const MEATSPACE_DIR = PATHS.meatspace;
const CONFIG_FILE = join(MEATSPACE_DIR, 'config.json');

const DEFAULT_DRINK_BUTTONS = [
  { name: 'Modelo Especial (12oz)', oz: 12, abv: 4.4 },
  { name: 'Nitro Guinness (14.9oz)', oz: 14.9, abv: 4.2 },
  { name: 'Old Fashioned (2oz)', oz: 2, abv: 40 },
  { name: 'Guinness 0 (14.9oz)', oz: 14.9, abv: 0.4 },
  { name: 'N/A Beer (12oz)', oz: 12, abv: 0.4 }
];

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

  const allEntries = [...entries].sort((a, b) => a.date.localeCompare(b.date));

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

const substanceLog = createSubstanceLog({
  key: 'alcohol', itemsField: 'drinks', totalField: 'standardDrinks', mlCollection: 'alcoholDrinks',
  itemFields: ['name', 'abv', 'oz', 'count'],
  computeTotal: item => computeStandardDrinks((item.oz || 0) * (item.count || 1), item.abv || 0),
  computeLogAmount: item => computeStandardDrinks(item.oz * item.count, item.abv),
  computeAverages: (entries, config) => computeRollingAverages(entries, config?.sex || 'male'),
  summaryConfig: () => readJSONFile(CONFIG_FILE, { sex: 'male' }),
  describe: {
    icon: '🍺', noun: 'drink', amountUnit: 'std',
    item: item => `${item.name || 'unnamed'} ${item.oz}oz @ ${item.abv}%`,
    button: item => `${item.name} ${item.oz}oz @ ${item.abv}%`
  },
  customButtons: { file: 'custom-drinks.json', field: 'drinks', defaults: DEFAULT_DRINK_BUTTONS, fields: ['name', 'oz', 'abv'] }
});

export const getAlcoholSummary = substanceLog.summary;
export const getDailyAlcohol = substanceLog.daily;
export const logDrink = substanceLog.log;
export const updateDrink = substanceLog.update;
export const removeDrink = substanceLog.remove;
export const getCustomDrinks = substanceLog.getButtons;
export const addCustomDrink = substanceLog.addButton;
export const updateCustomDrink = substanceLog.updateButton;
export const removeCustomDrink = substanceLog.removeButton;

/**
 * MeatSpace Nicotine Service
 *
 * Nicotine consumption logging, daily totals, and rolling averages.
 * Stores data in the shared daily-log.json under the `nicotine` key per entry.
 */

import { getDateString } from '../lib/fileUtils.js';
import { createSubstanceLog } from './meatspaceSubstanceLog.js';

const DEFAULT_PRODUCTS = [
  { name: 'Stokes Pick (5mg)', mgPerUnit: 5 },
];

// === Pure Functions ===

/**
 * Compute rolling averages from daily entries for nicotine consumption.
 */
export function computeRollingAverages(entries) {
  const now = new Date();
  const today = getDateString(now);

  const allEntries = [...entries].sort((a, b) => a.date.localeCompare(b.date));

  // Today's total
  const todayEntry = allEntries.find(e => e.date === today);
  const todayMg = todayEntry?.nicotine?.totalMg ?? 0;
  // Units consumed, not rows: each log is a separate event row (#8143).
  const todayCount = (todayEntry?.nicotine?.items ?? []).reduce((sum, i) => sum + (i?.count ?? 1), 0);

  // Helper: average over last N days
  const rollingAverage = (days) => {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = getDateString(cutoff);

    let totalMg = 0;
    for (const entry of allEntries) {
      if (entry.date >= cutoffStr && entry.date <= today) {
        totalMg += entry.nicotine?.totalMg ?? 0;
      }
    }
    return Math.round((totalMg / days) * 100) / 100;
  };

  // All-time average
  let allTimeAvg = 0;
  if (allEntries.length > 0) {
    const firstDate = new Date(allEntries[0].date);
    const totalDays = Math.max(1, Math.ceil((now - firstDate) / (24 * 60 * 60 * 1000)));
    const totalMg = allEntries.reduce((sum, e) => sum + (e.nicotine?.totalMg || 0), 0);
    allTimeAvg = Math.round((totalMg / totalDays) * 100) / 100;
  }

  const avg7day = rollingAverage(7);
  const avg30day = rollingAverage(30);
  const weeklyTotal = Math.round(avg7day * 7 * 100) / 100;

  const nicotineDays = entries.filter(e => e.nicotine?.totalMg > 0).length;

  return {
    today: todayMg,
    todayCount,
    avg7day,
    avg30day,
    allTimeAvg,
    weeklyTotal,
    nicotineDays,
    totalEntries: allEntries.length
  };
}

const substanceLog = createSubstanceLog({
  key: 'nicotine', itemsField: 'items', totalField: 'totalMg', mlCollection: 'nicotineEntries',
  itemFields: ['product', 'mgPerUnit', 'count'],
  computeTotal: item => (item.mgPerUnit ?? 0) * (item.count ?? 1),
  computeLogAmount: item => item.mgPerUnit * item.count,
  computeAverages: entries => computeRollingAverages(entries),
  describe: {
    icon: '🚬', noun: 'nicotine', amountUnit: 'mg',
    item: item => `${item.product || 'unnamed'} ${item.mgPerUnit}mg x${item.count}`,
    button: item => `${item.name} ${item.mgPerUnit}mg`
  },
  customButtons: { file: 'custom-nicotine-products.json', field: 'products', defaults: DEFAULT_PRODUCTS, fields: ['name', 'mgPerUnit'] }
});

export const getNicotineSummary = substanceLog.summary;
export const getDailyNicotine = substanceLog.daily;
export const logNicotine = substanceLog.log;
export const updateNicotine = substanceLog.update;
export const removeNicotine = substanceLog.remove;
export const getCustomProducts = substanceLog.getButtons;
export const addCustomProduct = substanceLog.addButton;
export const updateCustomProduct = substanceLog.updateButton;
export const removeCustomProduct = substanceLog.removeButton;

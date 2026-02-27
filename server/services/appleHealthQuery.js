/**
 * Apple Health Query Service
 *
 * Date-range queries for health metrics stored as day-partitioned files
 * at data/health/YYYY-MM-DD.json.
 */

import { readdir } from 'fs/promises';
import { PATHS } from '../lib/fileUtils.js';
import { readDayFile } from './appleHealthIngest.js';
import { getDailyAlcohol } from './meatspaceAlcohol.js';
import { getBloodTests } from './meatspaceHealth.js';

// Fallback aliases for metrics stored under old names (e.g. JSON ingest before normalization)
const METRIC_ALIASES = {
  'heart_rate_variability_sdnn': 'heart_rate_variability',
};

// === Directory Listing ===

/**
 * List all available day files in the health data directory.
 *
 * @returns {Promise<string[]>} Sorted array of date strings (YYYY-MM-DD)
 */
export async function listDayFiles() {
  const files = await readdir(PATHS.health).catch(() => []);
  return files
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''))
    .sort();
}

/**
 * Get the available date range from all health day files.
 *
 * @returns {Promise<Object|null>} { from, to, totalDays } or null if no files
 */
export async function getAvailableDateRange() {
  const dates = await listDayFiles();
  if (dates.length === 0) return null;
  return { from: dates[0], to: dates[dates.length - 1], totalDays: dates.length };
}

// === Metric Queries ===

/**
 * Compute default date range: last 7 days from today.
 *
 * @returns {{ from: string, to: string }}
 */
function defaultDateRange() {
  const to = new Date().toISOString().substring(0, 10);
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 7);
  const from = fromDate.toISOString().substring(0, 10);
  return { from, to };
}

/**
 * Get all data points for a metric across a date range.
 * Returns flat array sorted by date.
 *
 * @param {string} metricName - Health metric name
 * @param {string} [from] - Start date YYYY-MM-DD (defaults to 7 days ago)
 * @param {string} [to] - End date YYYY-MM-DD (defaults to today)
 * @returns {Promise<Array>} Flat sorted array of data points
 */
export async function getMetrics(metricName, from, to) {
  const dates = await listDayFiles();
  const range = from && to ? { from, to } : defaultDateRange();

  const filtered = dates.filter(d => d >= range.from && d <= range.to);
  const allPoints = [];

  for (const dateStr of filtered) {
    const dayData = await readDayFile(dateStr);
    const points = dayData.metrics?.[metricName] || dayData.metrics?.[METRIC_ALIASES[metricName]] || [];
    allPoints.push(...points);
  }

  return allPoints.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Get summary statistics for a metric over a date range.
 *
 * @param {string} metricName - Health metric name
 * @param {string} [from] - Start date YYYY-MM-DD
 * @param {string} [to] - End date YYYY-MM-DD
 * @returns {Promise<Object>} Summary: { metricName, count, latest, average, from, to, dataPoints }
 */
export async function getMetricSummary(metricName, from, to) {
  const range = from && to ? { from, to } : defaultDateRange();
  const dataPoints = await getMetrics(metricName, range.from, range.to);

  const count = dataPoints.length;
  const latest = count > 0 ? dataPoints[dataPoints.length - 1] : null;

  // Average: use qty if present, fall back to Avg (heart rate)
  let average = null;
  if (count > 0) {
    const hasQty = dataPoints.some(p => p.qty !== undefined);
    const hasAvg = dataPoints.some(p => p.Avg !== undefined);
    if (hasQty) {
      const qtyPoints = dataPoints.filter(p => p.qty !== undefined);
      average = qtyPoints.reduce((sum, p) => sum + p.qty, 0) / qtyPoints.length;
    } else if (hasAvg) {
      const avgPoints = dataPoints.filter(p => p.Avg !== undefined);
      average = avgPoints.reduce((sum, p) => sum + p.Avg, 0) / avgPoints.length;
    }
    if (average !== null) average = Math.round(average * 100) / 100;
  }

  return { metricName, count, latest, average, from: range.from, to: range.to, dataPoints };
}

/**
 * Get daily aggregated values for a metric over a date range.
 * Aggregation strategy depends on metric type.
 *
 * @param {string} metricName - Health metric name
 * @param {string} [from] - Start date YYYY-MM-DD
 * @param {string} [to] - End date YYYY-MM-DD
 * @returns {Promise<Array>} Array of { date, value } objects
 */
export async function getDailyAggregates(metricName, from, to) {
  const dates = await listDayFiles();
  const range = from && to ? { from, to } : defaultDateRange();
  const filtered = dates.filter(d => d >= range.from && d <= range.to);
  const results = [];

  for (const dateStr of filtered) {
    const dayData = await readDayFile(dateStr);
    const points = dayData.metrics?.[metricName] || dayData.metrics?.[METRIC_ALIASES[metricName]] || [];
    if (points.length === 0) continue;

    let value;
    if (metricName === 'step_count') {
      // Sum qty per day
      value = points.reduce((sum, p) => sum + (p.qty ?? 0), 0);
    } else if (metricName === 'heart_rate') {
      // Average of Avg values (JSON ingest) or qty values (XML ingest)
      const avgPoints = points.filter(p => p.Avg !== undefined);
      const qtyPoints = points.filter(p => p.qty !== undefined);
      if (avgPoints.length > 0) {
        value = avgPoints.reduce((sum, p) => sum + p.Avg, 0) / avgPoints.length;
      } else if (qtyPoints.length > 0) {
        value = qtyPoints.reduce((sum, p) => sum + p.qty, 0) / qtyPoints.length;
      } else {
        value = null;
      }
    } else if (metricName === 'heart_rate_variability_sdnn') {
      // Average qty per day
      const qtyPoints = points.filter(p => p.qty !== undefined);
      value = qtyPoints.length > 0
        ? qtyPoints.reduce((sum, p) => sum + p.qty, 0) / qtyPoints.length
        : null;
    } else if (metricName === 'sleep_analysis') {
      // Return full sleep summary with stage breakdown from most recent aggregated point
      const sleepPoint = [...points].reverse().find(p => p.totalSleep !== undefined);
      if (sleepPoint) {
        results.push({
          date: dateStr,
          value: Math.round((sleepPoint.totalSleep ?? 0) * 100) / 100,
          deep: sleepPoint.deep ?? 0,
          rem: sleepPoint.rem ?? 0,
          core: sleepPoint.core ?? 0,
          awake: sleepPoint.awake ?? 0
        });
      }
      continue;
    } else {
      // Default: average qty
      const qtyPoints = points.filter(p => p.qty !== undefined);
      value = qtyPoints.length > 0
        ? qtyPoints.reduce((sum, p) => sum + p.qty, 0) / qtyPoints.length
        : null;
    }

    if (value !== null) {
      results.push({ date: dateStr, value: Math.round(value * 100) / 100 });
    }
  }

  return results;
}

// === Correlation Data ===

/**
 * Get merged health + alcohol + blood data for correlation analysis.
 * Reads HRV, steps, and alcohol data by day, plus blood tests for date range.
 *
 * @param {string} [from] - Start date YYYY-MM-DD
 * @param {string} [to] - End date YYYY-MM-DD
 * @returns {Promise<Object>} { dailyData: Array<{ date, hrv, alcoholGrams, steps }>, bloodTests }
 */
export async function getCorrelationData(from, to) {
  const range = from && to ? { from, to } : defaultDateRange();

  const [hrvData, stepsData, alcoholEntries, bloodData] = await Promise.all([
    getDailyAggregates('heart_rate_variability_sdnn', range.from, range.to),
    getDailyAggregates('step_count', range.from, range.to),
    getDailyAlcohol(range.from, range.to),
    getBloodTests()
  ]);

  // Build lookup maps for O(1) access
  const hrvByDate = new Map(hrvData.map(d => [d.date, d.value]));
  const stepsByDate = new Map(stepsData.map(d => [d.date, d.value]));
  const alcoholByDate = new Map(
    alcoholEntries.map(e => [e.date, e.alcohol?.standardDrinks ?? 0])
  );

  // Collect all unique dates across all sources
  const allDates = new Set([
    ...hrvByDate.keys(),
    ...stepsByDate.keys(),
    ...alcoholByDate.keys()
  ]);

  const dailyData = Array.from(allDates)
    .sort()
    .map(date => ({
      date,
      hrv: hrvByDate.get(date) ?? null,
      alcoholGrams: alcoholByDate.get(date) != null
        ? Math.round(alcoholByDate.get(date) * 14 * 100) / 100  // std drinks to grams
        : null,
      steps: stepsByDate.get(date) ?? null
    }));

  // Filter blood tests to date range
  const bloodTests = (bloodData.tests || []).filter(
    t => t.date >= range.from && t.date <= range.to
  );

  return { dailyData, bloodTests };
}

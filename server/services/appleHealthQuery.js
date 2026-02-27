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

// Metrics that should be summed per day rather than averaged
const SUM_METRICS = new Set([
  'step_count', 'active_energy', 'basal_energy_burned', 'flights_climbed',
  'apple_exercise_time', 'apple_stand_time', 'walking_running_distance',
  'distance_cycling', 'time_in_daylight'
]);

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
    if (metricName === 'sleep_analysis') {
      // Sum all aggregated sleep entries (batch flushing may produce multiple per day)
      const sleepPoints = points.filter(p => p.totalSleep !== undefined);
      if (sleepPoints.length > 0) {
        const deep = sleepPoints.reduce((s, p) => s + (p.deep ?? 0), 0);
        const rem = sleepPoints.reduce((s, p) => s + (p.rem ?? 0), 0);
        const core = sleepPoints.reduce((s, p) => s + (p.core ?? 0), 0);
        const awake = sleepPoints.reduce((s, p) => s + (p.awake ?? 0), 0);
        results.push({
          date: dateStr,
          value: Math.round((deep + rem + core) * 100) / 100,
          deep, rem, core, awake
        });
      }
      continue;
    } else if (SUM_METRICS.has(metricName)) {
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
    } else {
      // Default: average qty (works for HRV, SpO2, walking metrics, etc.)
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

// === Available Metrics Discovery ===

/**
 * Scan day files to discover which metrics have data.
 * Samples every 30th file plus the last 30 to catch both sparse metrics
 * (e.g. Withings body weight every few weeks) and recent daily metrics.
 *
 * @returns {Promise<Array<{name: string, dayCount: number}>>}
 */
export async function getAvailableMetrics() {
  const dates = await listDayFiles();
  // Sample evenly across full history + dense recent window
  const sample = new Set();
  for (let i = 0; i < dates.length; i += 30) sample.add(dates[i]);
  for (const d of dates.slice(-30)) sample.add(d);

  const metricCounts = new Map();
  for (const dateStr of sample) {
    const dayData = await readDayFile(dateStr);
    const metrics = dayData.metrics ?? {};
    for (const name of Object.keys(metrics)) {
      if (metrics[name]?.length > 0) {
        metricCounts.set(name, (metricCounts.get(name) ?? 0) + 1);
      }
    }
  }

  // Also check aliases (e.g. heart_rate_variability → heart_rate_variability_sdnn)
  const reverseAliases = Object.fromEntries(
    Object.entries(METRIC_ALIASES).map(([alias, original]) => [original, alias])
  );
  for (const [original, alias] of Object.entries(reverseAliases)) {
    if (metricCounts.has(original) && !metricCounts.has(alias)) {
      metricCounts.set(alias, metricCounts.get(original));
    }
  }

  return Array.from(metricCounts.entries())
    .map(([name, dayCount]) => ({ name, dayCount }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// === Latest Values ===

/**
 * Get the most recent recorded value for each requested metric.
 * Scans backward from the newest day file until a value is found for each metric.
 *
 * @param {string[]} metricNames - Metric names to look up
 * @returns {Promise<Object>} Map of metricName → { date, value } or null
 */
export async function getLatestMetricValues(metricNames) {
  const dates = await listDayFiles();
  const result = {};
  const remaining = new Set(metricNames);

  for (let i = dates.length - 1; i >= 0 && remaining.size > 0; i--) {
    const dateStr = dates[i];
    const dayData = await readDayFile(dateStr);
    const metrics = dayData.metrics ?? {};

    for (const name of [...remaining]) {
      const points = metrics[name] || metrics[METRIC_ALIASES[name]] || [];
      if (points.length === 0) continue;

      // Use the last point's qty as the value
      const lastPoint = points[points.length - 1];
      const value = lastPoint.qty ?? lastPoint.Avg ?? lastPoint.value ?? null;
      if (value != null) {
        result[name] = { date: dateStr, value: Math.round(value * 100) / 100 };
        remaining.delete(name);
      }
    }
  }

  // Fill nulls for metrics with no data at all
  for (const name of remaining) result[name] = null;
  return result;
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

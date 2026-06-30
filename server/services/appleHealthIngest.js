/**
 * Apple Health Ingest Service
 *
 * Handles JSON ingest from Health Auto Export app, deduplication by
 * metric+timestamp, and day-partitioned file storage at data/health/YYYY-MM-DD.json.
 */

import { join } from 'path';
import { atomicWrite, PATHS, ensureDir, readJSONFile } from '../lib/fileUtils.js';

// === Pure Functions ===

/**
 * Extract YYYY-MM-DD from an Apple Health timestamp string.
 * Uses substring (not Date parsing) to avoid timezone conversion issues.
 * Apple Health timestamps are like: "2024-01-15 08:30:00 -0800"
 *
 * @param {string} dateString - Apple Health timestamp string
 * @returns {string|null} YYYY-MM-DD string or null if invalid
 */
export function extractDateStr(dateString) {
  if (!dateString || typeof dateString !== 'string') return null;
  const candidate = dateString.substring(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  return candidate;
}

/**
 * Generate a deduplication key from metric name and data point date string.
 *
 * @param {string} metricName - The health metric name (e.g. "step_count")
 * @param {string} dateString - The full date string from the data point
 * @returns {string} Dedup key
 */
export function dedupKey(metricName, dateString) {
  return `${metricName}::${dateString}`;
}

// === File I/O ===

/**
 * Read a day file for a given date string.
 *
 * @param {string} dateStr - YYYY-MM-DD string
 * @returns {Promise<Object>} Day file data with date and metrics map
 */
export async function readDayFile(dateStr) {
  const filePath = join(PATHS.health, `${dateStr}.json`);
  return readJSONFile(filePath, { date: dateStr, metrics: {} });
}

/**
 * Write a day file, setting the updated timestamp.
 *
 * @param {string} dateStr - YYYY-MM-DD string
 * @param {Object} data - Day file data to write
 * @returns {Promise<void>}
 */
export async function writeDayFile(dateStr, data) {
  await ensureDir(PATHS.health);
  data.updated = new Date().toISOString();
  const filePath = join(PATHS.health, `${dateStr}.json`);
  await atomicWrite(filePath, data);
}

/**
 * Merge new data points into an existing day file, deduplicating by date string.
 *
 * @param {string} dateStr - YYYY-MM-DD string
 * @param {string} metricName - Health metric name
 * @param {Array} newPoints - Array of data point objects from the metric
 * @returns {Promise<number>} Count of newly added (unique) points
 */
export async function mergeIntoDay(dateStr, metricName, newPoints) {
  const dayData = await readDayFile(dateStr);

  const existing = dayData.metrics[metricName] || [];

  // Build a Set of existing full date strings for fast dedup lookup
  const existingDates = new Set(existing.map(p => p.date));

  // Only keep points not already present
  const uniquePoints = newPoints.filter(p => !existingDates.has(p.date));

  if (uniquePoints.length > 0) {
    dayData.metrics[metricName] = existing.concat(uniquePoints);
    await writeDayFile(dateStr, dayData);
  }

  return uniquePoints.length;
}

// Health Auto Export uses short names; normalize to match XML import names
const METRIC_NAME_ALIASES = {
  'heart_rate_variability': 'heart_rate_variability_sdnn',
};

// === Main Ingest Entry Point ===

/**
 * Ingest a validated Health Auto Export payload.
 * Iterates all metrics, groups data points by day, and merges into day files.
 *
 * @param {Object} payload - Validated health ingest payload
 * @returns {Promise<Object>} Summary: { metricsProcessed, recordsIngested, recordsSkipped, daysAffected }
 */
export async function ingestHealthData(payload) {
  const metrics = payload.data.metrics || [];
  let metricsProcessed = 0;
  let recordsIngested = 0;
  let recordsSkipped = 0;
  const affectedDays = new Set();

  for (const metric of metrics) {
    const metricName = METRIC_NAME_ALIASES[metric.name] ?? metric.name;
    const dataPoints = metric.data ?? [];
    metricsProcessed++;

    // Group data points by extracted day string
    const byDay = new Map();
    for (const point of dataPoints) {
      const dateStr = extractDateStr(point.date);
      if (!dateStr) {
        recordsSkipped++;
        continue;
      }
      if (!byDay.has(dateStr)) byDay.set(dateStr, []);
      byDay.get(dateStr).push(point);
    }

    // Merge each day's points into the corresponding day file
    for (const [dateStr, points] of byDay) {
      const added = await mergeIntoDay(dateStr, metricName, points);
      recordsIngested += added;
      recordsSkipped += (points.length - added);
      if (added > 0) affectedDays.add(dateStr);
    }
  }

  const daysAffected = affectedDays.size;
  console.log(`🍎 Health ingest: ${recordsIngested} records across ${daysAffected} days (${recordsSkipped} dupes skipped)`);

  return { metricsProcessed, recordsIngested, recordsSkipped, daysAffected };
}

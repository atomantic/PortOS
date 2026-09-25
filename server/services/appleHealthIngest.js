/**
 * Apple Health Ingest Service
 *
 * Handles JSON ingest from Health Auto Export app, deduplication by
 * metric+timestamp, and day-partitioned file storage at data/health/YYYY-MM-DD.json.
 */

import { join } from 'path';
import { atomicWrite, PATHS, ensureDir, readJSONFile } from '../lib/fileUtils.js';
import { createKeyedFileWriteQueue } from '../lib/fileWriteQueue.js';

// === Module State ===

/**
 * Per-date write queue to serialize read-modify-write cycles.
 * Keyed by date string (YYYY-MM-DD) so different days fan out in parallel
 * while writes to the same day serialize.
 */
const queueDayWrite = createKeyedFileWriteQueue();

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
  return readJSONFile(filePath, { date: dateStr, metrics: {} }, { strict: true });
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
 * Upsert data points into a metric array.
 * For each new point, if an existing point has the same date, replace it.
 * Otherwise append the new point.
 *
 * @param {Array} existing - Existing points for the metric
 * @param {Array} newPoints - New points to upsert
 * @returns {Object} { added: number of new points, updated: number of replaced points }
 */
export function upsertPoints(existing, newPoints) {
  if (!existing.length) {
    return { added: newPoints.length, updated: 0, result: [...newPoints] };
  }

  // Build a map of existing points by date for O(1) lookup and update
  const pointsByDate = new Map();
  for (const point of existing) {
    pointsByDate.set(point.date, point);
  }

  let added = 0;
  let updated = 0;

  // Process new points: update if date exists, otherwise add
  for (const newPoint of newPoints) {
    if (pointsByDate.has(newPoint.date)) {
      // Check if the point actually changed
      const oldPoint = pointsByDate.get(newPoint.date);
      if (JSON.stringify(oldPoint) !== JSON.stringify(newPoint)) {
        pointsByDate.set(newPoint.date, newPoint);
        updated++;
      }
      // If identical, count as a dupe (neither added nor updated)
    } else {
      pointsByDate.set(newPoint.date, newPoint);
      added++;
    }
  }

  const result = Array.from(pointsByDate.values());
  return { added, updated, result };
}

/**
 * Merge new data points into an existing day file, using upsert (latest write wins).
 * Serializes writes per date to prevent concurrent read-modify-write races.
 *
 * @param {string} dateStr - YYYY-MM-DD string
 * @param {string} metricName - Health metric name
 * @param {Array} newPoints - Array of data point objects from the metric
 * @returns {Promise<Object>} { added, updated, totalPoints }
 */
export async function mergeIntoDay(dateStr, metricName, newPoints) {
  return queueDayWrite(dateStr, async () => {
    const dayData = await readDayFile(dateStr);
    const existing = dayData.metrics[metricName] || [];

    const { added, updated, result } = upsertPoints(existing, newPoints);

    if (added > 0 || updated > 0) {
      dayData.metrics[metricName] = result;
      await writeDayFile(dateStr, dayData);
    }

    return { added, updated, totalPoints: result.length };
  });
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
 * @returns {Promise<Object>} Summary: { metricsProcessed, recordsIngested, recordsUpdated, recordsSkipped, daysAffected }
 */
export async function ingestHealthData(payload) {
  const metrics = payload.data.metrics || [];
  let metricsProcessed = 0;
  let recordsIngested = 0;
  let recordsUpdated = 0;
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
      const result = await mergeIntoDay(dateStr, metricName, points);
      recordsIngested += result.added;
      recordsUpdated += result.updated;
      recordsSkipped += (points.length - result.added - result.updated);
      if (result.added > 0 || result.updated > 0) affectedDays.add(dateStr);
    }
  }

  const daysAffected = affectedDays.size;
  const updateMsg = recordsUpdated > 0 ? ` ${recordsUpdated} updated,` : '';
  console.log(`🍎 Health ingest: ${recordsIngested} added,${updateMsg} ${recordsSkipped} dupes, ${daysAffected} days affected`);

  return { metricsProcessed, recordsIngested, recordsUpdated, recordsSkipped, daysAffected };
}

/**
 * Apple Health Ingest Service
 *
 * Handles JSON ingest from Health Auto Export app, deduplication by
 * metric+timestamp, and day-partitioned file storage at data/health/YYYY-MM-DD.json.
 */

import { invalidateMeatspace } from './meatspaceEvents.js';
import { join } from 'path';
import { atomicWrite, PATHS, ensureDir, readJSONFile } from '../lib/fileUtils.js';
import { createKeyedFileWriteQueue } from '../lib/fileWriteQueue.js';

// === Module State ===

/**
 * Per-date write queue to serialize read-modify-write cycles.
 * Keyed by date string (YYYY-MM-DD) so different days fan out in parallel
 * while writes to the same day serialize. Reached only through
 * `queueHealthDayMutation`, so every day-file mutation is also admitted.
 */
const queueDayWrite = createKeyedFileWriteQueue();

/**
 * Health mutation admission (#10899). A live file restore that reaches
 * `data/health` closes admission, waits for every admitted day cycle to settle,
 * transfers, and reopens. Admission is taken BEFORE a day's queue and held until
 * its write settles, so a cycle never carries a pre-image across a restore.
 * Ordinary cycles only count themselves: distinct days stay concurrent.
 */
const admission = { active: 0, restores: 0, reopen: null, drained: null };
let restoreTail = Promise.resolve();

/**
 * Run one read-modify-write (or capture/removal) cycle for `dateStr` inside
 * health mutation admission and that day's queue. JSON ingest, XML flushes and
 * health archival all mutate day files through this — never around it.
 *
 * @param {string} dateStr - YYYY-MM-DD string
 * @param {() => Promise<*>} mutate - Reads, then writes or removes, the day file
 * @returns {Promise<*>} The cycle's result
 */
export async function queueHealthDayMutation(dateStr, mutate) {
  // The open path admits and enqueues synchronously, before the first await.
  while (admission.restores > 0) await admission.reopen.promise;
  admission.active += 1;
  try {
    return await queueDayWrite(dateStr, mutate);
  } finally {
    admission.active -= 1;
    if (admission.active === 0) admission.drained?.resolve();
  }
}

/**
 * Own Apple Health day files through an out-of-band live restore. Closes new
 * mutation admission synchronously at the call, drains admitted day cycles,
 * runs `transfer`, invalidates health caches and reopens admission on every
 * outcome. Competing restores serialize and keep admission closed between them.
 * Acquire after the backup snapshot cut; never call `queueHealthDayMutation`
 * from `transfer` (it would wait on itself).
 *
 * @param {() => Promise<*>} transfer
 * @returns {Promise<*>} The transfer's result
 */
export function withLiveHealthRestore(transfer) {
  if (admission.restores++ === 0) admission.reopen = Promise.withResolvers();
  const run = restoreTail.then(async () => {
    try {
      if (admission.active > 0) {
        admission.drained = Promise.withResolvers();
        await admission.drained.promise;
      }
      const [result] = await Promise.allSettled([Promise.resolve().then(transfer)]);
      // A restored day can change any metric, including the body metrics the
      // writers invalidate, and a failed rsync may already have replaced some
      // days — so invalidate after every outcome.
      invalidateMeatspace(['healthBody']);
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    } finally {
      admission.drained = null;
      if (--admission.restores === 0) admission.reopen.resolve();
    }
  });
  restoreTail = run.catch(() => {});
  return run;
}

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
export async function writeDayFile(dateStr, data, changedMetrics = Object.keys(data.metrics || {})) {
  await ensureDir(PATHS.health);
  data.updated = new Date().toISOString();
  const filePath = join(PATHS.health, `${dateStr}.json`);
  await atomicWrite(filePath, data);
  if (changedMetrics.some(name => ['body_mass', 'body_fat_percentage', 'lean_body_mass'].includes(name))) {
    invalidateMeatspace(['healthBody']);
  }
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
  return queueHealthDayMutation(dateStr, async () => {
    const dayData = await readDayFile(dateStr);
    const existing = dayData.metrics[metricName] || [];

    const { added, updated, result } = upsertPoints(existing, newPoints);

    if (added > 0 || updated > 0) {
      dayData.metrics[metricName] = result;
      await writeDayFile(dateStr, dayData, [metricName]);
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

    // Group data points by extracted day string, stamping origin so the
    // read side can pick a single source of truth per metric-day and avoid
    // double-counting against XML-imported points for the same day (#8450).
    // HealthKit has already deduplicated across devices before Health Auto
    // Export sends this payload.
    const byDay = new Map();
    for (const point of dataPoints) {
      const dateStr = extractDateStr(point.date);
      if (!dateStr) {
        recordsSkipped++;
        continue;
      }
      if (!byDay.has(dateStr)) byDay.set(dateStr, []);
      byDay.get(dateStr).push({ ...point, origin: 'hae' });
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

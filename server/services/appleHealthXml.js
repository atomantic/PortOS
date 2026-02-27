/**
 * Apple Health XML Import Service
 *
 * SAX streaming parser for Apple Health exports (500MB+).
 * Normalizes HK identifiers to metric names matching JSON ingest format.
 * Emits WebSocket progress events every 10k records.
 */

import sax from 'sax';
import { createReadStream } from 'fs';
import { unlink } from 'fs';
import { extractDateStr, readDayFile, writeDayFile } from './appleHealthIngest.js';

// === Mapping Tables ===

const XML_TO_METRIC_NAME = {
  'hkquantitytypeidentifierstepcount': 'step_count',
  'hkquantitytypeidentifierheartrate': 'heart_rate',
  'hkquantitytypeidentifierheartratevariancessdnn': 'heart_rate_variability_sdnn',
  'hkcategorytypeidentifiersleepanalysis': 'sleep_analysis',
};

// HKQuantityTypeIdentifierHeartRateVariabilitySDNN mapped by direct lowercase below
// Using the exact HK identifier (already lowercase) as fallback for unknowns

const SLEEP_STAGE_MAP = {
  'hkcategoryvaluesleepanalysisasleepdeep': 'deep',
  'hkcategoryvaluesleepanalysisasleeprem': 'rem',
  'hkcategoryvaluesleepanalysisasleepcore': 'core',
  'hkcategoryvaluesleepanalysisawake': 'awake',
  'hkcategoryvaluesleepanalysisinbed': 'inBed',
  'hkcategoryvaluesleepanalysisasleep': 'asleep',  // Legacy pre-iOS 16
};

// === Pure Functions ===

/**
 * Normalize an XML Record node into a standard data point.
 * Uses lowercase attribute names (sax non-strict lowercase mode).
 *
 * @param {Object} node - SAX opentag node with lowercase attributes
 * @returns {{ metricName: string, dateStr: string, dataPoint: Object }|null}
 */
export function normalizeXmlRecord(node) {
  const attrs = node.attributes;
  const type = attrs.type;
  const value = attrs.value;
  const startdate = attrs.startdate;
  const enddate = attrs.enddate;
  const unit = attrs.unit;
  const sourcename = attrs.sourcename;

  if (!type || !startdate) return null;

  const typeLower = type.toLowerCase();
  const metricName = XML_TO_METRIC_NAME[typeLower] ?? typeLower;

  const dateStr = extractDateStr(startdate);
  if (!dateStr) return null;

  // Sleep analysis: categorical value → duration-based stage data
  if (typeLower === 'hkcategorytypeidentifiersleepanalysis') {
    const durationHours = enddate
      ? (new Date(enddate) - new Date(startdate)) / 3600000
      : 0;
    const valueLower = value?.toLowerCase() ?? '';
    const stage = SLEEP_STAGE_MAP[valueLower] ?? value ?? 'unknown';
    const dataPoint = { date: startdate, stage, durationHours };
    return { metricName, dateStr, dataPoint };
  }

  // Heart rate: include end timestamp
  if (typeLower === 'hkquantitytypeidentifierheartrate') {
    const dataPoint = {
      date: startdate,
      qty: parseFloat(value),
      unit: unit ?? null,
      src: sourcename ?? null,
      end: enddate ?? null,
    };
    return { metricName, dateStr, dataPoint };
  }

  // All other numeric types
  const dataPoint = {
    date: startdate,
    qty: parseFloat(value),
    unit: unit ?? null,
    src: sourcename ?? null,
  };
  return { metricName, dateStr, dataPoint };
}

// === Aggregation ===

/**
 * Aggregate step_count entries in a day bucket — sum all qty values into a single total.
 * Apple Health emits per-activity step records; we want the daily total.
 *
 * @param {Array} points - Array of step_count data points
 * @returns {Array} Single-element array with aggregated total
 */
function aggregateStepCount(points) {
  if (!points.length) return points;
  const total = points.reduce((sum, p) => sum + (p.qty || 0), 0);
  // Use first point's date for the aggregated entry
  return [{ date: points[0].date, qty: total, unit: points[0].unit ?? null }];
}

/**
 * Aggregate sleep_analysis entries in a day bucket — sum duration by stage per day.
 *
 * @param {Array} points - Array of sleep_analysis data points with stage/durationHours
 * @returns {Object} Aggregated sleep summary { date, totalSleep, deep, rem, core, awake, inBed, asleep }
 */
function aggregateSleepAnalysis(points) {
  if (!points.length) return points;
  const summary = { date: points[0].date, totalSleep: 0, deep: 0, rem: 0, core: 0, awake: 0, inBed: 0, asleep: 0 };
  for (const p of points) {
    const stage = p.stage;
    const dur = p.durationHours || 0;
    if (stage === 'deep') summary.deep += dur;
    else if (stage === 'rem') summary.rem += dur;
    else if (stage === 'core') summary.core += dur;
    else if (stage === 'awake') summary.awake += dur;
    else if (stage === 'inBed') summary.inBed += dur;
    else if (stage === 'asleep') summary.asleep += dur;
  }
  // totalSleep = meaningful sleep stages (deep + rem + core)
  summary.totalSleep = summary.deep + summary.rem + summary.core;
  return [summary];
}

// === Main Export ===

/**
 * Stream-parse an Apple Health export.xml file using SAX.
 * Accumulates records, aggregates step/sleep metrics, then writes day files.
 *
 * @param {string} filePath - Absolute path to the XML file (temp upload)
 * @param {Object|null} io - Socket.IO server instance for progress events
 * @returns {Promise<{ days: number, records: number }>}
 */
export async function importAppleHealthXml(filePath, io = null) {
  // dayBuckets: { [dateStr]: { [metricName]: [...dataPoints] } }
  const dayBuckets = {};
  let processedRecords = 0;

  await new Promise((resolve, reject) => {
    const saxStream = sax.createStream(false, { lowercase: true });

    saxStream.on('opentag', (node) => {
      if (node.name !== 'record') return;

      const normalized = normalizeXmlRecord(node);
      if (!normalized) return;

      const { metricName, dateStr, dataPoint } = normalized;

      if (!dayBuckets[dateStr]) dayBuckets[dateStr] = {};
      if (!dayBuckets[dateStr][metricName]) dayBuckets[dateStr][metricName] = [];
      dayBuckets[dateStr][metricName].push(dataPoint);

      processedRecords++;

      if (processedRecords % 10000 === 0) {
        io?.emit('health:xml:progress', { processed: processedRecords });
        console.log(`🍎 XML import progress: ${processedRecords} records`);
      }
    });

    saxStream.on('error', function (e) {
      console.error(`❌ XML parse error at record ${processedRecords}: ${e.message}`);
      // Clear error and resume — Apple Health XML can have minor malformations
      this._parser.error = null;
      this._parser.resume();
    });

    saxStream.on('end', resolve);
    saxStream.on('close', resolve);

    createReadStream(filePath).pipe(saxStream);
  });

  console.log(`🍎 XML parsing done: ${processedRecords} raw records across ${Object.keys(dayBuckets).length} days — starting aggregation`);

  // === Post-parse aggregation (outside SAX event loop) ===
  for (const dateStr of Object.keys(dayBuckets)) {
    const metrics = dayBuckets[dateStr];

    // Aggregate step_count: sum all qty values into single daily total
    if (metrics.step_count) {
      metrics.step_count = aggregateStepCount(metrics.step_count);
    }

    // Aggregate sleep_analysis: sum stage durations into daily summary
    if (metrics.sleep_analysis) {
      metrics.sleep_analysis = aggregateSleepAnalysis(metrics.sleep_analysis);
    }
  }

  // === Write day files sequentially ===
  const allDates = Object.keys(dayBuckets);
  for (const dateStr of allDates) {
    const dayData = await readDayFile(dateStr);
    const metrics = dayBuckets[dateStr];

    for (const [metricName, newPoints] of Object.entries(metrics)) {
      const existing = dayData.metrics[metricName] || [];
      const existingDates = new Set(existing.map(p => p.date));
      const uniquePoints = newPoints.filter(p => !existingDates.has(p.date));
      if (uniquePoints.length > 0) {
        dayData.metrics[metricName] = existing.concat(uniquePoints);
      }
    }

    await writeDayFile(dateStr, dayData);
  }

  const daysCount = allDates.length;

  // Clean up temp file
  unlink(filePath, () => {});

  io?.emit('health:xml:complete', { days: daysCount, records: processedRecords });
  console.log(`🍎 XML import complete: ${processedRecords} records across ${daysCount} days`);

  return { days: daysCount, records: processedRecords };
}

/**
 * Apple Health XML Import Service
 *
 * Dependency-free streaming parser for Apple Health exports (500MB+).
 * Normalizes HK identifiers to metric names matching JSON ingest format.
 * Emits WebSocket progress events every 10k records.
 */

import { emitToOperatorsOn } from './socketIo.js';
import { createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import { extractDateStr, readDayFile, writeDayFile, upsertPoints, queueHealthDayMutation } from './appleHealthIngest.js';
import { createAppleHealthRecordStream } from './appleHealthXmlParser.js';
import { bucketFor } from '../lib/objects.js';
import { healthPointOrigin } from '../lib/appleHealthPoints.js';

// === Mapping Tables ===

const XML_TO_METRIC_NAME = {
  // Core vitals
  'hkquantitytypeidentifierheartrate': 'heart_rate',
  'hkquantitytypeidentifierheartratevariancessdnn': 'heart_rate_variability_sdnn',
  'hkquantitytypeidentifierrestingheartrate': 'resting_heart_rate',
  'hkquantitytypeidentifierwalkingheartrateaverage': 'walking_heart_rate_average',
  'hkquantitytypeidentifierheartraterecoveryoneminute': 'heart_rate_recovery',
  'hkquantitytypeidentifieroxygensaturation': 'blood_oxygen_saturation',
  'hkquantitytypeidentifierrespiratoryrate': 'respiratory_rate',
  'hkquantitytypeidentifierbodytemperature': 'body_temperature',
  'hkquantitytypeidentifiervo2max': 'vo2_max',

  // Activity
  'hkquantitytypeidentifierstepcount': 'step_count',
  'hkquantitytypeidentifieractiveenergyburned': 'active_energy',
  'hkquantitytypeidentifierbasalenergyburned': 'basal_energy_burned',
  'hkquantitytypeidentifierdistancewalkingrunning': 'walking_running_distance',
  'hkquantitytypeidentifierflightsclimbed': 'flights_climbed',
  'hkquantitytypeidentifierappleexercisetime': 'apple_exercise_time',
  'hkquantitytypeidentifierapplestandtime': 'apple_stand_time',
  'hkcategorytypeidentifierapplestandhour': 'apple_stand_hour',
  'hkquantitytypeidentifierphysicaleffort': 'physical_effort',
  'hkquantitytypeidentifiertimeindaylight': 'time_in_daylight',

  // Walking metrics
  'hkquantitytypeidentifierwalkingspeed': 'walking_speed',
  'hkquantitytypeidentifierwalkingsteplength': 'walking_step_length',
  'hkquantitytypeidentifierwalkingdoublesupportpercentage': 'walking_double_support_percentage',
  'hkquantitytypeidentifierwalkingasymmetrypercentage': 'walking_asymmetry_percentage',
  'hkquantitytypeidentifierstairdescentspeed': 'stair_speed_down',
  'hkquantitytypeidentifierstairascentspeed': 'stair_speed_up',
  'hkquantitytypeidentifierapplewalkingsteadiness': 'walking_steadiness',
  'hkquantitytypeidentifiersixminutewalktestdistance': 'six_minute_walk_test',

  // Running
  'hkquantitytypeidentifierrunningspeed': 'running_speed',
  'hkquantitytypeidentifierrunningpower': 'running_power',
  'hkquantitytypeidentifierrunningverticaloscillation': 'running_vertical_oscillation',
  'hkquantitytypeidentifierrunninggroundcontacttime': 'running_ground_contact_time',
  'hkquantitytypeidentifierrunningstridelength': 'running_stride_length',

  // Cycling
  'hkquantitytypeidentifierdistancecycling': 'distance_cycling',
  'hkquantitytypeidentifiercyclingspeed': 'cycling_speed',
  'hkquantitytypeidentifiercyclingcadence': 'cycling_cadence',
  'hkquantitytypeidentifiercyclingpower': 'cycling_power',
  'hkquantitytypeidentifiercyclingfunctionalthresholdpower': 'cycling_ftp',

  // Cardiovascular
  'hkquantitytypeidentifierbloodpressuresystolic': 'blood_pressure_systolic',
  'hkquantitytypeidentifierbloodpressurediastolic': 'blood_pressure_diastolic',

  // Body measurements
  'hkquantitytypeidentifierbodymass': 'body_mass',
  'hkquantitytypeidentifierbodymassindex': 'body_mass_index',
  'hkquantitytypeidentifierbodyfatpercentage': 'body_fat_percentage',
  'hkquantitytypeidentifierleanbodymass': 'lean_body_mass',
  'hkquantitytypeidentifierheight': 'height',

  // Sleep
  'hkcategorytypeidentifiersleepanalysis': 'sleep_analysis',
  'hkquantitytypeidentifierapplesleepingbreathingdisturbances': 'breathing_disturbances',

  // Audio exposure
  'hkquantitytypeidentifierenvironmentalaudioexposure': 'environmental_audio_exposure',
  'hkquantitytypeidentifierheadphoneaudioexposure': 'headphone_audio_exposure',
  'hkquantitytypeidentifierenvironmentalsoundreduction': 'environmental_sound_reduction',

  // Other categories
  'hkcategorytypeidentifierhandwashingevent': 'handwashing',
  'hkcategorytypeidentifiermindfulsession': 'mindful_session',
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
 * Uses lowercase attribute names (matching the parser's lowercase-name mode).
 *
 * @param {Object} node - Record node with lowercase attribute names
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
    const dataPoint = { date: startdate, stage, durationHours, src: sourcename ?? null, origin: 'xml' };
    return { metricName, dateStr, dataPoint };
  }

  // Heart rate: include end timestamp
  if (typeLower === 'hkquantitytypeidentifierheartrate') {
    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed)) return null;
    const dataPoint = {
      date: startdate,
      qty: parsed,
      unit: unit ?? null,
      src: sourcename ?? null,
      end: enddate ?? null,
      origin: 'xml',
    };
    return { metricName, dateStr, dataPoint };
  }

  // All other numeric types
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  const dataPoint = {
    date: startdate,
    qty: parsed,
    unit: unit ?? null,
    src: sourcename ?? null,
    origin: 'xml',
  };
  return { metricName, dateStr, dataPoint };
}

// === Aggregation ===

// step_count and sleep_analysis collapse to one aggregate per day per source
// device. Apple Health emits per-activity step records, often from several
// devices (iPhone + Watch) covering the same walk, and several sleep sources can
// record the same night, so summing across sources would double-count: keep one
// aggregate per `src` and defer picking the source of truth to read time (see
// `pickDaySumPoints` in appleHealthQuery.js).
//
// These are accumulated in memory across the WHOLE file (days x sources, small
// even for a 3GB export) and written only once at the end. Flushing a partial
// aggregate mid-day would key it by whichever record happened to sit at a flush
// boundary; a newer export moves the boundary, so the old partial would survive
// next to the new total and inflate it (#17312).
const AGGREGATED_METRICS = new Set(['step_count', 'sleep_analysis']);
const SLEEP_STAGES = ['deep', 'rem', 'core', 'awake', 'inBed', 'asleep'];

function newAggregate(metricName, point) {
  if (metricName === 'step_count') {
    return { date: point.date, qty: 0, unit: point.unit ?? null, src: point.src ?? null, origin: 'xml' };
  }
  return {
    date: point.date, totalSleep: 0, deep: 0, rem: 0, core: 0, awake: 0, inBed: 0, asleep: 0,
    src: point.src ?? null, origin: 'xml',
  };
}

/** Fold one record into its day/metric/source aggregate; `date` tracks the earliest startdate. */
function accumulateAggregate(aggregates, dateStr, metricName, point) {
  if (!aggregates.has(dateStr)) aggregates.set(dateStr, new Map());
  const byMetric = aggregates.get(dateStr);
  if (!byMetric.has(metricName)) byMetric.set(metricName, new Map());
  const bySrc = byMetric.get(metricName);
  const src = point.src ?? null;
  if (!bySrc.has(src)) bySrc.set(src, newAggregate(metricName, point));
  const agg = bySrc.get(src);

  if (point.date < agg.date) agg.date = point.date;
  if (metricName === 'step_count') {
    agg.qty += point.qty || 0;
    return;
  }
  if (SLEEP_STAGES.includes(point.stage)) agg[point.stage] += point.durationHours || 0;
  // totalSleep = meaningful sleep stages (deep + rem + core)
  agg.totalSleep = agg.deep + agg.rem + agg.core;
}

// === Main Export ===

const FLUSH_INTERVAL = 200000; // Flush to disk every 200K records to stay under memory limits

/**
 * Flush accumulated day buckets to disk: merge with existing, write, clear.
 * Uses upsert to handle re-imports that update existing day totals.
 *
 * @param {Object} dayBuckets - { [dateStr]: { [metricName]: [...dataPoints] } }
 * @returns {Promise<Set<string>>} Set of date strings that were flushed
 */
async function flushDayBuckets(dayBuckets) {
  const flushedDates = new Set();
  const allDates = Object.keys(dayBuckets);

  for (const dateStr of allDates) {
    // Admission is per day, so a live health restore can run between days and
    // every later day re-reads the restored file rather than a stale one.
    await queueHealthDayMutation(dateStr, async () => {
      const metrics = dayBuckets[dateStr];

      const dayData = await readDayFile(dateStr);

      for (const [metricName, newPoints] of Object.entries(metrics)) {
        const existing = dayData.metrics[metricName] || [];
        const { result } = upsertPoints(existing, newPoints);
        if (result.length > 0) {
          dayData.metrics[metricName] = result;
        }
      }

      await writeDayFile(dateStr, dayData, Object.keys(metrics));
      flushedDates.add(dateStr);
    });

    delete dayBuckets[dateStr];
  }

  return flushedDates;
}

/**
 * Write the whole-file step/sleep aggregates. For each day, metric and source the
 * single new aggregate REPLACES every existing XML point of that source (not just
 * the one with an equal timestamp), so partials stranded by an earlier import
 * are repaired. HAE points and other sources are untouched.
 *
 * @param {Map<string, Map<string, Map<string|null, Object>>>} aggregates
 */
async function flushAggregates(aggregates) {
  for (const [dateStr, byMetric] of aggregates) {
    await queueHealthDayMutation(dateStr, async () => {
      const dayData = await readDayFile(dateStr);
      for (const [metricName, bySrc] of byMetric) {
        const kept = (dayData.metrics[metricName] || []).filter(
          (p) => !(healthPointOrigin(p) === 'xml' && bySrc.has(p.src ?? null)),
        );
        dayData.metrics[metricName] = [...kept, ...bySrc.values()];
      }
      await writeDayFile(dateStr, dayData, [...byMetric.keys()]);
    });
  }
}

/**
 * Stream-parse an Apple Health export.xml file with the dependency-free
 * `<Record>` parser. Accumulates records in batches, flushing to disk
 * periodically to avoid OOM.
 *
 * @param {string} filePath - Absolute path to the XML file (temp upload)
 * @param {Object|null} io - Socket.IO server instance for progress events
 * @param {{ flushInterval?: number }} [options] - Records between intermediate flushes
 * @returns {Promise<{ days: number, records: number }>}
 */
export async function importAppleHealthXml(filePath, io = null, { flushInterval = FLUSH_INTERVAL } = {}) {
  // dayBuckets: { [dateStr]: { [metricName]: [...dataPoints] } }
  const dayBuckets = {};
  const aggregates = new Map();
  let processedRecords = 0;
  let lastFlush = 0;
  const allDays = new Set();
  let flushing = false;

  const inputStream = createReadStream(filePath);

  try {
    await new Promise((resolve, reject) => {
      const parser = createAppleHealthRecordStream({
        onRecord: (node) => {
          const normalized = normalizeXmlRecord(node);
          if (!normalized) return;

          const { metricName, dateStr, dataPoint } = normalized;

          if (AGGREGATED_METRICS.has(metricName)) {
            accumulateAggregate(aggregates, dateStr, metricName, dataPoint);
          } else {
            // dateStr and metricName both come from the uploaded export.
            const metrics = bucketFor(dayBuckets, dateStr, () => ({}));
            const points = metrics && bucketFor(metrics, metricName, () => []);
            if (!points) return;
            points.push(dataPoint);
          }
          allDays.add(dateStr);

          processedRecords++;

          if (processedRecords % 10000 === 0) {
            emitToOperatorsOn(io, 'health:xml:progress', { processed: processedRecords });
            console.log(`🍎 XML import progress: ${processedRecords} records`);
          }

          // Batch flush to prevent OOM — pause input stream, flush to disk, resume
          if (processedRecords - lastFlush >= flushInterval && !flushing) {
            flushing = true;
            lastFlush = processedRecords;
            inputStream.pause();
            flushDayBuckets(dayBuckets).then(() => {
              console.log(`🍎 Flushed batch at ${processedRecords} records (${allDays.size} days total)`);
              flushing = false;
              inputStream.resume();
            }).catch(reject);
          }
        },
      });

      // Malformed records can't throw here — records missing required attributes
      // are dropped by normalizeXmlRecord, so minor XML malformations are skipped
      // rather than fatal (matching the prior sax error-skip behavior).
      parser.on('finish', resolve);
      parser.on('error', reject);

      inputStream.on('error', reject);
      inputStream.pipe(parser);
    });

    console.log(`🍎 XML parsing done: ${processedRecords} raw records across ${allDays.size} days — flushing remaining`);

    // Final flush for remaining records
    await flushDayBuckets(dayBuckets);
    await flushAggregates(aggregates);
  } finally {
    // Runs on success AND on every rejection route (parser error, input-stream
    // error, rejected batch flush). Destroy before unlink: a batch-flush
    // rejection leaves the stream pause()d and still holding its fd, and on
    // Windows unlink fails while the file is open. An Apple Health export.xml
    // is routinely 0.5-3GB, so a leaked temp file is expensive.
    inputStream.destroy();
    // destroy() tears the fd down asynchronously, so wait for 'close' before
    // unlinking — on Windows the unlink fails while the handle is open and the
    // failure is swallowed below (same wait the ZIP write-stream cleanup does).
    if (!inputStream.closed) await new Promise((res) => inputStream.once('close', res));
    await unlink(filePath).catch(() => {});
  }

  emitToOperatorsOn(io, 'health:xml:complete', { days: allDays.size, records: processedRecords });
  console.log(`🍎 XML import complete: ${processedRecords} records across ${allDays.size} days`);

  return { days: allDays.size, records: processedRecords };
}

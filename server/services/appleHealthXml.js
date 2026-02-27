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
    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed)) return null;
    const dataPoint = {
      date: startdate,
      qty: parsed,
      unit: unit ?? null,
      src: sourcename ?? null,
      end: enddate ?? null,
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

const FLUSH_INTERVAL = 200000; // Flush to disk every 200K records to stay under memory limits

/**
 * Flush accumulated day buckets to disk: aggregate, merge with existing, write, clear.
 *
 * @param {Object} dayBuckets - { [dateStr]: { [metricName]: [...dataPoints] } }
 * @returns {Promise<Set<string>>} Set of date strings that were flushed
 */
async function flushDayBuckets(dayBuckets) {
  const flushedDates = new Set();
  const allDates = Object.keys(dayBuckets);

  for (const dateStr of allDates) {
    const metrics = dayBuckets[dateStr];

    // Aggregate step_count: sum all qty values into single daily total
    if (metrics.step_count) {
      metrics.step_count = aggregateStepCount(metrics.step_count);
    }

    // Aggregate sleep_analysis: sum stage durations into daily summary
    if (metrics.sleep_analysis) {
      metrics.sleep_analysis = aggregateSleepAnalysis(metrics.sleep_analysis);
    }

    const dayData = await readDayFile(dateStr);

    for (const [metricName, newPoints] of Object.entries(metrics)) {
      const existing = dayData.metrics[metricName] || [];
      const existingDates = new Set(existing.map(p => p.date));
      const uniquePoints = newPoints.filter(p => !existingDates.has(p.date));
      if (uniquePoints.length > 0) {
        dayData.metrics[metricName] = existing.concat(uniquePoints);
      }
    }

    await writeDayFile(dateStr, dayData);
    flushedDates.add(dateStr);
    delete dayBuckets[dateStr];
  }

  return flushedDates;
}

/**
 * Stream-parse an Apple Health export.xml file using SAX.
 * Accumulates records in batches, flushing to disk periodically to avoid OOM.
 *
 * @param {string} filePath - Absolute path to the XML file (temp upload)
 * @param {Object|null} io - Socket.IO server instance for progress events
 * @returns {Promise<{ days: number, records: number }>}
 */
export async function importAppleHealthXml(filePath, io = null) {
  // dayBuckets: { [dateStr]: { [metricName]: [...dataPoints] } }
  const dayBuckets = {};
  let processedRecords = 0;
  let lastFlush = 0;
  const allDays = new Set();
  let flushing = false;

  const inputStream = createReadStream(filePath);

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
      allDays.add(dateStr);

      processedRecords++;

      if (processedRecords % 10000 === 0) {
        io?.emit('health:xml:progress', { processed: processedRecords });
        console.log(`🍎 XML import progress: ${processedRecords} records`);
      }

      // Batch flush to prevent OOM — pause input stream, flush to disk, resume
      if (processedRecords - lastFlush >= FLUSH_INTERVAL && !flushing) {
        flushing = true;
        lastFlush = processedRecords;
        inputStream.pause();
        flushDayBuckets(dayBuckets).then(() => {
          console.log(`🍎 Flushed batch at ${processedRecords} records (${allDays.size} days total)`);
          flushing = false;
          inputStream.resume();
        }).catch(reject);
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

    inputStream.on('error', reject);
    inputStream.pipe(saxStream);
  });

  console.log(`🍎 XML parsing done: ${processedRecords} raw records across ${allDays.size} days — flushing remaining`);

  // Final flush for remaining records
  await flushDayBuckets(dayBuckets);

  // Clean up temp file
  unlink(filePath, () => {});

  io?.emit('health:xml:complete', { days: allDays.size, records: processedRecords });
  console.log(`🍎 XML import complete: ${processedRecords} records across ${allDays.size} days`);

  return { days: allDays.size, records: processedRecords };
}

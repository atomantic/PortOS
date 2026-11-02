/**
 * Checked-in `.quality.json` schema. This is not the peer wire payload.
 *
 * `PORTOS_SCHEMA_VERSIONS.appQuality` stays the v1 federation object. Writers
 * emit only canonical file schema v3. v1/v2 JSON and a historical
 * `quality-snapshot.json` body normalize to the same records; a future schema
 * is recognized and left for the publisher to report, not reinterpreted.
 *
 * Rows are `[assessedAt, categoryIndex, score, worstSeverity, coverageIndex,
 * confidenceIndex, scannedFiles, totalFiles]`. New assessments keep their UTC
 * timestamp so independent publishers can select the latest run per day. When
 * legacy date-only rows cannot be ordered, a stable tie-break selects one; a
 * timestamped candidate is preferred. `measurementId` is not stored. The v3
 * version prevents older publishers from pruning or
 * rewriting this shared history using the former date-only semantics.
 */
import { z } from 'zod';
import { historicalQualityReportSchema, qualityTieKey } from '../lib/auditQuality.js';

export const APP_QUALITY_FILE_SCHEMA_VERSION = 3;
export const APP_QUALITY_REPORT_VERSION = 1;
export const APP_QUALITY_SNAPSHOT_FILENAME = '.quality.json';
export const APP_QUALITY_LEGACY_SNAPSHOT_FILENAME = 'quality-snapshot.json';
export const APP_QUALITY_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
export const QUALITY_COVERAGE_VALUES = Object.freeze(['broad', 'partial', 'unavailable', 'not-applicable']);
export const QUALITY_CONFIDENCE_VALUES = Object.freeze(['low', 'medium', 'high']);
export const MAX_QUALITY_SNAPSHOT_ROWS = 250000;
const MAX_CATEGORY_NAMES = 256;

const REPOSITORY = /^[a-f0-9]{64}$/;
const COVERAGE = new Set(QUALITY_COVERAGE_VALUES);
const CONFIDENCE = new Set(QUALITY_CONFIDENCE_VALUES);
const V1_KEYS = new Set(['schemaVersion', 'repository', 'measurements']);
const V2_KEYS = new Set(['schemaVersion', 'repository', 'reportVersion', 'categories', 'coverage', 'confidence', 'measurements']);
const MEASUREMENT_KEYS = new Set(['measurementId', 'assessedAt', 'report']);
const REPORT_KEYS = new Set(['version', 'category', 'score', 'worstSeverity', 'coverage', 'confidence', 'summary', 'scannedFiles', 'totalFiles']);
const PLACEHOLDER_SUMMARY = 'Numeric assessment';
// Z and numeric offsets are both ISO instants. Zod's default datetime() rejects
// offsets, which would treat one UTC day as two when the date prefix differs.
const datetimeSchema = z.iso.datetime({ offset: true });
// A date without a time is legacy evidence of unknown ordering, not midnight.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const timestampSchema = { safeParse: value => (typeof value === 'string' && z.iso.date().safeParse(value).success
  ? { success: true } : datetimeSchema.safeParse(value)) };

function compareText(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function allowedKeys(value, keys) {
  return plainObject(value) && Object.keys(value).every(key => keys.has(key));
}

function utcDay(iso) {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

function isInt(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * One row per UTC day/category. Real timestamps select the latest run; when
 * legacy dates or equal timestamps cannot be ordered, choose deterministically.
 */
function collapseToDays(records) {
  const latest = new Map();
  for (const record of records) {
    const day = utcDay(record.assessedAt);
    if (!day) return null;
    const key = `${day}|${record.category}`;
    const kept = latest.get(key);
    const recordHasTime = !DATE_ONLY.test(record.assessedAt);
    const keptHasTime = kept && !DATE_ONLY.test(kept.assessedAt);
    const order = !kept ? 1 : recordHasTime !== keptHasTime ? (recordHasTime ? 1 : -1)
      : recordHasTime ? Date.parse(record.assessedAt) - Date.parse(kept.assessedAt) : 0;
    if (order > 0 || (order === 0 && compareText(snapshotTieKey(record), snapshotTieKey(kept)) > 0)) latest.set(key, record);
  }
  return [...latest.values()];
}

function numericReport(report) {
  if (!allowedKeys(report, REPORT_KEYS)) return null;
  const parsed = historicalQualityReportSchema.safeParse({ ...report, summary: PLACEHOLDER_SUMMARY });
  if (!parsed.success) return null;
  const { summary: _summary, ...kept } = parsed.data;
  return kept;
}

function normalizeRecord(record, measurementId = null) {
  if (!plainObject(record) || !timestampSchema.safeParse(record.assessedAt).success) return null;
  const report = numericReport({
    version: 1,
    category: record.category,
    score: record.score,
    worstSeverity: record.worstSeverity,
    coverage: record.coverage,
    confidence: record.confidence,
    scannedFiles: record.scannedFiles,
    totalFiles: record.totalFiles,
  });
  if (!report) return null;
  return {
    assessedAt: DATE_ONLY.test(record.assessedAt) ? record.assessedAt : new Date(record.assessedAt).toISOString(),
    category: report.category,
    score: report.score,
    worstSeverity: report.worstSeverity,
    coverage: report.coverage,
    confidence: report.confidence,
    scannedFiles: report.scannedFiles,
    totalFiles: report.totalFiles,
    measurementId,
  };
}

function compareRecords(a, b) {
  return Date.parse(a.assessedAt) - Date.parse(b.assessedAt)
    || compareText(a.assessedAt, b.assessedAt)
    || compareText(a.category, b.category)
    || compareText(snapshotTieKey(a), snapshotTieKey(b));
}

function formatArrayEntries(values) {
  if (values.length === 0) return '[]';
  // Keep each immutable snapshot item on one diff line, including each row.
  return `[\n${values.map(value => `    ${JSON.stringify(value)}`).join(',\n')}\n  ]`;
}

function canonicalize(repository, records) {
  const categories = [...new Set(records.map(record => record.category))].sort(compareText);
  const categoryIndex = new Map(categories.map((category, index) => [category, index]));
  const coverageIndex = new Map(QUALITY_COVERAGE_VALUES.map((value, index) => [value, index]));
  const confidenceIndex = new Map(QUALITY_CONFIDENCE_VALUES.map((value, index) => [value, index]));
  const measurements = [...records].sort(compareRecords).map(record => [
    record.assessedAt,
    categoryIndex.get(record.category),
    record.score,
    record.worstSeverity,
    coverageIndex.get(record.coverage),
    confidenceIndex.get(record.confidence),
    record.scannedFiles,
    record.totalFiles,
  ]);
  return [
    '{',
    `  "schemaVersion": ${APP_QUALITY_FILE_SCHEMA_VERSION},`,
    `  "repository": ${JSON.stringify(repository)},`,
    `  "reportVersion": ${APP_QUALITY_REPORT_VERSION},`,
    `  "categories": ${formatArrayEntries(categories)},`,
    `  "coverage": ${formatArrayEntries(QUALITY_COVERAGE_VALUES)},`,
    `  "confidence": ${formatArrayEntries(QUALITY_CONFIDENCE_VALUES)},`,
    `  "measurements": ${formatArrayEntries(measurements)}`,
    '}',
    '',
  ].join('\n');
}

/** Distinguish invalid evidence from the capacity limit without discarding it. */
export function serializeQualitySnapshotResult(repository, records) {
  if (typeof repository !== 'string' || !REPOSITORY.test(repository) || !Array.isArray(records)) return { reason: 'invalid-evidence' };
  const normalized = [];
  for (const record of records) {
    const measurementId = typeof record?.measurementId === 'string' && REPOSITORY.test(record.measurementId)
      ? record.measurementId : null;
    const next = normalizeRecord(record, measurementId);
    if (!next) return { reason: 'invalid-evidence' };
    normalized.push(next);
  }
  const days = collapseToDays(normalized);
  if (!days) return { reason: 'invalid-evidence' };
  if (days.length > MAX_QUALITY_SNAPSHOT_ROWS) return { reason: 'snapshot-too-large' };
  if (new Set(days.map(record => record.category)).size > MAX_CATEGORY_NAMES) return { reason: 'snapshot-too-large' };
  return { body: canonicalize(repository, days) };
}

/** Canonical v3 text, or null when the records cannot be serialized. */
export function serializeQualitySnapshot(repository, records) {
  return serializeQualitySnapshotResult(repository, records).body ?? null;
}

/**
 * The category dictionary may name categories a NEWER install added — the
 * catalog grows, and a snapshot committed by an upgraded peer reaches installs
 * that have not upgraded yet. Well-formed names remain numeric history even
 * when this install cannot run that category.
 */
const CATEGORY_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const parseCategoryDictionary = values => parseDictionary(values, { max: MAX_CATEGORY_NAMES, accepts: value => CATEGORY_NAME.test(value) });

/** A dictionary of unique strings, each passing `accepts`, at most `max` long — or null. */
function parseDictionary(values, { max, accepts }) {
  if (!Array.isArray(values) || values.length > max) return null;
  if (values.some(value => typeof value !== 'string' || !accepts(value))) return null;
  if (new Set(values).size !== values.length) return null;
  return values;
}

function parseV1Measurement(measurement) {
  if (!allowedKeys(measurement, MEASUREMENT_KEYS)) return null;
  if (typeof measurement.measurementId !== 'string' || !REPOSITORY.test(measurement.measurementId)) return null;
  if (!timestampSchema.safeParse(measurement.assessedAt).success) return null;
  const report = numericReport(measurement.report);
  if (!report) return null;
  return normalizeRecord({ assessedAt: measurement.assessedAt, ...report }, measurement.measurementId);
}

function parseV1(value) {
  if (!allowedKeys(value, V1_KEYS) || value.schemaVersion !== 1) return { status: 'malformed' };
  if (typeof value.repository !== 'string' || !REPOSITORY.test(value.repository)) return { status: 'malformed' };
  if (!Array.isArray(value.measurements) || value.measurements.length > MAX_QUALITY_SNAPSHOT_ROWS) return { status: 'malformed' };
  const records = [];
  for (const measurement of value.measurements) {
    const record = parseV1Measurement(measurement);
    if (!record) return { status: 'malformed' };
    records.push(record);
  }
  const days = collapseToDays(records);
  if (!days) return { status: 'malformed' };
  const canonical = canonicalize(value.repository, days);
  return canonical
    ? { status: 'v1', repository: value.repository, records: days, canonical }
    : { status: 'malformed' };
}

function parseV2Row(row, categories, coverage, confidence) {
  if (!Array.isArray(row) || row.length !== 8) return null;
  const [assessedAt, categoryIndex, score, worstSeverity, coverageIndex, confidenceIndex, scannedFiles, totalFiles] = row;
  if (!timestampSchema.safeParse(assessedAt).success) return null;
  if (!isInt(categoryIndex, 0, Math.max(categories.length - 1, 0)) || categoryIndex >= categories.length) return null;
  if (!(score === null || isInt(score, 0, 100))) return null;
  if (!isInt(worstSeverity, 0, 10)) return null;
  if (!isInt(coverageIndex, 0, Math.max(coverage.length - 1, 0)) || coverageIndex >= coverage.length) return null;
  if (!isInt(confidenceIndex, 0, Math.max(confidence.length - 1, 0)) || confidenceIndex >= confidence.length) return null;
  if (!isInt(scannedFiles, 0, Number.MAX_SAFE_INTEGER) || !isInt(totalFiles, 0, Number.MAX_SAFE_INTEGER)) return null;
  return normalizeRecord({
    assessedAt,
    category: categories[categoryIndex],
    score,
    worstSeverity,
    coverage: coverage[coverageIndex],
    confidence: confidence[confidenceIndex],
    scannedFiles,
    totalFiles,
  });
}

function parseCompact(value) {
  if (!allowedKeys(value, V2_KEYS) || ![2, 3].includes(value.schemaVersion) || value.reportVersion !== APP_QUALITY_REPORT_VERSION) {
    return { status: 'malformed' };
  }
  if (typeof value.repository !== 'string' || !REPOSITORY.test(value.repository)) return { status: 'malformed' };
  const categories = parseCategoryDictionary(value.categories);
  const coverage = parseDictionary(value.coverage, { max: COVERAGE.size, accepts: v => COVERAGE.has(v) });
  const confidence = parseDictionary(value.confidence, { max: CONFIDENCE.size, accepts: v => CONFIDENCE.has(v) });
  if (!categories || !coverage || !confidence) return { status: 'malformed' };
  if (!Array.isArray(value.measurements) || value.measurements.length > MAX_QUALITY_SNAPSHOT_ROWS) return { status: 'malformed' };
  if (value.measurements.length > 0 && (categories.length === 0 || coverage.length === 0 || confidence.length === 0)) {
    return { status: 'malformed' };
  }
  const records = [];
  for (const row of value.measurements) {
    const record = parseV2Row(row, categories, coverage, confidence);
    if (!record) return { status: 'malformed' };
    records.push(record);
  }
  const days = collapseToDays(records);
  if (!days) return { status: 'malformed' };
  const canonical = canonicalize(value.repository, days);
  return canonical
    ? { status: `v${value.schemaVersion}`, repository: value.repository, records: days, canonical }
    : { status: 'malformed' };
}

/**
 * Classify a snapshot document. `canonical` is the only byte sequence writers
 * emit for that repository and those records. Future schemas stay unparsed.
 */
export function classifyQualitySnapshot(body) {
  if (typeof body !== 'string') return { status: 'unrecognized' };
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status: 'unrecognized' };
  }
  if (!plainObject(parsed) || !Object.hasOwn(parsed, 'schemaVersion')) return { status: 'unrecognized' };
  if (parsed.schemaVersion === 1) return parseV1(parsed);
  if (parsed.schemaVersion === 2 || parsed.schemaVersion === 3) return parseCompact(parsed);
  if (Number.isInteger(parsed.schemaVersion) && parsed.schemaVersion > APP_QUALITY_FILE_SCHEMA_VERSION) {
    return { status: 'future' };
  }
  return { status: 'unrecognized' };
}

/** v1 wire object or compact file object → canonical v3 text, or null. */
export function qualityFileFromWireSnapshot(snapshot) {
  const classified = classifyQualitySnapshot(JSON.stringify(snapshot ?? null));
  return ['v1', 'v2', 'v3'].includes(classified.status) ? classified.canonical : null;
}

/** Digest of a numeric row, used for deterministic ordering and deduplication. */
export function snapshotTieKey(record) {
  return qualityTieKey(record);
}

/** v1 files keep their stored id. Compact rows get the transient digest. */
export function releaseTieId(record) {
  return typeof record?.measurementId === 'string' && REPOSITORY.test(record.measurementId)
    ? record.measurementId
    : snapshotTieKey(record);
}

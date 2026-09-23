/**
 * Checked-in `.quality.json` schema. This is not the peer wire payload.
 *
 * `PORTOS_SCHEMA_VERSIONS.appQuality` stays the v1 federation object. Writers
 * emit only canonical file schema v2. v1 JSON and a historical
 * `quality-snapshot.json` body normalize to the same records; a future schema
 * is recognized and left for the publisher to report, not reinterpreted.
 *
 * Rows are `[assessedAt, categoryIndex, score, worstSeverity, coverageIndex,
 * confidenceIndex, scannedFiles, totalFiles]`. `measurementId` is not stored.
 * Same-timestamp selection uses the v1 id while a file still has one, otherwise
 * a transient digest of the normalized row (`releaseTieId`). The digest is not
 * written. PostgreSQL remains the history; this file is only the bounded
 * projection the publisher already built.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AUDIT_DEFINITIONS, LEGACY_AUDIT_TASK_TYPE_ALIASES } from '../lib/auditCatalog.js';
import { auditQualityReportSchema } from '../lib/auditQuality.js';

export const APP_QUALITY_FILE_SCHEMA_VERSION = 2;
export const APP_QUALITY_REPORT_VERSION = 1;
export const APP_QUALITY_LEGACY_SNAPSHOT_FILENAME = 'quality-snapshot.json';
export const QUALITY_COVERAGE_VALUES = Object.freeze(['broad', 'partial', 'unavailable', 'not-applicable']);
export const QUALITY_CONFIDENCE_VALUES = Object.freeze(['low', 'medium', 'high']);
export const MAX_QUALITY_SNAPSHOT_ROWS = 10000;

const REPOSITORY = /^[a-f0-9]{64}$/;
const CATEGORIES = new Set(Object.keys(AUDIT_DEFINITIONS));
const READABLE_CATEGORIES = new Set([...CATEGORIES, ...Object.keys(LEGACY_AUDIT_TASK_TYPE_ALIASES)]);
const COVERAGE = new Set(QUALITY_COVERAGE_VALUES);
const CONFIDENCE = new Set(QUALITY_CONFIDENCE_VALUES);
const V1_KEYS = new Set(['schemaVersion', 'repository', 'measurements']);
const V2_KEYS = new Set(['schemaVersion', 'repository', 'reportVersion', 'categories', 'coverage', 'confidence', 'measurements']);
const MEASUREMENT_KEYS = new Set(['measurementId', 'assessedAt', 'report']);
const REPORT_KEYS = new Set(['version', 'category', 'score', 'worstSeverity', 'coverage', 'confidence', 'summary', 'scannedFiles', 'totalFiles']);
const PLACEHOLDER_SUMMARY = 'Numeric assessment';
// Z and numeric offsets are both ISO instants. Zod's default datetime() rejects
// offsets, which would treat one UTC day as two when the date prefix differs.
const timestampSchema = z.iso.datetime({ offset: true });

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

function duplicateDays(records) {
  const seen = new Set();
  for (const record of records) {
    const day = utcDay(record.assessedAt);
    if (!day) return true;
    const key = `${day}|${record.category}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function numericReport(report) {
  if (!allowedKeys(report, REPORT_KEYS)) return null;
  const parsed = auditQualityReportSchema.safeParse({ ...report, summary: PLACEHOLDER_SUMMARY });
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
    assessedAt: record.assessedAt,
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
    || compareText(a.category, b.category);
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

/** Canonical v2 text, or null when the records are not a valid projection. */
export function serializeQualitySnapshot(repository, records) {
  if (typeof repository !== 'string' || !REPOSITORY.test(repository) || !Array.isArray(records)) return null;
  if (records.length > MAX_QUALITY_SNAPSHOT_ROWS) return null;
  const normalized = [];
  for (const record of records) {
    const measurementId = typeof record?.measurementId === 'string' && REPOSITORY.test(record.measurementId)
      ? record.measurementId : null;
    const next = normalizeRecord(record, measurementId);
    if (!next) return null;
    normalized.push(next);
  }
  if (duplicateDays(normalized)) return null;
  return canonicalize(repository, normalized);
}

function parseDictionary(values, allowed) {
  if (!Array.isArray(values) || values.length > allowed.size) return null;
  if (values.some(value => typeof value !== 'string' || !allowed.has(value))) return null;
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
  if (duplicateDays(records)) return { status: 'malformed' };
  const canonical = canonicalize(value.repository, records);
  return canonical
    ? { status: 'v1', repository: value.repository, records, canonical }
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

function parseV2(value) {
  if (!allowedKeys(value, V2_KEYS) || value.schemaVersion !== 2 || value.reportVersion !== APP_QUALITY_REPORT_VERSION) {
    return { status: 'malformed' };
  }
  if (typeof value.repository !== 'string' || !REPOSITORY.test(value.repository)) return { status: 'malformed' };
  const categories = parseDictionary(value.categories, READABLE_CATEGORIES);
  const coverage = parseDictionary(value.coverage, COVERAGE);
  const confidence = parseDictionary(value.confidence, CONFIDENCE);
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
  if (duplicateDays(records)) return { status: 'malformed' };
  const canonical = canonicalize(value.repository, records);
  return canonical
    ? { status: 'v2', repository: value.repository, records, canonical }
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
  if (parsed.schemaVersion === 2) return parseV2(parsed);
  if (Number.isInteger(parsed.schemaVersion) && parsed.schemaVersion > APP_QUALITY_FILE_SCHEMA_VERSION) {
    return { status: 'future' };
  }
  return { status: 'unrecognized' };
}

/** v1 wire object or v2 file object → canonical v2 text, or null. */
export function qualityFileFromWireSnapshot(snapshot) {
  const classified = classifyQualitySnapshot(JSON.stringify(snapshot ?? null));
  return classified.status === 'v1' || classified.status === 'v2' ? classified.canonical : null;
}

/** Digest of the scoring row. Not stored in v2; used only to order timestamp ties. */
export function snapshotTieKey(record) {
  return createHash('sha256').update(JSON.stringify([
    record.assessedAt,
    record.category,
    record.score,
    record.worstSeverity,
    record.coverage,
    record.confidence,
    record.scannedFiles,
    record.totalFiles,
  ])).digest('hex');
}

/** v1 files keep their stored id. v2 rows get the transient digest. */
export function releaseTieId(record) {
  return typeof record?.measurementId === 'string' && REPOSITORY.test(record.measurementId)
    ? record.measurementId
    : snapshotTieKey(record);
}

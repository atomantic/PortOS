import { it, expect } from 'vitest';
import { AUDIT_DEFINITIONS } from '../lib/auditCatalog.js';
import { compareQualityRecords } from '../lib/auditQuality.js';
import { APP_QUALITY_SNAPSHOT_MAX_BYTES } from './appQualitySnapshotFile.js';
import {
  APP_QUALITY_FILE_SCHEMA_VERSION, QUALITY_COVERAGE_VALUES, QUALITY_CONFIDENCE_VALUES,
  classifyQualitySnapshot, qualityFileFromWireSnapshot, releaseTieId, serializeQualitySnapshot,
  snapshotTieKey,
} from './appQualitySnapshotFormat.js';

const repository = 'a'.repeat(64);
const measurementId = 'b'.repeat(64);
const security = {
  assessedAt: '2026-09-20T00:00:00.000Z',
  category: 'security',
  score: 82,
  worstSeverity: 5,
  coverage: 'broad',
  confidence: 'high',
  scannedFiles: 120,
  totalFiles: 120,
};
const typing = {
  assessedAt: '2026-09-21T00:00:00.000Z',
  category: 'typing',
  score: null,
  worstSeverity: 0,
  coverage: 'not-applicable',
  confidence: 'low',
  scannedFiles: 0,
  totalFiles: 4,
};

function v1Document(measurements) {
  return {
    schemaVersion: 1,
    repository,
    measurements: measurements.map(record => ({
      measurementId: record.measurementId || measurementId,
      assessedAt: record.assessedAt,
      report: {
        version: 1,
        category: record.category,
        score: record.score,
        worstSeverity: record.worstSeverity,
        coverage: record.coverage,
        confidence: record.confidence,
        summary: 'private narrative for example-user and agent-example',
        scannedFiles: record.scannedFiles,
        totalFiles: record.totalFiles,
      },
    })),
  };
}

it('serializes canonical v2 rows with stable indexes and no provenance', () => {
  const text = serializeQualitySnapshot(repository, [{ ...typing }, { ...security, measurementId }]);
  const parsed = JSON.parse(text);
  expect(APP_QUALITY_FILE_SCHEMA_VERSION).toBe(2);
  expect(parsed).toEqual({
    schemaVersion: 2,
    repository,
    reportVersion: 1,
    categories: ['security', 'typing'],
    coverage: [...QUALITY_COVERAGE_VALUES],
    confidence: [...QUALITY_CONFIDENCE_VALUES],
    measurements: [
      ['2026-09-20T00:00:00.000Z', 0, 82, 5, 0, 2, 120, 120],
      ['2026-09-21T00:00:00.000Z', 1, null, 0, 3, 0, 0, 4],
    ],
  });
  expect(text).toBe([
    '{',
    '  "schemaVersion": 2,',
    `  "repository": "${repository}",`,
    '  "reportVersion": 1,',
    '  "categories": [',
    '    "security",',
    '    "typing"',
    '  ],',
    '  "coverage": [',
    '    "broad",',
    '    "partial",',
    '    "unavailable",',
    '    "not-applicable"',
    '  ],',
    '  "confidence": [',
    '    "low",',
    '    "medium",',
    '    "high"',
    '  ],',
    '  "measurements": [',
    '    ["2026-09-20T00:00:00.000Z",0,82,5,0,2,120,120],',
    '    ["2026-09-21T00:00:00.000Z",1,null,0,3,0,0,4]',
    '  ]',
    '}',
    '',
  ].join('\n'));
  expect(text.endsWith('\n')).toBe(true);
  expect(text).not.toMatch(/measurementId|example-user|agent-example|summary/);
  expect(classifyQualitySnapshot(text).canonical).toBe(text);
  const reversed = serializeQualitySnapshot(repository, [typing, security]);
  expect(reversed).toBe(text);
});

it('normalizes v1 JSON idempotently and keeps its measurement id off the v2 bytes', () => {
  const wire = v1Document([security, typing]);
  const first = classifyQualitySnapshot(JSON.stringify(wire));
  expect(first.status).toBe('v1');
  expect(first.records.map(record => record.measurementId)).toEqual([measurementId, measurementId]);
  expect(first.records.map(record => record.score)).toEqual([82, null]);
  expect(JSON.stringify(first.records)).not.toMatch(/example-user|agent-example/);
  const second = classifyQualitySnapshot(first.canonical);
  expect(second.status).toBe('v2');
  expect(second.canonical).toBe(first.canonical);
  expect(second.records.map(record => record.measurementId)).toEqual([null, null]);
  expect(qualityFileFromWireSnapshot(wire)).toBe(first.canonical);
  expect(first.canonical).not.toContain(measurementId);
});

it('rejects future, unrecognized, malformed, duplicate-day, and invalid-index documents', () => {
  expect(classifyQualitySnapshot('category\tscore\n').status).toBe('unrecognized');
  expect(classifyQualitySnapshot('{"quality":true}').status).toBe('unrecognized');
  expect(classifyQualitySnapshot(JSON.stringify({ schemaVersion: 3, repository })).status).toBe('future');
  expect(classifyQualitySnapshot(JSON.stringify({ ...v1Document([security]), schemaVersion: 2 })).status).toBe('malformed');
  expect(classifyQualitySnapshot(JSON.stringify({ ...v1Document([security]), note: true })).status).toBe('malformed');

  const sameDay = v1Document([
    security,
    { ...security, assessedAt: '2026-09-19T22:30:00-04:00', score: 10 },
  ]);
  expect(classifyQualitySnapshot(JSON.stringify(sameDay)).status).toBe('malformed');
  const nextDay = v1Document([
    security,
    { ...security, assessedAt: '2026-09-20T20:30:00-04:00', score: 70 },
  ]);
  expect(classifyQualitySnapshot(JSON.stringify(nextDay)).status).toBe('v1');

  const badIndex = classifyQualitySnapshot(JSON.stringify({
    schemaVersion: 2, repository, reportVersion: 1,
    categories: ['security'], coverage: [...QUALITY_COVERAGE_VALUES], confidence: [...QUALITY_CONFIDENCE_VALUES],
    measurements: [['2026-09-20T00:00:00.000Z', 4, 82, 5, 0, 2, 120, 120]],
  }));
  expect(badIndex.status).toBe('malformed');
  expect(serializeQualitySnapshot(repository, [security, { ...security, score: 1 }])).toBeNull();
});

it('keeps v1 tie ids and orders v2 rows with a transient digest', () => {
  const low = { ...security, score: 25 };
  const high = { ...security, score: 75 };
  expect(snapshotTieKey(low)).not.toBe(snapshotTieKey(high));
  expect(snapshotTieKey({ ...low, measurementId: 'c'.repeat(64) })).toBe(snapshotTieKey(low));
  expect(releaseTieId({ ...low, measurementId })).toBe(measurementId);
  expect(releaseTieId({ ...low, measurementId: null })).toBe(snapshotTieKey(low));
  const winner = rows => [...rows].sort(compareQualityRecords).at(-1).score;
  const keyed = record => ({ ...record, measurementId: snapshotTieKey(record) });
  expect(winner([keyed(low), keyed(high)])).toBe(winner([keyed(high), keyed(low)]));
  expect(classifyQualitySnapshot(serializeQualitySnapshot(repository, [low])).canonical).not.toContain(snapshotTieKey(low));
});

it('keeps a full 30-day category window under the cap and materially smaller than v1', () => {
  const categories = Object.keys(AUDIT_DEFINITIONS);
  const start = Date.parse('2026-08-01T00:00:00.000Z');
  const records = [];
  for (let day = 0; day < 30; day += 1) {
    const assessedAt = new Date(start + day * 86400000).toISOString();
    for (const category of categories) {
      records.push({
        assessedAt, category, score: 80, worstSeverity: 3,
        coverage: 'broad', confidence: 'high', scannedFiles: 10, totalFiles: 10,
      });
    }
  }
  const v2 = serializeQualitySnapshot(repository, records);
  const v1 = `${JSON.stringify(v1Document(records), null, 2)}\n`;
  const rows = JSON.parse(v2).measurements;
  expect(rows).toHaveLength(30 * categories.length);
  expect(Buffer.byteLength(v2)).toBeLessThan(APP_QUALITY_SNAPSHOT_MAX_BYTES);
  expect(Buffer.byteLength(v2)).toBeLessThan(Buffer.byteLength(v1) * 0.5);
  const oneCategory = records.filter(record => record.category === categories[0]);
  expect(JSON.parse(serializeQualitySnapshot(repository, records)).measurements)
    .toHaveLength(JSON.parse(serializeQualitySnapshot(repository, oneCategory)).measurements.length * categories.length);
  expect(JSON.parse(classifyQualitySnapshot(v2).canonical).measurements).toHaveLength(rows.length);
});

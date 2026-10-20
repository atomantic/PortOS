/**
 * ZIP-extraction temp-directory contract for POST /api/health/import/xml.
 *
 * The extracted export.xml used to be minted as `apple-health-${Date.now()}.xml`
 * in the shared temp dir, so two imports issued inside the same millisecond
 * wrote into one another's file — and a failed import left the multi-GB
 * extraction behind forever (issue #5654).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { createZip } from '../lib/zipWriter.js';

const imports = vi.hoisted(() => ({ paths: [], impl: null, limits: undefined }));
vi.mock('../lib/zipStream.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createZipBudget: options => actual.createZipBudget(imports.limits ?? options) };
});
vi.mock('../services/appleHealthXml.js', () => ({
  importAppleHealthXml: vi.fn(async (filePath) => {
    imports.paths.push(filePath);
    if (imports.impl) return imports.impl(filePath);
    return { days: 1, records: 2 };
  }),
}));
vi.mock('../services/appleHealthQuery.js', () => ({
  getMetricSummary: vi.fn(), getDailyAggregates: vi.fn(), getAvailableDateRange: vi.fn(),
  getCorrelationData: vi.fn(), getAvailableMetrics: vi.fn(),
  getLatestMetricValues: vi.fn(async () => ({ step_count: 1 })),
}));
vi.mock('../services/appleHealthClinical.js', () => ({
  importClinicalRecords: vi.fn(async () => ({ imported: 0 })),
}));

const { default: appleHealthRoutes } = await import('./appleHealth.js');

const XML = '<?xml version="1.0"?><HealthData><Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2025-01-15 08:00:00 -0800" value="120"/></HealthData>';

const buildApp = () => {
  const app = express();
  app.use('/api/health', appleHealthRoutes);
  app.use(errorMiddleware);
  return app;
};

const multipart = (boundary, bytes, fileName = 'export.zip') => Buffer.concat([
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/zip\r\n\r\n`),
  bytes,
  Buffer.from(`\r\n--${boundary}--\r\n`),
]);

const postZip = (entries) => request(buildApp())
  .post('/api/health/import/xml')
  .set('content-type', 'multipart/form-data; boundary=----portoshealth')
  .send(multipart('----portoshealth', createZip(entries)));

const extractDirs = async () =>
  (await readdir(tmpdir())).filter((n) => n.startsWith('portos-apple-health-'));

describe('POST /api/health/import/xml — ZIP extraction temp dir', () => {
  let preexisting;

  beforeEach(async () => {
    imports.paths = [];
    imports.impl = null;
    imports.limits = undefined;
    preexisting = new Set(await extractDirs());
  });

  afterEach(async () => {
    const leaked = (await extractDirs()).filter((n) => !preexisting.has(n));
    expect(leaked).toEqual([]);
  });

  it('rejects a high-ratio XML member and removes the partial extraction', async () => {
    const zip = createZip([{ name: 'export.xml', data: 'A'.repeat(1024 * 1024) }], { compress: true });
    const res = await request(buildApp()).post('/api/health/import/xml')
      .set('content-type', 'multipart/form-data; boundary=----portoshealth')
      .send(multipart('----portoshealth', zip));
    expect(res.status).toBe(413);
    expect(imports.paths).toHaveLength(0);
    // afterEach checks that the partial XML and extraction directory are gone.
  });

  it.each([{ maxTotalBytes: 5 }, { maxEntries: 1 }])('rejects aggregate clinical-record limits and cleans extraction: %j', async (limits) => {
    imports.limits = limits;
    const res = await postZip([
      { name: 'export.xml', data: XML },
      { name: 'clinical_records/a.json', data: '{} ' },
      { name: 'clinical_records/b.json', data: '{} ' }
    ]);
    expect(res.status).toBe(413);
    expect(imports.paths).toHaveLength(0);
  });

  it('rejects duplicate XML destinations without leaving an extracted file', async () => {
    const res = await postZip([
      { name: 'export.xml', data: XML },
      { name: 'apple_health_export/export.xml', data: XML }
    ]);
    expect(res.status).toBe(400);
    expect(imports.paths).toHaveLength(0);
  });

  it('gives back-to-back imports distinct extraction directories and cleans both up', async () => {
    const entries = [{ name: 'apple_health_export/export.xml', data: XML }];

    const [a, b] = await Promise.all([postZip(entries), postZip(entries)]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(imports.paths).toHaveLength(2);
    expect(imports.paths[0]).not.toBe(imports.paths[1]);
    for (const p of imports.paths) expect(p).toMatch(/portos-apple-health-[^/\\]+[/\\]export\.xml$/);
  });

  it('removes the extraction directory when the import itself fails', async () => {
    imports.impl = () => { throw new Error('parse exploded'); };

    const res = await postZip([{ name: 'export.xml', data: XML }]);

    expect(res.status).toBe(500);
    // afterEach asserts nothing was left behind.
  });

  it('removes the extraction directory when the ZIP has no export.xml', async () => {
    const res = await postZip([{ name: 'apple_health_export/other.txt', data: 'nope' }]);

    expect(res.status).toBe(400);
    expect(imports.paths).toHaveLength(0);
  });
});

describe('GET /api/health/metrics/latest query validation', () => {
  it('accepts a comma-separated metrics list and refuses repeated keys with 400', async () => {
    const { getLatestMetricValues } = await import('../services/appleHealthQuery.js');
    const ok = await request(buildApp()).get('/api/health/metrics/latest?metrics=step_count,heart_rate');
    expect(ok.status).toBe(200);
    expect(getLatestMetricValues).toHaveBeenCalledWith(['step_count', 'heart_rate']);

    const repeated = await request(buildApp()).get('/api/health/metrics/latest?metrics=step_count&metrics=heart_rate');
    expect(repeated.status).toBe(400);
    expect(repeated.body.code).toBe('VALIDATION_ERROR');
  });
});

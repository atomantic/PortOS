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

const imports = vi.hoisted(() => ({ paths: [], impl: null }));
vi.mock('../services/appleHealthXml.js', () => ({
  importAppleHealthXml: vi.fn(async (filePath) => {
    imports.paths.push(filePath);
    if (imports.impl) return imports.impl(filePath);
    return { days: 1, records: 2 };
  }),
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
    preexisting = new Set(await extractDirs());
  });

  afterEach(async () => {
    const leaked = (await extractDirs()).filter((n) => !preexisting.has(n));
    expect(leaked).toEqual([]);
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

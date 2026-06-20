import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { LEGACY_EXPORT_SECTIONS } from '../lib/validation.js';
import { getSectionKeys } from '../services/legacyExport.js';

// Mock the service so the route test stays fast and binary-free — the bundle
// itself is covered by legacyExport.test.js.
const buildLegacyZip = vi.fn(async () => ({ buffer: Buffer.from('PK-fake-zip'), manifest: { fileCount: 1 } }));
const previewLegacyExport = vi.fn(async () => ({ sections: { goals: { present: true } }, fileCount: 4, estimatedBytes: 1234 }));
vi.mock('../services/legacyExport.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildLegacyZip: (...a) => buildLegacyZip(...a), previewLegacyExport: (...a) => previewLegacyExport(...a) };
});

function makeApp() {
  const app = express();
  app.use(express.json());
  return import('./legacyExport.js').then(({ default: router }) => {
    app.use('/api/legacy-export', router);
    app.use(errorMiddleware);
    return app;
  });
}

beforeEach(() => {
  buildLegacyZip.mockClear();
  previewLegacyExport.mockClear();
});

describe('GET /api/legacy-export/preview', () => {
  it('returns the section preview', async () => {
    const app = await makeApp();
    const res = await request(app).get('/api/legacy-export/preview');
    expect(res.status).toBe(200);
    expect(res.body.sections).toBeDefined();
    expect(res.body.estimatedBytes).toBe(1234);
    expect(previewLegacyExport).toHaveBeenCalledOnce();
  });
});

describe('POST /api/legacy-export', () => {
  it('streams a zip attachment with a date-stamped filename', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/legacy-export').send({});
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="legacy-export-\d{4}-\d{2}-\d{2}\.zip"/);
    expect(buildLegacyZip).toHaveBeenCalledWith(expect.objectContaining({ sections: null }));
  });

  it('passes a section filter through to the service', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/legacy-export').send({ sections: ['goals', 'health'] });
    expect(res.status).toBe(200);
    expect(buildLegacyZip).toHaveBeenCalledWith(expect.objectContaining({ sections: ['goals', 'health'] }));
  });

  it('threads includePdf through to the service', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/legacy-export').send({ includePdf: true });
    expect(res.status).toBe(200);
    expect(buildLegacyZip).toHaveBeenCalledWith(expect.objectContaining({ includePdf: true }));
  });

  it('defaults includePdf to false when omitted', async () => {
    const app = await makeApp();
    await request(app).post('/api/legacy-export').send({});
    expect(buildLegacyZip).toHaveBeenCalledWith(expect.objectContaining({ includePdf: false }));
  });

  it('rejects a non-boolean includePdf with 400', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/legacy-export').send({ includePdf: 'yes' });
    expect(res.status).toBe(400);
    expect(buildLegacyZip).not.toHaveBeenCalled();
  });

  it('rejects an unknown section with 400', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/legacy-export').send({ sections: ['not-a-section'] });
    expect(res.status).toBe(400);
    expect(buildLegacyZip).not.toHaveBeenCalled();
  });
});

describe('schema/service section parity', () => {
  it('LEGACY_EXPORT_SECTIONS matches the service section keys', () => {
    expect(LEGACY_EXPORT_SECTIONS).toEqual(getSectionKeys());
  });
});

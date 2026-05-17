import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import importerRoutes from './importer.js';
import { ERR_VALIDATION, ERR_LOCKED, IMPORTER_SOURCE_CHAR_LIMIT } from '../services/importer.js';
import * as universeSvc from '../services/universeBuilder.js';
import * as seriesSvc from '../services/pipeline/series.js';
import { ARC_ROLES } from '../lib/storyArc.js';

vi.mock('../services/importer.js', async () => {
  const actual = await vi.importActual('../services/importer.js');
  return {
    ...actual,               // real ERR_VALIDATION, ERR_LOCKED, IMPORTER_SOURCE_CHAR_LIMIT, etc.
    analyzeImport: vi.fn(),  // mocked behavior
    commitImport: vi.fn(),   // mocked behavior
  };
});

// No mock for ../services/universeBuilder.js, ../services/pipeline/series.js,
// or ../lib/storyArc.js — the route only reads `ERR_NOT_FOUND` constants
// from the service modules and `ARC_ROLES`/`ARC_SHAPE_IDS` from storyArc.
// Using the real modules keeps `ERR_NOT_FOUND` aligned with the
// SERVICE_ERROR_STATUS map, and keeps the Zod enums aligned with the
// prompts — placeholder mocks would silently mask drift.

import * as importerSvc from '../services/importer.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/importer', importerRoutes);
  return app;
}

describe('GET /api/importer/config', () => {
  it('returns sourceCharLimit and arcRoles', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/importer/config');
    expect(res.status).toBe(200);
    expect(res.body.sourceCharLimit).toBe(IMPORTER_SOURCE_CHAR_LIMIT);
    expect(Array.isArray(res.body.arcRoles)).toBe(true);
  });
});

describe('POST /api/importer/analyze', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 with the service result on success', async () => {
    importerSvc.analyzeImport.mockResolvedValue({ universe: {}, series: {}, issueProposals: [] });
    const app = buildApp();
    const res = await request(app).post('/api/importer/analyze').send({
      universeName: 'U',
      seriesName: 'S',
      contentType: 'short-story',
      source: 'text',
    });
    expect(res.status).toBe(200);
    expect(res.body.issueProposals).toEqual([]);
  });

  it('returns 400 when the service throws ERR_VALIDATION', async () => {
    const err = Object.assign(new Error('source is required'), { code: ERR_VALIDATION });
    importerSvc.analyzeImport.mockRejectedValue(err);
    const app = buildApp();
    const res = await request(app).post('/api/importer/analyze').send({
      universeName: 'U',
      seriesName: 'S',
      contentType: 'short-story',
      source: 'x',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ERR_VALIDATION);
  });

  it('returns 409 when the service throws ERR_LOCKED', async () => {
    const err = Object.assign(
      new Error('Series "X" has a locked arc.'),
      { code: ERR_LOCKED },
    );
    importerSvc.analyzeImport.mockRejectedValue(err);
    const app = buildApp();
    const res = await request(app).post('/api/importer/analyze').send({
      universeName: 'U',
      seriesName: 'X',
      contentType: 'short-story',
      source: 'text',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ERR_LOCKED);
  });
});

describe('POST /api/importer/commit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 with the service result on success', async () => {
    importerSvc.commitImport.mockResolvedValue({
      universe: {}, series: {}, createdIssueIds: ['issue-1'], remappedIssues: [],
    });
    const app = buildApp();
    const res = await request(app).post('/api/importer/commit').send({
      universeId: 'uni-1',
      seriesId: 'ser-1',
      canonSelections: { characters: [], places: [], objects: [] },
      arc: null,
      seasons: [],
      issues: [{ title: 'I1', arcPosition: 1 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.createdIssueIds).toEqual(['issue-1']);
  });

  it('returns 400 when the service throws ERR_VALIDATION', async () => {
    const err = Object.assign(new Error('universeId is required'), { code: ERR_VALIDATION });
    importerSvc.commitImport.mockRejectedValue(err);
    const app = buildApp();
    const res = await request(app).post('/api/importer/commit').send({
      universeId: 'uni-1',
      seriesId: 'ser-1',
      canonSelections: { characters: [], places: [], objects: [] },
      arc: null,
      seasons: [],
      issues: [{ title: 'I1', arcPosition: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ERR_VALIDATION);
  });

  it('returns 409 when the service throws ERR_LOCKED', async () => {
    const err = Object.assign(
      new Error('Series "X" has a locked arc — commit refused.'),
      { code: ERR_LOCKED },
    );
    importerSvc.commitImport.mockRejectedValue(err);
    const app = buildApp();
    const res = await request(app).post('/api/importer/commit').send({
      universeId: 'uni-1',
      seriesId: 'ser-1',
      canonSelections: { characters: [], places: [], objects: [] },
      arc: null,
      seasons: [],
      issues: [{ title: 'I1', arcPosition: 1 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ERR_LOCKED);
  });

  it('returns 404 when the service throws the universe not-found code', async () => {
    const err = Object.assign(new Error('Universe not found'), { code: universeSvc.ERR_NOT_FOUND });
    importerSvc.commitImport.mockRejectedValue(err);
    const app = buildApp();
    const res = await request(app).post('/api/importer/commit').send({
      universeId: 'missing',
      seriesId: 'ser-1',
      canonSelections: { characters: [], places: [], objects: [] },
      arc: null,
      seasons: [],
      issues: [{ title: 'I1', arcPosition: 1 }],
    });
    expect(res.status).toBe(404);
    // Pin the code too — a rename of universeSvc.ERR_NOT_FOUND would
    // otherwise silently land here because SERVICE_ERROR_STATUS[undefined]
    // falls through to the generic 500 handler and the status assertion
    // alone wouldn't catch the regression.
    expect(res.body.code).toBe(universeSvc.ERR_NOT_FOUND);
  });
});

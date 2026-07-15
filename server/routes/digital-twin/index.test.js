import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';

// The route delegates to several service modules; we don't exercise their
// internals here — this suite pins the ROUTE contract (Zod validation → 400,
// status mapping → 404/201/204, and one happy path per operation group). Each
// service method the route calls is mocked as a vi.fn(); tests override only
// the few they assert on. (Vitest mock factories must return a plain object,
// not a Proxy, so the method list is spelled out.)
// Hoisted so the vi.mock factories below (which are hoisted to the top of the
// module) can call it.
const fnMap = vi.hoisted(() => (names) => Object.fromEntries(names.map((n) => [n, vi.fn()])));

vi.mock('../../services/digital-twin.js', () => fnMap([
  'getDigitalTwinStatus', 'getDocuments', 'getDocumentById', 'createDocument', 'updateDocument', 'deleteDocument',
  'parseTestSuite', 'runTests', 'runMultiTests', 'getTestHistory', 'parseValuesAlignmentSuite', 'runValuesAlignmentTests',
  'getValuesAlignmentHistory', 'parseAdversarialSuite', 'runAdversarialTests', 'getAdversarialTestHistory',
  'parseMultiTurnSuite', 'runMultiTurnTests', 'getMultiTurnTestHistory', 'getEnrichmentCategories', 'getEnrichmentProgress',
  'generateEnrichmentQuestion', 'processEnrichmentAnswer', 'analyzeEnrichmentList', 'saveEnrichmentListDocument',
  'getEnrichmentListItems', 'getExportFormats', 'exportDigitalTwin', 'loadMeta', 'updateSettings', 'getPersonas',
  'createPersona', 'getActivePersona', 'setActivePersona', 'updatePersona', 'deletePersona', 'getPersonaById',
  'validateCompleteness', 'detectContradictions', 'generateDynamicTests', 'analyzeWritingSamples', 'compareSpokenWrittenStyle',
  'analyzeIdentityImage', 'saveIdentityImageDocument', 'getTraits', 'analyzeTraits', 'updateTraits', 'getConfidence',
  'calculateConfidence', 'getGapRecommendations', 'analyzeAssessment', 'getImportSources', 'analyzeImportedData',
  'saveImportAsDocument',
]));
vi.mock('../../services/taste-questionnaire.js', () => fnMap([
  'TASTE', 'getNextQuestion', 'submitAnswer', 'getTasteProfile', 'getSectionResponses', 'generateSectionSummary',
  'generateOverallSummary', 'resetSection', 'generatePersonalizedTasteQuestion',
]));
vi.mock('../../services/feedbackLoop.js', () => fnMap([
  'submitFeedback', 'getFeedbackStats', 'getRecentFeedback', 'recalculateWeights',
]));
vi.mock('../../services/timeCapsule.js', () => fnMap([
  'createSnapshot', 'listSnapshots', 'getSnapshot', 'deleteSnapshot', 'compareSnapshots',
]));

import digitalTwinRoutes from './index.js';
import * as digitalTwinService from '../../services/digital-twin.js';

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

describe('Digital Twin Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/digital-twin', digitalTwinRoutes);
    vi.clearAllMocks();
  });

  describe('GET / (status)', () => {
    it('returns the status summary', async () => {
      digitalTwinService.getDigitalTwinStatus.mockResolvedValue({ documentCount: 3, enabled: true });
      const res = await request(app).get('/api/digital-twin');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ documentCount: 3, enabled: true });
    });
  });

  describe('documents', () => {
    it('GET /documents lists documents', async () => {
      digitalTwinService.getDocuments.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
      const res = await request(app).get('/api/digital-twin/documents');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('GET /documents returns a bounded envelope when pagination is requested (#2535)', async () => {
      digitalTwinService.getDocuments.mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => ({ id: `doc-${i}` })),
      );
      const res = await request(app).get('/api/digital-twin/documents?limit=2&offset=1');
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items[0].id).toBe('doc-1');
      expect(res.body.total).toBe(5);
      expect(res.body.limit).toBe(2);
      expect(res.body.offset).toBe(1);
    });

    it('GET /documents/:id returns 404 for an unknown doc', async () => {
      digitalTwinService.getDocumentById.mockResolvedValue(null);
      const res = await request(app).get('/api/digital-twin/documents/nope');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('POST /documents creates a document (201)', async () => {
      const created = { id: 'doc-1', filename: 'bio.md', title: 'Bio' };
      digitalTwinService.createDocument.mockResolvedValue(created);
      const res = await request(app)
        .post('/api/digital-twin/documents')
        .send({ filename: 'bio.md', title: 'Bio', category: 'core', content: 'Hello world' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual(created);
      expect(digitalTwinService.createDocument).toHaveBeenCalledOnce();
    });

    it('POST /documents 400s on a missing required field (no title)', async () => {
      const res = await request(app)
        .post('/api/digital-twin/documents')
        .send({ filename: 'bio.md', category: 'core', content: 'Hello' });
      expect(res.status).toBe(400);
      expect(digitalTwinService.createDocument).not.toHaveBeenCalled();
    });

    it('POST /documents 400s on an invalid filename (not *.md)', async () => {
      const res = await request(app)
        .post('/api/digital-twin/documents')
        .send({ filename: 'bio.txt', title: 'Bio', category: 'core', content: 'Hello' });
      expect(res.status).toBe(400);
    });

    it('PUT /documents/:id returns 404 when the doc is unknown', async () => {
      digitalTwinService.updateDocument.mockResolvedValue(null);
      const res = await request(app)
        .put('/api/digital-twin/documents/ghost')
        .send({ title: 'New' });
      expect(res.status).toBe(404);
    });

    it('DELETE /documents/:id returns 204 on success', async () => {
      digitalTwinService.deleteDocument.mockResolvedValue(true);
      const res = await request(app).delete('/api/digital-twin/documents/doc-1');
      expect(res.status).toBe(204);
    });

    it('DELETE /documents/:id returns 404 when nothing was deleted', async () => {
      digitalTwinService.deleteDocument.mockResolvedValue(false);
      const res = await request(app).delete('/api/digital-twin/documents/ghost');
      expect(res.status).toBe(404);
    });
  });

  describe('tests', () => {
    it('GET /tests parses + returns the suite', async () => {
      digitalTwinService.parseTestSuite.mockResolvedValue([{ id: 1, prompt: 'x' }]);
      const res = await request(app).get('/api/digital-twin/tests');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it('POST /tests/run runs the suite (happy path)', async () => {
      digitalTwinService.runTests.mockResolvedValue({ runId: 'r1', results: [] });
      const res = await request(app)
        .post('/api/digital-twin/tests/run')
        .send({ providerId: 'p1', model: 'm1' });
      expect(res.status).toBe(200);
      expect(digitalTwinService.runTests).toHaveBeenCalledOnce();
    });

    it('POST /tests/run 400s without providerId/model', async () => {
      const res = await request(app).post('/api/digital-twin/tests/run').send({ testIds: [1] });
      expect(res.status).toBe(400);
      expect(digitalTwinService.runTests).not.toHaveBeenCalled();
    });

    it('POST /tests/run 404s for an unknown personaId', async () => {
      digitalTwinService.getPersonaById.mockResolvedValue(null);
      const res = await request(app)
        .post('/api/digital-twin/tests/run')
        .send({ providerId: 'p1', model: 'm1', personaId: VALID_UUID });
      expect(res.status).toBe(404);
      expect(digitalTwinService.runTests).not.toHaveBeenCalled();
    });
  });

  describe('export', () => {
    it('POST /export 400s on an invalid format', async () => {
      const res = await request(app).post('/api/digital-twin/export').send({ format: 'invalid-format' });
      expect(res.status).toBe(400);
    });

    it('POST /export returns the export payload on a valid format', async () => {
      digitalTwinService.exportDigitalTwin.mockResolvedValue({ format: 'json', content: '# Twin' });
      const res = await request(app).post('/api/digital-twin/export').send({ format: 'json' });
      expect(res.status).toBe(200);
      expect(res.body.format).toBe('json');
    });
  });

  describe('settings', () => {
    it('GET /settings returns settings', async () => {
      digitalTwinService.loadMeta.mockResolvedValue({ settings: { autoEnrich: false } });
      const res = await request(app).get('/api/digital-twin/settings');
      expect(res.status).toBe(200);
    });

    it('PUT /settings updates settings (happy path)', async () => {
      digitalTwinService.updateSettings.mockResolvedValue({ autoEnrich: true });
      const res = await request(app).put('/api/digital-twin/settings').send({ autoEnrich: true });
      expect(res.status).toBe(200);
      expect(digitalTwinService.updateSettings).toHaveBeenCalledOnce();
    });
  });

  describe('personas', () => {
    it('GET /personas lists personas', async () => {
      digitalTwinService.getPersonas.mockResolvedValue([{ id: VALID_UUID, name: 'Formal' }]);
      const res = await request(app).get('/api/digital-twin/personas');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it('POST /personas creates a persona (201)', async () => {
      digitalTwinService.createPersona.mockResolvedValue({ id: VALID_UUID, name: 'Formal' });
      const res = await request(app)
        .post('/api/digital-twin/personas')
        .send({ name: 'Formal', instructions: 'Be formal and concise.' });
      expect(res.status).toBe(201);
      expect(digitalTwinService.createPersona).toHaveBeenCalledOnce();
    });

    it('POST /personas 400s without instructions', async () => {
      const res = await request(app).post('/api/digital-twin/personas').send({ name: 'Formal' });
      expect(res.status).toBe(400);
      expect(digitalTwinService.createPersona).not.toHaveBeenCalled();
    });

    it('DELETE /personas/:id returns 404 when nothing was deleted', async () => {
      digitalTwinService.deletePersona.mockResolvedValue({ deleted: false });
      const res = await request(app).delete(`/api/digital-twin/personas/${VALID_UUID}`);
      expect(res.status).toBe(404);
    });
  });
});

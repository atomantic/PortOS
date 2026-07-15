import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

// Pin the ROUTE contract (Zod validation → 400, status mapping, exact service
// call args); the service internals are covered in services/modelPersonality.test.js.
const fnMap = vi.hoisted(() => (names) => Object.fromEntries(names.map((n) => [n, vi.fn()])));

vi.mock('../services/modelPersonality.js', () => fnMap([
  'runPersonalityTest', 'getHistory', 'deleteResult', 'getSettings', 'updateSettings'
]));

import modelPersonalityRoutes from './model-personality.js';
import * as modelPersonality from '../services/modelPersonality.js';

describe('Model Personality Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/model-personality', modelPersonalityRoutes);
    vi.clearAllMocks();
  });

  describe('POST /run', () => {
    it('runs the test and passes the exact validated args to the service', async () => {
      const record = { runId: 'r1', model: 'effective', traits: {} };
      modelPersonality.runPersonalityTest.mockResolvedValue(record);

      const res = await request(app)
        .post('/api/model-personality/run')
        .send({ providerId: 'p1', model: 'm1', includeAlignment: true });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(record);
      expect(modelPersonality.runPersonalityTest).toHaveBeenCalledExactlyOnceWith({
        providerId: 'p1', model: 'm1', includeAlignment: true, personaId: undefined
      });
    });

    it('400s without providerId and never calls the service', async () => {
      const res = await request(app).post('/api/model-personality/run').send({ model: 'm1' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(modelPersonality.runPersonalityTest).not.toHaveBeenCalled();
    });

    it('400s on a non-boolean includeAlignment', async () => {
      const res = await request(app)
        .post('/api/model-personality/run')
        .send({ providerId: 'p1', includeAlignment: 'yes' });
      expect(res.status).toBe(400);
      expect(modelPersonality.runPersonalityTest).not.toHaveBeenCalled();
    });
  });

  describe('GET /history', () => {
    it('returns history with a coerced limit', async () => {
      modelPersonality.getHistory.mockResolvedValue([{ runId: 'r1' }]);
      const res = await request(app).get('/api/model-personality/history?limit=5');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ runId: 'r1' }]);
      expect(modelPersonality.getHistory).toHaveBeenCalledExactlyOnceWith(5);
    });

    it('passes undefined when no limit is supplied', async () => {
      modelPersonality.getHistory.mockResolvedValue([]);
      const res = await request(app).get('/api/model-personality/history');
      expect(res.status).toBe(200);
      expect(modelPersonality.getHistory).toHaveBeenCalledExactlyOnceWith(undefined);
    });

    it('400s on an invalid limit', async () => {
      const res = await request(app).get('/api/model-personality/history?limit=0');
      expect(res.status).toBe(400);
      expect(modelPersonality.getHistory).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /history/:runId', () => {
    it('204s on success', async () => {
      modelPersonality.deleteResult.mockResolvedValue(true);
      const res = await request(app).delete('/api/model-personality/history/run-1');
      expect(res.status).toBe(204);
      expect(modelPersonality.deleteResult).toHaveBeenCalledExactlyOnceWith('run-1');
    });

    it('404s when nothing was deleted', async () => {
      modelPersonality.deleteResult.mockResolvedValue(false);
      const res = await request(app).delete('/api/model-personality/history/ghost');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });

  describe('settings', () => {
    it('GET /settings returns the stored settings', async () => {
      const settings = { scorerProviderId: null, scorerModel: null, historyCap: 200, defaultIncludeAlignment: true };
      modelPersonality.getSettings.mockResolvedValue(settings);
      const res = await request(app).get('/api/model-personality/settings');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(settings);
    });

    it('PUT /settings passes the validated partial patch through', async () => {
      modelPersonality.updateSettings.mockResolvedValue({ historyCap: 50 });
      const res = await request(app)
        .put('/api/model-personality/settings')
        .send({ historyCap: 50 });
      expect(res.status).toBe(200);
      expect(modelPersonality.updateSettings).toHaveBeenCalledExactlyOnceWith({ historyCap: 50 });
    });

    it('PUT /settings normalizes empty-string scorer sentinels to null', async () => {
      modelPersonality.updateSettings.mockResolvedValue({});
      const res = await request(app)
        .put('/api/model-personality/settings')
        .send({ scorerProviderId: '', scorerModel: '' });
      expect(res.status).toBe(200);
      expect(modelPersonality.updateSettings).toHaveBeenCalledExactlyOnceWith({
        scorerProviderId: null, scorerModel: null
      });
    });

    it('PUT /settings 400s on an out-of-bounds historyCap', async () => {
      const res = await request(app)
        .put('/api/model-personality/settings')
        .send({ historyCap: 100000 });
      expect(res.status).toBe(400);
      expect(modelPersonality.updateSettings).not.toHaveBeenCalled();
    });
  });
});

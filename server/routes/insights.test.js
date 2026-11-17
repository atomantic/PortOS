import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';
import * as insightsService from '../services/insightsService.js';
import * as goalScorecard from '../services/goalScorecard.js';
import insightsRoutes from './insights.js';

vi.mock('../services/insightsService.js', () => ({
  generateThemeAnalysis: vi.fn(async () => ({})),
  refreshCrossDomainNarrative: vi.fn(async () => ({})),
}));

vi.mock('../services/goalScorecard.js', () => ({
  computeWeeklyScorecard: vi.fn(async () => ({})),
  refreshScorecardNarrative: vi.fn(async () => ({})),
  getEffectiveRules: vi.fn(async () => ({})),
  saveRuleOverrides: vi.fn(async () => ({})),
  updateSettings: vi.fn(async () => ({})),
}));

const app = express();
app.use(express.json());
app.use('/api/insights', insightsRoutes);
app.use(errorMiddleware);

beforeEach(() => vi.clearAllMocks());

it.each([
  ['/themes/refresh', insightsService.generateThemeAnalysis],
  ['/narrative/refresh', insightsService.refreshCrossDomainNarrative],
  ['/goal-scorecard/narrative', goalScorecard.refreshScorecardNarrative],
])('validates and normalizes provider references for %s', async (path, generate) => {
  const url = `/api/insights${path}`;
  const invalid = await request(app).post(url).send({ providerId: '../invalid' });
  expect(invalid.status).toBe(400);
  expect(generate).not.toHaveBeenCalled();

  const valid = await request(app).post(url).send({ providerId: ' direct.api@example ', model: 'example-model' });
  expect(valid.status).toBe(200);
  expect(generate).toHaveBeenCalledWith('direct.api@example', 'example-model');
});

it.each([
  ['post', '/compute', goalScorecard.computeWeeklyScorecard,
    { weekStart: '11/16/2026' }, { weekStart: '2026-11-16' }],
  ['put', '/settings', goalScorecard.updateSettings,
    { weekStartsOn: 8 }, { provider: null, model: null, weekStartsOn: 1 }],
  ['put', '/rules', goalScorecard.saveRuleOverrides,
    { 'goal-1': { keywords: 'walk' } }, { 'goal-1': { keywords: ['walk'], enabled: false } }],
])('validates goal scorecard %s %s before calling the service', async (method, path, save, invalid, valid) => {
  const url = `/api/insights/goal-scorecard${path}`;
  expect((await request(app)[method](url).send(invalid)).status).toBe(400);
  expect(save).not.toHaveBeenCalled();

  expect((await request(app)[method](url).send(valid)).status).toBe(200);
  expect(save).toHaveBeenCalledWith(valid);
});

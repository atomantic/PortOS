import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/meatspaceDailyLog.js', () => ({ readLocalDailyLog: vi.fn() }));
vi.mock('../services/meatspace.js', () => ({ getConfig: vi.fn() }));
vi.mock('../services/meatspaceAlcohol.js', () => ({ getCustomDrinks: vi.fn() }));
vi.mock('../services/meatspaceNicotine.js', () => ({ getCustomProducts: vi.fn() }));
vi.mock('../services/meatspaceHealth.js', () => ({
  getBloodTests: vi.fn(), getEpigeneticTests: vi.fn(), getEyeExams: vi.fn(),
}));
vi.mock('../services/identity.js', () => ({ getGoals: vi.fn() }));

import meatspaceExportRoutes from './meatspaceExportRoutes.js';
import { readLocalDailyLog } from '../services/meatspaceDailyLog.js';
import { getConfig } from '../services/meatspace.js';
import { getCustomDrinks } from '../services/meatspaceAlcohol.js';
import { getCustomProducts } from '../services/meatspaceNicotine.js';
import { getBloodTests, getEpigeneticTests, getEyeExams } from '../services/meatspaceHealth.js';
import { getGoals } from '../services/identity.js';

function makeApp() {
  const app = express();
  app.use('/api/meatspace', meatspaceExportRoutes);
  app.use(errorMiddleware);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  getConfig.mockResolvedValue({
    birthDate: '1980-02-03', sex: 'female',
    lifestyle: { smokingStatus: 'never', exerciseMinutesPerWeek: 180 },
  });
  getBloodTests.mockResolvedValue({ tests: [{ date: '2026-01-02', glucose: 91 }] });
  getEpigeneticTests.mockResolvedValue({ tests: [{ date: '2026-01-03', chronologicalAge: 46, biologicalAge: 44 }] });
  getEyeExams.mockResolvedValue({ exams: [{ date: '2026-01-04', leftSphere: -1.25 }] });
  readLocalDailyLog.mockResolvedValue({ entries: [
    { date: '2026-01-05', alcohol: { drinks: [{ name: 'Wine', oz: 5, abv: 13, count: 0 }] }, nicotine: { items: [{ product: 'gum', mgPerUnit: 2, count: 2 }] }, body: { weightLbs: 150, fatPct: 20 } },
  ] });
  getCustomDrinks.mockResolvedValue([{ name: 'Beer', oz: 12, abv: 5 }]);
  getCustomProducts.mockResolvedValue([{ name: 'Patch', mgPerUnit: 7 }]);
  getGoals.mockResolvedValue({ goals: [{ title: 'Run', description: 'Daily', status: 'active', urgency: 0.8, createdAt: '2026-01-01T12:00:00Z', checkIns: [{ date: '2026-01-05', value: 25 }], milestones: [{ title: 'Start', completedAt: null }] }] });
});

describe('GET /api/meatspace/export/mortalloom', () => {
  it('aggregates configured health sources and daily entries into the export schema', async () => {
    const response = await request(makeApp()).get('/api/meatspace/export/mortalloom');

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain('MortalLoom-export.json');
    expect(response.body.profile).toMatchObject({ birthDate: '1980-02-03', biologicalSex: 'female' });
    expect(response.body.profile.lifestyle).toMatchObject({ exerciseMinutesPerWeek: 180, sleepHoursPerNight: 7.5 });
    expect(response.body.alcoholDrinks[0]).toMatchObject({ name: 'Wine', count: 1, date: '2026-01-05' });
    expect(response.body.nicotineEntries[0]).toMatchObject({ product: 'gum', count: 2 });
    expect(response.body.bloodTests[0]).toMatchObject({ date: '2026-01-02', markers: { glucose: 91 } });
    expect(response.body.epigeneticTests[0]).toMatchObject({ chronologicalAge: 46, biologicalAge: 44, paceOfAging: null });
    expect(response.body.eyeExams[0]).toMatchObject({ leftSphere: -1.25, rightSphere: null });
    expect(response.body.bodyEntries).toEqual([{ id: expect.any(String), date: '2026-01-05', weightLbs: 150, bodyFatPct: 20 }]);
    expect(response.body.alcoholPresets[0]).toMatchObject({ name: 'Beer', oz: 12, abv: 5 });
    expect(response.body.nicotinePresets[0]).toMatchObject({ name: 'Patch', mgPerUnit: 7 });
    expect(response.body.goals[0]).toMatchObject({ title: 'Run', status: 'active', priority: 'high', checkInIntervalDays: 7 });
    expect(response.body.goals[0].checkIns).toEqual([{ id: expect.any(String), date: '2026-01-05', progressPct: 25, note: '' }]);
    expect(response.body.goals[0].milestones).toEqual([{ id: expect.any(String), title: 'Start', completed: false, completedDate: null }]);
    const ids = [response.body.alcoholDrinks[0].id, response.body.nicotineEntries[0].id, response.body.bloodTests[0].id];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('handles sparse sources and falls back to progress history when check-ins are empty', async () => {
    getConfig.mockResolvedValue({});
    getBloodTests.mockResolvedValue({});
    getEpigeneticTests.mockResolvedValue({ tests: [] });
    getEyeExams.mockResolvedValue({ exams: [] });
    readLocalDailyLog.mockResolvedValue({ entries: [{ date: '2026-02-01' }] });
    getCustomDrinks.mockResolvedValue([]);
    getCustomProducts.mockResolvedValue([]);
    getGoals.mockResolvedValue({ goals: [{ title: 'Archive', status: 'archived', urgency: 0.2, checkIns: [], progressHistory: [{ timestamp: '2026-02-01T10:00:00Z', value: 80 }], milestones: [{ title: 'Done', completedAt: '2026-02-02T00:00:00Z' }] }] });

    const response = await request(makeApp()).get('/api/meatspace/export/mortalloom');

    expect(response.status).toBe(200);
    expect(response.body.profile).toEqual({ birthDate: null, biologicalSex: null, lifestyle: {
      smokingStatus: 'never', exerciseMinutesPerWeek: 150, sleepHoursPerNight: 7.5,
      dietQuality: 'good', stressLevel: 'moderate', bmi: null,
    } });
    expect(response.body.bloodTests).toEqual([]);
    expect(response.body.bodyEntries).toEqual([]);
    expect(response.body.goals[0]).toMatchObject({ status: 'completed', priority: 'low', completedDate: null });
    expect(response.body.goals[0].checkIns[0]).toMatchObject({ date: '2026-02-01', progressPct: 80, note: '' });
    expect(response.body.goals[0].milestones[0]).toEqual({ id: expect.any(String), title: 'Done', completed: true, completedDate: '2026-02-02' });
  });
});

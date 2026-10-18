import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/identity.js', async (importOriginal) => ({
  ...await importOriginal(),
  setBirthDate: vi.fn(),
  createGoal: vi.fn(),
  deleteGoal: vi.fn(),
  getGoalCalendarEvents: vi.fn(),
}));
vi.mock('../services/goalCalendarScheduler.js', () => ({
  scheduleTimeBlocks: vi.fn(), removeScheduledEvents: vi.fn(), rescheduleTimeBlocks: vi.fn(),
}));

import * as identityService from '../services/identity.js';
import identityRoutes from './identity.js';

const app = express();
app.use(express.json());
app.use('/api/digital-twin/identity', identityRoutes);
app.use(errorMiddleware);
const BASE = '/api/digital-twin/identity';

beforeEach(() => vi.clearAllMocks());

describe('/api/digital-twin/identity goals', () => {
  it('creates a goal with the schema defaults filled in', async () => {
    identityService.createGoal.mockImplementation(async (data) => ({ id: 'g1', ...data }));
    const res = await request(app).post(`${BASE}/goals`).send({ title: 'Run a marathon' });
    expect(res.status).toBe(201);
    expect(identityService.createGoal).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Run a marathon', horizon: '5-year', category: 'mastery', goalType: 'standard', parentId: null, tags: [],
    }));
  });

  it('refuses a goal without a title and a birth date in the future', async () => {
    expect((await request(app).post(`${BASE}/goals`).send({ description: 'x' })).status).toBe(400);
    expect(identityService.createGoal).not.toHaveBeenCalled();

    const future = await request(app).put(`${BASE}/goals/birth-date`).send({ birthDate: '2999-01-01' });
    expect(future.status).toBe(400);
    expect(identityService.setBirthDate).not.toHaveBeenCalled();

    identityService.setBirthDate.mockResolvedValue({ goals: [] });
    expect((await request(app).put(`${BASE}/goals/birth-date`).send({ birthDate: '1980-02-03' })).status).toBe(200);
    expect(identityService.setBirthDate).toHaveBeenCalledWith('1980-02-03');
  });

  it('answers 404 deleting a goal that does not exist and 204 for one that does', async () => {
    identityService.deleteGoal.mockResolvedValue(false);
    expect((await request(app).delete(`${BASE}/goals/missing`)).status).toBe(404);
    identityService.deleteGoal.mockResolvedValue(true);
    expect((await request(app).delete(`${BASE}/goals/g1`)).status).toBe(204);
  });

  it('passes the calendar window through and refuses a repeated bound', async () => {
    identityService.getGoalCalendarEvents.mockResolvedValue([]);
    await request(app).get(`${BASE}/goals/g1/calendar-events?startDate=2026-01-01&endDate=2026-01-31`);
    expect(identityService.getGoalCalendarEvents).toHaveBeenCalledWith('g1', '2026-01-01', '2026-01-31');

    const bad = await request(app).get(`${BASE}/goals/g1/calendar-events?startDate=a&startDate=b`);
    expect(bad.status).toBe(400);
  });
});

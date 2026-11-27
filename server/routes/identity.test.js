import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/identity.js', async (importOriginal) => ({
  ...await importOriginal(),
  setBirthDate: vi.fn(),
  createGoal: vi.fn(),
  updateGoal: vi.fn(),
  deleteGoal: vi.fn(),
  addMilestone: vi.fn(),
  completeMilestone: vi.fn(),
  addProgressEntry: vi.fn(),
  deleteProgressEntry: vi.fn(),
  linkActivity: vi.fn(),
  unlinkActivity: vi.fn(),
  linkCalendarToGoal: vi.fn(),
  unlinkCalendarFromGoal: vi.fn(),
  updateGoalProgress: vi.fn(),
  addTodo: vi.fn(),
  updateTodo: vi.fn(),
  deleteTodo: vi.fn(),
  completeMilestoneTask: vi.fn(),
  checkInGoal: vi.fn(),
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
  const mutationCases = [
    { method: 'updateGoal', request: () => request(app).put(`${BASE}/goals/g1`).send({ title: 'Updated' }), invalid: () => request(app).put(`${BASE}/goals/g1`).send({ title: '' }), status: 200 },
    { method: 'addMilestone', request: () => request(app).post(`${BASE}/goals/g1/milestones`).send({ title: 'Milestone' }), invalid: () => request(app).post(`${BASE}/goals/g1/milestones`).send({}), status: 201 },
    { method: 'completeMilestone', request: () => request(app).put(`${BASE}/goals/g1/milestones/m1/complete`), status: 200 },
    { method: 'addProgressEntry', request: () => request(app).post(`${BASE}/goals/g1/progress`).send({ date: '2026-01-01', note: 'Progress' }), invalid: () => request(app).post(`${BASE}/goals/g1/progress`).send({ date: 'bad', note: '' }), status: 201 },
    { method: 'deleteProgressEntry', request: () => request(app).delete(`${BASE}/goals/g1/progress/p1`), status: 204 },
    { method: 'linkActivity', request: () => request(app).post(`${BASE}/goals/g1/activities`).send({ activityName: 'Running' }), invalid: () => request(app).post(`${BASE}/goals/g1/activities`).send({ activityName: '' }), status: 200 },
    { method: 'unlinkActivity', request: () => request(app).delete(`${BASE}/goals/g1/activities/Running`), status: 200 },
    { method: 'linkCalendarToGoal', request: () => request(app).post(`${BASE}/goals/g1/calendars`).send({ subcalendarId: 'cal1', subcalendarName: 'Calendar' }), invalid: () => request(app).post(`${BASE}/goals/g1/calendars`).send({ subcalendarId: '' }), status: 200 },
    { method: 'unlinkCalendarFromGoal', request: () => request(app).delete(`${BASE}/goals/g1/calendars/cal1`), status: 200 },
    { method: 'updateGoalProgress', request: () => request(app).put(`${BASE}/goals/g1/progress`).send({ value: 50 }), invalid: () => request(app).put(`${BASE}/goals/g1/progress`).send({ value: 101 }), status: 200 },
    { method: 'addTodo', request: () => request(app).post(`${BASE}/goals/g1/todos`).send({ title: 'Task' }), invalid: () => request(app).post(`${BASE}/goals/g1/todos`).send({ title: '' }), status: 201 },
    { method: 'updateTodo', request: () => request(app).put(`${BASE}/goals/g1/todos/t1`).send({ status: 'done' }), invalid: () => request(app).put(`${BASE}/goals/g1/todos/t1`).send({ status: 'invalid' }), status: 200 },
    { method: 'deleteTodo', request: () => request(app).delete(`${BASE}/goals/g1/todos/t1`), status: 200 },
    { method: 'completeMilestoneTask', request: () => request(app).put(`${BASE}/goals/g1/milestones/m1/tasks/t1/complete`), status: 200 },
  ];

  it.each(mutationCases)('$method returns 404 for a missing record and its success status otherwise', async ({ method, request: makeRequest, status }) => {
    identityService[method].mockResolvedValueOnce(null);
    expect((await makeRequest()).status).toBe(404);

    identityService[method].mockResolvedValueOnce({ id: 'result' });
    expect((await makeRequest()).status).toBe(status);
    expect(identityService[method]).toHaveBeenCalledTimes(2);
  });

  it.each(mutationCases.filter(({ invalid }) => invalid))('$method rejects invalid input before calling the service', async ({ method, invalid }) => {
    const res = await invalid();
    expect(res.status).toBe(400);
    expect(identityService[method]).not.toHaveBeenCalled();
  });

  it('creates a check-in with status 201 and rejects invalid input before calling the service', async () => {
    identityService.checkInGoal.mockResolvedValue({ id: 'check-in' });
    expect((await request(app).post(`${BASE}/goals/g1/check-in`).send({})).status).toBe(201);

    identityService.checkInGoal.mockClear();
    expect((await request(app).post(`${BASE}/goals/g1/check-in`).send({ providerId: '' })).status).toBe(400);
    expect(identityService.checkInGoal).not.toHaveBeenCalled();
  });

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

  it('passes Express-decoded activity names through unchanged when unlinking', async () => {
    identityService.unlinkActivity.mockResolvedValue({ id: 'g1' });

    const percentName = await request(app).delete(`${BASE}/goals/g1/activities/100%25%20focus`);
    expect(percentName.status).toBe(200);
    expect(identityService.unlinkActivity).toHaveBeenCalledWith('g1', '100% focus');

    const encodedName = await request(app).delete(`${BASE}/goals/g1/activities/a%2520b`);
    expect(encodedName.status).toBe(200);
    expect(identityService.unlinkActivity).toHaveBeenLastCalledWith('g1', 'a%20b');
  });

  it('passes Express-decoded calendar identifiers through unchanged when unlinking', async () => {
    identityService.unlinkCalendarFromGoal.mockResolvedValue({ id: 'g1' });

    const res = await request(app).delete(`${BASE}/goals/g1/calendars/calendar%25id`);
    expect(res.status).toBe(200);
    expect(identityService.unlinkCalendarFromGoal).toHaveBeenCalledWith('g1', 'calendar%id');
  });

});

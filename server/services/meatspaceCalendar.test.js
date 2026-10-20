import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'fs/promises';
import express from 'express';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../lib/fileUtils.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-meatspace-calendar-'),
}));
vi.mock('./meatspace.js', () => ({ getDeathClock: async () => ({ error: 'no birth date' }) }));

import { PATHS } from '../lib/fileUtils.js';
import meatspaceCalendarRoutes from '../routes/meatspaceCalendarRoutes.js';
import {
  addActivity, getActivities, getLifeEvents, removeActivity, removeLifeEvent, addLifeEvent,
} from './meatspaceCalendar.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/meatspace', meatspaceCalendarRoutes);
  app.use(errorMiddleware);
  return app;
}

beforeEach(async () => {
  await rm(PATHS.meatspace, { recursive: true, force: true });
});
afterAll(cleanupTempDataRoots);

describe('Life Calendar defaults vs deliberately emptied lists', () => {
  it('shows the defaults when nothing has been configured', async () => {
    expect((await getLifeEvents()).length).toBeGreaterThan(0);
    expect((await getActivities()).length).toBeGreaterThan(0);
  });

  it('keeps events empty after the user deletes every one, even across a later add', async () => {
    for (const { id } of await getLifeEvents()) await removeLifeEvent(id);
    expect(await getLifeEvents()).toEqual([]);
    await addLifeEvent({ name: 'Mine', type: 'custom', recurrence: 'yearly', month: 0, day: 2, enabled: true });
    expect(await getLifeEvents()).toHaveLength(1);
  });

  it('keeps activities empty after the user deletes every one', async () => {
    const total = (await getActivities()).length;
    for (let i = 0; i < total; i++) await removeActivity(0);
    expect(await getActivities()).toEqual([]);
    await addActivity({ name: 'Mine', cadence: 'day', frequency: 1, icon: 'coffee' });
    expect(await getActivities()).toHaveLength(1);
  });
});

describe('activity index routes', () => {
  it.each(['delete', 'put'])('%s with a non-integer index answers 400 and changes nothing', async (method) => {
    const before = await getActivities();
    const req = request(makeApp())[method]('/api/meatspace/activities/abc');
    const res = await (method === 'put' ? req.send({ name: 'X' }) : req);
    expect(res.status).toBe(400);
    expect(await getActivities()).toEqual(before);
  });
});

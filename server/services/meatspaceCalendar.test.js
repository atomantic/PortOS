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
  addActivity, getActivities, getLifeEvents, removeActivity, removeLifeEvent, addLifeEvent, updateLifeEvent,
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

describe('activity delete by index is guarded by the row the client saw', () => {
  it('a double-clicked delete removes one activity and answers the second 409', async () => {
    const before = await getActivities();
    const name = before[3].name;
    const [first, second] = await Promise.all(['a', 'b'].map(() =>
      request(makeApp()).delete(`/api/meatspace/activities/3?name=${encodeURIComponent(name)}`)));
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(second.body.code).toBe('ACTIVITY_MOVED');
    const after = await getActivities();
    expect(after).toHaveLength(before.length - 1);
    expect(after.some(a => a.name === name)).toBe(false);
    expect(after[3].name).toBe(before[4].name);
  });

  it('a delete without ?name= keeps the old index-only behavior for older clients', async () => {
    const before = await getActivities();
    const res = await request(makeApp()).delete('/api/meatspace/activities/0');
    expect(res.status).toBe(200);
    expect(await getActivities()).toHaveLength(before.length - 1);
  });

  it('a stale PUT with a mismatched ?name= leaves the activity at that index untouched', async () => {
    const before = await getActivities();
    const res = await request(makeApp())
      .put('/api/meatspace/activities/2?name=Not%20Here')
      .send({ frequency: 99 });
    expect(res.status).toBe(409);
    expect(await getActivities()).toEqual(before);
  });
});

describe('life calendar read-modify-writes are serialized', () => {
  it('a concurrent add and update both persist', async () => {
    const [seed] = await getLifeEvents();
    const [, events] = await Promise.all([
      addLifeEvent({ name: 'Added', type: 'custom', recurrence: 'yearly', month: 2, day: 3, enabled: true }),
      updateLifeEvent(seed.id, { enabled: false }),
    ]);
    expect(events.map(e => e.name)).toContain('Added');
    const persisted = await getLifeEvents();
    expect(persisted.find(e => e.id === seed.id).enabled).toBe(false);
    expect(persisted.map(e => e.name)).toContain('Added');
  });
});

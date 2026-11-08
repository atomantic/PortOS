import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
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
    const responses = [first, second];
    const refused = responses.find(r => r.status === 409);
    expect(responses.filter(r => r.status === 200)).toHaveLength(1);
    expect(refused.body.code).toBe('ACTIVITY_MOVED');
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

const activitiesFile = () => join(PATHS.meatspace, 'activities.json');
async function storeActivities(activities) {
  await mkdir(PATHS.meatspace, { recursive: true });
  await writeFile(activitiesFile(), JSON.stringify({ activities }));
}
const stored = async () => JSON.parse(await readFile(activitiesFile(), 'utf8')).activities;

describe('activities are addressed by a stable id', () => {
  it('a default row keeps the id the client read across the first write that seeds the list', async () => {
    const before = await getActivities();
    const target = before[1];
    const res = await request(makeApp()).delete(`/api/meatspace/activities/1?id=${encodeURIComponent(target.id)}`);
    expect(res.status).toBe(200);
    expect((await stored()).map(a => a.id)).toEqual(before.filter(a => a.id !== target.id).map(a => a.id));
  });

  it('an added activity gets an id the client cannot choose', async () => {
    const res = await request(makeApp()).post('/api/meatspace/activities')
      .send({ id: 'chosen', name: 'Walks', cadence: 'day', frequency: 1 });
    const added = res.body.at(-1);
    expect(added.name).toBe('Walks');
    expect(added.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    ['first', 'w1', 1, ['a', 'w2']],
    ['second', 'w2', 2, ['a', 'w1']],
  ])('a stale index with an id removes only the %s of two same-named activities', async (_which, id, staleIndex, remaining) => {
    await storeActivities([
      { id: 'gone', name: 'Earlier', cadence: 'day', frequency: 1 },
      { id: 'a', name: 'Books', cadence: 'month', frequency: 1 },
      { id: 'w1', name: 'Walks', cadence: 'day', frequency: 1 },
      { id: 'w2', name: 'Walks', cadence: 'week', frequency: 3 },
    ]);
    // Another tab removes the first row, so this caller's indexes are one too high.
    await removeActivity(0, { id: 'gone' });
    const res = await request(makeApp()).delete(`/api/meatspace/activities/${staleIndex + 1}?id=${id}`);
    expect(res.status).toBe(200);
    expect((await stored()).map(a => a.id)).toEqual(remaining);
  });

  it('guards a nameless row by its id, and refuses an id that is no longer stored', async () => {
    await storeActivities([
      { id: 'x', cadence: 'day', frequency: 1 },
      { id: 'y', cadence: 'year', frequency: 1 },
    ]);
    const refused = await request(makeApp()).delete('/api/meatspace/activities/0?id=already-removed');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('ACTIVITY_MOVED');
    expect((await stored()).map(a => a.id)).toEqual(['x', 'y']);

    const res = await request(makeApp()).delete('/api/meatspace/activities/0?id=y');
    expect(res.status).toBe(200);
    expect((await stored()).map(a => a.id)).toEqual(['x']);
  });

  it('a PUT by id edits that row and keeps its id', async () => {
    await storeActivities([
      { id: 'x', name: 'Walks', cadence: 'day', frequency: 1 },
      { id: 'y', name: 'Walks', cadence: 'day', frequency: 1 },
    ]);
    const res = await request(makeApp()).put('/api/meatspace/activities/0?id=y').send({ frequency: 5 });
    expect(res.status).toBe(200);
    expect(await stored()).toEqual([
      { id: 'x', name: 'Walks', cadence: 'day', frequency: 1 },
      { id: 'y', name: 'Walks', cadence: 'day', frequency: 5 },
    ]);
  });

  it('a write gives a row stored without an id one, and an index-only delete still works', async () => {
    await storeActivities([
      { name: 'Walks', cadence: 'day', frequency: 1 },
      { cadence: 'year', frequency: 1 },
    ]);
    const res = await request(makeApp()).delete('/api/meatspace/activities/0');
    expect(res.status).toBe(200);
    const [row] = await stored();
    expect(row).toMatchObject({ cadence: 'year', frequency: 1, id: expect.any(String) });
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

import { afterAll, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import express from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, ownTestBodies } from '../lib/mockPathsDataRoot.js';
import { request } from '../lib/testHelper.js';

vi.mock('../lib/fileUtils.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-meatspace-routes-'),
}));

// Keep the production router barrel and its local services; do not touch iCloud.
vi.mock('../services/mortalLoomStore.js', () => ({
  isMortalLoomEnabled: async () => false,
  mlArrayIfEnabled: async () => null,
  mlGetProfileIfEnabled: async () => null,
  mlPatchProfileIfEnabled: async () => null,
  readDailyLogIfEnabled: async () => null,
}));

import { getDateString, PATHS } from '../lib/fileUtils.js';
import meatspaceRoutes from './meatspace.js';

const app = express();
app.use(express.json());
app.use('/api/meatspace', meatspaceRoutes);
app.use(errorMiddleware);

const { it, drain } = ownTestBodies(vitestIt);
beforeEach(async () => {
  await rm(PATHS.meatspace, { recursive: true, force: true });
});
afterAll(async () => {
  try {
    await drain();
  } finally {
    cleanupTempDataRoots();
  }
});

const base = '/api/meatspace';
const birthDate = '1980-02-03';
const validationError = { status: 400, body: { code: 'VALIDATION_ERROR' } };
const invalidIndex = { status: 400, body: { code: 'INVALID_INDEX' } };
const notFound = { status: 404, body: { code: 'NOT_FOUND' } };

describe('MeatSpace core HTTP routes', () => {
  it('updates and reads config, preserving omitted lifestyle fields and rejecting an invalid patch', async () => {
    const path = `${base}/config`;
    const initial = { sex: 'female', lifestyle: { smokingStatus: 'former', sleepHoursPerNight: 8 } };
    expect(await request(app).put(path).send(initial)).toMatchObject({ status: 200, body: initial });

    const updated = { ...initial, lifestyle: { ...initial.lifestyle, sleepHoursPerNight: 9 } };
    expect(await request(app).put(path).send({ lifestyle: { sleepHoursPerNight: 9 } })).toMatchObject({
      status: 200, body: updated,
    });
    expect(await request(app).put(path).send({ lifestyle: { sleepHoursPerNight: 25 } }))
      .toMatchObject(validationError);
    expect(await request(app).get(path)).toMatchObject({ status: 200, body: updated });
  });

  it('sets and reads the birth date used by the death clock and overview', async () => {
    const path = `${base}/birth-date`;
    expect(await request(app).get(path)).toMatchObject({ status: 200, body: { birthDate: null } });
    expect(await request(app).get(`${base}/death-clock`)).toMatchObject({
      status: 200, body: { error: expect.stringContaining('Birth date not set') },
    });

    expect(await request(app).put(path).send({ birthDate })).toMatchObject({ status: 200, body: { birthDate } });
    expect(await request(app).put(path).send({ birthDate: 'Feb 3' })).toMatchObject(validationError);
    expect(await request(app).get(path)).toMatchObject({ status: 200, body: { birthDate } });

    const clock = await request(app).get(`${base}/death-clock`);
    expect(clock).toMatchObject({
      status: 200, body: { birthDate, deathDate: expect.any(String), lifeExpectancy: { total: expect.any(Number) } },
    });
    expect(Date.parse(clock.body.deathDate)).toBeGreaterThan(Date.parse(birthDate));
    expect(await request(app).get(base)).toMatchObject({
      status: 200, body: { config: { birthDate }, deathClock: { birthDate, deathDate: clock.body.deathDate } },
    });
  });

  it('returns logging stats from records written through the workout route', async () => {
    const date = getDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));
    expect(await request(app).post(`${base}/workouts`).send({ date, type: 'walk' })).toMatchObject({ status: 201 });
    expect(await request(app).get(`${base}/logging-stats`)).toMatchObject({
      status: 200,
      body: {
        totalLogged: 1,
        weekTotal: 1,
        domains: expect.arrayContaining([expect.objectContaining({ key: 'workouts', total: 1, thisWeek: 1 })]),
      },
    });
  });
});

describe.each([
  {
    kind: 'alcohol', buttons: 'custom-drinks', itemKey: 'drink', listKey: 'drinks',
    record: { name: 'Test drink', oz: 12, abv: 5 }, button: { name: 'Test drink', oz: 12, abv: 5 },
    invalid: { oz: 0 },
  },
  {
    kind: 'nicotine', buttons: 'custom-products', itemKey: 'item', listKey: 'items',
    record: { product: 'Test product', mgPerUnit: 2 }, button: { name: 'Test product', mgPerUnit: 2 },
    invalid: { mgPerUnit: 0 },
  },
])('MeatSpace $kind HTTP routes', ({ kind, buttons, itemKey, listKey, record, button, invalid }) => {
  const path = `${base}/${kind}`;

  it('logs a record, returns it in summary and date-filtered history, and edits and deletes by event ID', async () => {
    const date = getDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const log = `${path}/log`;
    const daily = `${path}/daily`;
    const created = await request(app).post(log).send({ date, ...record });
    expect(created).toMatchObject({
      status: 201, body: { date, [itemKey]: { ...record, count: 1, id: expect.any(String) } },
    });
    const { id } = created.body[itemKey];
    const entry = { date, [kind]: { [listKey]: [expect.objectContaining({ ...record, id })] } };
    expect(await request(app).get(path)).toMatchObject({
      status: 200, body: { recentEntries: [entry], avg7day: expect.any(Number) },
    });
    expect(await request(app).get(daily)).toMatchObject({ status: 200, body: [entry] });
    expect(await request(app).get(`${daily}?from=${date}&to=${date}`)).toMatchObject({ status: 200, body: [entry] });
    expect(await request(app).get(`${daily}?to=2000-01-01`)).toMatchObject({ status: 200, body: [] });

    // An ID still addresses the event after the client's index has gone stale.
    const target = `${log}/${date}/99`;
    expect(await request(app).put(target).send({ id, count: 2 })).toMatchObject({
      status: 200, body: { [itemKey]: { ...record, id, count: 2 } },
    });
    expect(await request(app).delete(`${target}?id=${id}`)).toMatchObject({
      status: 200, body: { ...record, id, count: 2 },
    });
    expect(await request(app).get(daily)).toMatchObject({ status: 200, body: [] });
    expect(await request(app).put(target).send({ id, count: 2 })).toMatchObject(notFound);
    expect(await request(app).delete(`${target}?id=${id}`)).toMatchObject(notFound);
  });

  it('refuses invalid log bodies, indices and query fields', async () => {
    const log = `${path}/log`;
    const target = `${log}/2024-06-01/0`;
    const badIndex = `${log}/2024-06-01/zero`;
    expect(await request(app).post(log).send({ ...record, ...invalid })).toMatchObject(validationError);
    expect(await request(app).put(target).send({ id: 123 })).toMatchObject(validationError);
    expect(await request(app).delete(`${target}?id=`)).toMatchObject(validationError);
    expect(await request(app).put(badIndex).send({ count: 2 })).toMatchObject(invalidIndex);
    expect(await request(app).delete(badIndex)).toMatchObject(invalidIndex);
    expect(await request(app).get(`${path}/daily?from=yesterday`)).toMatchObject(validationError);
    expect(await request(app).get(`${path}/daily?to=2026-1-5`)).toMatchObject(validationError);
    expect(await request(app).get(`${path}/daily`)).toMatchObject({ status: 200, body: [] });
  });

  it('creates, lists, updates and removes a custom button with validation and missing-index responses', async () => {
    const custom = `${path}/${buttons}`;
    const initial = await request(app).get(custom);
    expect(initial.status).toBe(200);
    expect(await request(app).post(custom).send({ ...button, ...invalid })).toMatchObject(validationError);
    expect(await request(app).post(custom).send(button)).toMatchObject({ status: 201, body: button });

    const index = initial.body.length;
    const target = `${custom}/${index}`;
    expect(await request(app).get(custom)).toMatchObject({ status: 200, body: [...initial.body, button] });
    expect(await request(app).put(target).send({ name: '' })).toMatchObject(validationError);
    expect(await request(app).put(`${custom}/-1`).send({ name: 'Invalid' })).toMatchObject(invalidIndex);
    expect(await request(app).delete(`${custom}/-1`)).toMatchObject(invalidIndex);

    const edited = { ...button, name: 'Renamed test button' };
    expect(await request(app).put(target).send({ name: edited.name })).toMatchObject({ status: 200, body: edited });
    expect(await request(app).delete(target)).toMatchObject({ status: 200, body: edited });
    expect(await request(app).get(custom)).toMatchObject({ status: 200, body: initial.body });
    expect(await request(app).put(target).send({ name: edited.name })).toMatchObject(notFound);
    expect(await request(app).delete(target)).toMatchObject(notFound);
  });
});

describe('MeatSpace calendar HTTP routes', () => {
  it('returns a life grid after the birth date is configured', async () => {
    const path = `${base}/calendar`;
    expect(await request(app).get(path)).toMatchObject({
      status: 200, body: { error: expect.stringContaining('Birth date not set') },
    });
    expect(await request(app).put(`${base}/birth-date`).send({ birthDate })).toMatchObject({ status: 200 });
    const calendar = await request(app).get(path);
    expect(calendar).toMatchObject({
      status: 200,
      body: { birthDate, deathDate: expect.any(String), stats: expect.any(Object), activitiesConfigured: false },
    });
    expect(calendar.body.grid[0]).toMatchObject({ age: 0, weeks: Array(52).fill('s') });
  });

  it('persists activity changes and rejects malformed and stale selectors', async () => {
    const path = `${base}/activities`;
    const input = { name: 'Test activity', cadence: 'week', frequency: 2 };
    const initial = await request(app).get(path);
    expect(initial.status).toBe(200);
    expect(await request(app).post(path).send({ ...input, cadence: 'hour' })).toMatchObject(validationError);

    const created = await request(app).post(path).send(input);
    const activity = { ...input, icon: 'circle', id: expect.any(String) };
    expect(created).toMatchObject({ status: 200, body: [...initial.body, activity] });
    const { id } = created.body.at(-1);
    const target = `${path}/0?id=${id}`;
    expect(await request(app).put(target).send({ frequency: 0 })).toMatchObject(validationError);
    expect(await request(app).put(`${path}/0?id=`).send({ frequency: 3 })).toMatchObject(validationError);
    expect(await request(app).delete(`${path}/0?name=`)).toMatchObject(validationError);

    const edited = { ...activity, id, frequency: 3 };
    expect(await request(app).put(target).send({ frequency: 3 })).toMatchObject({
      status: 200, body: [...initial.body, edited],
    });
    expect(await request(app).get(path)).toMatchObject({ status: 200, body: [...initial.body, edited] });
    expect(await request(app).delete(target)).toMatchObject({ status: 200, body: initial.body });
    expect(await request(app).delete(target)).toMatchObject({ status: 409, body: { code: 'ACTIVITY_MOVED' } });
    const missing = `${path}/${initial.body.length}`;
    expect(await request(app).put(missing).send({ frequency: 3 })).toMatchObject(notFound);
    expect(await request(app).delete(missing)).toMatchObject(notFound);
  });

  it('adds, edits and removes a life event exposed by the calendar', async () => {
    const path = `${base}/life-events`;
    const calendarPath = `${base}/calendar`;
    expect(await request(app).put(`${base}/birth-date`).send({ birthDate })).toMatchObject({ status: 200 });
    const initial = await request(app).get(calendarPath);
    expect(initial.status).toBe(200);
    const { events } = initial.body;
    const input = { name: 'Test event', type: 'custom', recurrence: 'once', date: '2024-06-01' };

    expect(await request(app).post(path).send({ ...input, recurrence: 'monthly' })).toMatchObject(validationError);
    const created = await request(app).post(path).send(input);
    expect(created).toMatchObject({
      status: 200, body: [...events, { ...input, id: expect.any(String), enabled: true }],
    });
    const { id } = created.body.at(-1);
    const target = `${path}/${id}`;
    expect(await request(app).put(target).send({ enabled: 'false' })).toMatchObject(validationError);
    const edited = { ...input, id, enabled: false };
    expect(await request(app).put(target).send({ enabled: false })).toMatchObject({
      status: 200, body: [...events, edited],
    });
    expect(await request(app).get(calendarPath)).toMatchObject({ status: 200, body: { events: [...events, edited] } });
    expect(await request(app).delete(target)).toMatchObject({ status: 200, body: events });
    expect(await request(app).put(target).send({ enabled: true })).toMatchObject(notFound);
    expect(await request(app).delete(target)).toMatchObject(notFound);
  });
});

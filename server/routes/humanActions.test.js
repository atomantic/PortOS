import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// An in-memory thread store behind the brainStorage calls the service makes.
const store = new Map();
vi.mock('../services/brainStorage.js', () => ({
  getThreads: vi.fn(async () => [...store.values()]),
  createThread: vi.fn(async (data) => {
    const record = { id: `t${store.size + 1}`, ...data };
    store.set(record.id, record);
    return record;
  }),
  updateWith: vi.fn(async (_type, id, fn) => {
    const updates = await fn({ ...store.get(id) });
    if (updates) store.set(id, { ...store.get(id), ...updates });
    return store.get(id);
  }),
}));

import humanActionRoutes from './humanActions.js';

const app = express();
app.use(express.json());
app.use('/api/human-actions', humanActionRoutes);
app.use(errorMiddleware);

const step = (title, dueAt) => ({ title, dueAt, instructions: [`Do ${title}`], content: [{ label: 'Post text', text: 'Hello.' }] });
const planBody = (steps) => ({ planKey: 'promo-example', title: 'Promote "Example Song"', steps });

describe('/api/human-actions', () => {
  beforeEach(() => store.clear());

  it('schedules a plan as open, tagged threads, soonest first', async () => {
    const res = await request(app).post('/api/human-actions/plans').send(planBody([
      step('Second', '2026-10-08T18:00:00Z'),
      step('First', '2026-10-07T18:00:00-07:00'),
    ]));
    expect(res.status).toBe(201);
    expect(res.body.created.map((t) => t.title)).toEqual(['First', 'Second']);
    expect(res.body.created[0]).toMatchObject({
      status: 'open', source: 'human-action', nextAction: 'Do First', dueAt: '2026-10-08T01:00:00.000Z',
      tags: ['human-action', 'plan:promo-example'],
    });

    const list = await request(app).get('/api/human-actions?planKey=promo-example');
    expect(list.body.actions.map((t) => t.title)).toEqual(['First', 'Second']);
  });

  it('planning again archives the open steps and leaves finished ones alone', async () => {
    await request(app).post('/api/human-actions/plans').send(planBody([step('Old', '2026-10-07T18:00:00Z'), step('Done', '2026-10-07T19:00:00Z')]));
    store.set('t2', { ...store.get('t2'), status: 'done' });

    const res = await request(app).post('/api/human-actions/plans').send(planBody([step('New', '2026-10-09T18:00:00Z')]));
    expect(res.body.replaced).toBe(1);
    expect(store.get('t1').status).toBe('archived');
    expect(store.get('t2').status).toBe('done');
    const list = await request(app).get('/api/human-actions?planKey=promo-example&includeDone=true');
    expect(list.body.actions.map((t) => t.title)).toEqual(['Old', 'Done', 'New']);
  });

  it('refuses a step with no instructions or a due time without an offset', async () => {
    const noSteps = await request(app).post('/api/human-actions/plans').send(planBody([{ ...step('X', '2026-10-07T18:00:00Z'), instructions: [] }]));
    expect(noSteps.status).toBe(400);
    const naive = await request(app).post('/api/human-actions/plans').send(planBody([step('X', '2026-10-07T18:00:00')]));
    expect(naive.status).toBe(400);
    expect(store.size).toBe(0);
  });
});

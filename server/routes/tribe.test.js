import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorEvents } from '../lib/errorHandler.js';
import tribeRoutes from './tribe.js';

// asyncHandler emits to errorEvents on every route failure when `io` is set; an
// EventEmitter with no 'error' listener would rethrow and hang the response, so
// swallow it (matches routes/voice.test.js, routes/localLlm.test.js).
errorEvents.on('error', () => {});

vi.mock('../services/tribe.js', () => ({
  listPeople: vi.fn(),
  getCareSummary: vi.fn(),
  getPerson: vi.fn(),
  createPerson: vi.fn(),
  updatePerson: vi.fn(),
  deletePerson: vi.fn(),
  listTouchpoints: vi.fn(),
  createTouchpoint: vi.fn(),
  createCalendarTouchpoint: vi.fn(),
  listMemoryLinks: vi.fn(),
  linkMemory: vi.fn(),
  unlinkMemory: vi.fn(),
}));

import * as tribe from '../services/tribe.js';

const PERSON_ID = '11111111-1111-4111-8111-111111111111';
const MEMORY_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

describe('Tribe Routes', () => {
  let app;
  let emit;

  beforeEach(() => {
    emit = vi.fn();
    app = express();
    app.use(express.json());
    app.set('io', { emit });
    app.use('/api/tribe', tribeRoutes);
    vi.clearAllMocks();
  });

  it('lists people with search and ring filters', async () => {
    tribe.listPeople.mockResolvedValue([{ id: PERSON_ID, name: 'Ada' }]);

    const response = await request(app).get('/api/tribe/people?search=ada&ring=core');

    expect(response.status).toBe(200);
    expect(response.body.people).toEqual([{ id: PERSON_ID, name: 'Ada' }]);
    expect(tribe.listPeople).toHaveBeenCalledWith({ search: 'ada', ring: 'core' });
  });

  it('returns the care summary with a clamped limit', async () => {
    tribe.getCareSummary.mockResolvedValue({ hasPeople: true, peopleCount: 2, overdueCount: 1, overdue: [] });

    const response = await request(app).get('/api/tribe/care?limit=999');

    expect(response.status).toBe(200);
    expect(response.body.overdueCount).toBe(1);
    expect(tribe.getCareSummary).toHaveBeenCalledWith(50); // clamped from 999
  });

  it('creates a person and emits tribe changes', async () => {
    tribe.createPerson.mockResolvedValue({ id: PERSON_ID, name: 'Ada', ring: 'core' });

    const response = await request(app)
      .post('/api/tribe/people')
      .send({ name: 'Ada', ring: 'core', tags: ['mentor'] });

    expect(response.status).toBe(201);
    expect(response.body.id).toBe(PERSON_ID);
    expect(tribe.createPerson).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Ada',
      ring: 'core',
      tags: ['mentor'],
    }));
    expect(emit).toHaveBeenCalledWith('tribe:changed', { personId: PERSON_ID });
  });

  it('updates a person with partial fields', async () => {
    tribe.updatePerson.mockResolvedValue({ id: PERSON_ID, name: 'Ada', nextMove: 'Coffee' });

    const response = await request(app)
      .put(`/api/tribe/people/${PERSON_ID}`)
      .send({ nextMove: 'Coffee' });

    expect(response.status).toBe(200);
    expect(tribe.updatePerson).toHaveBeenCalledWith(PERSON_ID, { nextMove: 'Coffee' });
    expect(emit).toHaveBeenCalledWith('tribe:changed', { personId: PERSON_ID });
  });

  it('forwards calendar fields on a manual touchpoint', async () => {
    const touchpoint = {
      id: 'touch-1',
      personId: PERSON_ID,
      source: 'calendar',
      calendarAccountId: ACCOUNT_ID,
      calendarEventId: 'event-1',
    };
    tribe.createTouchpoint.mockResolvedValue(touchpoint);

    const response = await request(app)
      .post(`/api/tribe/people/${PERSON_ID}/touchpoints`)
      .send({
        happenedAt: '2026-06-18T15:00:00.000Z',
        source: 'calendar',
        calendarAccountId: ACCOUNT_ID,
        calendarEventId: 'event-1',
        metadata: { title: 'Walk' },
      });

    expect(response.status).toBe(201);
    expect(response.body.calendarEventId).toBe('event-1');
    expect(tribe.createTouchpoint).toHaveBeenCalledWith(PERSON_ID, expect.objectContaining({
      source: 'calendar',
      calendarAccountId: ACCOUNT_ID,
      calendarEventId: 'event-1',
      metadata: { title: 'Walk' },
    }));
  });

  it('creates touchpoints from calendar events', async () => {
    tribe.createCalendarTouchpoint.mockResolvedValue({
      id: 'touch-2',
      personId: PERSON_ID,
      source: 'calendar',
    });

    const response = await request(app)
      .post(`/api/tribe/people/${PERSON_ID}/touchpoints/calendar`)
      .send({ accountId: ACCOUNT_ID, eventId: 'cal-event-1', summary: 'Synced over lunch' });

    expect(response.status).toBe(201);
    expect(tribe.createCalendarTouchpoint).toHaveBeenCalledWith(PERSON_ID, {
      accountId: ACCOUNT_ID,
      eventId: 'cal-event-1',
      summary: 'Synced over lunch',
    });
  });

  it('links and unlinks brain memories for a person', async () => {
    tribe.linkMemory.mockResolvedValue({ personId: PERSON_ID, memoryId: MEMORY_ID });
    tribe.listMemoryLinks.mockResolvedValue([{ personId: PERSON_ID, memoryId: MEMORY_ID }]);

    const createResponse = await request(app)
      .post(`/api/tribe/people/${PERSON_ID}/memories`)
      .send({ memoryId: MEMORY_ID, note: 'Birthday context' });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.links).toEqual([{ personId: PERSON_ID, memoryId: MEMORY_ID }]);
    expect(tribe.linkMemory).toHaveBeenCalledWith(PERSON_ID, MEMORY_ID, 'Birthday context');

    tribe.unlinkMemory.mockResolvedValue(true);
    const deleteResponse = await request(app)
      .delete(`/api/tribe/people/${PERSON_ID}/memories/${MEMORY_ID}`);

    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body.success).toBe(true);
    expect(tribe.unlinkMemory).toHaveBeenCalledWith(PERSON_ID, MEMORY_ID);
  });

  it('rejects an empty name before service calls', async () => {
    const response = await request(app)
      .post('/api/tribe/people')
      .send({ name: '', ring: 'core' });

    expect(response.status).toBe(400);
    expect(tribe.createPerson).not.toHaveBeenCalled();
  });

  it('rejects an out-of-enum ring before service calls', async () => {
    const response = await request(app)
      .post('/api/tribe/people')
      .send({ name: 'Ada', ring: 'outer-space' });

    expect(response.status).toBe(400);
    expect(tribe.createPerson).not.toHaveBeenCalled();
  });

  it('rejects a blank lastContact (must be a date or null, not "")', async () => {
    const response = await request(app)
      .post('/api/tribe/people')
      .send({ name: 'Ada', ring: 'core', lastContact: '' });

    expect(response.status).toBe(400);
    expect(tribe.createPerson).not.toHaveBeenCalled();
  });

  it('accepts a create payload with lastContact: null', async () => {
    tribe.createPerson.mockResolvedValue({ id: PERSON_ID, name: 'Ada' });

    const response = await request(app)
      .post('/api/tribe/people')
      .send({ name: 'Ada', ring: 'core', lastContact: null });

    expect(response.status).toBe(201);
    expect(tribe.createPerson).toHaveBeenCalledWith(expect.objectContaining({ lastContact: null }));
  });

  it('rejects a PUT body that carries an id (id comes from the URL)', async () => {
    const response = await request(app)
      .put(`/api/tribe/people/${PERSON_ID}`)
      .send({ id: PERSON_ID, name: 'Ada' });

    expect(response.status).toBe(400);
    expect(tribe.updatePerson).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID person id path param with 400', async () => {
    const response = await request(app).get('/api/tribe/people/not-a-uuid');

    expect(response.status).toBe(400);
    expect(tribe.getPerson).not.toHaveBeenCalled();
  });

  it('rejects an out-of-enum ring query param with 400', async () => {
    const response = await request(app).get('/api/tribe/people?ring=outer-space');

    expect(response.status).toBe(400);
    expect(tribe.listPeople).not.toHaveBeenCalled();
  });

  it('returns 404 when getting a missing person', async () => {
    tribe.getPerson.mockResolvedValue(null);

    const response = await request(app).get(`/api/tribe/people/${PERSON_ID}`);

    expect(response.status).toBe(404);
  });

  it('returns 404 when updating a missing person', async () => {
    tribe.updatePerson.mockResolvedValue(null);

    const response = await request(app)
      .put(`/api/tribe/people/${PERSON_ID}`)
      .send({ nextMove: 'Coffee' });

    expect(response.status).toBe(404);
    expect(emit).not.toHaveBeenCalledWith('tribe:changed', expect.anything());
  });

  it('returns 404 when deleting a missing person', async () => {
    tribe.deletePerson.mockResolvedValue(false);

    const response = await request(app).delete(`/api/tribe/people/${PERSON_ID}`);

    expect(response.status).toBe(404);
    expect(emit).not.toHaveBeenCalledWith('tribe:changed', expect.anything());
  });
});

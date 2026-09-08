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
  checkDuplicateTribeIdentifiers: vi.fn(),
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

vi.mock('../services/tribeOutreach.js', () => ({
  findUnansweredTribeThreads: vi.fn(),
  generateOutreachDraft: vi.fn(),
}));

vi.mock('../services/beeperTribe.js', () => ({
  linkParticipant: vi.fn(),
  unlinkParticipant: vi.fn(),
  createPersonAndLinkParticipant: vi.fn(),
  listPersonIdentitiesWithConversations: vi.fn(),
  unlinkIdentity: vi.fn(),
}));

import * as tribe from '../services/tribe.js';
import * as tribeOutreach from '../services/tribeOutreach.js';
import * as beeperTribe from '../services/beeperTribe.js';

const PERSON_ID = '11111111-1111-4111-8111-111111111111';
const MEMORY_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '55555555-5555-4555-8555-555555555555';
const IDENTITY_ID = '77777777-7777-4777-8777-777777777777';

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

  it('returns the duplicate-identifiers report', async () => {
    const report = { emails: [{ identifier: 'a@x.com', people: [{ id: 'p1', name: 'Ada' }, { id: 'p2', name: 'Bea' }] }], phones: [] };
    tribe.checkDuplicateTribeIdentifiers.mockResolvedValue(report);

    const response = await request(app).get('/api/tribe/duplicate-identifiers');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(report);
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

  it('accepts and forwards an emails array on create', async () => {
    tribe.createPerson.mockResolvedValue({ id: PERSON_ID, name: 'Ada' });

    const response = await request(app)
      .post('/api/tribe/people')
      .send({ name: 'Ada', emails: ['ada@work.com', 'ada@home.com'] });

    expect(response.status).toBe(201);
    expect(tribe.createPerson).toHaveBeenCalledWith(expect.objectContaining({
      emails: ['ada@work.com', 'ada@home.com'],
    }));
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
        localDate: '2026-06-19',
        source: 'calendar',
        calendarAccountId: ACCOUNT_ID,
        calendarEventId: 'event-1',
        metadata: { title: 'Walk' },
      });

    expect(response.status).toBe(201);
    expect(response.body.calendarEventId).toBe('event-1');
    expect(tribe.createTouchpoint).toHaveBeenCalledWith(PERSON_ID, expect.objectContaining({
      source: 'calendar',
      localDate: '2026-06-19',
      calendarAccountId: ACCOUNT_ID,
      calendarEventId: 'event-1',
      metadata: { title: 'Walk' },
    }));
  });

  it('rejects an invalid local date on a manual touchpoint', async () => {
    const response = await request(app)
      .post(`/api/tribe/people/${PERSON_ID}/touchpoints`)
      .send({ localDate: '06/19/2026' });

    expect(response.status).toBe(400);
    expect(tribe.createTouchpoint).not.toHaveBeenCalled();
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
    expect(beeperTribe.listPersonIdentitiesWithConversations).not.toHaveBeenCalled();
  });

  it('merges the person read model with its linked Beeper identities (#99)', async () => {
    tribe.getPerson.mockResolvedValue({ id: PERSON_ID, name: 'Ada' });
    const identities = [
      {
        id: IDENTITY_ID, personId: PERSON_ID, kind: 'beeper-user', network: ACCOUNT_ID, handle: 'user-1',
        source: 'user', linkedAt: '2026-06-01T00:00:00.000Z',
        conversations: [{ conversationId: CONVERSATION_ID, network: 'whatsapp', title: 'Example Thread', accountId: ACCOUNT_ID, displayName: 'Example Person' }],
      },
    ];
    beeperTribe.listPersonIdentitiesWithConversations.mockResolvedValue(identities);

    const response = await request(app).get(`/api/tribe/people/${PERSON_ID}`);

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(PERSON_ID);
    expect(response.body.identities).toEqual(identities);
    expect(beeperTribe.listPersonIdentitiesWithConversations).toHaveBeenCalledWith(PERSON_ID);
  });

  it('returns an empty identities array for a person with no Beeper claims', async () => {
    tribe.getPerson.mockResolvedValue({ id: PERSON_ID, name: 'Ada' });
    beeperTribe.listPersonIdentitiesWithConversations.mockResolvedValue([]);

    const response = await request(app).get(`/api/tribe/people/${PERSON_ID}`);

    expect(response.status).toBe(200);
    expect(response.body.identities).toEqual([]);
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

  it('lists unanswered outreach threads with a clamped limit', async () => {
    tribeOutreach.findUnansweredTribeThreads.mockResolvedValue([
      { conversationKey: 'chat:1', personId: PERSON_ID, personName: 'Ada', daysAgo: 3 },
    ]);

    const response = await request(app).get('/api/tribe/outreach?limit=999');

    expect(response.status).toBe(200);
    expect(response.body.threads).toHaveLength(1);
    expect(tribeOutreach.findUnansweredTribeThreads).toHaveBeenCalledWith({ limit: 50 }); // clamped
  });

  it('generates an outreach draft and announces the new draft', async () => {
    tribeOutreach.generateOutreachDraft.mockResolvedValue({
      draft: { id: '44444444-4444-4444-8444-444444444444', body: 'Hey Ada!' },
      person: { id: PERSON_ID, name: 'Ada' },
    });

    const response = await request(app)
      .post('/api/tribe/outreach/draft')
      .send({ personId: PERSON_ID, source: 'imessage', chatGuid: 'chat-1' });

    expect(response.status).toBe(201);
    expect(response.body.draft.body).toBe('Hey Ada!');
    expect(tribeOutreach.generateOutreachDraft).toHaveBeenCalledWith(
      expect.objectContaining({ personId: PERSON_ID, source: 'imessage', chatGuid: 'chat-1' }),
    );
    expect(emit).toHaveBeenCalledWith('messages:draft:created', { draftId: '44444444-4444-4444-8444-444444444444' });
  });

  it('rejects an outreach draft request with a non-UUID personId', async () => {
    const response = await request(app)
      .post('/api/tribe/outreach/draft')
      .send({ personId: 'not-a-uuid', chatGuid: 'chat-1' });

    expect(response.status).toBe(400);
    expect(tribeOutreach.generateOutreachDraft).not.toHaveBeenCalled();
  });

  it('rejects an outreach draft request with no conversation key', async () => {
    const response = await request(app)
      .post('/api/tribe/outreach/draft')
      .send({ personId: PERSON_ID }); // valid person, but no thread/chat/convo/handle

    expect(response.status).toBe(400);
    expect(tribeOutreach.generateOutreachDraft).not.toHaveBeenCalled();
  });

  describe('Beeper participant linking (#34)', () => {
    it('links a Beeper participant to an existing person', async () => {
      beeperTribe.linkParticipant.mockResolvedValue({
        conversationId: CONVERSATION_ID, sourceUserId: 'user-1', tribePersonId: PERSON_ID, displacedPersonId: null,
      });

      const response = await request(app)
        .post('/api/tribe/beeper/link')
        .send({ conversationId: CONVERSATION_ID, sourceUserId: 'user-1', personId: PERSON_ID });

      expect(response.status).toBe(200);
      expect(response.body.participant.tribePersonId).toBe(PERSON_ID);
      expect(response.body.displacedPersonId).toBeNull();
      // No `network` — it's derived server-side from the participant's own
      // conversation, never accepted from the request body (#34 review).
      expect(beeperTribe.linkParticipant).toHaveBeenCalledWith({
        conversationId: CONVERSATION_ID, sourceUserId: 'user-1', personId: PERSON_ID,
      });
      expect(emit).toHaveBeenCalledWith('tribe:changed', { personId: PERSON_ID });
    });

    it('surfaces a displaced person when the handle was already claimed by someone else', async () => {
      const OTHER_PERSON_ID = '66666666-6666-4666-8666-666666666666';
      beeperTribe.linkParticipant.mockResolvedValue({
        conversationId: CONVERSATION_ID, sourceUserId: 'user-1', tribePersonId: PERSON_ID, displacedPersonId: OTHER_PERSON_ID,
      });

      const response = await request(app)
        .post('/api/tribe/beeper/link')
        .send({ conversationId: CONVERSATION_ID, sourceUserId: 'user-1', personId: PERSON_ID });

      expect(response.status).toBe(200);
      expect(response.body.displacedPersonId).toBe(OTHER_PERSON_ID);
      expect(response.body.participant.displacedPersonId).toBeUndefined();
    });

    it('rejects a link request with a non-UUID personId', async () => {
      const response = await request(app)
        .post('/api/tribe/beeper/link')
        .send({ conversationId: CONVERSATION_ID, sourceUserId: 'user-1', personId: 'not-a-uuid' });

      expect(response.status).toBe(400);
      expect(beeperTribe.linkParticipant).not.toHaveBeenCalled();
    });

    it('unlinks a participant, removing its claims', async () => {
      beeperTribe.unlinkParticipant.mockResolvedValue({
        participant: { conversationId: CONVERSATION_ID, sourceUserId: 'user-1', tribePersonId: null },
        unlinkedPersonId: PERSON_ID,
        removedClaims: 2,
      });

      const response = await request(app)
        .delete('/api/tribe/beeper/link')
        .send({ conversationId: CONVERSATION_ID, sourceUserId: 'user-1' });

      expect(response.status).toBe(200);
      expect(response.body.participant.tribePersonId).toBeNull();
      expect(response.body.unlinkedPersonId).toBe(PERSON_ID);
      expect(response.body.removedClaims).toBe(2);
      expect(beeperTribe.unlinkParticipant).toHaveBeenCalledWith({
        conversationId: CONVERSATION_ID, sourceUserId: 'user-1',
      });
      expect(emit).toHaveBeenCalledWith('tribe:changed', { personId: PERSON_ID });
    });

    it('is a 200 no-op — with no socket emit — for an already-unlinked participant', async () => {
      beeperTribe.unlinkParticipant.mockResolvedValue({
        participant: { conversationId: CONVERSATION_ID, sourceUserId: 'user-1', tribePersonId: null },
        unlinkedPersonId: null,
        removedClaims: 0,
      });

      const response = await request(app)
        .delete('/api/tribe/beeper/link')
        .send({ conversationId: CONVERSATION_ID, sourceUserId: 'user-1' });

      expect(response.status).toBe(200);
      expect(response.body.unlinkedPersonId).toBeNull();
      expect(emit).not.toHaveBeenCalled();
    });

    it('surfaces a 404 for an unknown participant on unlink', async () => {
      const error = Object.assign(new Error('Participant not found'), { status: 404 });
      beeperTribe.unlinkParticipant.mockRejectedValue(error);

      const response = await request(app)
        .delete('/api/tribe/beeper/link')
        .send({ conversationId: CONVERSATION_ID, sourceUserId: 'ghost' });

      expect(response.status).toBe(404);
    });

    it('rejects an unlink request missing sourceUserId', async () => {
      const response = await request(app)
        .delete('/api/tribe/beeper/link')
        .send({ conversationId: CONVERSATION_ID });

      expect(response.status).toBe(400);
      expect(beeperTribe.unlinkParticipant).not.toHaveBeenCalled();
    });

    it('creates a new Tribe person from a participant and links it', async () => {
      beeperTribe.createPersonAndLinkParticipant.mockResolvedValue({
        person: { id: PERSON_ID, name: 'Example Person' },
        participant: { conversationId: CONVERSATION_ID, sourceUserId: 'user-2', tribePersonId: PERSON_ID },
        created: true,
        displacedPersonId: null,
      });

      const response = await request(app)
        .post('/api/tribe/beeper/link-new')
        .send({ conversationId: CONVERSATION_ID, sourceUserId: 'user-2', name: 'Example Person' });

      expect(response.status).toBe(201);
      expect(response.body.person.id).toBe(PERSON_ID);
      expect(response.body.displacedPersonId).toBeNull();
      // No `network` — it's derived server-side, never accepted from the
      // request body (#34 review).
      expect(beeperTribe.createPersonAndLinkParticipant).toHaveBeenCalledWith(expect.objectContaining({
        conversationId: CONVERSATION_ID, sourceUserId: 'user-2', name: 'Example Person',
      }));
      expect(beeperTribe.createPersonAndLinkParticipant).toHaveBeenCalledWith(
        expect.not.objectContaining({ network: expect.anything() }),
      );
      expect(emit).toHaveBeenCalledWith('tribe:changed', { personId: PERSON_ID });
    });

    it('rejects a create-and-link request missing sourceUserId', async () => {
      const response = await request(app)
        .post('/api/tribe/beeper/link-new')
        .send({ conversationId: CONVERSATION_ID, name: 'Example Person' });

      expect(response.status).toBe(400);
      expect(beeperTribe.createPersonAndLinkParticipant).not.toHaveBeenCalled();
    });
  });

  describe('Unlink a Beeper identity (#99)', () => {
    it('deletes the identity and emits a tribe change', async () => {
      beeperTribe.unlinkIdentity.mockResolvedValue({ id: IDENTITY_ID, personId: PERSON_ID, kind: 'handle', network: 'whatsapp', handle: 'ada' });

      const response = await request(app).delete(`/api/tribe/beeper/identities/${IDENTITY_ID}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(beeperTribe.unlinkIdentity).toHaveBeenCalledWith(IDENTITY_ID);
      expect(emit).toHaveBeenCalledWith('tribe:changed', { personId: PERSON_ID });
    });

    it('returns 404 for an unknown identity id', async () => {
      beeperTribe.unlinkIdentity.mockResolvedValue(null);

      const response = await request(app).delete(`/api/tribe/beeper/identities/${IDENTITY_ID}`);

      expect(response.status).toBe(404);
      expect(emit).not.toHaveBeenCalledWith('tribe:changed', expect.anything());
    });

    it('rejects a non-UUID identity id with 400', async () => {
      const response = await request(app).delete('/api/tribe/beeper/identities/not-a-uuid');

      expect(response.status).toBe(400);
      expect(beeperTribe.unlinkIdentity).not.toHaveBeenCalled();
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/imessageSync.js', () => ({
  checkSetup: vi.fn(async () => ({ ok: true, messageCount: 1 })),
  getStatus: vi.fn(async () => ({ config: { enabled: false }, state: {} })),
  runSync: vi.fn(async () => ({ ok: true, recorded: 0 })),
}));

vi.mock('../services/imessageManage.js', () => ({
  listConversations: vi.fn(async () => [{ chatKey: 'abc', chatGuid: 'g1', title: 'Test', eventCount: 2 }]),
  listConversationEvents: vi.fn(async (key) => (
    key === 'bad'
      ? { chatGuid: null, chatKey: key, events: [] }
      : { chatGuid: 'g1', chatKey: key, events: [{ id: 'e1', summary: 'hi' }] }
  )),
  purgeConversation: vi.fn(async (key) => (
    key === 'bad' ? { deleted: 0, chatGuid: null } : { deleted: 3, chatGuid: 'g1', chatKey: key }
  )),
  deleteEvent: vi.fn(async () => ({ deleted: 1 })),
  readBlocklist: vi.fn(async () => ({ handles: ['+15551234567'], updatedAt: null })),
  setBlocklist: vi.fn(async (handles) => ({ handles, updatedAt: '2026-01-01T00:00:00.000Z' })),
  addToBlocklist: vi.fn(async (handles, opts) => ({
    handles: ['+15551234567'],
    added: Array.isArray(handles) ? handles : [handles],
    purged: opts?.purgeExisting ? 2 : 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
  })),
  removeFromBlocklist: vi.fn(async () => ({ handles: [], updatedAt: null })),
  getStats: vi.fn(async () => ({ source: 'imessage', eventCount: 5, conversationCount: 2, blockedCount: 1 })),
}));

const { default: router } = await import('./imessage.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/imessage', router);
  app.use(errorMiddleware);
  return app;
}

describe('imessage routes (#2413)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /conversations returns the list', async () => {
    const res = await request(makeApp()).get('/api/imessage/conversations');
    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.conversations[0].title).toBe('Test');
  });

  it('GET /conversations/:chatKey/events returns events', async () => {
    const res = await request(makeApp()).get('/api/imessage/conversations/abc/events');
    expect(res.status).toBe(200);
    expect(res.body.events[0].id).toBe('e1');
  });

  it('GET /conversations/:chatKey/events 400s on invalid key', async () => {
    const res = await request(makeApp()).get('/api/imessage/conversations/bad/events');
    expect(res.status).toBe(400);
  });

  it('DELETE /conversations/:chatKey purges', async () => {
    const res = await request(makeApp()).delete('/api/imessage/conversations/abc');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(3);
  });

  it('DELETE /events/:id deletes one event', async () => {
    const res = await request(makeApp()).delete('/api/imessage/events/e1');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
  });

  it('POST /blocklist accepts handles + purgeExisting', async () => {
    const res = await request(makeApp())
      .post('/api/imessage/blocklist')
      .send({ handles: '+15551234567', purgeExisting: true });
    expect(res.status).toBe(200);
    expect(res.body.purged).toBe(2);
  });

  it('GET /stats returns aggregate counts', async () => {
    const res = await request(makeApp()).get('/api/imessage/stats');
    expect(res.status).toBe(200);
    expect(res.body.eventCount).toBe(5);
    expect(res.body.blockedCount).toBe(1);
  });
});

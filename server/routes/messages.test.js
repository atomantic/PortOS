import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import messagesRoutes from './messages.js';

// Mock the services
vi.mock('../services/messageAccounts.js', () => ({
  listAccounts: vi.fn(),
  getAccount: vi.fn(),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  deleteAccount: vi.fn(),
  updateSyncStatus: vi.fn()
}));

vi.mock('../services/messageSync.js', () => ({
  syncAccount: vi.fn(),
  getSyncStatus: vi.fn(),
  getMessages: vi.fn(),
  getMessage: vi.fn(),
  getThread: vi.fn(),
  deleteCache: vi.fn()
}));

vi.mock('../services/messageDrafts.js', () => ({
  listDrafts: vi.fn(),
  createDraft: vi.fn(),
  updateDraft: vi.fn(),
  approveDraft: vi.fn(),
  deleteDraft: vi.fn(),
  deleteDraftsByAccountId: vi.fn()
}));

vi.mock('../services/messageSender.js', () => ({
  sendDraft: vi.fn()
}));

vi.mock('../services/messagePlaywrightSync.js', () => ({
  getSelectors: vi.fn(),
  updateSelectors: vi.fn(),
  testSelectors: vi.fn(),
  launchProvider: vi.fn()
}));

// Import mocked modules
import * as messageAccounts from '../services/messageAccounts.js';
import * as messageSync from '../services/messageSync.js';
import * as messageDrafts from '../services/messageDrafts.js';
import * as messageSender from '../services/messageSender.js';
import * as messagePlaywrightSync from '../services/messagePlaywrightSync.js';

const VALID_UUID = '11111111-1111-1111-1111-111111111111';
const VALID_UUID_2 = '22222222-2222-2222-2222-222222222222';
const DRAFT_UUID = '33333333-3333-3333-3333-333333333333';
const DRAFT_UUID_2 = '44444444-4444-4444-4444-444444444444';
const INVALID_UUID = 'not-a-uuid';

describe('Messages Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/messages', messagesRoutes);
    vi.clearAllMocks();
  });

  // === Account Routes ===

  describe('GET /api/messages/accounts', () => {
    it('should return list of accounts', async () => {
      const mockAccounts = [
        { id: VALID_UUID, name: 'Work Gmail', type: 'gmail' }
      ];
      messageAccounts.listAccounts.mockResolvedValue(mockAccounts);

      const response = await request(app).get('/api/messages/accounts');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockAccounts);
    });

    it('should return empty array when no accounts exist', async () => {
      messageAccounts.listAccounts.mockResolvedValue([]);

      const response = await request(app).get('/api/messages/accounts');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(0);
    });
  });

  describe('POST /api/messages/accounts', () => {
    it('should create a new account', async () => {
      const newAccount = { name: 'Work Gmail', type: 'gmail', email: 'work@gmail.com' };
      const created = { id: VALID_UUID, ...newAccount, enabled: true };
      messageAccounts.createAccount.mockResolvedValue(created);

      const response = await request(app)
        .post('/api/messages/accounts')
        .send(newAccount);

      expect(response.status).toBe(201);
      expect(response.body.id).toBe(VALID_UUID);
      expect(messageAccounts.createAccount).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Work Gmail', type: 'gmail' })
      );
    });

    it('should return 400 for missing name', async () => {
      const response = await request(app)
        .post('/api/messages/accounts')
        .send({ type: 'gmail' });

      expect(response.status).toBe(400);
    });

    it('should return 400 for invalid type', async () => {
      const response = await request(app)
        .post('/api/messages/accounts')
        .send({ name: 'Test', type: 'yahoo' });

      expect(response.status).toBe(400);
    });
  });

  describe('PUT /api/messages/accounts/:id', () => {
    it('should update an account', async () => {
      const updated = { id: VALID_UUID, name: 'Updated', type: 'gmail' };
      messageAccounts.updateAccount.mockResolvedValue(updated);

      const response = await request(app)
        .put(`/api/messages/accounts/${VALID_UUID}`)
        .send({ name: 'Updated' });

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Updated');
      expect(messageAccounts.updateAccount).toHaveBeenCalledWith(VALID_UUID, { name: 'Updated' });
    });

    it('should return 400 for invalid UUID', async () => {
      const response = await request(app)
        .put(`/api/messages/accounts/${INVALID_UUID}`)
        .send({ name: 'Updated' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid account ID format');
    });

    it('should return 404 if account not found', async () => {
      messageAccounts.updateAccount.mockResolvedValue(null);

      const response = await request(app)
        .put(`/api/messages/accounts/${VALID_UUID}`)
        .send({ name: 'Updated' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Account not found');
    });
  });

  describe('DELETE /api/messages/accounts/:id', () => {
    it('should delete an account', async () => {
      messageAccounts.deleteAccount.mockResolvedValue(true);
      messageSync.deleteCache.mockResolvedValue();
      messageDrafts.deleteDraftsByAccountId.mockResolvedValue();

      const response = await request(app).delete(`/api/messages/accounts/${VALID_UUID}`);

      expect(response.status).toBe(204);
      expect(messageAccounts.deleteAccount).toHaveBeenCalledWith(VALID_UUID);
      expect(messageSync.deleteCache).toHaveBeenCalledWith(VALID_UUID);
      expect(messageDrafts.deleteDraftsByAccountId).toHaveBeenCalledWith(VALID_UUID);
    });

    it('should return 400 for invalid UUID', async () => {
      const response = await request(app).delete(`/api/messages/accounts/${INVALID_UUID}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid account ID format');
    });

    it('should return 404 if account not found', async () => {
      messageAccounts.deleteAccount.mockResolvedValue(false);

      const response = await request(app).delete(`/api/messages/accounts/${VALID_UUID}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Account not found');
    });
  });

  // === Sync Routes ===

  describe('POST /api/messages/sync/:accountId', () => {
    it('should trigger sync for an account', async () => {
      messageSync.syncAccount.mockResolvedValue({ newMessages: 5, total: 100 });

      const response = await request(app).post(`/api/messages/sync/${VALID_UUID}`);

      expect(response.status).toBe(200);
      expect(response.body.newMessages).toBe(5);
      expect(messageSync.syncAccount).toHaveBeenCalledWith(VALID_UUID, undefined, { mode: 'unread' });
    });

    it('should return 400 for invalid UUID', async () => {
      const response = await request(app).post(`/api/messages/sync/${INVALID_UUID}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid account ID format');
    });

    it('should return 404 if account not found', async () => {
      messageSync.syncAccount.mockResolvedValue({ error: 'Account not found' });

      const response = await request(app).post(`/api/messages/sync/${VALID_UUID}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Account not found');
    });
  });

  describe('GET /api/messages/sync/:accountId/status', () => {
    it('should return sync status', async () => {
      const status = { accountId: VALID_UUID, lastSyncAt: '2026-01-01T00:00:00Z', lastSyncStatus: 'success' };
      messageSync.getSyncStatus.mockResolvedValue(status);

      const response = await request(app).get(`/api/messages/sync/${VALID_UUID}/status`);

      expect(response.status).toBe(200);
      expect(response.body.lastSyncStatus).toBe('success');
    });

    it('should return 404 if account not found', async () => {
      messageSync.getSyncStatus.mockResolvedValue(null);

      const response = await request(app).get(`/api/messages/sync/${VALID_UUID}/status`);

      expect(response.status).toBe(404);
    });
  });

  // === Inbox Routes ===

  describe('GET /api/messages/inbox', () => {
    it('should return messages', async () => {
      const result = { messages: [{ id: 'msg-1', subject: 'Hello' }], total: 1 };
      messageSync.getMessages.mockResolvedValue(result);

      const response = await request(app).get('/api/messages/inbox');

      expect(response.status).toBe(200);
      expect(response.body.messages).toHaveLength(1);
      expect(response.body.total).toBe(1);
    });

    it('should pass accountId filter', async () => {
      messageSync.getMessages.mockResolvedValue({ messages: [], total: 0 });

      await request(app).get(`/api/messages/inbox?accountId=${VALID_UUID}`);

      expect(messageSync.getMessages).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: VALID_UUID })
      );
    });

    it('should return 400 for invalid accountId format', async () => {
      const response = await request(app).get(`/api/messages/inbox?accountId=${INVALID_UUID}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid accountId format');
    });

    it('should clamp limit to 100', async () => {
      messageSync.getMessages.mockResolvedValue({ messages: [], total: 0 });

      await request(app).get('/api/messages/inbox?limit=999');

      expect(messageSync.getMessages).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 })
      );
    });

    it('should default limit to 50 for invalid values', async () => {
      messageSync.getMessages.mockResolvedValue({ messages: [], total: 0 });

      await request(app).get('/api/messages/inbox?limit=abc');

      expect(messageSync.getMessages).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50 })
      );
    });
  });

  // === Draft Routes ===

  describe('GET /api/messages/drafts', () => {
    it('should return list of drafts', async () => {
      const drafts = [{ id: DRAFT_UUID, subject: 'Re: Hello', status: 'draft' }];
      messageDrafts.listDrafts.mockResolvedValue(drafts);

      const response = await request(app).get('/api/messages/drafts');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
    });

    it('should pass accountId and status filters', async () => {
      messageDrafts.listDrafts.mockResolvedValue([]);

      await request(app).get(`/api/messages/drafts?accountId=${VALID_UUID}&status=draft`);

      expect(messageDrafts.listDrafts).toHaveBeenCalledWith({
        accountId: VALID_UUID,
        status: 'draft'
      });
    });
  });

  describe('POST /api/messages/drafts', () => {
    it('should create a draft', async () => {
      const draftData = { accountId: VALID_UUID, subject: 'Test', body: 'Hello' };
      const account = { id: VALID_UUID, type: 'gmail', provider: 'api' };
      const created = { id: DRAFT_UUID, ...draftData, status: 'draft' };

      messageAccounts.getAccount.mockResolvedValue(account);
      messageDrafts.createDraft.mockResolvedValue(created);

      const response = await request(app)
        .post('/api/messages/drafts')
        .send(draftData);

      expect(response.status).toBe(201);
      expect(response.body.id).toBe(DRAFT_UUID);
      expect(messageDrafts.createDraft).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: VALID_UUID, sendVia: 'api' })
      );
    });

    it('should return 404 if account not found', async () => {
      messageAccounts.getAccount.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/messages/drafts')
        .send({ accountId: VALID_UUID });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Account not found');
    });

    it('should reject invalid accountId format', async () => {
      const response = await request(app)
        .post('/api/messages/drafts')
        .send({ accountId: INVALID_UUID });

      // validateRequest returns 400 for invalid input
      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/messages/drafts/generate', () => {
    it('should generate a draft', async () => {
      const account = { id: VALID_UUID, type: 'outlook', provider: 'playwright' };
      const created = { id: DRAFT_UUID, generatedBy: 'ai', status: 'draft' };

      messageAccounts.getAccount.mockResolvedValue(account);
      messageDrafts.createDraft.mockResolvedValue(created);

      const response = await request(app)
        .post('/api/messages/drafts/generate')
        .send({ accountId: VALID_UUID, context: 'meeting follow-up' });

      expect(response.status).toBe(201);
      expect(response.body.generatedBy).toBe('ai');
    });

    it('should return 404 if account not found', async () => {
      messageAccounts.getAccount.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/messages/drafts/generate')
        .send({ accountId: VALID_UUID });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Account not found');
    });
  });

  describe('PUT /api/messages/drafts/:id', () => {
    it('should update a draft', async () => {
      const updated = { id: DRAFT_UUID, subject: 'Updated', status: 'draft' };
      messageDrafts.updateDraft.mockResolvedValue(updated);

      const response = await request(app)
        .put(`/api/messages/drafts/${DRAFT_UUID}`)
        .send({ subject: 'Updated' });

      expect(response.status).toBe(200);
      expect(response.body.subject).toBe('Updated');
    });

    it('should return 404 if draft not found', async () => {
      messageDrafts.updateDraft.mockResolvedValue(null);

      const response = await request(app)
        .put(`/api/messages/drafts/${DRAFT_UUID_2}`)
        .send({ subject: 'Updated' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Draft not found');
    });
  });

  describe('POST /api/messages/drafts/:id/approve', () => {
    it('should approve a draft', async () => {
      const approved = { id: DRAFT_UUID, status: 'approved' };
      messageDrafts.approveDraft.mockResolvedValue(approved);

      const response = await request(app).post(`/api/messages/drafts/${DRAFT_UUID}/approve`);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('approved');
    });

    it('should return 404 if draft not found', async () => {
      messageDrafts.approveDraft.mockResolvedValue(null);

      const response = await request(app).post(`/api/messages/drafts/${DRAFT_UUID_2}/approve`);

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/messages/drafts/:id/send', () => {
    it('should send a draft', async () => {
      messageSender.sendDraft.mockResolvedValue({ success: true });

      const response = await request(app).post(`/api/messages/drafts/${DRAFT_UUID}/send`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should return 404 if draft not found', async () => {
      messageSender.sendDraft.mockResolvedValue({ success: false, status: 404, code: 'DRAFT_NOT_FOUND', error: 'Draft not found' });

      const response = await request(app).post(`/api/messages/drafts/${DRAFT_UUID_2}/send`);

      expect(response.status).toBe(404);
    });

    it('should return 400 for non-not-found errors', async () => {
      messageSender.sendDraft.mockResolvedValue({ success: false, status: 400, code: 'INVALID_STATUS', error: 'Draft not approved' });

      const response = await request(app).post(`/api/messages/drafts/${DRAFT_UUID}/send`);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Draft not approved');
    });
  });

  describe('DELETE /api/messages/drafts/:id', () => {
    it('should delete a draft', async () => {
      messageDrafts.deleteDraft.mockResolvedValue(true);

      const response = await request(app).delete(`/api/messages/drafts/${DRAFT_UUID}`);

      expect(response.status).toBe(204);
    });

    it('should return 404 if draft not found', async () => {
      messageDrafts.deleteDraft.mockResolvedValue(false);

      const response = await request(app).delete(`/api/messages/drafts/${DRAFT_UUID_2}`);

      expect(response.status).toBe(404);
    });
  });

  // === Thread Route ===

  describe('GET /api/messages/thread/:accountId/:threadId', () => {
    it('should return thread messages', async () => {
      const threadMessages = [
        { id: 'msg-1', subject: 'Hello', threadId: 'thread-1' },
        { id: 'msg-2', subject: 'Hello', threadId: 'thread-1' }
      ];
      messageSync.getThread.mockResolvedValue(threadMessages);

      const response = await request(app).get(`/api/messages/thread/${VALID_UUID}/thread-1`);

      expect(response.status).toBe(200);
      expect(response.body.messages).toHaveLength(2);
      expect(messageSync.getThread).toHaveBeenCalledWith(VALID_UUID, 'thread-1');
    });

    it('should return 400 for invalid accountId', async () => {
      const response = await request(app).get(`/api/messages/thread/${INVALID_UUID}/thread-1`);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid accountId format');
    });

    it('should return empty array for unknown threadId', async () => {
      messageSync.getThread.mockResolvedValue([]);

      const response = await request(app).get(`/api/messages/thread/${VALID_UUID}/unknown`);

      expect(response.status).toBe(200);
      expect(response.body.messages).toHaveLength(0);
    });
  });

  // === Message Detail Route ===

  describe('GET /api/messages/:accountId/:messageId', () => {
    it('should return a message', async () => {
      const message = { id: 'msg-1', subject: 'Hello', accountId: VALID_UUID };
      messageSync.getMessage.mockResolvedValue(message);

      const response = await request(app).get(`/api/messages/${VALID_UUID}/msg-1`);

      expect(response.status).toBe(200);
      expect(response.body.subject).toBe('Hello');
    });

    it('should return 400 for invalid accountId', async () => {
      const response = await request(app).get(`/api/messages/${INVALID_UUID}/msg-1`);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid accountId or messageId format');
    });

    it('should return 404 if message not found', async () => {
      messageSync.getMessage.mockResolvedValue(null);

      const response = await request(app).get(`/api/messages/${VALID_UUID}/msg-1`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Message not found');
    });
  });

  // === Browser Launch Route ===

  describe('POST /api/messages/launch/:accountId', () => {
    it('should launch browser for outlook account', async () => {
      messageAccounts.getAccount.mockResolvedValue({ id: VALID_UUID, type: 'outlook' });
      messagePlaywrightSync.launchProvider.mockResolvedValue({ success: true });

      const response = await request(app).post(`/api/messages/launch/${VALID_UUID}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(messagePlaywrightSync.launchProvider).toHaveBeenCalledWith('outlook');
    });

    it('should return 404 if account not found', async () => {
      messageAccounts.getAccount.mockResolvedValue(null);

      const response = await request(app).post(`/api/messages/launch/${VALID_UUID}`);

      expect(response.status).toBe(404);
    });

    it('should return 400 for gmail accounts', async () => {
      messageAccounts.getAccount.mockResolvedValue({ id: VALID_UUID, type: 'gmail' });

      const response = await request(app).post(`/api/messages/launch/${VALID_UUID}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Gmail uses the Google API, not browser automation');
    });

    it('should return 503 if launch fails', async () => {
      messageAccounts.getAccount.mockResolvedValue({ id: VALID_UUID, type: 'teams' });
      messagePlaywrightSync.launchProvider.mockResolvedValue({ success: false, error: 'Browser not found' });

      const response = await request(app).post(`/api/messages/launch/${VALID_UUID}`);

      expect(response.status).toBe(503);
    });
  });

  // === Selector Routes ===

  describe('GET /api/messages/selectors', () => {
    it('should return selectors', async () => {
      const selectors = { outlook: { inbox: '.inbox' }, teams: { chat: '.chat' } };
      messagePlaywrightSync.getSelectors.mockResolvedValue(selectors);

      const response = await request(app).get('/api/messages/selectors');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(selectors);
    });
  });

  describe('PUT /api/messages/selectors/:provider', () => {
    it('should update selectors for a valid provider', async () => {
      const updated = { inbox: '.new-inbox' };
      messagePlaywrightSync.updateSelectors.mockResolvedValue(updated);

      const response = await request(app)
        .put('/api/messages/selectors/outlook')
        .send({ selectors: { inbox: '.new-inbox' } });

      expect(response.status).toBe(200);
      expect(messagePlaywrightSync.updateSelectors).toHaveBeenCalledWith('outlook', { inbox: '.new-inbox' });
    });

    it('should return 400 for invalid provider', async () => {
      const response = await request(app)
        .put('/api/messages/selectors/gmail')
        .send({ selectors: { inbox: '.inbox' } });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid provider');
    });
  });

  describe('POST /api/messages/selectors/:provider/test', () => {
    it('should test selectors for a valid provider', async () => {
      messagePlaywrightSync.testSelectors.mockResolvedValue({ provider: 'teams', results: { matched: 5 }, status: 'ok' });

      const response = await request(app).post('/api/messages/selectors/teams/test');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.provider).toBe('teams');
      expect(response.body.results).toEqual({ matched: 5 });
    });

    it('should return 400 for invalid provider', async () => {
      const response = await request(app).post('/api/messages/selectors/gmail/test');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid provider');
    });
  });
});

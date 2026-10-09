import { beforeEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { join } from 'path';
import { request } from '../lib/testHelper.js';

// Exercise HTTP creation/approval/send through the real store, sender and Gmail
// adapter. Only storage, account/cache lookup and the external provider are doubled.
const doubles = vi.hoisted(() => ({
  files: new Map(), original: null, metadata: vi.fn(), submit: vi.fn(), auth: { getAccessToken: vi.fn() }
}));
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { messages: '/mock/messages' },
  UUID_RE: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,
  ensureDir: async () => {},
  readJSONFileStrict: async (path, fallback) => ({
    ok: true, value: doubles.files.has(path) ? JSON.parse(doubles.files.get(path)) : fallback
  }),
  tryReadFile: async path => doubles.files.get(path) ?? null,
  atomicWrite: async (path, data) => { doubles.files.set(path, JSON.stringify(data)); },
  safeJSONParse: JSON.parse
}));
vi.mock('../services/messageAccounts.js', () => ({
  getAccount: async id => ({ id, type: 'gmail' }), listAccounts: async () => []
}));
vi.mock('../services/messageSync.js', () => ({
  getMessage: async (accountId, id) => doubles.original?.id === id && doubles.original.accountId === accountId ? doubles.original : null
}));
vi.mock('../services/googleAuth.js', () => ({ getAuthenticatedClient: async () => doubles.auth }));
vi.mock('@googleapis/gmail', () => ({ gmail: () => ({ users: { messages: { get: doubles.metadata, send: doubles.submit } } }) }));
vi.mock('../services/messagePlaywrightSync.js', () => ({ getSelectors: vi.fn(), updateSelectors: vi.fn(), testSelectors: vi.fn(), launchProvider: vi.fn() }));
vi.mock('../services/messageEvaluator.js', () => ({ evaluateMessages: vi.fn(), generateReplyBody: vi.fn() }));
vi.mock('../services/messageActions.js', () => ({ executeAction: vi.fn() }));
vi.mock('../services/messageTriageRules.js', () => ({ listRules: vi.fn(), deleteRule: vi.fn() }));
vi.mock('../services/messageTokenExtractor.js', () => ({ getToken: vi.fn(), getTokenStatus: vi.fn(), testApi: vi.fn(), clearTokenCache: vi.fn() }));

import messagesRoutes from './messages.js';
import { errorEvents } from '../lib/errorHandler.js';
import { getDraft, updateDraft } from '../services/messageDrafts.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const LOCAL_ID = '33333333-3333-4333-8333-333333333333';
const observeError = () => {};
beforeAll(() => errorEvents.on('error', observeError));
afterAll(() => errorEvents.off('error', observeError));
let app;
const metadata = () => ({ data: {
  id: 'gmail-message-1', threadId: 'gmail-thread-1', payload: { headers: [
    { name: 'Message-ID', value: '<original@example.com>' },
    { name: 'References', value: '<root@example.com>\r\n <parent@example.com>' },
    { name: 'Subject', value: 'Example conversation' }
  ] }
} });

beforeEach(() => {
  vi.resetAllMocks();
  doubles.files.clear();
  doubles.original = {
    id: LOCAL_ID, accountId: ACCOUNT_ID, apiId: 'gmail-message-1',
    threadId: 'conv-local-hash', conversationId: 'gmail-thread-1'
    // Legacy cache: no persisted RFC Message-ID or References.
  };
  doubles.metadata.mockResolvedValue(metadata());
  doubles.auth.getAccessToken.mockResolvedValue({ token: 'example-token' });
  doubles.submit.mockResolvedValue({ data: { id: 'gmail-reply-1' } });
  app = express();
  app.use(express.json());
  app.use('/api/messages', messagesRoutes);
});

async function approvedReply(overrides = {}) {
  const created = await request(app).post('/api/messages/drafts').send({
    accountId: ACCOUNT_ID, replyToMessageId: LOCAL_ID, threadId: 'conv-local-hash',
    to: ['alice@example.com'], subject: 'Re: Example conversation', body: 'Example reply', ...overrides
  });
  expect(created.status).toBe(201);
  const { id } = created.body;
  expect((await request(app).post(`/api/messages/drafts/${id}/approve`)).status).toBe(200);
  return id;
}

describe('HTTP Gmail reply identity', () => {
  it('resolves legacy local IDs once, preserves the RFC chain and submits the provider thread and subject', async () => {
    const id = await approvedReply();
    expect((await request(app).post(`/api/messages/drafts/${id}/send`)).body).toEqual({ success: true });
    expect((await getDraft(id)).status).toBe('sent');
    expect(doubles.metadata).toHaveBeenCalledTimes(1);
    expect(doubles.metadata).toHaveBeenCalledWith({
      userId: 'me', id: 'gmail-message-1', format: 'metadata',
      metadataHeaders: ['Message-ID', 'References', 'In-Reply-To', 'Subject']
    }, { timeout: 10_000, retry: false });
    expect(doubles.submit).toHaveBeenCalledTimes(1);
    const [{ requestBody }, options] = doubles.submit.mock.calls[0];
    expect(requestBody.threadId).toBe('gmail-thread-1');
    expect(options).toEqual({ retry: false });
    const mime = Buffer.from(requestBody.raw, 'base64url').toString('utf8');
    expect(mime).toContain('In-Reply-To: <original@example.com>\r\n');
    expect(mime).toContain('References: <root@example.com> <parent@example.com> <original@example.com>\r\n');
    expect(mime).toContain('Subject: Example conversation\r\n');
    expect(mime).toContain('\r\n\r\nExample reply');
    expect(mime).not.toContain(LOCAL_ID);
    expect(mime).not.toContain('conv-local-hash');
    expect((await getDraft(id)).replyToMessageId).toBe(LOCAL_ID);
  });

  it('fills an empty reply subject and uses the parent In-Reply-To when References are absent', async () => {
    const data = metadata();
    data.data.payload.headers = data.data.payload.headers.filter(h => h.name !== 'References');
    data.data.payload.headers.push({ name: 'In-Reply-To', value: '<parent@example.com>' });
    doubles.metadata.mockResolvedValue(data);
    const id = await approvedReply({ subject: '', threadId: null });
    expect((await request(app).post(`/api/messages/drafts/${id}/send`)).status).toBe(200);
    const mime = Buffer.from(doubles.submit.mock.calls[0][0].requestBody.raw, 'base64url').toString('utf8');
    expect(mime).toContain('References: <parent@example.com> <original@example.com>\r\n');
    expect(mime).toContain('Subject: Example conversation\r\n');
  });

  it.each([
    ['missing original', () => { doubles.original = null; }, {}, 'REPLY_TARGET_NOT_FOUND'],
    ['wrong account', () => {}, { accountId: OTHER_ACCOUNT_ID }, 'REPLY_TARGET_NOT_FOUND'],
    ['local thread mismatch', () => {}, { threadId: 'other-local-thread' }, 'THREAD_MISMATCH'],
    ['metadata lookup failure', () => { doubles.metadata.mockRejectedValue(new Error('Example lookup failure')); }, {}, 'GMAIL_REPLY_METADATA_UNAVAILABLE'],
    ['provider identity mismatch', () => { const data = metadata(); data.data.id = 'other-gmail-message'; doubles.metadata.mockResolvedValue(data); }, {}, 'GMAIL_REPLY_METADATA_UNAVAILABLE'],
    ['provider thread mismatch', () => { const data = metadata(); data.data.threadId = 'other-gmail-thread'; doubles.metadata.mockResolvedValue(data); }, {}, 'GMAIL_REPLY_METADATA_UNAVAILABLE'],
    ['missing RFC identity', () => { const data = metadata(); data.data.payload.headers = data.data.payload.headers.filter(h => h.name !== 'Message-ID'); doubles.metadata.mockResolvedValue(data); }, {}, 'GMAIL_REPLY_METADATA_INVALID'],
    ['incompatible subject', () => {}, { subject: 'Different conversation' }, 'GMAIL_REPLY_SUBJECT_MISMATCH']
  ])('refuses %s without submission, approval consumption or send attempts', async (_label, arrange, overrides, code) => {
    arrange();
    const id = await approvedReply(overrides);
    const response = await request(app).post(`/api/messages/drafts/${id}/send`);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body).toMatchObject({ code, error: expect.any(String) });
    expect(await getDraft(id)).toMatchObject({ status: 'approved', sendAttempts: [] });
    expect(doubles.submit).not.toHaveBeenCalled();
  });

  it('revalidates the claimed subject if it changes while provider metadata is loading', async () => {
    const id = await approvedReply();
    doubles.metadata.mockImplementationOnce(async () => {
      await updateDraft(id, { subject: 'Different conversation' });
      return metadata();
    });
    const response = await request(app).post(`/api/messages/drafts/${id}/send`);
    expect(response.body.code).toBe('GMAIL_REPLY_SUBJECT_MISMATCH');
    expect(await getDraft(id)).toMatchObject({ status: 'approved', subject: 'Different conversation', sendAttempts: [] });
    expect(doubles.submit).not.toHaveBeenCalled();
  });

  it('sends new messages without metadata lookup or threading fields', async () => {
    const id = await approvedReply({ replyToMessageId: null, threadId: null, subject: 'New message' });
    expect((await request(app).post(`/api/messages/drafts/${id}/send`)).status).toBe(200);
    expect(doubles.metadata).not.toHaveBeenCalled();
    const body = doubles.submit.mock.calls[0][0].requestBody;
    expect(Object.keys(body)).toEqual(['raw']);
    const mime = Buffer.from(body.raw, 'base64url').toString('utf8');
    expect(mime).toContain('Subject: New message\r\n');
    expect(mime).not.toMatch(/In-Reply-To:|References:/);
    expect(doubles.files.has(join('/mock/messages', 'drafts.json'))).toBe(true);
  });
});

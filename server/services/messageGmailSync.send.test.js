import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { auth as googleAuth } from '@googleapis/gmail';

// Gmail send workflow through the REAL sender, draft store, Gmail adapter and
// Google API client. Only the network is stubbed (the auth client's fetch), so
// the count of captured submissions is what Gmail would actually have received,
// including any resubmission the client library might attempt on its own (#10715).
const doubles = vi.hoisted(() => ({ files: new Map(), auth: null, getAccount: vi.fn() }));
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { messages: '/mock/messages' },
  ensureDir: async () => {},
  tryReadFile: async path => doubles.files.get(path) ?? null,
  atomicWrite: async (path, data) => { doubles.files.set(path, JSON.stringify(data)); },
  safeJSONParse: JSON.parse
}));
vi.mock('./messageAccounts.js', () => ({ getAccount: doubles.getAccount, listAccounts: async () => [] }));
vi.mock('./googleAuth.js', () => ({ getAuthenticatedClient: async () => doubles.auth }));

import { sendDraft } from './messageSender.js';
import { getDraft, approveDraft, updateDraft, deleteDraft, reconcileDraftSend } from './messageDrafts.js';

const SEND_URL = 'gmail.googleapis.com/gmail/v1/users/me/messages/send';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const timeout = () => Object.assign(new Error('Example acknowledgement lost'), { code: 'ETIMEDOUT' });

let network;
let submissions;
function authClient({ expired = false } = {}) {
  const client = new googleAuth.OAuth2({
    clientId: 'example-client', clientSecret: 'example-secret',
    transporterOptions: { fetchImplementation: async (url, init) => network(String(url), init) }
  });
  client.setCredentials({ access_token: 'example-token', refresh_token: 'example-refresh', expiry_date: expired ? 1 : Date.now() + 3_600_000 });
  return client;
}
// The provider captures the submission first, then answers with `respond` — a
// throw models an acknowledgement lost after Gmail may already have accepted it.
function gmailAnswers(respond) {
  network = async (url, init) => {
    if (url.includes(SEND_URL)) submissions.push(init);
    return respond(url);
  };
}
function seed(id) {
  doubles.files.set(join('/mock/messages', 'drafts.json'), JSON.stringify([{
    id, accountId: 'account-1', status: 'approved', sendVia: 'api', to: ['alice@example.com'], subject: 'Example subject', body: 'Example message'
  }]));
}

beforeEach(() => {
  doubles.files.clear();
  doubles.auth = authClient();
  doubles.getAccount.mockResolvedValue({ id: 'account-1', type: 'gmail' });
  submissions = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('Gmail draft send delivery certainty', () => {
  it.each([
    ['a timed-out acknowledgement', () => { throw timeout(); }],
    ['a reset socket', () => { throw Object.assign(new Error('Example reset'), { code: 'ECONNRESET' }); }],
    ['a server error after submission', () => json(503, { error: { code: 503, message: 'Example backend error' } })],
    ['a request timeout status', () => json(408, { error: { code: 408, message: 'Example timeout' } })]
  ])('parks %s as unknown, submits once, and blocks every resend until reconciled', async (_label, respond) => {
    seed('draft-1');
    gmailAnswers(respond);
    expect(await sendDraft('draft-1')).toMatchObject({ success: false, status: 502, code: 'DELIVERY_UNKNOWN' });
    const unknown = await getDraft('draft-1');
    expect(unknown.status).toBe('delivery_unknown');
    expect(unknown.sendAttempts).toEqual([expect.objectContaining({ id: unknown.sendAttemptId, outcome: 'delivery_unknown' })]);
    expect(submissions).toHaveLength(1);

    // Every path that could submit it again stays closed, even once Gmail is healthy.
    gmailAnswers(() => json(200, { id: 'example-message' }));
    expect(await sendDraft('draft-1')).toMatchObject({ status: 409 });
    await expect(approveDraft('draft-1')).rejects.toMatchObject({ status: 409 });
    await expect(updateDraft('draft-1', { status: 'approved' })).rejects.toMatchObject({ status: 409 });
    await expect(deleteDraft('draft-1')).rejects.toMatchObject({ status: 409 });
    expect(await sendDraft('draft-1')).toMatchObject({ status: 409 });
    expect(submissions).toHaveLength(1);
  });

  it('closes an unknown send confirmed in Sent Mail without submitting again', async () => {
    seed('draft-1');
    gmailAnswers(() => { throw timeout(); });
    await sendDraft('draft-1');
    const { sendAttemptId } = await getDraft('draft-1');
    expect((await reconcileDraftSend('draft-1', { attemptId: sendAttemptId, outcome: 'sent' })).status).toBe('sent');
    await expect(approveDraft('draft-1')).rejects.toMatchObject({ status: 409 });
    expect(await sendDraft('draft-1')).toMatchObject({ status: 409 });
    expect(submissions).toHaveLength(1);
  });

  it('reopens an unknown send confirmed absent from Sent Mail for one explicit resend', async () => {
    seed('draft-1');
    gmailAnswers(() => { throw timeout(); });
    await sendDraft('draft-1');
    const { sendAttemptId } = await getDraft('draft-1');
    expect((await reconcileDraftSend('draft-1', { attemptId: sendAttemptId, outcome: 'not_sent' })).status).toBe('draft');
    await approveDraft('draft-1');
    gmailAnswers(() => json(200, { id: 'example-message' }));
    expect(await sendDraft('draft-1')).toEqual({ success: true });
    expect((await getDraft('draft-1')).status).toBe('sent');
    expect(submissions).toHaveLength(2);
  });

  it('keeps a proven Gmail refusal a definite, re-approvable failure', async () => {
    seed('draft-1');
    gmailAnswers(() => json(400, { error: { code: 400, message: 'Example invalid recipient' } }));
    expect(await sendDraft('draft-1')).toMatchObject({ success: false, code: 'GMAIL_SEND_FAILED' });
    expect((await getDraft('draft-1')).status).toBe('failed');
    expect(submissions).toHaveLength(1);
    await approveDraft('draft-1');
    gmailAnswers(() => json(200, { id: 'example-message' }));
    expect(await sendDraft('draft-1')).toEqual({ success: true });
    expect(submissions).toHaveLength(2);
  });

  it.each([
    ['OAuth is not configured', () => { doubles.auth = null; }, 'GMAIL_NOT_CONFIGURED'],
    ['the access token cannot be refreshed', () => {
      doubles.auth = authClient({ expired: true });
      network = async () => json(400, { error: 'invalid_grant' });
    }, 'GMAIL_AUTH_FAILED']
  ])('fails definitely without contacting Gmail when %s', async (_label, arrange, code) => {
    seed('draft-1');
    gmailAnswers(() => json(200, { id: 'example-message' }));
    arrange();
    expect(await sendDraft('draft-1')).toMatchObject({ success: false, code });
    expect((await getDraft('draft-1')).status).toBe('failed');
    expect(submissions).toHaveLength(0);
  });

  it('marks a confirmed send as sent', async () => {
    seed('draft-1');
    gmailAnswers(() => json(200, { id: 'example-message', threadId: 'example-thread' }));
    expect(await sendDraft('draft-1')).toEqual({ success: true });
    expect((await getDraft('draft-1')).status).toBe('sent');
    expect(submissions).toHaveLength(1);
  });
});

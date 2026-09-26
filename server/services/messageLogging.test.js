import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';

const doubles = vi.hoisted(() => ({
  files: new Map(),
  send: vi.fn(), list: vi.fn(), get: vi.fn(), trash: vi.fn(), modify: vi.fn(),
  fetch: vi.fn(), token: vi.fn(), evaluate: vi.fn()
}));
vi.mock('../lib/fileUtils.js', async (original) => ({
  ...await original(),
  PATHS: { messages: '/mock/messages' },
  ensureDir: async () => {},
  tryReadFile: async path => doubles.files.get(path) ?? null,
  atomicWrite: async (path, value) => { doubles.files.set(path, JSON.stringify(value)); }
}));
vi.mock('./readinessNotify.js', () => ({ noteReadinessChanged: () => {} }));
vi.mock('./googleAuth.js', () => ({ getAuthenticatedClient: async () => ({}) }));
vi.mock('@googleapis/gmail', () => ({
  gmail: () => ({ users: {
    messages: { send: doubles.send, list: doubles.list, get: doubles.get, trash: doubles.trash, modify: doubles.modify },
    settings: { sendAs: { list: async () => ({ data: { sendAs: [] } }) } }
  } })
}));
vi.mock('../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: doubles.fetch }));
vi.mock('./messageTokenExtractor.js', () => ({ getToken: doubles.token, clearTokenCache: () => {} }));
vi.mock('./browserService.js', () => ({
  findOrOpenPage: async () => ({ url: 'https://outlook.office.com/mail/', webSocketDebuggerUrl: 'ws://example.invalid' }),
  listCdpPages: async () => [{ url: 'https://outlook.office.com/mail/', webSocketDebuggerUrl: 'ws://example.invalid' }],
  isAuthPage: () => false,
  evaluateOnPage: doubles.evaluate
}));
vi.mock('./userTimezone.js', () => ({ getUserTimezone: async () => 'UTC' }));
vi.mock('./humanActivity.js', () => ({ recordEvents: async () => ({ recorded: 0 }) }));
vi.mock('./tribe.js', () => ({ autoLogTouchpoints: async () => ({ created: 0 }) }));
vi.mock('./messageTriageRules.js', () => ({ recordCorrection: async () => {} }));

import { createAccount } from './messageAccounts.js';
import { createDraft, getDraft, updateDraft } from './messageDrafts.js';
import { sendDraft } from './messageSender.js';
import { syncAccount, refreshMessage, getMessage } from './messageSync.js';
import { syncOutlookApi } from './messageApiSync.js';
import { executeAction } from './messageActions.js';
import { syncPlaywright, sendPlaywright } from './messagePlaywrightSync.js';

const PRIVATE = {
  subject: 'SYNTHETIC_PRIVATE_SUBJECT',
  body: 'SYNTHETIC_PRIVATE_BODY',
  name: 'SYNTHETIC_PRIVATE_DISPLAY_NAME',
  email: 'synthetic-private@example.com'
};
const credential = 'Bearer synthetic-credential-must-not-be-logged';
const failure = () => Object.assign(
  new Error(Object.values(PRIVATE).join(' ') + ' ' + credential),
  { code: PRIVATE.subject, response: { status: 403 } }
);
let logs;
function output() { return logs.flatMap(spy => spy.mock.calls.flat()).join('\n'); }
function expectPrivateOutputAbsent() {
  for (const marker of [...Object.values(PRIVATE), credential]) expect(output()).not.toContain(marker);
}
function seedMessage(account) {
  const message = { id: 'local-message-1', apiId: 'api-message-1', subject: PRIVATE.subject, bodyText: PRIVATE.body, from: { name: PRIVATE.name, email: PRIVATE.email } };
  doubles.files.set(join('/mock/messages/cache', account.id + '.json'), JSON.stringify({ messages: [message] }));
  return message;
}

beforeEach(() => {
  vi.clearAllMocks();
  doubles.files.clear();
  doubles.send.mockResolvedValue({ data: { id: 'api-message-1' } });
  doubles.list.mockResolvedValue({ data: { messages: [] } });
  doubles.get.mockResolvedValue({ data: {} });
  doubles.token.mockResolvedValue({ token: 'synthetic-token' });
  doubles.evaluate.mockResolvedValue({ notInInbox: true, error: 'Not found' });
  logs = ['log', 'warn', 'error'].map(method => vi.spyOn(console, method).mockImplementation(() => {}));
});
afterEach(() => vi.restoreAllMocks());

describe('mailbox operational log privacy', () => {
  it('creates and sends drafts without duplicating content, including provider failure diagnostics', async () => {
    const account = await createAccount({ ...PRIVATE, type: 'gmail' });
    const draft = await createDraft({ ...PRIVATE, to: [PRIVATE.email], accountId: account.id });
    await updateDraft(draft.id, { status: 'approved' });
    expect(await sendDraft(draft.id)).toEqual({ success: true });
    expect((await getDraft(draft.id)).status).toBe('sent');
    expect((await getDraft(draft.id)).body).toBe(PRIVATE.body);

    await updateDraft(draft.id, { status: 'approved' });
    doubles.send.mockRejectedValueOnce(failure());
    expect(await sendDraft(draft.id)).toMatchObject({ success: false, code: 'GMAIL_SEND_FAILED' });
    expect((await getDraft(draft.id)).status).toBe('failed');
    expect(output()).toContain(draft.id);
    expect(output()).toContain(account.id);
    expect(output()).toContain('HTTP 403');
    expect(output()).toContain('GMAIL_SEND_FAILED');
    expectPrivateOutputAbsent();
  });

  it('syncs accounts without names or addresses and keeps transport errors bounded', async () => {
    const account = await createAccount({ ...PRIVATE, type: 'gmail' });
    await syncAccount(account.id);
    doubles.list.mockRejectedValueOnce(failure());
    await syncAccount(account.id);
    expect(output()).toContain(account.id);
    expect(output()).toContain('HTTP 403');
    expectPrivateOutputAbsent();
  });

  it('does not log Outlook response bodies or token diagnostics while falling back', async () => {
    const account = await createAccount({ ...PRIVATE, type: 'outlook' });
    doubles.fetch.mockResolvedValue({ ok: false, status: 403, text: async () => failure().message });
    expect(await syncOutlookApi(account, {})).toMatchObject({ status: 'api-error' });
    doubles.token.mockResolvedValueOnce({ error: true, message: failure().message });
    expect(await syncOutlookApi(account, {})).toBeNull();
    doubles.evaluate.mockResolvedValueOnce([]);
    await syncPlaywright(account, { messages: [] });
    await sendPlaywright(account, PRIVATE);
    expect(output()).toContain('HTTP 403');
    expect(output()).toContain(account.id);
    expectPrivateOutputAbsent();
  });

  it('refreshes and removes an Outlook message without logging its subject', async () => {
    const account = await createAccount({ ...PRIVATE, type: 'outlook' });
    const message = seedMessage(account);
    doubles.evaluate.mockResolvedValueOnce({ found: false, hasListbox: true });
    await refreshMessage(account.id, message.id);
    expect(await executeAction(account.id, message.id, 'archive')).toMatchObject({ success: true });
    expect(await getMessage(account.id, message.id)).toBeNull();
    expect(output()).toContain(message.id);
    expectPrivateOutputAbsent();
  });

  it('archives and deletes Gmail messages through the API and browser fallback without subjects', async () => {
    const account = await createAccount({ ...PRIVATE, type: 'gmail' });
    for (const action of ['archive', 'delete']) {
      const message = seedMessage(account);
      expect(await executeAction(account.id, message.id, action)).toMatchObject({ success: true });
      expect(await getMessage(account.id, message.id)).toBeNull();
    }
    const message = seedMessage(account);
    delete message.apiId;
    doubles.files.set(join('/mock/messages/cache', account.id + '.json'), JSON.stringify({ messages: [message] }));
    expect(await executeAction(account.id, message.id, 'delete')).toMatchObject({ success: true });
    expect(doubles.modify).toHaveBeenCalledOnce();
    expect(doubles.trash).toHaveBeenCalledOnce();
    expect(output()).toContain(message.id);
    expectPrivateOutputAbsent();
  });
});

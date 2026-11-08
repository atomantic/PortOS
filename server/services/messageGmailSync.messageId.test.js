import { describe, it, expect, vi, beforeEach } from 'vitest';

// #15308: live Gmail sync records each message's RFC-822 Message-ID (the key the
// Takeout importer uses) and backfills it onto messages cached before it existed.
const gmail = vi.hoisted(() => ({ listed: [], details: new Map(), metadata: new Map(), metadataCalls: [] }));

vi.mock('./googleAuth.js', () => ({
  getAuthenticatedClient: async () => ({}),
  GOOGLE_API_TIMEOUT_MS: 30_000,
}));
vi.mock('./gmailApi.js', () => ({
  createGmailApi: () => ({
    listSendAs: async () => ({ sendAs: [] }),
    listMessages: async () => ({ messages: gmail.listed }),
    getMessage: async (id, { format }) => {
      if (format === 'full') return gmail.details.get(id);
      gmail.metadataCalls.push(id);
      const answer = gmail.metadata.get(id);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  }),
}));

import { syncGmail, RFC_MESSAGE_ID_BACKFILL_MAX } from './messageGmailSync.js';

const headers = (messageId) => [
  { name: 'From', value: 'Friend <friend@example.com>' },
  { name: 'Subject', value: 'Hello' },
  ...(messageId ? [{ name: 'Message-ID', value: messageId }] : []),
];
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

beforeEach(() => {
  gmail.listed = [];
  gmail.details.clear();
  gmail.metadata.clear();
  gmail.metadataCalls = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('syncGmail Message-ID identity (#15308)', () => {
  it('records the normalized Message-ID on fetched mail and backfills cached mail without an extra fetch for this sync\'s messages', async () => {
    gmail.listed = [{ id: 'fresh', threadId: 't1' }, { id: 'no-header', threadId: 't2' }];
    for (const [id, messageId] of [['fresh', ' <fresh@example.com> '], ['no-header', null]]) {
      gmail.details.set(id, { id, labelIds: ['INBOX'], payload: { headers: headers(messageId) }, internalDate: '1720000000000' });
    }
    gmail.metadata.set('cached', { id: 'cached', payload: { headers: [{ name: 'Message-ID', value: '<cached@example.com>' }] } });
    gmail.metadata.set('deleted', httpError(404));
    gmail.metadata.set('flaky', httpError(503));
    const cache = { messages: [
      { apiId: 'cached' },
      { apiId: 'deleted' },
      { apiId: 'flaky' },
      { apiId: 'known', rfcMessageId: 'known@example.com' },
      { apiId: 'fresh' },
      { externalId: 'browser-only' },
    ] };

    const result = await syncGmail({ id: 'acct', type: 'gmail', syncConfig: { ingestSent: false } }, cache, null, { mode: 'unread' });

    expect(result.messages.map((m) => [m.apiId, m.rfcMessageId])).toEqual([['fresh', 'fresh@example.com'], ['no-header', '']]);
    // Only cached API messages with an unknown Message-ID that this sync did not
    // fetch in full get a metadata request.
    expect(gmail.metadataCalls.sort()).toEqual(['cached', 'deleted', 'flaky']);
    const byApiId = new Map(cache.messages.map((m) => [m.apiId, m]));
    expect(byApiId.get('cached').rfcMessageId).toBe('cached@example.com');
    // A message Gmail no longer has is settled; a transient failure retries next sync.
    expect(byApiId.get('deleted').rfcMessageId).toBe('');
    expect(byApiId.get('flaky')).not.toHaveProperty('rfcMessageId');
    expect(byApiId.get('known').rfcMessageId).toBe('known@example.com');
  });

  it('bounds the backfill per sync', async () => {
    const cache = { messages: Array.from({ length: RFC_MESSAGE_ID_BACKFILL_MAX + 5 }, (_, i) => ({ apiId: `m${i}` })) };
    for (const { apiId } of cache.messages) gmail.metadata.set(apiId, { id: apiId, payload: { headers: [] } });

    await syncGmail({ id: 'acct', type: 'gmail', syncConfig: { ingestSent: false } }, cache, null, { mode: 'unread' });

    expect(gmail.metadataCalls).toHaveLength(RFC_MESSAGE_ID_BACKFILL_MAX);
    expect(cache.messages.filter((m) => m.rfcMessageId === undefined)).toHaveLength(5);
  });
});

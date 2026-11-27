import { describe, expect, it, vi } from 'vitest';
import { GOOGLE_API_TIMEOUT_MS } from './googleAuth.js';
import { createCalendarApi } from './calendarApi.js';
import { createGmailApi } from './gmailApi.js';
import { prepareGmailReply } from './messageGmailSync.js';

vi.mock('./googleAuth.js', async importOriginal => ({
  ...(await importOriginal()),
  getAuthenticatedClient: vi.fn(async () => ({})),
}));
vi.mock('./gmailApi.js', () => ({ createGmailApi: vi.fn() }));

describe('Google API client request timeout', () => {
  it('sets the shared 30-second deadline on every Calendar operation', async () => {
    const requests = [];
    const calendar = createCalendarApi({ request: async (options) => { requests.push(options); } });

    await calendar.listEvents({ calendarId: 'primary' });
    await calendar.listCalendarList({});
    await calendar.insertEvent({ calendarId: 'primary', requestBody: {} });
    await calendar.deleteEvent({ calendarId: 'primary', eventId: 'example-event' });

    expect(GOOGLE_API_TIMEOUT_MS).toBe(30_000);
    expect(requests.map(({ timeout }) => timeout)).toEqual(Array(4).fill(GOOGLE_API_TIMEOUT_MS));
  });

  it('keeps the shorter Gmail reply-metadata request override', async () => {
    const original = {
      id: 'example-original', accountId: 'example-account', threadId: 'example-thread',
      apiId: 'example-gmail-message', conversationId: 'example-gmail-thread',
    };
    const getMessage = vi.fn().mockResolvedValue({
      id: original.apiId,
      threadId: original.conversationId,
      payload: { headers: [{ name: 'Message-ID', value: '<original@example.com>' }] },
    });
    createGmailApi.mockReturnValueOnce({ getMessage });

    const reply = await prepareGmailReply({ id: original.accountId }, {
      accountId: original.accountId, replyToMessageId: original.id, threadId: original.threadId, sendVia: 'api',
    }, original);

    expect(reply).toMatchObject({ delivery: { messageId: '<original@example.com>' } });
    expect(getMessage).toHaveBeenCalledExactlyOnceWith(original.apiId,
      expect.objectContaining({ format: 'metadata' }), { timeout: 10_000, retry: false });
  });
});

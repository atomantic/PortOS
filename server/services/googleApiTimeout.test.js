import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GOOGLE_API_TIMEOUT_MS } from './googleAuth.js';
import { createCalendarApi } from './calendarApi.js';

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

  it('keeps the shorter Gmail reply-metadata request override', () => {
    const source = readFileSync(new URL('./messageGmailSync.js', import.meta.url), 'utf8');
    expect(source).toMatch(/gmailClient\.getMessage\([\s\S]*?\},\s*\{ timeout: 10_000, retry: false \}\)/);
  });
});

import { expect, it, vi } from 'vitest';
import { createGoogleOAuthClient } from '../lib/googleOAuthClient.js';
import { createCalendarApi } from './calendarApi.js';

function makeClient(fetchImplementation) {
  const auth = createGoogleOAuthClient({ fetchImplementation });
  auth.setCredentials({ access_token: 'example-token', expiry_date: Date.now() + 3_600_000 });
  return auth;
}

it('sends all four Calendar operations to the fixed origin with encoded IDs and queries', async () => {
  const fetch = vi.fn(async () => Response.json({ id: 'example-event' }));
  const auth = makeClient(fetch);
  const api = createCalendarApi(auth);
  const eventList = {
    calendarId: 'work+team@example.com',
    timeMin: '2026-03-01T00:00:00Z',
    timeMax: '2026-04-01T00:00:00Z',
    maxResults: 250,
    singleEvents: true,
    orderBy: 'startTime',
  };
  const eventBody = { summary: 'Focus time' };
  const pageToken = 'next/+&token';

  await api.listEvents(eventList);
  await api.listEvents({ ...eventList, pageToken });
  await api.listCalendarList({ pageToken });
  await expect(api.insertEvent({ calendarId: 'primary', requestBody: eventBody }))
    .resolves.toMatchObject({ data: { id: 'example-event' } });
  await api.deleteEvent({ calendarId: eventList.calendarId, eventId: 'event/1?#' });

  const urls = fetch.mock.calls.map(([url]) => new URL(url));
  expect(urls.map(url => url.origin)).toEqual(Array(5).fill('https://www.googleapis.com'));
  const eventsPath = '/calendar/v3/calendars/work%2Bteam%40example.com/events';
  expect(urls.map(url => url.pathname)).toEqual([
    eventsPath, eventsPath, '/calendar/v3/users/me/calendarList',
    '/calendar/v3/calendars/primary/events', `${eventsPath}/event%2F1%3F%23`,
  ]);
  expect(Object.fromEntries(urls[0].searchParams)).toEqual({
    timeMin: eventList.timeMin, timeMax: eventList.timeMax,
    maxResults: '250', singleEvents: 'true', orderBy: 'startTime',
  });
  expect(urls[1].searchParams.get('pageToken')).toBe(pageToken);
  expect(Object.fromEntries(urls[2].searchParams)).toEqual({ pageToken });
  expect(fetch.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'GET', 'GET', 'POST', 'DELETE']);
  expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual(eventBody);
});

it.each([404, 410])('preserves the transport error for delete HTTP %i', async (code) => {
  const auth = makeClient(async () => Response.json({ error: { code, message: 'Event is gone' } }, { status: code }));
  const api = createCalendarApi(auth);
  await expect(api.deleteEvent({ calendarId: 'primary', eventId: 'example-event' }))
    .rejects.toMatchObject({ code, message: 'Event is gone', response: { status: code } });
});

it.each(['.', '..'])('rejects the dot segment %s before requesting either path', (id) => {
  const auth = { request: vi.fn() };
  const api = createCalendarApi(auth);
  expect(() => api.listEvents({ calendarId: id })).toThrow(TypeError);
  expect(() => api.deleteEvent({ calendarId: 'primary', eventId: id })).toThrow(TypeError);
  expect(auth.request).not.toHaveBeenCalled();
});

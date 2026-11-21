import { GOOGLE_API_TIMEOUT_MS } from './googleAuth.js';

const CALENDAR_ORIGIN = 'https://www.googleapis.com/calendar/v3';

function encodePathSegment(id) {
  // URL parsers normalize dot segments, which would escape the intended path.
  if (id === '.' || id === '..') throw new TypeError('Invalid Calendar path segment');
  return encodeURIComponent(id);
}

export function createCalendarApi(auth) {
  const eventsPath = (calendarId) => `/calendars/${encodePathSegment(calendarId)}/events`;
  const request = (method, path, { query, data } = {}) => auth.request({
    url: `${CALENDAR_ORIGIN}${path}`,
    method,
    timeout: GOOGLE_API_TIMEOUT_MS,
    // Preserve the SDK's transport retry policy (which excludes POST by default).
    retry: true,
    ...(query && { params: Object.fromEntries(Object.entries(query).filter(([, value]) => value != null)) }),
    ...(data !== undefined && { data }),
  });

  return {
    listEvents: ({ calendarId, timeMin, timeMax, maxResults, singleEvents, orderBy, pageToken }) =>
      request('GET', eventsPath(calendarId), {
        query: { timeMin, timeMax, maxResults, singleEvents, orderBy, pageToken },
      }),
    insertEvent: ({ calendarId, requestBody }) =>
      request('POST', eventsPath(calendarId), { data: requestBody }),
    deleteEvent: ({ calendarId, eventId }) =>
      request('DELETE', `${eventsPath(calendarId)}/${encodePathSegment(eventId)}`),
    listCalendarList: ({ pageToken }) =>
      request('GET', '/users/me/calendarList', { query: { pageToken } }),
  };
}

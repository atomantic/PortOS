import { v4 as uuidv4 } from '../lib/uuid.js';
import crypto from 'crypto';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { getToken, clearTokenCache } from './messageTokenExtractor.js';

const GRAPH_API_TIMEOUT_MS = 30000;

function makeExternalId(id) {
  const hash = crypto.createHash('md5').update(id).digest('hex').slice(0, 12);
  return `api-cal-${hash}`;
}

function mapResponseStatus(status) {
  const map = {
    None: 'none',
    Organizer: 'organizer',
    TentativelyAccepted: 'tentative',
    Accepted: 'accepted',
    Declined: 'declined',
    NotResponded: 'notResponded'
  };
  return map[status?.Response] || 'unknown';
}

/**
 * Normalize an Outlook DateTime value to ISO string.
 * Outlook Graph API returns bare datetimes (no offset/Z) in UTC with a separate
 * TimeZone field. We always treat bare values as UTC and store the timeZone
 * separately on the event object for display purposes.
 */
function normalizeDateTime(dateTimeStr) {
  // Already has timezone offset or Z suffix — parse as-is
  if (/[Zz]$/.test(dateTimeStr) || /[+-]\d{2}:\d{2}$/.test(dateTimeStr)) {
    return new Date(dateTimeStr).toISOString();
  }
  // Bare datetime — treat as UTC
  return new Date(dateTimeStr + 'Z').toISOString();
}

function mapAttendeeStatus(status) {
  const map = {
    None: 'none',
    Accepted: 'accepted',
    Declined: 'declined',
    TentativelyAccepted: 'tentative'
  };
  return map[status?.Response] || 'unknown';
}

export async function syncOutlookCalendarApi(account, _cache, io, options = {}) {
  const tokenResult = await getToken('outlook');

  if (tokenResult.error) {
    console.log(`📅 Calendar API sync unavailable for ${account.email}: ${tokenResult.message}`);
    return null;
  }

  const token = tokenResult.token;
  const now = new Date();
  const pastDays = options.pastDays ?? 7;
  const futureDays = options.futureDays ?? 90;
  const startRange = new Date(now.getTime() - pastDays * 24 * 60 * 60 * 1000);
  const endRange = new Date(now.getTime() + futureDays * 24 * 60 * 60 * 1000);
  const startDateTime = startRange.toISOString();
  const endDateTime = endRange.toISOString();

  console.log(`📅 Calendar API sync for ${account.email} (${startDateTime} to ${endDateTime})`);

  const select = '$select=Subject,Start,End,Location,Organizer,Attendees,IsAllDay,Importance,Categories,IsCancelled,Recurrence,ResponseStatus,Body,ShowAs';
  const orderBy = '$orderby=Start/DateTime asc';
  const baseUrl = `https://outlook.office.com/api/v2.0/me/calendarview?startDateTime=${encodeURIComponent(startDateTime)}&endDateTime=${encodeURIComponent(endDateTime)}&${select}&${orderBy}&$top=200`;

  const events = [];
  const syncedAt = new Date().toISOString();
  let url = baseUrl;
  let page = 0;

  while (url) {
    page++;
    io?.emit('calendar:sync:event', { accountId: account.id, current: events.length, page });

    const response = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="Text"' }
    }, GRAPH_API_TIMEOUT_MS);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.log(`📅 Calendar API sync failed (${response.status}): ${text.slice(0, 200)}`);
      if (response.status === 401) {
        clearTokenCache('outlook');
        return null;
      }
      return { events: [], status: 'api-error' };
    }

    const data = await response.json();
    const items = data.value || [];

    for (const item of items) {
      const extId = makeExternalId(item.Id);
      const event = {
        id: uuidv4(),
        externalId: extId,
        apiId: item.Id,
        accountId: account.id,
        title: item.Subject || '',
        description: item.Body?.Content || '',
        location: item.Location?.DisplayName || '',
        startTime: item.Start?.DateTime ? normalizeDateTime(item.Start.DateTime) : null,
        endTime: item.End?.DateTime ? normalizeDateTime(item.End.DateTime) : null,
        isAllDay: item.IsAllDay || false,
        timeZone: item.Start?.TimeZone || 'UTC',
        organizer: {
          name: item.Organizer?.EmailAddress?.Name || '',
          email: item.Organizer?.EmailAddress?.Address || ''
        },
        attendees: (item.Attendees || []).map(a => ({
          name: a.EmailAddress?.Name || '',
          email: a.EmailAddress?.Address || '',
          status: mapAttendeeStatus(a.Status)
        })),
        myStatus: mapResponseStatus(item.ResponseStatus),
        recurrence: item.Recurrence || null,
        isRecurring: !!item.Recurrence,
        isCancelled: item.IsCancelled || false,
        categories: item.Categories || [],
        importance: item.Importance || 'Normal',
        source: 'outlook-calendar',
        syncMethod: 'api',
        syncedAt
      };
      events.push(event);
    }

    url = data['@odata.nextLink'] || null;
  }

  if (io && events.length > 0) {
    io.emit('calendar:sync:event', { accountId: account.id, events });
  }

  // Declined/cancelled filtering handled universally by calendarSync.filterDeclinedAndCancelled at read time
  console.log(`📅 Calendar API sync complete: ${events.length} events in ${page} page(s)`);
  return { events, status: 'success', syncMethod: 'api' };
}

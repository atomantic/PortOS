import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { getToken, clearTokenCache } from './messageTokenExtractor.js';

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
 * Outlook may return bare datetimes (no offset/Z) with a separate TimeZone field,
 * or datetimes that already include an offset. Append 'Z' only when the value
 * has no existing timezone indicator and the TimeZone is UTC.
 */
function normalizeDateTime(dateTimeStr, timeZone) {
  // Already has timezone offset or Z suffix — parse as-is
  if (/[Zz]$/.test(dateTimeStr) || /[+-]\d{2}:\d{2}$/.test(dateTimeStr)) {
    return new Date(dateTimeStr).toISOString();
  }
  // Bare datetime — always treat as UTC since Outlook Graph API returns UTC
  // datetimes with a separate TimeZone field. We store the timeZone separately.
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

export async function syncOutlookCalendarApi(account, cache, io, options = {}) {
  const tokenResult = await getToken('outlook');

  if (tokenResult.error) {
    console.log(`📅 Calendar API sync unavailable for ${account.email}: ${tokenResult.message}`);
    return null;
  }

  const token = tokenResult.token;
  const now = new Date();
  const startRange = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // -7d
  const endRange = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // +90d
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="Text"' },
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

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
        startTime: item.Start?.DateTime ? normalizeDateTime(item.Start.DateTime, item.Start.TimeZone) : null,
        endTime: item.End?.DateTime ? normalizeDateTime(item.End.DateTime, item.End.TimeZone) : null,
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

  console.log(`📅 Calendar API sync complete: ${events.length} events fetched in ${page} page(s)`);
  return { events, status: 'success', syncMethod: 'api' };
}

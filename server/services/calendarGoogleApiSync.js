import { calendar } from '@googleapis/calendar';
import { ServerError } from '../lib/errorHandler.js';
import { getAuthenticatedClient } from './googleAuth.js';
import { getAccount, updateSubcalendars, mergeDiscoveredSubcalendars } from './calendarAccounts.js';
import { pushSyncEvents, getSyncDateRange } from './calendarGoogleSync.js';

export async function apiSyncAccount(accountId, io) {
  const account = await getAccount(accountId);
  if (!account) throw new ServerError('Account not found', { status: 404 });
  if (account.type !== 'google-calendar') throw new ServerError('Not a Google Calendar account', { status: 400 });

  const auth = await getAuthenticatedClient();
  if (!auth) throw new ServerError('Google OAuth not configured. Set up credentials in Config tab.', { status: 401 });

  const enabledCalendars = (account.subcalendars || []).filter(sc => sc.enabled && !sc.dormant);
  if (enabledCalendars.length === 0) throw new ServerError('No enabled subcalendars', { status: 400 });

  io?.emit('calendar:sync:started', { accountId, method: 'api' });
  console.log(`📅 Starting Google API sync for ${account.name} (${enabledCalendars.length} calendars)`);

  const cal = calendar({ version: 'v3', auth });
  const { pastDate, futureDate } = getSyncDateRange();

  let totalNew = 0;
  let totalUpdated = 0;
  let totalPruned = 0;
  const results = [];

  const fetchResults = await Promise.all(enabledCalendars.map(async (sc) => {
    io?.emit('calendar:sync:progress', { accountId, message: `Fetching ${sc.name}...` });
    const allEvents = [];
    let pageToken;
    do {
      const response = await cal.events.list({
        calendarId: sc.calendarId,
        timeMin: pastDate.toISOString(),
        timeMax: futureDate.toISOString(),
        maxResults: 250,
        singleEvents: true,
        orderBy: 'startTime',
        pageToken
      });
      const items = response.data.items || [];
      allEvents.push(...items.map(item => ({
        id: item.id,
        summary: item.summary || '',
        start: item.start,
        end: item.end,
        location: item.location || '',
        description: item.description || '',
        status: item.status || 'confirmed',
        // Attendee/organizer identities feed Tribe touchpoint auto-logging (#2033).
        organizer: item.organizer || null,
        attendees: item.attendees || []
      })));
      pageToken = response.data.nextPageToken;
    } while (pageToken);
    return { sc, allEvents };
  }));

  for (const { sc, allEvents } of fetchResults) {
    const syncResult = await pushSyncEvents(accountId, sc.calendarId, sc.name, allEvents, null);
    totalNew += syncResult.newEvents;
    totalUpdated += syncResult.updated;
    totalPruned += syncResult.pruned;
    results.push({ calendarId: sc.calendarId, calendarName: sc.name, events: allEvents.length, ...syncResult });
    console.log(`📅 Google API: ${sc.name} → ${allEvents.length} events`);
  }

  io?.emit('calendar:sync:completed', { accountId, newEvents: totalNew, updated: totalUpdated, pruned: totalPruned, status: 'success', method: 'api' });
  console.log(`📅 Google API sync complete for ${account.name}: ${totalNew} new, ${totalUpdated} updated, ${totalPruned} pruned`);

  return { newEvents: totalNew, updated: totalUpdated, pruned: totalPruned, calendars: results, status: 'success' };
}

export async function apiDiscoverCalendars(accountId) {
  const account = await getAccount(accountId);
  if (!account) throw new ServerError('Account not found', { status: 404 });

  const auth = await getAuthenticatedClient();
  if (!auth) throw new ServerError('Google OAuth not configured', { status: 401 });

  const cal = calendar({ version: 'v3', auth });
  const allCalendars = [];
  let pageToken;

  do {
    const response = await cal.calendarList.list({ pageToken });
    allCalendars.push(...(response.data.items || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  // Normalize to { id, name, color } shape for merge helper
  const discovered = allCalendars.map(c => ({
    id: c.id,
    name: c.summaryOverride || c.summary || c.id,
    color: c.backgroundColor || ''
  }));
  const merged = mergeDiscoveredSubcalendars(account.subcalendars, discovered);

  await updateSubcalendars(accountId, merged);

  console.log(`📅 Discovered ${allCalendars.length} calendars via Google API for ${account.name}`);
  return { calendars: merged, status: 'success' };
}

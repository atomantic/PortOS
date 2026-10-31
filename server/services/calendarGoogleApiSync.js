import { calendar } from '@googleapis/calendar';
import { ServerError } from '../lib/errorHandler.js';
import { getAuthenticatedClient, GOOGLE_API_TIMEOUT_MS } from './googleAuth.js';
import { getAccount, updateSubcalendars, mergeDiscoveredSubcalendars, updateSyncStatus } from './calendarAccounts.js';
import { pushSyncEvents, getSyncDateRange } from './calendarGoogleSync.js';

const apiSyncLocks = new Set();

export async function apiSyncAccount(accountId, io) {
  if (apiSyncLocks.has(accountId)) throw new ServerError('Google API sync already in progress', { status: 409 });
  apiSyncLocks.add(accountId);
  try {
    return await runApiSyncAccount(accountId, io);
  } finally {
    apiSyncLocks.delete(accountId);
  }
}

async function runApiSyncAccount(accountId, io) {
  const account = await getAccount(accountId);
  if (!account) throw new ServerError('Account not found', { status: 404 });
  if (account.type !== 'google-calendar') throw new ServerError('Not a Google Calendar account', { status: 400 });

  const enabledCalendars = (account.subcalendars || []).filter(sc => sc.enabled && !sc.dormant);
  if (enabledCalendars.length === 0) throw new ServerError('No enabled subcalendars', { status: 400 });

  io?.emit('calendar:sync:started', { accountId, method: 'api' });
  console.log(`📅 Starting Google API sync for account ${accountId} (${enabledCalendars.length} calendars)`);

  try {
    const auth = await getAuthenticatedClient();
    if (!auth) throw new ServerError('Google OAuth not configured. Set up credentials in Config tab.', { status: 401 });

    const cal = calendar({ version: 'v3', auth, timeout: GOOGLE_API_TIMEOUT_MS });
    const { pastDate, futureDate } = getSyncDateRange();

    let totalNew = 0;
    let totalUpdated = 0;
    let totalPruned = 0;
    const results = [];

    const fetchResults = await Promise.allSettled(enabledCalendars.map(async (sc) => {
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
          attendees: item.attendees || [],
          // Conference metadata feeds the cached `meetingUrl` join link (#6289).
          // Both keys are emitted UNCONDITIONALLY — an explicit null is what makes
          // a direct API response authoritative enough to clear a stale link,
          // where an omitted key would (correctly) preserve it. Only the entry
          // type + URI are carried forward; Google's conference passwords and
          // dial-in codes are dropped here rather than travelling any further.
          hangoutLink: item.hangoutLink || null,
          conferenceData: item.conferenceData
            ? {
              // Passed through unflattened — `selectMeetingUrl` owns every
              // "is this usable?" decision, so this layer only decides what is
              // allowed to travel at all.
              entryPoints: (item.conferenceData.entryPoints || []).map(ep => ({
                entryPointType: ep.entryPointType ?? null,
                uri: ep.uri ?? null
              }))
            }
            : null
        })));
        pageToken = response.data.nextPageToken;
      } while (pageToken);
      return { sc, allEvents };
    }));

    const failures = [];
    for (let i = 0; i < fetchResults.length; i++) {
      const fetchResult = fetchResults[i];
      const sc = enabledCalendars[i];
      if (fetchResult.status === 'rejected') {
        const reason = fetchResult.reason;
        const error = reason instanceof Error ? reason.message : String(reason);
        const failure = {
          calendarId: sc.calendarId,
          calendarName: sc.name,
          error,
          ...(reason?.code ? { code: reason.code } : {}),
          ...(reason?.name ? { name: reason.name } : {}),
        };
        failures.push(failure);
        results.push({ ...failure, status: 'error' });
        console.warn(`⚠️ Google API: calendar fetch failed for account ${accountId}${reason?.code ? ` code=${reason.code}` : ''}`);
        continue;
      }
      const { allEvents } = fetchResult.value;
      const syncResult = await pushSyncEvents(accountId, sc.calendarId, sc.name, allEvents, null, { dateRange: { pastDate, futureDate } });
      totalNew += syncResult.newEvents;
      totalUpdated += syncResult.updated;
      totalPruned += syncResult.pruned;
      results.push({ calendarId: sc.calendarId, calendarName: sc.name, events: allEvents.length, ...syncResult, status: 'success' });
      console.log(`📅 Google API: account ${accountId} calendar synced → ${allEvents.length} events`);
    }

    if (failures.length === enabledCalendars.length) {
      const reason = summarizeApiFailures(failures);
      const error = new ServerError(`Google API sync failed for all calendars: ${reason}`, { status: 502 });
      error.calendars = failures;
      error.cause = fetchResults.find(result => result.status === 'rejected')?.reason;
      throw error;
    }

    const status = failures.length ? 'partial' : 'success';
    const reason = failures.length ? summarizeApiFailures(failures) : undefined;
    await updateSyncStatus(accountId, status);
    io?.emit('calendar:sync:completed', {
      accountId, newEvents: totalNew, updated: totalUpdated, pruned: totalPruned, status, method: 'api',
      ...(failures.length ? { reason, failedCalendars: failures } : {}),
    });
    console.log(`📅 Google API sync ${status} for account ${accountId}: ${totalNew} new, ${totalUpdated} updated, ${totalPruned} pruned`);

    return { newEvents: totalNew, updated: totalUpdated, pruned: totalPruned, calendars: results, status, ...(reason ? { reason } : {}) };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    console.error(`❌ Google API sync failed for account ${accountId}${failure.code ? ` code=${failure.code}` : ''}`);
    io?.emit('calendar:sync:failed', { accountId, error: failure.message, method: 'api', ...(failure.calendars ? { calendars: failure.calendars } : {}) });
    await Promise.resolve().then(() => updateSyncStatus(accountId, 'error')).catch(() => {});
    throw error instanceof Error ? error : failure;
  }
}

function summarizeApiFailures(failures) {
  const shown = failures.slice(0, 3).map(({ calendarName, error }) => `"${calendarName}": ${error}`).join('; ');
  return failures.length > 3 ? `${shown}; and ${failures.length - 3} more` : shown;
}

export async function apiDiscoverCalendars(accountId) {
  const account = await getAccount(accountId);
  if (!account) throw new ServerError('Account not found', { status: 404 });

  const auth = await getAuthenticatedClient();
  if (!auth) throw new ServerError('Google OAuth not configured', { status: 401 });

  const cal = calendar({ version: 'v3', auth, timeout: GOOGLE_API_TIMEOUT_MS });
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

  console.log(`📅 Discovered ${allCalendars.length} calendars via Google API for account ${accountId}`);
  return { calendars: merged, status: 'success' };
}

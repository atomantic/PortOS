import { readdir, unlink } from 'fs/promises';
import { join } from 'path';
import { atomicWrite, ensureDir, filterBySearch as genericFilterBySearch, PATHS, readJSONFile, UUID_RE } from '../lib/fileUtils.js';
import { createKeyedFileWriteQueue } from '../lib/fileWriteQueue.js';
import { ServerError } from '../lib/errorHandler.js';
import { overlapsSyncWindow } from '../lib/calendarSyncWindow.js';
import { calendarTouchpointDedupeKey } from '../lib/tribeMatch.js';
import { resolveCalendarInstant, resolveEventInstant } from '../lib/timezone.js';
import { getUserTimezone } from './userTimezone.js';
import { getAccount, updateSyncStatus } from './calendarAccounts.js';

export const CACHE_DIR = join(PATHS.calendar, 'cache');
const syncLocks = new Map();
const queueCacheWrite = createKeyedFileWriteQueue();

const CALENDAR_SEARCH_FIELDS = ['title', 'description', 'location', 'organizer.name'];
function filterBySearch(events, search) {
  return genericFilterBySearch(events, search, CALENDAR_SEARCH_FIELDS);
}

// Epoch ms of a query bound or event field. Offset-less bounds (the daily
// review's `YYYY-MM-DDT00:00:00`) are the user's wall clock; bounds that
// already carry an offset (agenda's localDayWindowUtc) stay absolute.
function boundMs(value, timezone) {
  const at = resolveEventInstant(value, timezone);
  return at ? at.getTime() : null;
}

function eventMs(event, field, timezone) {
  const at = resolveCalendarInstant(event?.[field], timezone, event?.isAllDay === true);
  return at ? at.getTime() : null;
}

// Half-open on the event end: an all-day event stored through the next
// midnight must not also occupy the day that starts at that midnight.
// A point event (no later end) still counts when its start is inside the
// window. The window end stays inclusive — callers pass either the last
// millisecond of the local day or a zoneless `T23:59:59`.
function filterByDateRange(events, startDate, endDate, timezone) {
  if (!startDate && !endDate) return events;
  const rangeStart = startDate ? boundMs(startDate, timezone) : null;
  const rangeEnd = endDate ? boundMs(endDate, timezone) : null;
  // A bound the caller asked for but we cannot read must not widen into
  // "no bound" and return the whole calendar.
  if ((startDate && rangeStart == null) || (endDate && rangeEnd == null)) return [];
  return events.filter((event) => {
    const start = eventMs(event, 'startTime', timezone) ?? eventMs(event, 'endTime', timezone);
    if (start == null) return false;
    const end = eventMs(event, 'endTime', timezone) ?? start;
    if (rangeEnd != null && start > rangeEnd) return false;
    if (rangeStart == null) return true;
    return end > start ? end > rangeStart : start >= rangeStart;
  });
}

function compareEventStart(timezone) {
  return (a, b) => (eventMs(a, 'startTime', timezone) ?? 0) - (eventMs(b, 'startTime', timezone) ?? 0);
}

const DEFAULT_CACHE = { syncCursor: null, events: [] };

export async function loadCache(accountId) {
  if (!UUID_RE.test(accountId)) throw new Error(`Invalid accountId: ${accountId}`);
  await ensureDir(CACHE_DIR);
  const parsed = await readJSONFile(join(CACHE_DIR, `${accountId}.json`), { ...DEFAULT_CACHE, events: [] });
  if (!parsed || !Array.isArray(parsed.events)) return { ...DEFAULT_CACHE, events: [] };
  return parsed;
}

async function saveCache(accountId, cache) {
  await ensureDir(CACHE_DIR);
  const filePath = join(CACHE_DIR, `${accountId}.json`);
  await atomicWrite(filePath, cache);
}

// One file per account: load, mutate and persist under the same queue. Account
// deletion removes metadata BEFORE queueing deleteCache; earlier writes drain
// before unlink, and later/provider-delayed writes reject instead of resurrecting.
export function mutateCache(accountId, mutate) {
  return queueCacheWrite(accountId, async () => {
    const account = await getAccount(accountId);
    if (!account) throw new ServerError('Account not found', { status: 404 });
    const cache = await loadCache(accountId);
    const result = await mutate(cache, account);
    await saveCache(accountId, cache);
    return result;
  });
}

function filterDeclinedAndCancelled(events) {
  return events.filter(e =>
    e.myStatus !== 'declined' &&
    !e.isCancelled &&
    !e.title?.startsWith('Declined: ') &&
    !e.title?.startsWith('Canceled: ')
  );
}

function filterByEnabledSubcalendars(events, account) {
  if (!account?.subcalendars?.length) return events;
  const enabledIds = new Set(
    account.subcalendars.filter(sc => sc.enabled && !sc.dormant).map(sc => sc.calendarId)
  );
  // Only filter events that have a subcalendarId (google-calendar events)
  return events.filter(e => !e.subcalendarId || enabledIds.has(e.subcalendarId));
}

export async function getEvents(options = {}) {
  const { accountId, search, startDate, endDate, limit = 50, offset = 0 } = options;

  if (accountId) {
    const cache = await loadCache(accountId);
    const account = await getAccount(accountId);
    if (!account) return { events: [], total: 0 };
    let events = cache.events.map(e => ({ ...e, accountId: e.accountId || accountId }));
    events = filterDeclinedAndCancelled(events);
    events = filterByEnabledSubcalendars(events, account);
    events = filterBySearch(events, search);
    const timezone = await getUserTimezone();
    events = filterByDateRange(events, startDate, endDate, timezone);
    return {
      events: events.sort(compareEventStart(timezone)).slice(offset, offset + limit),
      total: events.length
    };
  }

  // Aggregate across all account caches
  await ensureDir(CACHE_DIR);
  const files = await readdir(CACHE_DIR).catch(() => []);
  const { listAccounts } = await import('./calendarAccounts.js');
  const accounts = await listAccounts();
  const accountMap = new Map(accounts.map(a => [a.id, a]));

  const accountIds = files
    .filter(file => file.endsWith('.json'))
    .map(file => file.replace('.json', ''))
    .filter(id => UUID_RE.test(id) && accountMap.has(id));
  // Load each account's cache in parallel rather than serializing one disk read
  // per account before aggregating the combined calendar view.
  const caches = await Promise.all(
    accountIds.map(async id => ({ id, cache: await loadCache(id) }))
  );
  let allEvents = [];
  for (const { id, cache } of caches) {
    let events = cache.events.map(e => ({ ...e, accountId: e.accountId || id }));
    events = filterDeclinedAndCancelled(events);
    events = filterByEnabledSubcalendars(events, accountMap.get(id));
    allEvents.push(...events);
  }
  allEvents = filterBySearch(allEvents, search);
  const timezone = await getUserTimezone();
  allEvents = filterByDateRange(allEvents, startDate, endDate, timezone);
  allEvents.sort(compareEventStart(timezone));
  return {
    events: allEvents.slice(offset, offset + limit),
    total: allEvents.length
  };
}

export async function purgeDisabledSubcalendars(accountId) {
  return mutateCache(accountId, (cache, account) => {
    if (!account?.subcalendars?.length) return { purged: 0 };

    const enabledIds = new Set(
      account.subcalendars.filter(sc => sc.enabled && !sc.dormant).map(sc => sc.calendarId)
    );
    const before = cache.events.length;
    cache.events = cache.events.filter(e => !e.subcalendarId || enabledIds.has(e.subcalendarId));
    const purged = before - cache.events.length;
    if (purged > 0) {
      console.log(`🧹 Purged ${purged} events from disabled subcalendars for account ${accountId}`);
    }
    return { purged, remaining: cache.events.length };
  });
}

export async function getEvent(accountId, eventId) {
  const cache = await loadCache(accountId);
  if (!await getAccount(accountId)) return null;
  const event = cache.events.find(e => e.id === eventId);
  if (!event) return null;
  return { ...event, accountId: event.accountId || accountId };
}

export async function deleteCache(accountId) {
  if (!UUID_RE.test(accountId)) return;
  return queueCacheWrite(accountId, async () => {
    const filePath = join(CACHE_DIR, `${accountId}.json`);
    try {
      await unlink(filePath);
      console.log(`🗑️ Calendar cache deleted for account ${accountId}`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log(`🗑️ No calendar cache to delete for account ${accountId}`);
      } else {
        console.error(`❌ Failed to delete calendar cache for account ${accountId}: ${err.message}`);
        throw err;
      }
    }
  });
}

export async function syncAccount(accountId, io, options = {}) {
  if (syncLocks.has(accountId)) throw new ServerError('Sync already in progress', { status: 409 });

  syncLocks.set(accountId, true);
  try {
    return await runAccountSync(accountId, io, options);
  } finally {
    syncLocks.delete(accountId);
  }
}

async function runAccountSync(accountId, io, options) {
  const account = await getAccount(accountId);
  if (!account) throw new ServerError('Account not found', { status: 404 });
  if (!account.enabled) throw new ServerError('Account is disabled', { status: 400 });

  io?.emit('calendar:sync:started', { accountId });
  console.log(`📅 Starting calendar sync for account ${accountId} (${account.type})`);

  const providerSync = async () => {
    const cache = await loadCache(accountId);
    let providerResult;
    if (account.type === 'outlook-calendar') {
      const { syncOutlookCalendarApi } = await import('./calendarApiSync.js');
      providerResult = await syncOutlookCalendarApi(account, cache, io, options);
    } else if (account.type === 'google-calendar') {
      // Google Calendar uses push sync — syncAccount is a no-op
      return { newEvents: 0, pruned: 0, total: cache.events.length, status: 'push-only' };
    } else {
      throw new Error(`Unsupported calendar account type: ${account.type}`);
    }

    // syncOutlookCalendarApi returns null when token is unavailable — treat as no-op
    if (providerResult === null) {
      return { newEvents: 0, pruned: 0, total: cache.events.length, status: 'skipped' };
    }
    const newEvents = Array.isArray(providerResult) ? providerResult : providerResult?.events ?? [];
    const providerStatus = Array.isArray(providerResult) ? 'success' : providerResult?.status ?? 'success';

    const { newCount, pruned, total } = await mutateCache(accountId, cache => {
      // Deduplicate by externalId; update fields on existing events
      const existingMap = new Map();
      cache.events = cache.events.filter(event => {
        if (!event.externalId) return true;
        if (existingMap.has(event.externalId)) return false;
        existingMap.set(event.externalId, event);
        return true;
      });
      const uniqueNew = [];
      for (const event of newEvents) {
        if (!event.externalId || !existingMap.has(event.externalId)) {
          uniqueNew.push(event);
          if (event.externalId) existingMap.set(event.externalId, event);
        } else {
          const existing = existingMap.get(event.externalId);
          // Update mutable fields
          if (event.title !== undefined) existing.title = event.title;
          if (event.description !== undefined) existing.description = event.description;
          if (event.location !== undefined) existing.location = event.location;
          if (event.startTime !== undefined) existing.startTime = event.startTime;
          if (event.endTime !== undefined) existing.endTime = event.endTime;
          if (event.isAllDay !== undefined) existing.isAllDay = event.isAllDay;
          if (event.isCancelled !== undefined) existing.isCancelled = event.isCancelled;
          if (event.organizer !== undefined) existing.organizer = event.organizer;
          if (event.attendees !== undefined) existing.attendees = event.attendees;
          if (event.myStatus !== undefined) existing.myStatus = event.myStatus;
          if (event.categories !== undefined) existing.categories = event.categories;
          if (event.importance !== undefined) existing.importance = event.importance;
        }
      }
      cache.events.push(...uniqueNew);

      // Reconcile: remove cached events no longer present
      let pruned = 0;
      if (providerStatus === 'success') {
        const fetchedIds = new Set(newEvents.filter(e => e.externalId).map(e => e.externalId));
        const before = cache.events.length;
        // A windowed fetch only vouches for events overlapping its window.
        cache.events = cache.events.filter(e => !e.externalId || fetchedIds.has(e.externalId) || !overlapsSyncWindow(e, providerResult?.dateRange));
        pruned = before - cache.events.length;
        if (pruned > 0) console.log(`🧹 Pruned ${pruned} stale calendar events for account ${accountId}`);
      }

      return { newCount: uniqueNew.length, pruned, total: cache.events.length };
    });
    await updateSyncStatus(accountId, providerStatus === 'success' ? 'success' : providerStatus);

    // Auto-log Tribe touchpoints from this batch (secondary effect — must not
    // fail the sync). Idempotent on event id, so re-processing fetched events is safe.
    await logCalendarTouchpoints(accountId, newEvents).catch((err) =>
      console.error(`🤝 Tribe auto-log failed for account ${accountId}: ${err.message}`));

    // Populate the human-activity timeline (#2150) — secondary effect, must NOT
    // fail the sync. Idempotent on (source, dedupe_key). Machine-local.
    await recordCalendarActivity(account, newEvents).catch((err) =>
      console.error(`🗓️  Activity ingest failed for account ${accountId}: ${err.message}`));

    io?.emit('calendar:sync:completed', { accountId, newEvents: newCount, pruned, status: providerStatus });
    console.log(`📅 Sync complete for account ${accountId}: ${newCount} new, ${pruned} pruned, status=${providerStatus}`);

    return { newEvents: newCount, pruned, total, status: providerStatus };
  };

  const result = await providerSync().catch(async (error) => {
    console.error(`📅 Sync failed for account ${accountId} (${account.type}) status=${error.status ?? 502}${error.code ? ` code=${error.code}` : ''}`);
    await updateSyncStatus(accountId, 'error').catch(() => {});
    io?.emit('calendar:sync:failed', { accountId, error: error.message });
    throw error instanceof ServerError ? error : new ServerError(error.message, { status: 502 });
  });

  return result;
}

export async function getSyncStatus(accountId) {
  const account = await getAccount(accountId);
  if (!account) return null;
  return {
    accountId,
    lastSyncAt: account.lastSyncAt,
    lastSyncStatus: account.lastSyncStatus
  };
}

// Auto-log Tribe touchpoints for synced calendar events (#2033). Deterministic:
// an event's organizer/attendees are matched to tracked people by email/handle
// (or unique exact name) and one touchpoint per person is logged, idempotent on
// the event id so re-syncs never double-log. Only events that have already
// happened (start/end <= now) and weren't declined/cancelled count as contact.
// Called from both the Outlook (syncAccount) and Google (pushSyncEvents) paths;
// a no-op when nothing is tracked. Tribe is imported dynamically to avoid a
// static import cycle (tribe.js → calendarSync.js).
export async function logCalendarTouchpoints(accountId, events = []) {
  const now = Date.now();
  const timezone = await getUserTimezone();
  const candidates = [];
  for (const event of events) {
    if (event.isCancelled || event.myStatus === 'declined') continue;
    const at = (field) => resolveCalendarInstant(event[field], timezone, event.isAllDay === true);
    const startedAt = at('startTime') || at('endTime');
    if (!startedAt) continue;
    // Gate on the event's END (completion), not its start: an in-progress or
    // all-day event isn't a finished contact until it ends. All-day midnights
    // are the user's calendar dates, so a July 4 all-day is not over at UTC
    // midnight while it is still July 4 locally.
    const completedAt = at('endTime') || startedAt;
    if (completedAt.getTime() > now) continue; // not finished yet
    const identities = [event.organizer, ...(event.attendees || [])].filter(Boolean);
    if (identities.length === 0) continue;
    const eventKey = event.externalId || event.id;
    if (!eventKey) continue;
    candidates.push({
      identities,
      source: 'calendar',
      // The resolved instant, not the raw producer string. An all-day midnight
      // stored as `...T00:00:00Z` is UTC midnight; Tribe turns that into the
      // user's local day and would record July 3 for a July 4 event west of UTC.
      happenedAt: startedAt.toISOString(),
      channel: event.location || 'Calendar',
      summary: event.title || 'Calendar touchpoint',
      dedupeKey: calendarTouchpointDedupeKey(accountId, event),
      calendarAccountId: accountId,
      calendarEventId: eventKey,
      metadata: {
        title: event.title,
        location: event.location,
        startTime: event.startTime,
        endTime: event.endTime,
      },
    });
  }
  if (candidates.length === 0) return { created: 0, matched: 0 };
  const tribe = await import('./tribe.js');
  const result = await tribe.autoLogTouchpoints(candidates);
  if (result.created > 0) {
    console.log(`🤝 Auto-logged ${result.created} calendar touchpoint(s) for account ${accountId}`);
  }
  return result;
}

// Record synced calendar events into the machine-local human-activity timeline
// (#2150). Only finished, non-declined/cancelled events count as activity.
// Idempotent (dedupe on source + event id). humanActivity is imported
// dynamically to keep this hook lazy (mirrors the tribe auto-log path).
export async function recordCalendarActivity(account, events = []) {
  const { calendarActivityCandidates, recordEvents } = await import('./humanActivity.js');
  // The user's configured timezone anchors offset-less values (Google all-day
  // events normalize to "YYYY-MM-DDT00:00:00") so they land on the right local day.
  const timezone = await getUserTimezone();
  const candidates = calendarActivityCandidates(account, events, Date.now(), timezone);
  if (candidates.length === 0) return { recorded: 0, skipped: 0 };
  return recordEvents(candidates);
}

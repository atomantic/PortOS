import { readdir, unlink } from 'fs/promises';
import { join } from 'path';
import { atomicWrite, ensureDir, filterBySearch as genericFilterBySearch, PATHS, readJSONFile, safeDate, UUID_RE } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { getUserTimezone } from '../lib/timezone.js';
import { getAccount, updateSyncStatus } from './calendarAccounts.js';

export const CACHE_DIR = join(PATHS.calendar, 'cache');
const syncLocks = new Map();

const CALENDAR_SEARCH_FIELDS = ['title', 'description', 'location', 'organizer.name'];
function filterBySearch(events, search) {
  return genericFilterBySearch(events, search, CALENDAR_SEARCH_FIELDS);
}

function filterByDateRange(events, startDate, endDate) {
  let filtered = events;
  if (startDate) {
    const start = safeDate(startDate);
    filtered = filtered.filter(e => safeDate(e.endTime || e.startTime) >= start);
  }
  if (endDate) {
    const end = safeDate(endDate);
    filtered = filtered.filter(e => safeDate(e.startTime) <= end);
  }
  return filtered;
}

const DEFAULT_CACHE = { syncCursor: null, events: [] };

export async function loadCache(accountId) {
  if (!UUID_RE.test(accountId)) throw new Error(`Invalid accountId: ${accountId}`);
  await ensureDir(CACHE_DIR);
  const parsed = await readJSONFile(join(CACHE_DIR, `${accountId}.json`), DEFAULT_CACHE);
  if (!parsed || !Array.isArray(parsed.events)) return { ...DEFAULT_CACHE };
  return parsed;
}

export async function saveCache(accountId, cache) {
  await ensureDir(CACHE_DIR);
  const filePath = join(CACHE_DIR, `${accountId}.json`);
  await atomicWrite(filePath, cache);
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
    let events = cache.events.map(e => ({ ...e, accountId: e.accountId || accountId }));
    events = filterDeclinedAndCancelled(events);
    events = filterByEnabledSubcalendars(events, account);
    events = filterBySearch(events, search);
    events = filterByDateRange(events, startDate, endDate);
    return {
      events: events.sort((a, b) => safeDate(a.startTime) - safeDate(b.startTime)).slice(offset, offset + limit),
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
    .filter(id => UUID_RE.test(id));
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
  allEvents = filterByDateRange(allEvents, startDate, endDate);
  allEvents.sort((a, b) => safeDate(a.startTime) - safeDate(b.startTime));
  return {
    events: allEvents.slice(offset, offset + limit),
    total: allEvents.length
  };
}

export async function purgeDisabledSubcalendars(accountId) {
  const account = await getAccount(accountId);
  if (!account?.subcalendars?.length) return { purged: 0 };

  const enabledIds = new Set(
    account.subcalendars.filter(sc => sc.enabled && !sc.dormant).map(sc => sc.calendarId)
  );
  const cache = await loadCache(accountId);
  const before = cache.events.length;
  cache.events = cache.events.filter(e => !e.subcalendarId || enabledIds.has(e.subcalendarId));
  const purged = before - cache.events.length;
  if (purged > 0) {
    await saveCache(accountId, cache);
    console.log(`🧹 Purged ${purged} events from disabled subcalendars for account ${accountId}`);
  }
  return { purged, remaining: cache.events.length };
}

export async function getEvent(accountId, eventId) {
  const cache = await loadCache(accountId);
  const event = cache.events.find(e => e.id === eventId);
  if (!event) return null;
  return { ...event, accountId: event.accountId || accountId };
}

export async function deleteCache(accountId) {
  if (!UUID_RE.test(accountId)) return;
  const filePath = join(CACHE_DIR, `${accountId}.json`);
  try {
    await unlink(filePath);
    console.log(`🗑️ Calendar cache deleted for account ${accountId}`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`🗑️ No calendar cache to delete for account ${accountId}`);
    } else {
      console.error(`❌ Failed to delete calendar cache for account ${accountId}: ${err.message}`);
    }
  }
}

export async function syncAccount(accountId, io, options = {}) {
  if (syncLocks.has(accountId)) throw new ServerError('Sync already in progress', { status: 409 });

  const account = await getAccount(accountId);
  if (!account) throw new ServerError('Account not found', { status: 404 });
  if (!account.enabled) throw new ServerError('Account is disabled', { status: 400 });

  syncLocks.set(accountId, true);
  io?.emit('calendar:sync:started', { accountId });
  console.log(`📅 Starting calendar sync for ${account.name} (${account.type})`);

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

    // Deduplicate by externalId; update fields on existing events
    const existingMap = new Map(cache.events.filter(e => e.externalId).map(e => [e.externalId, e]));
    const uniqueNew = [];
    for (const event of newEvents) {
      if (!event.externalId || !existingMap.has(event.externalId)) {
        uniqueNew.push(event);
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
      cache.events = cache.events.filter(e => !e.externalId || fetchedIds.has(e.externalId));
      pruned = before - cache.events.length;
      if (pruned > 0) console.log(`🧹 Pruned ${pruned} stale calendar events from ${account.name}`);
    }

    await saveCache(accountId, cache);
    await updateSyncStatus(accountId, providerStatus === 'success' ? 'success' : providerStatus);

    // Auto-log Tribe touchpoints from this batch (secondary effect — must not
    // fail the sync). Idempotent on event id, so re-processing fetched events is safe.
    await logCalendarTouchpoints(accountId, newEvents).catch((err) =>
      console.error(`🤝 Tribe auto-log failed for account ${accountId}: ${err.message}`));

    // Populate the human-activity timeline (#2150) — secondary effect, must NOT
    // fail the sync. Idempotent on (source, dedupe_key). Machine-local.
    await recordCalendarActivity(account, newEvents).catch((err) =>
      console.error(`🗓️  Activity ingest failed for account ${accountId}: ${err.message}`));

    io?.emit('calendar:sync:completed', { accountId, newEvents: uniqueNew.length, pruned, status: providerStatus });
    console.log(`📅 Sync complete for ${account.name}: ${uniqueNew.length} new, ${pruned} pruned, status=${providerStatus}`);

    return { newEvents: uniqueNew.length, pruned, total: cache.events.length, status: providerStatus };
  };

  const result = await providerSync().catch(async (error) => {
    console.error(`📅 Sync failed for ${account.name} (${account.type}): ${error.message}`);
    await updateSyncStatus(accountId, 'error').catch(() => {});
    io?.emit('calendar:sync:failed', { accountId, error: error.message });
    throw error instanceof ServerError ? error : new ServerError(error.message, { status: 502 });
  }).finally(() => {
    syncLocks.delete(accountId);
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
  const candidates = [];
  for (const event of events) {
    if (event.isCancelled || event.myStatus === 'declined') continue;
    const startedAt = event.startTime || event.endTime;
    if (!startedAt) continue;
    // Gate on the event's END (completion), not its start: an in-progress or
    // all-day event isn't a finished contact until it ends.
    const completedAt = event.endTime || event.startTime;
    if (safeDate(completedAt) > now) continue; // not finished yet
    const identities = [event.organizer, ...(event.attendees || [])].filter(Boolean);
    if (identities.length === 0) continue;
    const eventKey = event.externalId || event.id;
    if (!eventKey) continue;
    candidates.push({
      identities,
      source: 'calendar',
      happenedAt: startedAt,
      channel: event.location || 'Calendar',
      summary: event.title || 'Calendar touchpoint',
      dedupeKey: `cal:${accountId}:${eventKey}`,
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

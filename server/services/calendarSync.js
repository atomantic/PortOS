import { readdir, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { ensureDir, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { getAccount, updateSyncStatus } from './calendarAccounts.js';

const CACHE_DIR = join(PATHS.calendar, 'cache');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const syncLocks = new Map();

function safeDate(d) {
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function filterBySearch(events, search) {
  if (!search) return events;
  const q = search.toLowerCase();
  return events.filter(e =>
    e.title?.toLowerCase().includes(q) ||
    e.description?.toLowerCase().includes(q) ||
    e.location?.toLowerCase().includes(q) ||
    e.organizer?.name?.toLowerCase().includes(q)
  );
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

async function loadCache(accountId) {
  if (!UUID_RE.test(accountId)) throw new Error(`Invalid accountId: ${accountId}`);
  await ensureDir(CACHE_DIR);
  const parsed = await readJSONFile(join(CACHE_DIR, `${accountId}.json`), DEFAULT_CACHE);
  if (!parsed || !Array.isArray(parsed.events)) return { ...DEFAULT_CACHE };
  return parsed;
}

async function saveCache(accountId, cache) {
  await ensureDir(CACHE_DIR);
  const filePath = join(CACHE_DIR, `${accountId}.json`);
  await writeFile(filePath, JSON.stringify(cache, null, 2));
}

export async function getEvents(options = {}) {
  const { accountId, search, startDate, endDate, limit = 50, offset = 0 } = options;

  if (accountId) {
    const cache = await loadCache(accountId);
    let events = cache.events.map(e => ({ ...e, accountId: e.accountId || accountId }));
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
  let allEvents = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const fileAccountId = file.replace('.json', '');
    if (!UUID_RE.test(fileAccountId)) continue;
    const cache = await loadCache(fileAccountId);
    allEvents.push(...cache.events.map(e => ({ ...e, accountId: e.accountId || fileAccountId })));
  }
  allEvents = filterBySearch(allEvents, search);
  allEvents = filterByDateRange(allEvents, startDate, endDate);
  allEvents.sort((a, b) => safeDate(a.startTime) - safeDate(b.startTime));
  return {
    events: allEvents.slice(offset, offset + limit),
    total: allEvents.length
  };
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
  if (syncLocks.has(accountId)) return { error: 'Sync already in progress', status: 409 };

  const account = await getAccount(accountId);
  if (!account) return { error: 'Account not found' };
  if (!account.enabled) return { error: 'Account is disabled', status: 400 };

  syncLocks.set(accountId, true);
  io?.emit('calendar:sync:started', { accountId });
  console.log(`📅 Starting calendar sync for ${account.name} (${account.type})`);

  const providerSync = async () => {
    const cache = await loadCache(accountId);
    let providerResult;
    if (account.type === 'outlook-calendar') {
      const { syncOutlookCalendarApi } = await import('./calendarApiSync.js');
      providerResult = await syncOutlookCalendarApi(account, cache, io, options);
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

    io?.emit('calendar:sync:completed', { accountId, newEvents: uniqueNew.length, pruned, status: providerStatus });
    console.log(`📅 Sync complete for ${account.name}: ${uniqueNew.length} new, ${pruned} pruned, status=${providerStatus}`);

    return { newEvents: uniqueNew.length, pruned, total: cache.events.length, status: providerStatus };
  };

  const result = await providerSync().catch(async (error) => {
    console.error(`📅 Sync failed for ${account.name} (${account.type}): ${error.message}`);
    await updateSyncStatus(accountId, 'error').catch(() => {});
    io?.emit('calendar:sync:failed', { accountId, error: error.message });
    return { error: error.message, status: 502 };
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

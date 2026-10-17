import { messageLogError } from '../lib/messageLogError.js';

import { browserSummaryId, browserDetailIdentities, messageIngestionIdentity, matchBrowserMessage, createBrowserMessageMatcher, retainLegacyActivityIdentities } from '../lib/messageBrowserIdentity.js';
import { join } from 'path';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { atomicWrite, ensureDir, filterBySearch as genericFilterBySearch, PATHS, safeDate, safeJSONParse, UUID_RE, tryReadFile } from '../lib/fileUtils.js';
import { getAccount, updateSyncStatus, markSentIngested, updateSendAsAliases } from './messageAccounts.js';
import { defaultSyncModeForAccountType, syncModesForAccountType } from '../lib/messageTransport.js';
import { getLocalParts } from '../lib/timezone.js';
import { getUserTimezone } from './userTimezone.js';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';
import { createBoundedStateMap } from '../lib/boundedStateMap.js';

const CACHE_DIR = join(PATHS.messages, 'cache');
// `syncLocks` is a boolean re-entrancy guard that rejects a *duplicate* in-flight
// sync for an account with a 409 (you never want two full syncs racing).
const syncLocks = new Map();

// Per-account cache write tail. EVERY load→mutate→saveCache region for an account
// routes through this single tail so it serializes against the account's sync and
// against every other mutator (#2537): `syncAccount`, `refreshMessages`, and
// `updateMessageEvaluations` all share the one `${accountId}.json` cache file, so
// two that interleave their load/save would clobber each other's writes. The tail
// makes each one await the previous and re-read the freshest persisted state
// inside its serialized region — mirroring `queueSeriesIssuesWrite` in pipeline/issuesShared.js.
const accountWriteQueue = createKeyCachedQueue();
const summarySnapshots = createBoundedStateMap({ maxSize: 8 });
const summaryReads = new Map();
function queueAccountWrite(accountId, work) {
  return accountWriteQueue(accountId, work);
}

const MESSAGE_SEARCH_FIELDS = ['subject', 'from.name', 'from.email', 'bodyText'];
function filterMessages(messages, { search, unevaluatedOnly, messageIds }) {
  const ids = messageIds ? new Set(messageIds) : null;
  return genericFilterBySearch(messages, search, MESSAGE_SEARCH_FIELDS)
    .filter(message => (!unevaluatedOnly || !message.evaluation) && (!ids || ids.has(message.id)));
}

/**
 * Merge per-account caches into ONE date-sorted page (#2540) without spreading
 * every message across every account into a single giant array first.
 *
 * A message can only appear in the global top `(offset + limit)` if it is also
 * in the top `(offset + limit)` of its OWN account (there can't be more than
 * `offset+limit` messages globally ahead of it without more than that many
 * ahead of it within its own account). So each account contributes at most
 * `offset+limit` heads to the cross-account merge — bounding the spread + sort
 * to `accounts × (offset+limit)` instead of the full multi-account total. The
 * per-account filter still walks every message (needed for the exact `total`),
 * but no whole-inbox intermediate array is built or globally sorted.
 *
 * Pure helper (no I/O) so the paging math is unit-testable; the caller loads the
 * caches.
 */
export function aggregatePagedMessages(caches, { search, unevaluatedOnly, messageIds, limit = 50, offset = 0 } = {}) {
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 50;
  const perAccountCap = safeOffset + safeLimit;
  const byDateDesc = (a, b) => safeDate(b.date) - safeDate(a.date);
  let total = 0;
  const heads = [];
  for (const { id, cache } of caches) {
    const filtered = filterMessages(cache.messages, { search, unevaluatedOnly, messageIds });
    total += filtered.length;
    if (perAccountCap === 0) continue;
    const top = [...filtered]
      .sort(byDateDesc)
      .slice(0, perAccountCap)
      .map((m) => ({ ...m, accountId: m.accountId || id }));
    heads.push(...top);
  }
  return {
    messages: heads.sort(byDateDesc).slice(safeOffset, safeOffset + safeLimit),
    total,
  };
}

async function loadCache(accountId) {
  if (!UUID_RE.test(accountId)) throw new Error(`Invalid accountId: ${accountId}`);
  await ensureDir(CACHE_DIR);
  const filePath = join(CACHE_DIR, `${accountId}.json`);
  const content = await tryReadFile(filePath);
  if (!content) return { syncCursor: null, messages: [] };
  const parsed = safeJSONParse(content, { syncCursor: null, messages: [] }, { context: `messageCache:${accountId}` });
  if (!parsed || !Array.isArray(parsed.messages)) return { syncCursor: null, messages: [] };
  return parsed;
}

function messageSummary(message) {
  return {
    id: message.id,
    accountId: message.accountId,
    externalId: message.externalId,
    threadId: message.threadId,
    subject: message.subject,
    from: message.from && { name: message.from.name, email: message.from.email },
    date: message.date,
    source: message.source,
    isRead: message.isRead,
    isUnread: message.isUnread,
    isPinned: message.isPinned,
    isFlagged: message.isFlagged,
    // Detach the short preview so V8 cannot retain the full body behind it.
    preview: typeof message.bodyText === 'string' ? message.bodyText.slice(0, 100).split('').join('') : '',
    evaluation: message.evaluation && {
      action: message.evaluation.action,
      priority: message.evaluation.priority,
    },
  };
}

async function cacheRevision(filePath) {
  try {
    const info = await stat(filePath, { bigint: true });
    await access(filePath, constants.R_OK);
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  } catch {
    // Match loadCache's missing/unreadable fallback, without serving old rows.
    return null;
  }
}

function invalidateSummary(accountId) {
  summarySnapshots.delete(accountId);
  const pending = summaryReads.get(accountId);
  if (pending) pending.generation++;
}

function loadSummaryCache(accountId) {
  if (!UUID_RE.test(accountId)) throw new Error(`Invalid accountId: ${accountId}`);
  const current = summaryReads.get(accountId);
  if (current) return current.promise;
  const pending = { generation: 0 };
  pending.promise = (async () => {
    const filePath = join(CACHE_DIR, `${accountId}.json`);
    // No TTL freshness window: local writes invalidate immediately, while
    // restore/external replacements and permission changes change the revision.
    for (let attempt = 0; attempt < 3; attempt++) {
      const generation = pending.generation;
      const before = await cacheRevision(filePath);
      const snapshot = summarySnapshots.get(accountId);
      if (before !== null && snapshot?.revision === before && generation === pending.generation) {
        return snapshot.cache;
      }
      summarySnapshots.delete(accountId);
      const full = await loadCache(accountId);
      const after = await cacheRevision(filePath);
      if (before !== after || generation !== pending.generation) continue;
      const messages = full.messages.map(message => {
        const row = messageSummary(message);
        if (row.from) Object.freeze(row.from);
        if (row.evaluation) Object.freeze(row.evaluation);
        return Object.freeze(row);
      });
      const cache = { messages: Object.freeze(messages) };
      if (after !== null) summarySnapshots.set(accountId, { revision: after, cache });
      return cache;
    }
    throw new Error('Message cache changed repeatedly while reading its summary snapshot');
  })().finally(() => { summaryReads.delete(accountId); });
  summaryReads.set(accountId, pending);
  return pending.promise;
}

async function saveCache(accountId, cache) {
  const filePath = join(CACHE_DIR, `${accountId}.json`);
  await atomicWrite(filePath, cache);
  invalidateSummary(accountId);
}

export async function getMessages(options = {}) {
  const { accountId, search, unevaluatedOnly, messageIds, summary = false, limit = 50, offset = 0 } = options;
  const readCache = summary && !search ? loadSummaryCache : loadCache;
  let result;
  // If specific account, just load that cache
  if (accountId) {
    const cache = await readCache(accountId);
    let messages = cache.messages.map(m => ({ ...m, accountId: m.accountId || accountId }));
    messages = filterMessages(messages, { search, unevaluatedOnly, messageIds });
    result = {
      messages: messages.sort((a, b) => safeDate(b.date) - safeDate(a.date)).slice(offset, offset + limit),
      total: messages.length
    };
  } else {
    // Otherwise aggregate across all account caches
    await ensureDir(CACHE_DIR);
    const { readdir } = await import('fs/promises');
    const files = await readdir(CACHE_DIR).catch(() => []);
    const accountIds = files
      .filter(file => file.endsWith('.json'))
      .map(file => file.replace('.json', ''))
      .filter(id => UUID_RE.test(id));
    // Load each account's cache in parallel rather than serializing one disk read
    // per account before we can aggregate the combined inbox.
    const caches = await Promise.all(
      accountIds.map(async id => ({ id, cache: await readCache(id) }))
    );
    // Bound the cross-account merge to `accounts × (offset+limit)` heads instead
    // of spreading + globally sorting every message across every account (#2540).
    result = aggregatePagedMessages(caches, { search, unevaluatedOnly, messageIds, limit, offset });
  }
  // Search keeps its full-body semantics; only the selected page is projected.
  return summary && search ? { ...result, messages: result.messages.map(messageSummary) } : result;
}

/** Remove only a confirmed action target, serialized with sync/refresh writes. */
export async function removeMessageFromCache(accountId, messageId) {
  if (!UUID_RE.test(accountId)) throw new Error('Invalid accountId');
  return queueAccountWrite(accountId, async () => {
    const cache = await loadCache(accountId);
    cache.messages = cache.messages.filter(message => message.id !== messageId);
    await saveCache(accountId, cache);
  });
}

export async function deleteCache(accountId) {
  if (!UUID_RE.test(accountId)) return;
  // Drain cache writers before erasing; a writer already in flight must not
  // recreate the file after deletion reports success.
  return queueAccountWrite(accountId, async () => {
    const { unlink } = await import('fs/promises');
    const filePath = join(CACHE_DIR, `${accountId}.json`);
    await unlink(filePath).catch(err => {
      if (err.code !== 'ENOENT') throw err;
    });
    invalidateSummary(accountId);
    console.log(`🗑️ Message cache deleted for account ${accountId}`);
  });
}

export async function getMessage(accountId, messageId) {
  const cache = await loadCache(accountId);
  const msg = cache.messages.find(m => m.id === messageId);
  if (!msg) return null;
  return { ...msg, accountId: msg.accountId || accountId };
}

/**
 * Get all messages in a thread, sorted chronologically.
 */
export async function getThread(accountId, threadId) {
  if (!threadId) return [];
  const cache = await loadCache(accountId);
  return cache.messages
    .filter(m => m.threadId === threadId)
    .map(m => ({ ...m, accountId: m.accountId || accountId }))
    .sort((a, b) => safeDate(a.date) - safeDate(b.date));
}

export async function syncAccount(accountId, io, options = {}) {
  if (syncLocks.has(accountId)) return { error: 'Sync already in progress', status: 409 };

  const account = await getAccount(accountId);
  if (!account) return { error: 'Account not found' };
  if (!account.enabled) return { error: 'Account is disabled', status: 400 };

  // Reject an explicit mode the provider cannot honor BEFORE taking the lock, emitting
  // events, or touching the browser/cache. An omitted mode takes the account's default.
  const mode = options.mode || defaultSyncModeForAccountType(account.type);
  if (!syncModesForAccountType(account.type).includes(mode)) {
    return { error: `${account.type} accounts do not support ${mode} sync`, status: 400 };
  }

  syncLocks.set(accountId, true);
  io?.emit('messages:sync:started', { accountId, mode });
  console.log(`📧 Starting ${mode} sync for account ${account.id} (${account.type})`);

  const providerSync = async () => {
    // The initial read may predate queued deletion. Recheck under the cache
    // queue before a stale sync can write after cleanup.
    const currentAccount = await getAccount(accountId);
    if (!currentAccount) return { error: 'Account not found' };
    if (!currentAccount.enabled) return { error: 'Account is disabled', status: 400 };
    const cache = await loadCache(accountId);
    let providerResult;
    if (account.type === 'gmail') {
      const { syncGmail } = await import('./messageGmailSync.js');
      providerResult = await syncGmail(account, cache, io, { mode });
    } else if (account.type === 'outlook') {
      // Try API sync first (fast), fall back to Playwright (slow)
      const { syncOutlookApi } = await import('./messageApiSync.js');
      providerResult = await syncOutlookApi(account, cache, io, { mode }).catch(err => {
        console.log(`📧 API sync error, falling back to Playwright: ${messageLogError(err)}`);
        return null;
      });
      if (!providerResult) {
        console.log(`📧 Falling back to Playwright sync for account ${account.id}`);
        const { syncPlaywright } = await import('./messagePlaywrightSync.js');
        providerResult = await syncPlaywright(account, cache, io, { mode });
      }
    } else if (account.type === 'teams') {
      // Teams v2 uses service workers + WebSocket — no usable REST API yet
      const { syncPlaywright } = await import('./messagePlaywrightSync.js');
      providerResult = await syncPlaywright(account, cache, io, { mode });
    } else {
      throw new Error(`Unsupported account type: ${account.type}`);
    }

    // Support structured result { messages, status } or plain array
    const newMessages = Array.isArray(providerResult) ? providerResult : providerResult?.messages ?? [];
    const providerStatus = Array.isArray(providerResult) ? 'success' : providerResult?.status ?? 'success';
    const providerReason = typeof providerResult?.error === 'string' ? { reason: providerResult.error } : {};
    // Sent mail (Gmail reply-detection ingest, #2796) is activity-only: recorded to
    // the timeline but never added to the inbox cache/eval/trim. Kept separate here.
    const sentMessages = Array.isArray(providerResult) ? [] : (providerResult?.sentMessages ?? []);
    // Whether the sent window truncated at its ceiling this sync (#2820) — coverage
    // is then partial, so the reply-detection watermark is marked partial (fail closed).
    const sentTruncated = Array.isArray(providerResult) ? false : Boolean(providerResult?.sentTruncated);
    // Gmail send-as aliases fetched this sync (#2831). `null` = fetch failed/not supplied
    // (keep the stored set); an array = authoritative refresh. Applied in-memory below so
    // the SAME sync's activity ingest excludes every owner address, and persisted for the
    // next sync + the outreach detector's own reads.
    const sendAsAliases = Array.isArray(providerResult) ? null : (providerResult?.sendAsAliases ?? null);

    // Preserve the DB identity of unambiguous pre-upgrade cache entries.
    retainLegacyActivityIdentities(cache.messages);
    const matcher = createBrowserMessageMatcher(cache.messages, newMessages);
    const uniqueNew = [];
    for (const msg of newMessages) {
      const existing = matcher.match(msg);
      if (!msg.externalId || !existing) {
        uniqueNew.push(msg);
      } else {
        // A row that becomes one unambiguous child keeps its already-recorded event.
        existing.activityIdentity ||= messageIngestionIdentity(existing);
        // Adopt canonical identity without replacing local ID or evaluation.
        for (const key of ['externalId', 'browserMessageKind', 'providerMessageId', 'browserMemberDisambiguator', 'browserSummaryExternalId', 'from', 'date', 'subject']) {
          if (msg[key] !== undefined && (key !== 'providerMessageId' || msg[key])) existing[key] = msg[key];
        }
        // Update flags and provider identity on existing message
        if (msg.providerRowId) existing.providerRowId = msg.providerRowId;
        if (msg.isUnread !== undefined) existing.isUnread = msg.isUnread;
        if (msg.isRead !== undefined) existing.isRead = msg.isRead;
        if (msg.isPinned !== undefined) existing.isPinned = msg.isPinned;
        if (msg.isFlagged !== undefined) existing.isFlagged = msg.isFlagged;
        if (msg.isReplied !== undefined) existing.isReplied = msg.isReplied;
        if (msg.hasMeetingInvite !== undefined) existing.hasMeetingInvite = msg.hasMeetingInvite;
        // Upgrade body if new sync fetched full content
        if (msg.bodyFull && msg.bodyText) {
          existing.bodyText = msg.bodyText;
          existing.bodyFull = true;
          if (msg.bodyHtml) existing.bodyHtml = msg.bodyHtml;
        }
        // Set threadId if newly available
        if (msg.threadId && !existing.threadId) existing.threadId = msg.threadId;
        matcher.refresh(existing);
      }
    }
    cache.messages.push(...uniqueNew);

    // Only explicit, exhaustive inbox coverage authorizes membership deletion.
    // Legacy arrays and bounded/partial successes still merge, but never prune.
    let pruned = 0;
    if (mode === 'full' && providerStatus === 'success' && providerResult?.inboxComplete === true) {
      const fetchedIds = new Set(newMessages.filter(m => m.externalId).map(m => m.externalId));
      const before = cache.messages.length;
      cache.messages = cache.messages.filter(m => !m.externalId || fetchedIds.has(m.externalId));
      pruned = before - cache.messages.length;
      if (pruned > 0) console.log(`🧹 Pruned ${pruned} stale messages from account ${account.id}`);
    }

    // Trim to maxMessages
    if (account.syncConfig?.maxMessages && cache.messages.length > account.syncConfig.maxMessages) {
      cache.messages.sort((a, b) => safeDate(b.date) - safeDate(a.date));
      cache.messages = cache.messages.slice(0, account.syncConfig.maxMessages);
    }

    await saveCache(accountId, cache);
    await updateSyncStatus(accountId, providerStatus === 'success' ? 'success' : providerStatus);

    // Auto-log Tribe touchpoints from the cached messages (#2033) — secondary
    // effect, must not fail the sync. Scans the full (maxMessages-capped) cache
    // rather than only the newly-added batch, mirroring the calendar path: so
    // adding a person's email AFTER their messages synced still backfills, and a
    // prior auto-log failure self-heals on the next sync. Deduped per thread+day
    // (partial unique index), so re-scanning already-logged messages is a no-op.
    await logMessageTouchpoints(account, cache.messages).catch((err) =>
      console.error(`🤝 Tribe auto-log failed for account ${accountId}: ${messageLogError(err)}`));

    // Apply + persist the owner's Gmail send-as aliases (#2831) BEFORE the activity
    // ingest below, so THIS sync's `messageActivityCandidates` already excludes every
    // owner address (not just the primary email) from received-message participants.
    // Best-effort: a `null` sentinel (fetch failed / non-Gmail provider) leaves the
    // stored set untouched; persist failure must not fail the sync.
    if (Array.isArray(sendAsAliases)) {
      // Aliases learned for the FIRST time this sync (#2855). Rows recorded before
      // the alias set was known still carry the alias as a participant, and the
      // `ON CONFLICT DO NOTHING` insert contract means they never self-correct —
      // so repair exactly those rows once, right when the set changes.
      const previousAliases = account.sendAsAliases;
      account.sendAsAliases = sendAsAliases;
      // ORDER IS LOAD-BEARING: repair BEFORE persisting the new set. The repair is
      // triggered by the delta between the stored set and this sync's set, so if we
      // persisted first and the repair then failed transiently, the next sync would
      // see an UNCHANGED set, compute an empty delta, and never retry — the stale
      // rows would stay broken forever. Leaving the old set stored on failure means
      // the next sync recomputes the same delta and tries again. The cost is that a
      // failed repair also defers the persist by one sync interval; the in-memory
      // set is already updated above, so THIS sync's activity ingest still excludes
      // every owner address either way.
      let repaired = true;
      await repairActivityAliasParticipants(account, previousAliases, sendAsAliases).catch((err) => {
        repaired = false;
        console.error(`🗓️  Activity alias backfill failed for account ${accountId} — deferring alias persist so the next sync retries: ${messageLogError(err)}`);
      });
      if (repaired) {
        await updateSendAsAliases(accountId, sendAsAliases).catch((err) =>
          console.error(`📧 Send-as alias persist failed for account ${accountId}: ${messageLogError(err)}`));
      }
    }

    // Populate the human-activity timeline (#2150) — secondary effect, must NOT
    // fail the sync. Idempotent on (source, dedupe_key), so re-scanning the full
    // cache each sync is a no-op for already-recorded messages. Machine-local.
    // Sent mail (activity-only, #2796) is fed IN ADDITION to the cached inbox mail
    // so it records `message.sent` events without ever entering the inbox cache.
    let activityIngestFailed = false;
    await recordMessageActivity(account, [...cache.messages, ...sentMessages]).catch((err) => {
      activityIngestFailed = true;
      console.error(`🗓️  Activity ingest failed for account ${accountId}: ${messageLogError(err)}`);
    });

    // Reply-detection watermark (#2796): stamp when a Gmail account with sent-ingest
    // enabled completes a successful sync, so the outreach detector only trusts an
    // account whose sent history is actually present and recent. Without this, an
    // account default-on at upgrade (or after an OAuth/sync failure) would be trusted
    // before any reply evidence exists, producing false "unanswered" nudges.
    if (providerStatus === 'success' && account.type === 'gmail' && account.syncConfig?.ingestSent !== false) {
      // `partial` fails the account closed for the outreach detector when reply
      // evidence for this sync is incomplete: either the sent window truncated at
      // its ceiling (#2820) OR activity ingestion itself failed — in which case the
      // freshly-fetched `message.sent` rows never reached the timeline, so trusting a
      // full watermark (or a stale recent one) would let a replied thread look
      // unanswered. Stamping partial keeps the account fail-closed until a clean sync.
      await markSentIngested(accountId, { partial: sentTruncated || activityIngestFailed }).catch((err) =>
        console.error(`🤝 Sent-ingest watermark failed for account ${accountId}: ${messageLogError(err)}`));
    }

    io?.emit('messages:sync:completed', { accountId, newMessages: uniqueNew.length, pruned, status: providerStatus, ...providerReason });
    if (providerStatus === 'success') {
      io?.emit('messages:changed', {});
    }
    console.log(`📧 Sync complete for account ${account.id}: ${uniqueNew.length} new, ${pruned} pruned, status=${providerStatus}`);

    return { newMessages: uniqueNew.length, pruned, total: cache.messages.length, status: providerStatus, ...providerReason };
  };

  // Serialize the load→mutate→save region against `refreshMessage` /
  // `updateMessageEvaluations` on the same account (#2537). `syncLocks` already
  // blocks a second concurrent sync; the tail additionally orders the sync's
  // write against the other cache mutators so none clobbers the others.
  const result = await queueAccountWrite(accountId, providerSync).catch(async (error) => {
    console.error(`📧 Sync failed for account ${account.id} (${account.type}): ${messageLogError(error)}`);
    await updateSyncStatus(accountId, 'error').catch(() => {});
    io?.emit('messages:sync:failed', { accountId, error: error.message });
    return { error: error.message, status: 502 };
  }).finally(() => {
    syncLocks.delete(accountId);
  });

  return result;
}

function mergeRefreshedMessage(cache, accountId, source, message, detail) {
  retainLegacyActivityIdentities(cache.messages);
  const identities = browserDetailIdentities(message, detail);
  const threadKey = message.threadId || `thread-${messageIngestionIdentity(message)}`;
  const updatedMessages = identities.map((identity, index) => {
    const threadMsg = detail[index];
    const existing = matchBrowserMessage(cache.messages, identity, identities)
      || (!message.providerRowId && identities.length === 1
        && browserSummaryId(message.date || '', message.from?.name || '', message.subject || '') === identity.externalId
        ? message : null);
    if (existing?.providerMessageId) identity.providerMessageId ||= existing.providerMessageId;
    // API IDs remain authoritative; a browser refresh supplies content only.
    if (existing?.externalId && !existing.providerRowId && !identity.providerRowId) identity.externalId = existing.externalId;
    const updated = existing || {
      id: uuidv4(), labels: [], source, isRead: message.isRead === undefined ? true : message.isRead,
      isUnread: message.isUnread === undefined ? false : message.isUnread, isPinned: message.isPinned ?? false,
      isFlagged: message.isFlagged ?? false, isReplied: message.isReplied ?? false,
      hasMeetingInvite: message.hasMeetingInvite ?? false, subject: message.subject || ''
    };
    if (existing) updated.activityIdentity ||= messageIngestionIdentity(existing);
    Object.assign(updated, identity, {
      bodyText: threadMsg.body ?? updated.bodyText ?? '', bodyFull: true,
      threadId: threadKey, to: threadMsg.to || updated.to || [], cc: threadMsg.cc || updated.cc || [],
      syncedAt: new Date().toISOString()
    });
    if (!existing) cache.messages.push(updated);
    return updated;
  });
  // Do not copy an arbitrary child's body onto an unmatched conversation row.
  return updatedMessages.map(m => ({ ...m, accountId }));
}

export async function refreshMessages(accountId, messageIds) {
  if (messageIds.length === 0) return { results: [], updated: 0 };

  // A full-body refresh can touch hundreds of messages. Keep the whole batch in
  // the existing per-account write queue so it loads and saves the shared cache
  // once instead of rewriting the complete JSON file for every message.
  return queueAccountWrite(accountId, async () => {
    const cache = await loadCache(accountId);
    const account = await getAccount(accountId);
    if (!account) {
      console.log(`📧 Refresh: account ${accountId} not found`);
      return { results: messageIds.map(() => null), updated: 0 };
    }

    const { refreshMessageDetail } = await import('./messagePlaywrightSync.js');
    const messagesById = new Map(cache.messages.map(message => [message.id, message]));
    const results = [];
    let updated = 0;

    for (const messageId of messageIds) {
      const message = messagesById.get(messageId);
      if (!message) {
        console.log(`📧 Refresh: message ${messageId} not found in cache`);
        results.push(null);
        continue;
      }

      console.log(`📧 Refreshing ${message.id} via ${account.type}`);
      const detail = await refreshMessageDetail(account, message);
      // Structured error from refreshMessageDetail
      if (detail && detail.error) {
        results.push(detail);
        continue;
      }
      if (!detail || !Array.isArray(detail) || detail.length === 0) {
        console.log(`📧 Refresh: no detail returned`);
        results.push({ error: 'extraction-failed', message: 'Could not extract message content — the message may not be visible in the Outlook inbox' });
        continue;
      }

      results.push(mergeRefreshedMessage(cache, accountId, account.type, message, detail));
      updated++;
    }

    if (updated > 0) await saveCache(accountId, cache);
    return { results, updated };
  });
}

export async function refreshMessage(accountId, messageId) {
  const { results } = await refreshMessages(accountId, [messageId]);
  return results[0] ?? null;
}

export async function updateMessageEvaluations(evaluations) {
  await ensureDir(CACHE_DIR);
  const { readdir } = await import('fs/promises');
  const files = await readdir(CACHE_DIR).catch(() => []);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const accountId = file.replace('.json', '');
    if (!UUID_RE.test(accountId)) continue;
    // Serialize each account's load→mutate→save through the per-account tail
    // (#2537) so a concurrent sync/refresh doesn't clobber the written
    // evaluations (and vice versa); the cache reloads inside the tail.
    await queueAccountWrite(accountId, async () => {
      const cache = await loadCache(accountId);
      let changed = false;
      for (const msg of cache.messages) {
        if (evaluations[msg.id]) {
          msg.evaluation = evaluations[msg.id];
          changed = true;
        }
      }
      if (changed) await saveCache(accountId, cache);
    });
  }
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

// Normalize a message participant (from is `{ name, email }`, to/cc are bare
// email strings) to the `{ email, name }` shape the Tribe matcher expects.
function toIdentity(participant) {
  if (!participant) return null;
  if (typeof participant === 'string') return { email: participant };
  return { email: participant.email || '', name: participant.name || '' };
}

// Auto-log Tribe touchpoints for synced messages (#2033). Deterministic: the
// message counterparts (sender + recipients, excluding the account's own
// address) are matched to tracked people by email/handle (or unique exact name)
// and one touchpoint per person is logged, deduped per thread + calendar day so
// a long thread doesn't spam touchpoints. Tribe is imported dynamically to avoid
// a static import cycle. A no-op when nothing is tracked.
export async function logMessageTouchpoints(account, messages = []) {
  const selfEmail = String(account?.email || '').trim().toLowerCase();
  // Derive the dedupe "calendar day" in the user's LOCAL timezone (matching the
  // Tribe cadence math in tribeCadence.daysSinceDate). Using the UTC day here
  // would split one local evening of contact across two days whenever a thread
  // straddles UTC midnight (common in the Americas), double-logging touchpoints.
  const timezone = await getUserTimezone();
  const localDay = (when) => {
    const p = getLocalParts(new Date(safeDate(when)), timezone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  };
  const candidates = [];
  for (const message of messages) {
    const participants = [message.from, ...(message.to || []), ...(message.cc || [])];
    const identities = participants
      .map(toIdentity)
      .filter((identity) => {
        if (!identity) return false;
        const email = (identity.email || '').trim().toLowerCase();
        if (email && email === selfEmail) return false; // exclude the account owner
        // Keep name-only participants too so the matcher's unique-name fallback
        // still applies (mirrors the calendar path, which passes every identity).
        return Boolean(email || identity.name);
      });
    if (identities.length === 0) continue;
    const when = message.date || new Date().toISOString();
    const day = localDay(when);
    const threadKey = message.threadId || message.id;
    candidates.push({
      identities,
      source: 'message',
      happenedAt: when,
      channel: account?.type || 'Message',
      summary: message.subject || 'Message touchpoint',
      dedupeKey: `msg:${account?.id}:${threadKey}:${day}`,
      metadata: { subject: message.subject, threadId: message.threadId || null },
    });
  }
  if (candidates.length === 0) return { created: 0, matched: 0 };
  const tribe = await import('./tribe.js');
  const result = await tribe.autoLogTouchpoints(candidates);
  if (result.created > 0) {
    console.log(`🤝 Auto-logged ${result.created} message touchpoint(s) for account ${account?.id}`);
  }
  return result;
}

// Record synced messages into the machine-local human-activity timeline (#2150).
// Deterministic + idempotent (dedupe on source + message externalId), so
// re-scanning the full cache each sync is a no-op for already-recorded messages.
// humanActivity is imported dynamically to keep this hook lazy (mirrors the tribe
// auto-log path) and off the module graph for callers that never sync.
export async function recordMessageActivity(account, messages = []) {
  const { messageActivityCandidates, recordEvents } = await import('./humanActivity.js');
  const candidates = messageActivityCandidates(account, messages);
  if (candidates.length === 0) return { recorded: 0, skipped: 0 };
  return recordEvents(candidates);
}

// One-shot repair of activity rows recorded BEFORE this account's send-as aliases
// were known (#2855). Runs only for the aliases newly learned this sync, so a
// routine sync with an unchanged set does no DB work at all. Returns the number of
// rows repaired. Secondary effect — the caller must not let it fail the sync.
export async function repairActivityAliasParticipants(account, previousAliases, nextAliases) {
  const { newlyLearnedAliases, stripParticipantsForAccount } = await import('./humanActivity.js');
  const learned = newlyLearnedAliases(previousAliases, nextAliases);
  if (learned.length === 0) return 0;
  return stripParticipantsForAccount(account?.id, account?.type || 'message', learned);
}

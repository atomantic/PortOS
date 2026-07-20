
import { createHash } from 'crypto';
import { join } from 'path';
import { atomicWrite, ensureDir, filterBySearch as genericFilterBySearch, PATHS, safeDate, safeJSONParse, UUID_RE, tryReadFile } from '../lib/fileUtils.js';
import { getAccount, updateSyncStatus, markSentIngested } from './messageAccounts.js';
import { getUserTimezone, getLocalParts } from '../lib/timezone.js';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';

const CACHE_DIR = join(PATHS.messages, 'cache');
// `syncLocks` is a boolean re-entrancy guard that rejects a *duplicate* in-flight
// sync for an account with a 409 (you never want two full syncs racing).
const syncLocks = new Map();

// Per-account cache write tail. EVERY load→mutate→saveCache region for an account
// routes through this single tail so it serializes against the account's sync and
// against every other mutator (#2537): `syncAccount`, `refreshMessage`, and
// `updateMessageEvaluations` all share the one `${accountId}.json` cache file, so
// two that interleave their load/save would clobber each other's writes. The tail
// makes each one await the previous and re-read the freshest persisted state
// inside its serialized region — mirroring `issueWriteTail` in pipeline/issues.js.
const accountWriteQueue = createKeyCachedQueue();
function queueAccountWrite(accountId, work) {
  return accountWriteQueue(accountId, work);
}

const MESSAGE_SEARCH_FIELDS = ['subject', 'from.name', 'from.email', 'bodyText'];
function filterBySearch(messages, search) {
  return genericFilterBySearch(messages, search, MESSAGE_SEARCH_FIELDS);
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
export function aggregatePagedMessages(caches, { search, limit = 50, offset = 0 } = {}) {
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 50;
  const perAccountCap = safeOffset + safeLimit;
  const byDateDesc = (a, b) => safeDate(b.date) - safeDate(a.date);
  let total = 0;
  const heads = [];
  for (const { id, cache } of caches) {
    const filtered = filterBySearch(cache.messages, search);
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

async function saveCache(accountId, cache) {
  const filePath = join(CACHE_DIR, `${accountId}.json`);
  await atomicWrite(filePath, cache);
}

export async function getMessages(options = {}) {
  const { accountId, search, limit = 50, offset = 0 } = options;
  // If specific account, just load that cache
  if (accountId) {
    const cache = await loadCache(accountId);
    let messages = cache.messages.map(m => ({ ...m, accountId: m.accountId || accountId }));
    messages = filterBySearch(messages, search);
    return {
      messages: messages.sort((a, b) => safeDate(b.date) - safeDate(a.date)).slice(offset, offset + limit),
      total: messages.length
    };
  }

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
    accountIds.map(async id => ({ id, cache: await loadCache(id) }))
  );
  // Bound the cross-account merge to `accounts × (offset+limit)` heads instead
  // of spreading + globally sorting every message across every account (#2540).
  return aggregatePagedMessages(caches, { search, limit, offset });
}

export async function deleteCache(accountId) {
  if (!UUID_RE.test(accountId)) return;
  const { unlink } = await import('fs/promises');
  const filePath = join(CACHE_DIR, `${accountId}.json`);
  try {
    await unlink(filePath);
    console.log(`🗑️ Message cache deleted for account ${accountId}`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`🗑️ No message cache to delete for account ${accountId}`);
    } else {
      console.error(`❌ Failed to delete message cache for account ${accountId}: ${err.message}`);
    }
  }
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

  syncLocks.set(accountId, true);
  const mode = options.mode || 'unread';
  io?.emit('messages:sync:started', { accountId, mode });
  console.log(`📧 Starting ${mode} sync for ${account.name} (${account.type})`);

  const providerSync = async () => {
    const cache = await loadCache(accountId);
    let providerResult;
    if (account.type === 'gmail') {
      const { syncGmail } = await import('./messageGmailSync.js');
      providerResult = await syncGmail(account, cache, io, { mode });
    } else if (account.type === 'outlook') {
      // Try API sync first (fast), fall back to Playwright (slow)
      const { syncOutlookApi } = await import('./messageApiSync.js');
      providerResult = await syncOutlookApi(account, cache, io, { mode }).catch(err => {
        console.log(`📧 API sync error, falling back to Playwright: ${err.message}`);
        return null;
      });
      if (!providerResult) {
        console.log(`📧 Falling back to Playwright sync for ${account.email}`);
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
    // Sent mail (Gmail reply-detection ingest, #2796) is activity-only: recorded to
    // the timeline but never added to the inbox cache/eval/trim. Kept separate here.
    const sentMessages = Array.isArray(providerResult) ? [] : (providerResult?.sentMessages ?? []);
    // Whether the sent window truncated at its ceiling this sync (#2820) — coverage
    // is then partial, so the reply-detection watermark is marked partial (fail closed).
    const sentTruncated = Array.isArray(providerResult) ? false : Boolean(providerResult?.sentTruncated);

    // Deduplicate by externalId; update flags and body on existing messages
    const existingMap = new Map(cache.messages.filter(m => m.externalId).map(m => [m.externalId, m]));
    const uniqueNew = [];
    for (const msg of newMessages) {
      if (!msg.externalId || !existingMap.has(msg.externalId)) {
        uniqueNew.push(msg);
      } else {
        // Update flags on existing message
        const existing = existingMap.get(msg.externalId);
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
      }
    }
    cache.messages.push(...uniqueNew);

    // Reconcile: remove cached messages no longer present in inbox during full sync
    let pruned = 0;
    if (mode === 'full' && providerStatus === 'success' && newMessages.length > 0) {
      const fetchedIds = new Set(newMessages.filter(m => m.externalId).map(m => m.externalId));
      const before = cache.messages.length;
      cache.messages = cache.messages.filter(m => !m.externalId || fetchedIds.has(m.externalId));
      pruned = before - cache.messages.length;
      if (pruned > 0) console.log(`🧹 Pruned ${pruned} stale messages from ${account.name}`);
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
      console.error(`🤝 Tribe auto-log failed for account ${accountId}: ${err.message}`));

    // Populate the human-activity timeline (#2150) — secondary effect, must NOT
    // fail the sync. Idempotent on (source, dedupe_key), so re-scanning the full
    // cache each sync is a no-op for already-recorded messages. Machine-local.
    // Sent mail (activity-only, #2796) is fed IN ADDITION to the cached inbox mail
    // so it records `message.sent` events without ever entering the inbox cache.
    await recordMessageActivity(account, [...cache.messages, ...sentMessages]).catch((err) =>
      console.error(`🗓️  Activity ingest failed for account ${accountId}: ${err.message}`));

    // Reply-detection watermark (#2796): stamp when a Gmail account with sent-ingest
    // enabled completes a successful sync, so the outreach detector only trusts an
    // account whose sent history is actually present and recent. Without this, an
    // account default-on at upgrade (or after an OAuth/sync failure) would be trusted
    // before any reply evidence exists, producing false "unanswered" nudges.
    if (providerStatus === 'success' && account.type === 'gmail' && account.syncConfig?.ingestSent !== false) {
      // `partial` fails the account closed for the outreach detector when the sent
      // window truncated at its ceiling this sync (#2820) — incomplete reply evidence.
      await markSentIngested(accountId, { partial: sentTruncated }).catch((err) =>
        console.error(`🤝 Sent-ingest watermark failed for account ${accountId}: ${err.message}`));
    }

    io?.emit('messages:sync:completed', { accountId, newMessages: uniqueNew.length, pruned, status: providerStatus });
    if (providerStatus === 'success') {
      io?.emit('messages:changed', {});
    }
    console.log(`📧 Sync complete for ${account.name}: ${uniqueNew.length} new, ${pruned} pruned, status=${providerStatus}`);

    return { newMessages: uniqueNew.length, pruned, total: cache.messages.length, status: providerStatus };
  };

  // Serialize the load→mutate→save region against `refreshMessage` /
  // `updateMessageEvaluations` on the same account (#2537). `syncLocks` already
  // blocks a second concurrent sync; the tail additionally orders the sync's
  // write against the other cache mutators so none clobbers the others.
  const result = await queueAccountWrite(accountId, providerSync).catch(async (error) => {
    console.error(`📧 Sync failed for ${account.name} (${account.type}): ${error.message}`);
    await updateSyncStatus(accountId, 'error').catch(() => {});
    io?.emit('messages:sync:failed', { accountId, error: error.message });
    return { error: error.message, status: 502 };
  }).finally(() => {
    syncLocks.delete(accountId);
  });

  return result;
}

export async function refreshMessage(accountId, messageId) {
  // Serialize the whole load→extract→mutate→save region through the per-account
  // tail (#2537) so a concurrent sync or evaluation update can't clobber the
  // refreshed body (and vice versa). The cache is (re)loaded inside the tail so
  // it merges against the freshest persisted state.
  return queueAccountWrite(accountId, async () => {
  const cache = await loadCache(accountId);
  const message = cache.messages.find(m => m.id === messageId);
  if (!message) {
    console.log(`📧 Refresh: message ${messageId} not found in cache`);
    return null;
  }

  const account = await getAccount(accountId);
  if (!account) {
    console.log(`📧 Refresh: account ${accountId} not found`);
    return null;
  }

  console.log(`📧 Refreshing "${message.subject}" via ${account.type}`);
  const { refreshMessageDetail } = await import('./messagePlaywrightSync.js');
  const detail = await refreshMessageDetail(account, message);
  // Structured error from refreshMessageDetail
  if (detail && detail.error) return detail;
  if (!detail || !Array.isArray(detail) || detail.length === 0) {
    console.log(`📧 Refresh: no detail returned`);
    return { error: 'extraction-failed', message: 'Could not extract message content — the message may not be visible in the Outlook inbox' };
  }

  function makeExternalId(date, sender, subject) {
    return 'pw-' + createHash('md5').update(`${date}|${sender}|${subject}`).digest('hex').slice(0, 12);
  }

  const threadKey = message.threadId || `thread-${message.externalId || messageId}`;
  const existingMap = new Map(cache.messages.filter(m => m.externalId).map(m => [m.externalId, m]));
  const updatedMessages = [];

  for (const threadMsg of detail) {
    const extId = makeExternalId(threadMsg.date || message.date || '', threadMsg.from || message.from?.name || '', message.subject || '');
    const existing = existingMap.get(extId);
    if (existing) {
      // Use ?? not ||: a genuinely empty-body message (body === '') is a valid
      // full extraction and must overwrite the old text, not collapse back to it
      // (absent-vs-cleared, CLAUDE.md). Only an absent body (null/undefined) keeps
      // the prior text.
      existing.bodyText = threadMsg.body ?? existing.bodyText;
      existing.bodyFull = true;
      if (!existing.threadId) existing.threadId = threadKey;
      if (threadMsg.to?.length) existing.to = threadMsg.to;
      if (threadMsg.cc?.length) existing.cc = threadMsg.cc;
      updatedMessages.push(existing);
    } else {
      const newMsg = {
        id: uuidv4(),
        externalId: extId,
        threadId: threadKey,
        from: { name: threadMsg.from || message.from?.name || '', email: threadMsg.fromEmail || message.from?.email || '' },
        to: threadMsg.to || [],
        cc: threadMsg.cc || [],
        subject: message.subject || '',
        bodyText: threadMsg.body || '',
        bodyFull: true,
        date: threadMsg.date || message.date || new Date().toISOString(),
        isRead: message.isRead ?? true,
        isUnread: message.isUnread ?? false,
        isPinned: message.isPinned ?? false,
        isFlagged: message.isFlagged ?? false,
        isReplied: message.isReplied ?? false,
        hasMeetingInvite: message.hasMeetingInvite ?? false,
        labels: [],
        source: account.type,
        syncedAt: new Date().toISOString()
      };
      cache.messages.push(newMsg);
      updatedMessages.push(newMsg);
    }
  }

  // Update the original message too if it wasn't matched by externalId
  if (!updatedMessages.find(m => m.id === message.id)) {
    // ?? not ||: an empty extracted body ('') is a valid clear, not a fall-back
    // to the stale text (absent-vs-cleared, CLAUDE.md).
    message.bodyText = detail[0]?.body ?? message.bodyText;
    message.bodyFull = true;
    if (!message.threadId) message.threadId = threadKey;
    updatedMessages.push(message);
  }

  await saveCache(accountId, cache);
  return updatedMessages.map(m => ({ ...m, accountId }));
  });
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

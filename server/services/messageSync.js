
import { createHash } from 'crypto';
import { join } from 'path';
import { atomicWrite, ensureDir, filterBySearch as genericFilterBySearch, PATHS, safeDate, safeJSONParse, UUID_RE, tryReadFile } from '../lib/fileUtils.js';
import { getAccount, updateSyncStatus } from './messageAccounts.js';
import { v4 as uuidv4 } from '../lib/uuid.js';

const CACHE_DIR = join(PATHS.messages, 'cache');
const syncLocks = new Map();

const MESSAGE_SEARCH_FIELDS = ['subject', 'from.name', 'from.email', 'bodyText'];
function filterBySearch(messages, search) {
  return genericFilterBySearch(messages, search, MESSAGE_SEARCH_FIELDS);
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
  let allMessages = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const fileAccountId = file.replace('.json', '');
    if (!UUID_RE.test(fileAccountId)) continue;
    const cache = await loadCache(fileAccountId);
    allMessages.push(...cache.messages.map(m => ({ ...m, accountId: m.accountId || fileAccountId })));
  }
  allMessages = filterBySearch(allMessages, search);
  allMessages.sort((a, b) => safeDate(b.date) - safeDate(a.date));
  return {
    messages: allMessages.slice(offset, offset + limit),
    total: allMessages.length
  };
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

    // Auto-log Tribe touchpoints from newly synced messages (#2033) — secondary
    // effect, must not fail the sync; deduped per thread + day so re-syncs are safe.
    await logMessageTouchpoints(account, uniqueNew).catch((err) =>
      console.error(`🤝 Tribe auto-log failed for account ${accountId}: ${err.message}`));

    io?.emit('messages:sync:completed', { accountId, newMessages: uniqueNew.length, pruned, status: providerStatus });
    if (providerStatus === 'success') {
      io?.emit('messages:changed', {});
    }
    console.log(`📧 Sync complete for ${account.name}: ${uniqueNew.length} new, ${pruned} pruned, status=${providerStatus}`);

    return { newMessages: uniqueNew.length, pruned, total: cache.messages.length, status: providerStatus };
  };

  const result = await providerSync().catch(async (error) => {
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
}

export async function updateMessageEvaluations(evaluations) {
  await ensureDir(CACHE_DIR);
  const { readdir } = await import('fs/promises');
  const files = await readdir(CACHE_DIR).catch(() => []);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const accountId = file.replace('.json', '');
    if (!UUID_RE.test(accountId)) continue;
    const cache = await loadCache(accountId);
    let changed = false;
    for (const msg of cache.messages) {
      if (evaluations[msg.id]) {
        msg.evaluation = evaluations[msg.id];
        changed = true;
      }
    }
    if (changed) await saveCache(accountId, cache);
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
  const candidates = [];
  for (const message of messages) {
    const participants = [message.from, ...(message.to || []), ...(message.cc || [])];
    const identities = participants
      .map(toIdentity)
      .filter((identity) => identity && identity.email
        && identity.email.trim().toLowerCase() !== selfEmail);
    if (identities.length === 0) continue;
    const when = message.date || new Date().toISOString();
    const day = new Date(safeDate(when)).toISOString().slice(0, 10);
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

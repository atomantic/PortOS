import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { ensureDir, PATHS, safeJSONParse } from '../lib/fileUtils.js';
import { getAccount, updateSyncStatus } from './messageAccounts.js';

const CACHE_DIR = join(PATHS.messages, 'cache');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const syncLocks = new Map();

function safeDate(d) {
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function filterBySearch(messages, search) {
  if (!search) return messages;
  const q = search.toLowerCase();
  return messages.filter(m =>
    m.subject?.toLowerCase().includes(q) ||
    m.from?.name?.toLowerCase().includes(q) ||
    m.from?.email?.toLowerCase().includes(q) ||
    m.bodyText?.toLowerCase().includes(q)
  );
}

async function loadCache(accountId) {
  if (!UUID_RE.test(accountId)) throw new Error(`Invalid accountId: ${accountId}`);
  await ensureDir(CACHE_DIR);
  const filePath = join(CACHE_DIR, `${accountId}.json`);
  const content = await readFile(filePath, 'utf-8').catch(() => null);
  if (!content) return { syncCursor: null, messages: [] };
  const parsed = safeJSONParse(content, { syncCursor: null, messages: [] }, { context: `messageCache:${accountId}` });
  if (!parsed || !Array.isArray(parsed.messages)) return { syncCursor: null, messages: [] };
  return parsed;
}

async function saveCache(accountId, cache) {
  await ensureDir(CACHE_DIR);
  const filePath = join(CACHE_DIR, `${accountId}.json`);
  await writeFile(filePath, JSON.stringify(cache, null, 2));
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
  await unlink(filePath).catch(() => {});
  console.log(`🗑️ Message cache deleted for account ${accountId}`);
}

export async function getMessage(accountId, messageId) {
  const cache = await loadCache(accountId);
  return cache.messages.find(m => m.id === messageId) || null;
}

export async function syncAccount(accountId, io) {
  if (syncLocks.has(accountId)) return { error: 'Sync already in progress', status: 409 };

  const account = await getAccount(accountId);
  if (!account) return { error: 'Account not found' };
  if (!account.enabled) return { error: 'Account is disabled', status: 400 };

  syncLocks.set(accountId, true);
  io?.emit('messages:sync:started', { accountId });
  console.log(`📧 Starting sync for ${account.name} (${account.type})`);

  const providerSync = async () => {
    const cache = await loadCache(accountId);
    let providerResult;
    if (account.type === 'gmail') {
      const { syncGmail } = await import('./messageGmailSync.js');
      providerResult = await syncGmail(account, cache, io);
    } else if (account.type === 'outlook' || account.type === 'teams') {
      const { syncPlaywright } = await import('./messagePlaywrightSync.js');
      providerResult = await syncPlaywright(account, cache, io);
    } else {
      throw new Error(`Unsupported account type: ${account.type}`);
    }

    // Support structured result { messages, status } or plain array
    const newMessages = Array.isArray(providerResult) ? providerResult : providerResult?.messages ?? [];
    const providerStatus = Array.isArray(providerResult) ? 'success' : providerResult?.status ?? 'success';

    // Deduplicate by externalId (skip dedup for messages without externalId)
    const existingIds = new Set(cache.messages.map(m => m.externalId).filter(Boolean));
    const uniqueNew = newMessages.filter(m => !m.externalId || !existingIds.has(m.externalId));
    cache.messages.push(...uniqueNew);

    // Trim to maxMessages
    if (account.syncConfig?.maxMessages && cache.messages.length > account.syncConfig.maxMessages) {
      cache.messages.sort((a, b) => safeDate(b.date) - safeDate(a.date));
      cache.messages = cache.messages.slice(0, account.syncConfig.maxMessages);
    }

    await saveCache(accountId, cache);
    await updateSyncStatus(accountId, providerStatus === 'success' ? 'success' : providerStatus);

    io?.emit('messages:sync:completed', { accountId, newMessages: uniqueNew.length, status: providerStatus });
    io?.emit('messages:changed', {});
    console.log(`📧 Sync complete for ${account.name}: ${uniqueNew.length} new, status=${providerStatus}`);

    return { newMessages: uniqueNew.length, total: cache.messages.length, status: providerStatus };
  };

  const result = await providerSync().catch(async (error) => {
    console.error(`📧 Sync failed for ${account.name} (${account.type}): ${error.message}`);
    await updateSyncStatus(accountId, 'error').catch(() => {});
    io?.emit('messages:sync:failed', { accountId, error: error.message });
    throw error;
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

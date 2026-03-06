import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { ensureDir, PATHS, safeJSONParse } from '../lib/fileUtils.js';
import { getAccount, updateSyncStatus } from './messageAccounts.js';

const CACHE_DIR = join(PATHS.messages, 'cache');

async function loadCache(accountId) {
  await ensureDir(CACHE_DIR);
  const filePath = join(CACHE_DIR, `${accountId}.json`);
  const content = await readFile(filePath, 'utf-8').catch(() => null);
  if (!content) return { syncCursor: null, messages: [] };
  return safeJSONParse(content, { syncCursor: null, messages: [] }, { context: `messageCache:${accountId}` });
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
    if (search) {
      const q = search.toLowerCase();
      messages = messages.filter(m =>
        m.subject?.toLowerCase().includes(q) ||
        m.from?.name?.toLowerCase().includes(q) ||
        m.from?.email?.toLowerCase().includes(q) ||
        m.bodyText?.toLowerCase().includes(q)
      );
    }
    return {
      messages: messages.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(offset, offset + limit),
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
    const cache = await loadCache(fileAccountId);
    allMessages.push(...cache.messages.map(m => ({ ...m, accountId: m.accountId || fileAccountId })));
  }
  if (search) {
    const q = search.toLowerCase();
    allMessages = allMessages.filter(m =>
      m.subject?.toLowerCase().includes(q) ||
      m.from?.name?.toLowerCase().includes(q) ||
      m.from?.email?.toLowerCase().includes(q) ||
      m.bodyText?.toLowerCase().includes(q)
    );
  }
  allMessages.sort((a, b) => new Date(b.date) - new Date(a.date));
  return {
    messages: allMessages.slice(offset, offset + limit),
    total: allMessages.length
  };
}

export async function getMessage(accountId, messageId) {
  const cache = await loadCache(accountId);
  return cache.messages.find(m => m.id === messageId) || null;
}

export async function syncAccount(accountId, io) {
  const account = await getAccount(accountId);
  if (!account) return { error: 'Account not found' };

  io?.emit('messages:sync:started', { accountId });
  console.log(`📧 Starting sync for ${account.name} (${account.type})`);

  const cache = await loadCache(accountId);
  let newMessages = [];

  let uniqueNew;
  const providerSync = async () => {
    if (account.type === 'gmail') {
      const { syncGmail } = await import('./messageGmailSync.js');
      newMessages = await syncGmail(account, cache, io);
    } else if (account.type === 'outlook' || account.type === 'teams') {
      const { syncPlaywright } = await import('./messagePlaywrightSync.js');
      newMessages = await syncPlaywright(account, cache, io);
    }

    // Deduplicate by externalId (skip dedup for messages without externalId)
    const existingIds = new Set(cache.messages.map(m => m.externalId).filter(Boolean));
    uniqueNew = newMessages.filter(m => !m.externalId || !existingIds.has(m.externalId));
    cache.messages.push(...uniqueNew);

    // Trim to maxMessages
    if (account.syncConfig?.maxMessages && cache.messages.length > account.syncConfig.maxMessages) {
      cache.messages.sort((a, b) => new Date(b.date) - new Date(a.date));
      cache.messages = cache.messages.slice(0, account.syncConfig.maxMessages);
    }

    await saveCache(accountId, cache);
    await updateSyncStatus(accountId, 'success');

    io?.emit('messages:sync:completed', { accountId, newMessages: uniqueNew.length });
    io?.emit('messages:changed', {});
    console.log(`📧 Sync complete for ${account.name}: ${uniqueNew.length} new messages`);

    return { newMessages: uniqueNew.length, total: cache.messages.length };
  };

  const result = await providerSync().catch(async (error) => {
    console.error(`📧 Sync failed for ${account.name} (${account.type}): ${error.message}`);
    await updateSyncStatus(accountId, 'error').catch(() => {});
    io?.emit('messages:sync:failed', { accountId, error: error.message });
    throw error;
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

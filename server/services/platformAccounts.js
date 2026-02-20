/**
 * Platform Accounts Service
 *
 * Manages platform accounts that agents use to interact with social platforms.
 * Each account links an agent to a specific platform (e.g., Moltbook) with
 * credentials and status tracking.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import EventEmitter from 'events';
import { ensureDir, PATHS, safeJSONParse } from '../lib/fileUtils.js';

const AGENTS_DIR = PATHS.agentPersonalities;
const ACCOUNTS_FILE = join(AGENTS_DIR, 'accounts.json');

// Event emitter for account changes
export const platformAccountEvents = new EventEmitter();

// In-memory cache
let cache = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 2000;

async function ensureAccountsDir() {
  await ensureDir(AGENTS_DIR);
}

async function loadAccounts() {
  const now = Date.now();

  if (cache && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cache;
  }

  await ensureAccountsDir();

  if (!existsSync(ACCOUNTS_FILE)) {
    cache = { accounts: {} };
    cacheTimestamp = now;
    return cache;
  }

  const content = await readFile(ACCOUNTS_FILE, 'utf-8');
  cache = safeJSONParse(content, { accounts: {} }, { context: 'platformAccounts' });
  cacheTimestamp = now;
  return cache;
}

async function saveAccounts(data) {
  await ensureAccountsDir();
  await writeFile(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
  cache = data;
  cacheTimestamp = Date.now();
}

export function invalidateCache() {
  cache = null;
  cacheTimestamp = 0;
}

export function notifyChanged(action = 'update', accountId = null) {
  platformAccountEvents.emit('changed', { action, accountId, timestamp: Date.now() });
}

/**
 * Get all platform accounts
 */
export async function getAllAccounts() {
  const data = await loadAccounts();
  return Object.entries(data.accounts).map(([id, account]) => ({
    id,
    ...account,
    // Mask the API key for security
    credentials: {
      ...account.credentials,
      apiKey: account.credentials?.apiKey ? '***' + account.credentials.apiKey.slice(-4) : null
    }
  }));
}

/**
 * Get all accounts for a specific agent
 */
export async function getAccountsByAgent(agentId) {
  const accounts = await getAllAccounts();
  return accounts.filter(account => account.agentId === agentId);
}

/**
 * Get account by ID (with full credentials for internal use)
 */
export async function getAccountById(id, maskCredentials = true) {
  const data = await loadAccounts();
  const account = data.accounts[id];
  if (!account) return null;

  return {
    id,
    ...account,
    credentials: maskCredentials ? {
      ...account.credentials,
      apiKey: account.credentials?.apiKey ? '***' + account.credentials.apiKey.slice(-4) : null
    } : account.credentials
  };
}

/**
 * Get account with full credentials (for platform API calls)
 */
export async function getAccountWithCredentials(id) {
  return getAccountById(id, false);
}

/**
 * Create a new platform account
 */
export async function createAccount(accountData) {
  const data = await loadAccounts();
  const id = uuidv4();
  const now = new Date().toISOString();

  const account = {
    agentId: accountData.agentId,
    platform: accountData.platform,
    credentials: {
      apiKey: accountData.credentials.apiKey,
      username: accountData.credentials.username,
      ...(accountData.credentials.agentId ? { agentId: accountData.credentials.agentId } : {})
    },
    status: accountData.status || 'pending',
    lastActivity: null,
    platformData: accountData.platformData || {},
    createdAt: now
  };

  data.accounts[id] = account;
  await saveAccounts(data);
  notifyChanged('create', id);

  console.log(`🔗 Created platform account: ${account.platform}/${account.credentials.username} (${id})`);
  return {
    id,
    ...account,
    credentials: {
      ...account.credentials,
      apiKey: '***' + account.credentials.apiKey.slice(-4)
    }
  };
}

/**
 * Update account status
 */
export async function updateAccountStatus(id, status, platformData = null) {
  const data = await loadAccounts();

  if (!data.accounts[id]) {
    return null;
  }

  data.accounts[id].status = status;
  data.accounts[id].lastActivity = new Date().toISOString();
  if (platformData) {
    data.accounts[id].platformData = {
      ...data.accounts[id].platformData,
      ...platformData
    };
  }

  await saveAccounts(data);
  notifyChanged('update', id);

  return getAccountById(id);
}

/**
 * Record activity on account
 */
export async function recordActivity(id) {
  const data = await loadAccounts();

  if (!data.accounts[id]) {
    return null;
  }

  data.accounts[id].lastActivity = new Date().toISOString();
  await saveAccounts(data);

  return getAccountById(id);
}

/**
 * Update account credentials
 */
export async function updateCredentials(id, credentials) {
  const data = await loadAccounts();

  if (!data.accounts[id]) {
    return null;
  }

  data.accounts[id].credentials = {
    ...data.accounts[id].credentials,
    ...credentials
  };

  await saveAccounts(data);
  notifyChanged('update', id);

  console.log(`🔑 Updated credentials for account ${id}`);
  return getAccountById(id);
}

/**
 * Delete a platform account
 */
export async function deleteAccount(id) {
  const data = await loadAccounts();

  if (!data.accounts[id]) {
    return false;
  }

  const account = data.accounts[id];
  delete data.accounts[id];
  await saveAccounts(data);
  notifyChanged('delete', id);

  console.log(`🗑️ Deleted platform account: ${account.platform}/${account.credentials.username} (${id})`);
  return true;
}

/**
 * Get accounts by platform
 */
export async function getAccountsByPlatform(platform) {
  const accounts = await getAllAccounts();
  return accounts.filter(account => account.platform === platform);
}

/**
 * Get active accounts for an agent
 */
export async function getActiveAccountsForAgent(agentId) {
  const accounts = await getAccountsByAgent(agentId);
  return accounts.filter(account => account.status === 'active');
}

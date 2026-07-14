/**
 * Platform Accounts Service
 *
 * Manages platform accounts that agents use to interact with social platforms.
 * Each account links an agent to a specific platform (e.g., Moltbook) with
 * credentials and status tracking.
 */

import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import EventEmitter from 'events';
import { PATHS, createCachedStore } from '../lib/fileUtils.js';

const ACCOUNTS_FILE = join(PATHS.agentPersonalities, 'accounts.json');
const store = createCachedStore(ACCOUNTS_FILE, { accounts: {} }, { context: 'platformAccounts' });
const loadAccounts = store.load;

// Event emitter for account changes
export const platformAccountEvents = new EventEmitter();
export const invalidateCache = store.invalidateCache;

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

  await store.mutate((data) => { data.accounts[id] = account; });
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
  let found = false;
  await store.mutate((data) => {
    if (!data.accounts[id]) return data;
    found = true;
    data.accounts[id].status = status;
    data.accounts[id].lastActivity = new Date().toISOString();
    if (platformData) {
      data.accounts[id].platformData = {
        ...data.accounts[id].platformData,
        ...platformData
      };
    }
    return data;
  });

  if (!found) return null;
  notifyChanged('update', id);

  return getAccountById(id);
}

/**
 * Record activity on account
 */
export async function recordActivity(id) {
  let found = false;
  await store.mutate((data) => {
    if (!data.accounts[id]) return data;
    found = true;
    data.accounts[id].lastActivity = new Date().toISOString();
    return data;
  });

  if (!found) return null;
  return getAccountById(id);
}

/**
 * Update account credentials
 */
export async function updateCredentials(id, credentials) {
  let found = false;
  await store.mutate((data) => {
    if (!data.accounts[id]) return data;
    found = true;
    data.accounts[id].credentials = {
      ...data.accounts[id].credentials,
      ...credentials
    };
    return data;
  });

  if (!found) return null;
  notifyChanged('update', id);

  console.log(`🔑 Updated credentials for account ${id}`);
  return getAccountById(id);
}

/**
 * Delete a platform account
 */
export async function deleteAccount(id) {
  let account = null;
  await store.mutate((data) => {
    if (!data.accounts[id]) return data;
    account = data.accounts[id];
    delete data.accounts[id];
    return data;
  });

  if (!account) return false;
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

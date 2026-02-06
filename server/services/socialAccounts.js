/**
 * Social Accounts Service
 *
 * Manages the user's social media accounts as part of the Digital Twin.
 * These are the user's OWN accounts (not agent platform accounts) used for:
 * - Content ingestion and style learning
 * - Building a communication profile
 * - Reference for content creation
 * - Future account management automation
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import EventEmitter from 'events';
import { ensureDir, PATHS } from '../lib/fileUtils.js';

const DATA_FILE = join(PATHS.digitalTwin, 'social-accounts.json');

export const socialAccountEvents = new EventEmitter();

// In-memory cache
let cache = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 2000;

// Supported platform definitions
export const PLATFORMS = {
  github: {
    label: 'GitHub',
    urlTemplate: 'https://github.com/{username}',
    icon: 'github',
    contentTypes: ['code', 'repositories', 'contributions'],
    category: 'developer'
  },
  instagram: {
    label: 'Instagram',
    urlTemplate: 'https://instagram.com/{username}',
    icon: 'instagram',
    contentTypes: ['photos', 'stories', 'reels'],
    category: 'social'
  },
  facebook: {
    label: 'Facebook',
    urlTemplate: 'https://facebook.com/{username}',
    icon: 'facebook',
    contentTypes: ['posts', 'photos', 'events'],
    category: 'social'
  },
  linkedin: {
    label: 'LinkedIn',
    urlTemplate: 'https://linkedin.com/in/{username}',
    icon: 'linkedin',
    contentTypes: ['posts', 'articles', 'profile'],
    category: 'professional'
  },
  x: {
    label: 'X (Twitter)',
    urlTemplate: 'https://x.com/{username}',
    icon: 'twitter',
    contentTypes: ['tweets', 'threads', 'likes'],
    category: 'social'
  },
  substack: {
    label: 'Substack',
    urlTemplate: 'https://{username}.substack.com',
    icon: 'newspaper',
    contentTypes: ['articles', 'newsletters'],
    category: 'writing'
  },
  medium: {
    label: 'Medium',
    urlTemplate: 'https://medium.com/@{username}',
    icon: 'pen-tool',
    contentTypes: ['articles', 'responses'],
    category: 'writing'
  },
  youtube: {
    label: 'YouTube',
    urlTemplate: 'https://youtube.com/@{username}',
    icon: 'youtube',
    contentTypes: ['videos', 'shorts', 'comments'],
    category: 'video'
  },
  tiktok: {
    label: 'TikTok',
    urlTemplate: 'https://tiktok.com/@{username}',
    icon: 'music',
    contentTypes: ['videos', 'sounds'],
    category: 'video'
  },
  reddit: {
    label: 'Reddit',
    urlTemplate: 'https://reddit.com/user/{username}',
    icon: 'message-circle',
    contentTypes: ['posts', 'comments'],
    category: 'community'
  },
  bluesky: {
    label: 'Bluesky',
    urlTemplate: 'https://bsky.app/profile/{username}',
    icon: 'cloud',
    contentTypes: ['posts', 'reposts'],
    category: 'social'
  },
  mastodon: {
    label: 'Mastodon',
    urlTemplate: '{url}',
    icon: 'globe',
    contentTypes: ['toots', 'boosts'],
    category: 'social'
  },
  threads: {
    label: 'Threads',
    urlTemplate: 'https://threads.net/@{username}',
    icon: 'at-sign',
    contentTypes: ['posts', 'replies'],
    category: 'social'
  },
  other: {
    label: 'Other',
    urlTemplate: '{url}',
    icon: 'link',
    contentTypes: [],
    category: 'other'
  }
};

async function loadAccounts() {
  const now = Date.now();
  if (cache && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cache;
  }

  await ensureDir(PATHS.digitalTwin);

  if (!existsSync(DATA_FILE)) {
    cache = { accounts: {} };
    cacheTimestamp = now;
    return cache;
  }

  const content = await readFile(DATA_FILE, 'utf-8');
  cache = JSON.parse(content);
  cacheTimestamp = now;
  return cache;
}

async function saveAccounts(data) {
  await ensureDir(PATHS.digitalTwin);
  await writeFile(DATA_FILE, JSON.stringify(data, null, 2));
  cache = data;
  cacheTimestamp = Date.now();
}

export function invalidateCache() {
  cache = null;
  cacheTimestamp = 0;
}

export function notifyChanged(action = 'update', accountId = null) {
  socialAccountEvents.emit('changed', { action, accountId, timestamp: Date.now() });
}

/**
 * Get all social accounts
 */
export async function getAllAccounts() {
  const data = await loadAccounts();
  return Object.entries(data.accounts).map(([id, account]) => ({
    id,
    ...account
  }));
}

/**
 * Get account by ID
 */
export async function getAccountById(id) {
  const data = await loadAccounts();
  const account = data.accounts[id];
  if (!account) return null;
  return { id, ...account };
}

/**
 * Get accounts by platform
 */
export async function getAccountsByPlatform(platform) {
  const accounts = await getAllAccounts();
  return accounts.filter(a => a.platform === platform);
}

/**
 * Get accounts by category
 */
export async function getAccountsByCategory(category) {
  const accounts = await getAllAccounts();
  return accounts.filter(a => {
    const platformDef = PLATFORMS[a.platform];
    return platformDef && platformDef.category === category;
  });
}

/**
 * Create a new social account
 */
export async function createAccount(accountData) {
  const data = await loadAccounts();
  const id = uuidv4();
  const now = new Date().toISOString();

  const account = {
    platform: accountData.platform,
    username: accountData.username,
    displayName: accountData.displayName || accountData.username,
    url: accountData.url || buildUrl(accountData.platform, accountData.username),
    bio: accountData.bio || '',
    contentTypes: accountData.contentTypes || PLATFORMS[accountData.platform]?.contentTypes || [],
    ingestionEnabled: accountData.ingestionEnabled ?? false,
    ingestionStatus: 'pending',
    lastIngested: null,
    contentCount: 0,
    notes: accountData.notes || '',
    createdAt: now,
    updatedAt: now
  };

  data.accounts[id] = account;
  await saveAccounts(data);
  notifyChanged('create', id);

  console.log(`🔗 Added social account: ${account.platform}/${account.username} (${id})`);
  return { id, ...account };
}

/**
 * Update a social account
 */
export async function updateAccount(id, updates) {
  const data = await loadAccounts();
  if (!data.accounts[id]) return null;

  const allowed = [
    'username', 'displayName', 'url', 'bio', 'contentTypes',
    'ingestionEnabled', 'ingestionStatus', 'lastIngested',
    'contentCount', 'notes'
  ];

  for (const key of allowed) {
    if (updates[key] !== undefined) {
      data.accounts[id][key] = updates[key];
    }
  }
  data.accounts[id].updatedAt = new Date().toISOString();

  await saveAccounts(data);
  notifyChanged('update', id);

  console.log(`📝 Updated social account: ${data.accounts[id].platform}/${data.accounts[id].username} (${id})`);
  return { id, ...data.accounts[id] };
}

/**
 * Delete a social account
 */
export async function deleteAccount(id) {
  const data = await loadAccounts();
  if (!data.accounts[id]) return false;

  const account = data.accounts[id];
  delete data.accounts[id];
  await saveAccounts(data);
  notifyChanged('delete', id);

  console.log(`🗑️ Removed social account: ${account.platform}/${account.username} (${id})`);
  return true;
}

/**
 * Get supported platforms list
 */
export function getSupportedPlatforms() {
  return Object.entries(PLATFORMS).map(([id, platform]) => ({
    id,
    ...platform
  }));
}

/**
 * Get account summary stats
 */
export async function getAccountStats() {
  const accounts = await getAllAccounts();
  const byCategory = {};
  const byPlatform = {};

  for (const account of accounts) {
    const platformDef = PLATFORMS[account.platform];
    const category = platformDef?.category || 'other';

    byCategory[category] = (byCategory[category] || 0) + 1;
    byPlatform[account.platform] = (byPlatform[account.platform] || 0) + 1;
  }

  return {
    total: accounts.length,
    ingestionEnabled: accounts.filter(a => a.ingestionEnabled).length,
    byCategory,
    byPlatform
  };
}

/**
 * Build a profile URL from platform and username
 */
function buildUrl(platform, username) {
  const platformDef = PLATFORMS[platform];
  if (!platformDef) return '';
  return platformDef.urlTemplate.replace('{username}', username);
}

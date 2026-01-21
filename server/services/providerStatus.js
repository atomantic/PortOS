/**
 * Provider Status Service
 *
 * Tracks provider availability status, usage limits, and provides
 * fallback provider selection when the primary provider is unavailable.
 */

import { EventEmitter } from 'events';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATUS_FILE = join(__dirname, '../../data/provider-status.json');

// Event emitter for status changes
export const providerStatusEvents = new EventEmitter();

// In-memory status cache
let statusCache = {
  providers: {},
  lastUpdated: null
};

/**
 * Provider status structure:
 * {
 *   providerId: {
 *     available: boolean,
 *     reason: string,           // 'ok' | 'usage-limit' | 'rate-limit' | 'auth-error' | 'network-error'
 *     message: string,          // Human-readable status message
 *     waitTime: string,         // Extracted wait time (e.g., "1 day 1 hour 33 minutes")
 *     unavailableSince: string, // ISO timestamp when became unavailable
 *     estimatedRecovery: string,// ISO timestamp when expected to recover
 *     failureCount: number,     // Consecutive failures
 *     lastChecked: string       // ISO timestamp of last status check
 *   }
 * }
 */

/**
 * Load status from disk
 */
async function loadStatus() {
  if (!existsSync(STATUS_FILE)) {
    return { providers: {}, lastUpdated: null };
  }
  const content = await readFile(STATUS_FILE, 'utf-8');
  return JSON.parse(content);
}

/**
 * Save status to disk
 */
async function saveStatus(status) {
  const dir = dirname(STATUS_FILE);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  status.lastUpdated = new Date().toISOString();
  await writeFile(STATUS_FILE, JSON.stringify(status, null, 2));
  statusCache = status;
}

/**
 * Initialize status cache
 */
export async function initProviderStatus() {
  statusCache = await loadStatus().catch(() => ({ providers: {}, lastUpdated: null }));

  // Clean up stale statuses (older than 24 hours)
  const now = Date.now();
  let changed = false;
  for (const [providerId, status] of Object.entries(statusCache.providers)) {
    if (status.estimatedRecovery) {
      const recoveryTime = new Date(status.estimatedRecovery).getTime();
      if (now > recoveryTime) {
        // Recovery time passed, mark as available
        statusCache.providers[providerId] = {
          available: true,
          reason: 'ok',
          message: 'Provider available',
          lastChecked: new Date().toISOString()
        };
        changed = true;
      }
    }
  }

  if (changed) {
    await saveStatus(statusCache);
  }

  console.log('📊 Provider status service initialized');
}

/**
 * Get status for a specific provider
 */
export function getProviderStatus(providerId) {
  return statusCache.providers[providerId] || {
    available: true,
    reason: 'ok',
    message: 'Provider available',
    lastChecked: new Date().toISOString()
  };
}

/**
 * Get all provider statuses
 */
export function getAllProviderStatuses() {
  return { ...statusCache };
}

/**
 * Check if a provider is available
 */
export function isProviderAvailable(providerId) {
  const status = getProviderStatus(providerId);
  return status.available;
}

/**
 * Parse wait time string to milliseconds
 * e.g., "1 day 1 hour 33 minutes" -> 91980000
 */
function parseWaitTime(waitTimeStr) {
  if (!waitTimeStr) return null;

  let totalMs = 0;
  const dayMatch = waitTimeStr.match(/(\d+)\s*day/i);
  const hourMatch = waitTimeStr.match(/(\d+)\s*hour/i);
  const minMatch = waitTimeStr.match(/(\d+)\s*min/i);
  const secMatch = waitTimeStr.match(/(\d+)\s*sec/i);

  if (dayMatch) totalMs += parseInt(dayMatch[1]) * 24 * 60 * 60 * 1000;
  if (hourMatch) totalMs += parseInt(hourMatch[1]) * 60 * 60 * 1000;
  if (minMatch) totalMs += parseInt(minMatch[1]) * 60 * 1000;
  if (secMatch) totalMs += parseInt(secMatch[1]) * 1000;

  return totalMs || null;
}

/**
 * Mark a provider as unavailable due to usage limit
 */
export async function markProviderUsageLimit(providerId, errorInfo) {
  const now = new Date();
  const waitTimeMs = parseWaitTime(errorInfo.waitTime);
  const estimatedRecovery = waitTimeMs
    ? new Date(now.getTime() + waitTimeMs).toISOString()
    : new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(); // Default: 24 hours

  const previousStatus = statusCache.providers[providerId];
  const failureCount = (previousStatus?.failureCount || 0) + 1;

  statusCache.providers[providerId] = {
    available: false,
    reason: 'usage-limit',
    message: errorInfo.message || 'Usage limit exceeded',
    waitTime: errorInfo.waitTime || null,
    unavailableSince: now.toISOString(),
    estimatedRecovery,
    failureCount,
    lastChecked: now.toISOString()
  };

  await saveStatus(statusCache);

  // Emit event for UI updates
  providerStatusEvents.emit('status:changed', {
    providerId,
    status: statusCache.providers[providerId],
    type: 'usage-limit'
  });

  console.log(`⚠️ Provider ${providerId} marked unavailable: usage limit (retry after ${errorInfo.waitTime || '24h'})`);

  return statusCache.providers[providerId];
}

/**
 * Mark a provider as unavailable due to rate limiting (temporary)
 */
export async function markProviderRateLimited(providerId) {
  const now = new Date();
  // Rate limits are usually short - default to 5 minutes
  const estimatedRecovery = new Date(now.getTime() + 5 * 60 * 1000).toISOString();

  const previousStatus = statusCache.providers[providerId];
  const failureCount = (previousStatus?.failureCount || 0) + 1;

  statusCache.providers[providerId] = {
    available: false,
    reason: 'rate-limit',
    message: 'Rate limit exceeded - temporary',
    unavailableSince: now.toISOString(),
    estimatedRecovery,
    failureCount,
    lastChecked: now.toISOString()
  };

  await saveStatus(statusCache);

  providerStatusEvents.emit('status:changed', {
    providerId,
    status: statusCache.providers[providerId],
    type: 'rate-limit'
  });

  return statusCache.providers[providerId];
}

/**
 * Mark a provider as available (recovered)
 */
export async function markProviderAvailable(providerId) {
  statusCache.providers[providerId] = {
    available: true,
    reason: 'ok',
    message: 'Provider available',
    failureCount: 0,
    lastChecked: new Date().toISOString()
  };

  await saveStatus(statusCache);

  providerStatusEvents.emit('status:changed', {
    providerId,
    status: statusCache.providers[providerId],
    type: 'recovered'
  });

  console.log(`✅ Provider ${providerId} marked available`);

  return statusCache.providers[providerId];
}

/**
 * Get the best available fallback provider
 * Returns null if no fallback is available
 *
 * Priority order:
 * 1. Task-level fallback (task.metadata.fallbackProvider)
 * 2. Provider-level fallback (provider.fallbackProvider)
 * 3. System default priority list
 */
export async function getFallbackProvider(primaryProviderId, providers, taskFallbackId = null) {
  // Define fallback priority order
  const fallbackPriority = ['claude-code', 'codex', 'lmstudio', 'local-lm-studio', 'ollama', 'gemini-cli'];

  // 1. Check task-level fallback first (highest priority)
  if (taskFallbackId && taskFallbackId !== primaryProviderId) {
    const taskFallback = providers[taskFallbackId];
    if (taskFallback?.enabled && isProviderAvailable(taskFallback.id)) {
      return { provider: taskFallback, source: 'task' };
    }
  }

  // 2. Check provider's configured fallback
  const primaryProvider = providers[primaryProviderId];
  if (primaryProvider?.fallbackProvider) {
    const configuredFallback = providers[primaryProvider.fallbackProvider];
    if (configuredFallback?.enabled && isProviderAvailable(configuredFallback.id)) {
      return { provider: configuredFallback, source: 'provider' };
    }
  }

  // 3. Try fallback priority list
  for (const providerId of fallbackPriority) {
    if (providerId === primaryProviderId) continue;

    const provider = providers[providerId];
    if (provider?.enabled && isProviderAvailable(providerId)) {
      return { provider, source: 'system' };
    }
  }

  return null;
}

/**
 * Get human-readable time until provider recovery
 */
export function getTimeUntilRecovery(providerId) {
  const status = getProviderStatus(providerId);
  if (status.available || !status.estimatedRecovery) return null;

  const now = Date.now();
  const recoveryTime = new Date(status.estimatedRecovery).getTime();
  const remainingMs = recoveryTime - now;

  if (remainingMs <= 0) return 'any moment';

  const days = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
  const hours = Math.floor((remainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);

  return parts.join(' ') || '< 1m';
}

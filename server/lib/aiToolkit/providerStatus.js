/**
 * Provider Status Service
 *
 * Tracks provider availability status, usage limits, and provides
 * fallback provider selection when the primary provider is unavailable.
 */

import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { atomicWrite } from './internal/atomicWrite.js';

export function createProviderStatusService(config = {}) {
  const {
    dataDir = './data',
    statusFile = 'provider-status.json',
    defaultFallbackPriority = ['claude-code', 'codex', 'lmstudio', 'local-lm-studio', 'ollama', 'gemini-cli'],
    defaultUsageLimitWait = 24 * 60 * 60 * 1000,
    defaultRateLimitWait = 5 * 60 * 1000,
    onStatusChange = null
  } = config;

  const STATUS_PATH = join(dataDir, statusFile);
  const events = new EventEmitter();

  let statusCache = {
    providers: {},
    lastUpdated: null
  };

  async function loadStatus() {
    if (!existsSync(STATUS_PATH)) {
      return { providers: {}, lastUpdated: null };
    }
    const content = await readFile(STATUS_PATH, 'utf-8');
    const parsed = JSON.parse(content);
    return parsed || { providers: {}, lastUpdated: null };
  }

  async function saveStatus(status) {
    status.lastUpdated = new Date().toISOString();
    await atomicWrite(STATUS_PATH, status);
    statusCache = status;
  }

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

  function formatTimeRemaining(ms) {
    if (ms <= 0) return 'any moment';

    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);

    return parts.join(' ') || '< 1m';
  }

  function emitStatusChange(providerId, status, type) {
    const eventData = { providerId, status, type };
    events.emit('status:changed', eventData);
    onStatusChange?.(eventData);
  }

  return {
    events,

    async init() {
      statusCache = await loadStatus().catch(() => ({ providers: {}, lastUpdated: null }));

      const now = Date.now();
      let changed = false;
      for (const [providerId, status] of Object.entries(statusCache.providers)) {
        if (status.estimatedRecovery) {
          const recoveryTime = new Date(status.estimatedRecovery).getTime();
          if (now > recoveryTime) {
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

      return statusCache;
    },

    getStatus(providerId) {
      const status = statusCache.providers[providerId];
      if (!status) {
        return {
          available: true,
          reason: 'ok',
          message: 'Provider available',
          lastChecked: new Date().toISOString()
        };
      }
      // Auto-recover when the estimatedRecovery deadline has passed — without
      // this check a provider remains marked unavailable until the next
      // service restart (or an explicit markAvailable call) even after its
      // wait window has elapsed, so fallback selection keeps skipping it.
      if (status.estimatedRecovery && Date.now() > new Date(status.estimatedRecovery).getTime()) {
        return {
          available: true,
          reason: 'ok',
          message: 'Provider available',
          lastChecked: new Date().toISOString()
        };
      }
      return status;
    },

    getAllStatuses() {
      // Apply the same recovery check getStatus() uses so the aggregate
      // endpoint reports a recovered provider as available instead of
      // returning the stale cached unavailable entry.
      const now = Date.now();
      const providers = {};
      for (const [id, status] of Object.entries(statusCache.providers || {})) {
        if (status.estimatedRecovery && now > new Date(status.estimatedRecovery).getTime()) {
          providers[id] = {
            available: true,
            reason: 'ok',
            message: 'Provider available',
            lastChecked: new Date().toISOString()
          };
        } else {
          providers[id] = status;
        }
      }
      return { ...statusCache, providers };
    },

    isAvailable(providerId) {
      const status = this.getStatus(providerId);
      return status.available;
    },

    async markUsageLimit(providerId, errorInfo = {}) {
      const now = new Date();
      const waitTimeMs = parseWaitTime(errorInfo.waitTime) || defaultUsageLimitWait;
      const estimatedRecovery = new Date(now.getTime() + waitTimeMs).toISOString();

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
      emitStatusChange(providerId, statusCache.providers[providerId], 'usage-limit');

      return statusCache.providers[providerId];
    },

    async markRateLimited(providerId) {
      const now = new Date();
      const estimatedRecovery = new Date(now.getTime() + defaultRateLimitWait).toISOString();

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
      emitStatusChange(providerId, statusCache.providers[providerId], 'rate-limit');

      return statusCache.providers[providerId];
    },

    async markAvailable(providerId) {
      statusCache.providers[providerId] = {
        available: true,
        reason: 'ok',
        message: 'Provider available',
        failureCount: 0,
        lastChecked: new Date().toISOString()
      };

      await saveStatus(statusCache);
      emitStatusChange(providerId, statusCache.providers[providerId], 'recovered');

      return statusCache.providers[providerId];
    },

    getFallbackProvider(primaryProviderId, providers, taskFallbackId = null) {
      if (taskFallbackId && taskFallbackId !== primaryProviderId) {
        const taskFallback = providers[taskFallbackId];
        if (taskFallback?.enabled && this.isAvailable(taskFallback.id)) {
          return { provider: taskFallback, source: 'task' };
        }
      }

      const primaryProvider = providers[primaryProviderId];
      if (primaryProvider?.fallbackProvider) {
        const configuredFallback = providers[primaryProvider.fallbackProvider];
        if (configuredFallback?.enabled && this.isAvailable(configuredFallback.id)) {
          return { provider: configuredFallback, source: 'provider' };
        }
      }

      for (const providerId of defaultFallbackPriority) {
        if (providerId === primaryProviderId) continue;

        const provider = providers[providerId];
        if (provider?.enabled && this.isAvailable(providerId)) {
          return { provider, source: 'system' };
        }
      }

      return null;
    },

    getTimeUntilRecovery(providerId) {
      const status = this.getStatus(providerId);
      if (status.available || !status.estimatedRecovery) return null;

      const now = Date.now();
      const recoveryTime = new Date(status.estimatedRecovery).getTime();
      const remainingMs = recoveryTime - now;

      return formatTimeRemaining(remainingMs);
    },

    parseWaitTime,

    formatTimeRemaining
  };
}

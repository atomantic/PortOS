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

/**
 * Gate a *configured* fallback-model pin against the fallback provider's own
 * model list.
 *
 * `fallbackModel` (provider-level) and a task's fallback model are pins the
 * user chose once and that then sit in `providers.json` / the task record
 * forever. When the fallback provider's `models` list later moves on — a model
 * bump migration retires an id, or the user curates the list by hand — the pin
 * is left naming a model that provider no longer serves, and nothing downstream
 * notices: `resolveEffectiveModel` only screens for empty/embedding ids, so the
 * dead id gets baked straight into the spawned `--model` flag. That turns the
 * one retry the cascade has left into a request against a model that isn't
 * there.
 *
 * So: keep the pin only when the fallback provider actually lists it. Dropping
 * it to `null` means "let the fallback resolve its own default", which is the
 * same thing an unpinned fallback already does — strictly better than a model
 * id known to be absent.
 *
 * Providers with no enumerable `models` (local backends that discover theirs at
 * runtime, hand-typed ids in the free-text picker) have nothing to check
 * against, so their pins pass through untouched.
 *
 * @param {object} provider — the chosen fallback provider
 * @param {string|null|undefined} pinnedModel — the configured pin
 * @returns {string|null}
 */
export function usableFallbackModel(provider, pinnedModel) {
  if (!pinnedModel) return null;
  const models = provider?.models;
  if (!Array.isArray(models) || models.length === 0) return pinnedModel;
  if (models.includes(pinnedModel)) return pinnedModel;
  console.log(`⚠️ Fallback ${provider?.id || 'provider'} no longer lists pinned model ${pinnedModel} — using its own default instead`);
  return null;
}

export function createProviderStatusService(config = {}) {
  const {
    dataDir = './data',
    statusFile = 'provider-status.json',
    defaultFallbackPriority = ['claude-code', 'codex', 'lmstudio', 'local-lm-studio', 'ollama', 'antigravity-cli', 'gemini-cli'],
    // Usage-limit bench is a SHORT retry interval, not the provider's stated
    // reset. A usage limit resets on a rolling window (≈5h max), and a CLI's
    // self-reported "resets in 21h" is unreliable + over-conservative — benching
    // that long sidelines the primary for a day even though capacity usually
    // frees much sooner. So default to a tight 10m probe and re-bench if still
    // limited; never exceed the 5h reset window (`maxUsageLimitWait`).
    defaultUsageLimitWait = 10 * 60 * 1000,
    maxUsageLimitWait = 5 * 60 * 60 * 1000,
    defaultRateLimitWait = 5 * 60 * 1000,
    onStatusChange = null,
    // Host-supplied `(provider, providers) => boolean` answering "can this
    // provider run at all right now?" — its CLI binary present, its credential
    // stored. Enabled + not benched says nothing about either, so without this
    // the fallback chain happily hands a run to a provider whose binary was
    // never installed and the run dies at spawn time on a raw ENOENT (#4611).
    //
    // Injected rather than computed here because the answer needs host I/O (a
    // PATH probe) and this directory stays self-contained. It MUST be
    // synchronous and MUST default to "yes": an unknown answer has to route
    // exactly as it did before, never take a working provider out of the chain.
    prerequisitesMet = null
  } = config;

  const STATUS_PATH = join(dataDir, statusFile);
  const events = new EventEmitter();

  /**
   * Does the host vouch for this provider's prerequisites?
   *
   * A missing hook, a throwing hook, or a non-boolean answer all read as "yes".
   * The hook is a best-effort refinement of the routing decision; a broken one
   * must not silently empty the fallback chain, which is a far worse failure
   * than the late ENOENT it exists to prevent.
   */
  function meetsPrerequisites(provider, providers) {
    if (typeof prerequisitesMet !== 'function') return true;
    try {
      return prerequisitesMet(provider, providers) !== false;
    } catch (err) {
      console.error(`❌ Prerequisite check failed for ${provider?.id || 'provider'}: ${err.message}`);
      return true;
    }
  }

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

    // Generic unavailability marker. Each specific marker below (usage-limit,
    // rate-limit) is now a thin wrapper that supplies its own cooldown +
    // message defaults — keeps the persistence path in one place and lets
    // ad-hoc callers (e.g. promptRunner.js on a failed run) mark a provider
    // unavailable with a custom reason like 'network-error' without
    // proliferating wrapper methods for every error category.
    //
    // `extras` is an optional object of category-specific fields to splat
    // onto the persisted record (e.g. `waitTime: '5 hours'` for usage-limit
    // displays). Splatting in this single write keeps `status:changed`
    // listeners from observing a half-built record on the first emit.
    async markUnavailable(providerId, options = {}) {
      const {
        reason = 'unknown',
        message = 'Provider unavailable',
        waitTimeMs = defaultRateLimitWait,
        extras = null
      } = options;
      const now = new Date();
      const estimatedRecovery = new Date(now.getTime() + waitTimeMs).toISOString();

      const previousStatus = statusCache.providers[providerId];
      const failureCount = (previousStatus?.failureCount || 0) + 1;

      statusCache.providers[providerId] = {
        available: false,
        reason,
        message,
        unavailableSince: now.toISOString(),
        estimatedRecovery,
        failureCount,
        lastChecked: now.toISOString(),
        ...(extras && typeof extras === 'object' ? extras : {})
      };

      await saveStatus(statusCache);
      emitStatusChange(providerId, statusCache.providers[providerId], reason);

      return statusCache.providers[providerId];
    },

    async markUsageLimit(providerId, errorInfo = {}) {
      // Bench for a SHORT retry interval rather than the provider's stated reset.
      // Respect a parsed wait ONLY when it is shorter than the tight default (a
      // genuinely brief reset); otherwise use the default and never let any value
      // exceed the 5h reset-window ceiling. This keeps a "resets in 21h" estimate
      // from sidelining the primary for a day — it retries in 10m and re-benches
      // if still limited. The parsed value is still surfaced for DISPLAY.
      const parsed = parseWaitTime(errorInfo.waitTime);
      const benchMs = Math.min(
        parsed && parsed < defaultUsageLimitWait ? parsed : defaultUsageLimitWait,
        maxUsageLimitWait,
      );
      return this.markUnavailable(providerId, {
        reason: 'usage-limit',
        message: errorInfo.message || 'Usage limit exceeded',
        waitTimeMs: benchMs,
        // `waitTime` is a usage-limit-only display string ("resets 5pm") —
        // pass via extras so it's part of the SAME persisted record and
        // status:changed event, not a follow-up second write.
        extras: errorInfo.waitTime ? { waitTime: errorInfo.waitTime } : null
      });
    },

    async markRateLimited(providerId) {
      return this.markUnavailable(providerId, {
        reason: 'rate-limit',
        message: 'Rate limit exceeded - temporary',
        waitTimeMs: defaultRateLimitWait
      });
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

    // Returns `{ provider, source, model }` (or null). `model` is the model
    // hint the caller should run on the fallback provider — the configured
    // `fallbackModel` for a provider-level fallback, the task's fallback model
    // for a task-level one, or null ("let the fallback resolve its own
    // default"). It is NEVER the primary's model: a model id resolved against
    // the primary almost never exists on the fallback, and carrying it over is
    // exactly the leak that sent `codex-configured-default` to LM Studio.
    //
    // Every candidate must additionally clear `prerequisitesMet` (see the
    // config option): `enabled` + not benched says the user WANTS this provider
    // and it hasn't failed lately — neither says its CLI is installed or its
    // key is stored. Skipping an un-runnable candidate here is what turns a
    // late `spawn <binary> ENOENT` into "try the next provider instead".
    getFallbackProvider(primaryProviderId, providers, taskFallbackId = null, taskFallbackModelId = null) {
      if (taskFallbackId && taskFallbackId !== primaryProviderId) {
        const taskFallback = providers[taskFallbackId];
        if (taskFallback?.enabled && this.isAvailable(taskFallback.id) && meetsPrerequisites(taskFallback, providers)) {
          return { provider: taskFallback, source: 'task', model: usableFallbackModel(taskFallback, taskFallbackModelId) };
        }
      }

      const primaryProvider = providers[primaryProviderId];
      // Guard against `fallbackProvider === self` — a misconfigured provider
      // would otherwise loop back to itself and silently retry the same
      // broken endpoint. The system priority loop already excludes
      // primaryProviderId; the configured-fallback path needs its own check.
      if (primaryProvider?.fallbackProvider && primaryProvider.fallbackProvider !== primaryProviderId) {
        const configuredFallback = providers[primaryProvider.fallbackProvider];
        if (configuredFallback?.enabled && this.isAvailable(configuredFallback.id) && meetsPrerequisites(configuredFallback, providers)) {
          return { provider: configuredFallback, source: 'provider', model: usableFallbackModel(configuredFallback, primaryProvider.fallbackModel) };
        }
      }

      for (const providerId of defaultFallbackPriority) {
        if (providerId === primaryProviderId) continue;

        const provider = providers[providerId];
        if (provider?.enabled && this.isAvailable(providerId) && meetsPrerequisites(provider, providers)) {
          return { provider, source: 'system', model: null };
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

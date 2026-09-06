/**
 * Compatibility shim for PortOS services that import from providerStatus.js.
 *
 * Provider routing and the recovery UI must share one in-memory status cache.
 * The AI Toolkit owns that cache; this module only delegates to it. Creating a
 * second service over the same JSON file leaves two caches that disagree until
 * restart, so a manual recovery can look successful while new runs still skip
 * the recovered provider.
 */

import { EventEmitter } from 'events';
import { requireToolkit, setAIToolkitInstance } from '../lib/aiToolkitState.js';

export const providerStatusEvents = new EventEmitter();

let boundStatusEvents = null;

const forwardStatusChanged = (data) => {
  providerStatusEvents.emit('status:changed', data);
};

function getProviderStatusService() {
  return requireToolkit().services.providerStatus;
}

function bindProviderStatusEvents(toolkit) {
  const nextEvents = toolkit?.services?.providerStatus?.events || null;
  if (nextEvents === boundStatusEvents) return;

  boundStatusEvents?.off('status:changed', forwardStatusChanged);
  nextEvents?.on('status:changed', forwardStatusChanged);
  boundStatusEvents = nextEvents;
}

// Keep the named setter stable for bootstrap while sharing the singleton held
// by aiToolkitState with the providers, runner, and prompt-service shims.
export function setAIToolkit(toolkit) {
  setAIToolkitInstance(toolkit);
  bindProviderStatusEvents(toolkit);
}

/**
 * Initialize the toolkit-owned status cache.
 */
export async function initProviderStatus() {
  await getProviderStatusService().init();
  console.log('📊 Provider status service initialized');
}

/**
 * Get status for a specific provider.
 */
export function getProviderStatus(providerId) {
  return getProviderStatusService().getStatus(providerId);
}

/**
 * Get all provider statuses.
 */
export function getAllProviderStatuses() {
  return getProviderStatusService().getAllStatuses();
}

/**
 * Check if a provider is available.
 */
export function isProviderAvailable(providerId) {
  return getProviderStatusService().isAvailable(providerId);
}

/**
 * Mark a provider unavailable for an arbitrary reason + cooldown — the generic
 * marker the category-specific ones below are wrappers over. Callers resolve
 * `options` via `lib/providerCooldown.js#resolveProviderBench`.
 *
 * @param {string} providerId
 * @param {{ reason?: string, message?: string, waitTimeMs?: number, extras?: object }} options
 */
export async function markProviderUnavailable(providerId, options = {}) {
  const status = await getProviderStatusService().markUnavailable(providerId, options);
  console.log(`⚠️ Provider ${providerId} sidelined: ${options.reason || 'unknown'} (retry in ${Math.round((options.waitTimeMs || 0) / 60000)}m)`);
  return status;
}

/**
 * Mark a provider as unavailable due to usage limit.
 */
export async function markProviderUsageLimit(providerId, errorInfo) {
  const status = await getProviderStatusService().markUsageLimit(providerId, errorInfo);
  console.log(`⚠️ Provider ${providerId} marked unavailable: usage limit (retry after ${errorInfo?.waitTime || '24h'})`);
  return status;
}

/**
 * Mark a provider as unavailable due to rate limiting (temporary).
 */
export async function markProviderRateLimited(providerId) {
  return getProviderStatusService().markRateLimited(providerId);
}

/**
 * Mark a provider as available (recovered).
 */
export async function markProviderAvailable(providerId) {
  const status = await getProviderStatusService().markAvailable(providerId);
  console.log(`✅ Provider ${providerId} marked available`);
  return status;
}

/**
 * Get the best available fallback provider.
 * Returns `{ provider, source, model }` (or null if no fallback is available).
 *
 * `requestCapabilities` carries the caller's constraints for THIS request —
 * `hasImages` / `requiredContextTokens`, and `allowedModes` (the caller's
 * execution-mode policy from `lib/callerModePolicy.js`, applied to every
 * candidate tier). It was previously dropped by this wrapper, so an agent caller
 * could only enforce a policy on the pin it resolved itself and not on the
 * fallback that might replace it.
 */
export function getFallbackProvider(primaryProviderId, providers, taskFallbackId = null, taskFallbackModelId = null, requestCapabilities = null) {
  return getProviderStatusService().getFallbackProvider(primaryProviderId, providers, taskFallbackId, taskFallbackModelId, requestCapabilities);
}

/**
 * Get human-readable time until provider recovery.
 */
export function getTimeUntilRecovery(providerId) {
  return getProviderStatusService().getTimeUntilRecovery(providerId);
}

// Backwards-compatible direct-service facade. Property access resolves against
// the current toolkit, and methods are bound so implementations using `this`
// (such as isAvailable -> getStatus) continue to work.
export const providerStatusService = new Proxy({}, {
  get(_target, property) {
    const service = getProviderStatusService();
    const value = service[property];
    return typeof value === 'function' ? value.bind(service) : value;
  }
});

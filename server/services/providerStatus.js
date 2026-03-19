/**
 * Provider Status Service
 *
 * Thin wrapper around portos-ai-toolkit's createProviderStatusService
 * that provides backwards-compatible exports for PortOS.
 */

import { createProviderStatusService } from 'portos-ai-toolkit/server';
import { PATHS } from '../lib/fileUtils.js';

// Create the provider status service from ai-toolkit
const providerStatusService = createProviderStatusService({
  dataDir: PATHS.data,
  statusFile: 'provider-status.json',
  defaultFallbackPriority: ['claude-code', 'codex', 'lmstudio', 'local-lm-studio', 'ollama', 'gemini-cli'],
  onStatusChange: (eventData) => {
    // Re-emit on the exported events emitter for backwards compatibility
    providerStatusEvents.emit('status:changed', eventData);
  }
});

// Export the events emitter for Socket.IO integration
export const providerStatusEvents = providerStatusService.events;

/**
 * Initialize status cache
 */
export async function initProviderStatus() {
  await providerStatusService.init();
  console.log('📊 Provider status service initialized');
}

/**
 * Get status for a specific provider
 */
export function getProviderStatus(providerId) {
  return providerStatusService.getStatus(providerId);
}

/**
 * Get all provider statuses
 */
export function getAllProviderStatuses() {
  return providerStatusService.getAllStatuses();
}

/**
 * Check if a provider is available
 */
export function isProviderAvailable(providerId) {
  return providerStatusService.isAvailable(providerId);
}

/**
 * Mark a provider as unavailable due to usage limit
 */
export async function markProviderUsageLimit(providerId, errorInfo) {
  const status = await providerStatusService.markUsageLimit(providerId, errorInfo);
  console.log(`⚠️ Provider ${providerId} marked unavailable: usage limit (retry after ${errorInfo?.waitTime || '24h'})`);
  return status;
}

/**
 * Mark a provider as unavailable due to rate limiting (temporary)
 */
export async function markProviderRateLimited(providerId) {
  return providerStatusService.markRateLimited(providerId);
}

/**
 * Mark a provider as available (recovered)
 */
export async function markProviderAvailable(providerId) {
  const status = await providerStatusService.markAvailable(providerId);
  console.log(`✅ Provider ${providerId} marked available`);
  return status;
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
export function getFallbackProvider(primaryProviderId, providers, taskFallbackId = null) {
  return providerStatusService.getFallbackProvider(primaryProviderId, providers, taskFallbackId);
}

/**
 * Get human-readable time until provider recovery
 */
export function getTimeUntilRecovery(providerId) {
  return providerStatusService.getTimeUntilRecovery(providerId);
}

// Export the underlying service for direct access if needed
export { providerStatusService };
